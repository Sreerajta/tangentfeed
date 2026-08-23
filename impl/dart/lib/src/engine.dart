/// The merge engine — PROTOCOL.md sections 3, 5 and 6.
library;

import 'dart:async';
import 'dart:typed_data';

import 'hlc.dart';
import 'compaction.dart';
import 'op.dart';
import 'signing.dart';
import 'storage.dart';
import 'ulid.dart';

/// One row as materialized state: column to value, plus its id.
typedef RowData = Map<String, Object?>;

class RowChange {
  const RowChange(this.table, this.row);
  final String table;
  final String row;
}

/// What subscribers see after every committed batch.
class ChangeEvent {
  const ChangeEvent({required this.changes, required this.ops, required this.origin});

  final List<RowChange> changes;
  final List<Op> ops;

  /// "local" for writes made here, "remote" for ops applied from a peer.
  final String origin;
}

/// A replica of one space.
class SyncEngine {
  SyncEngine._(this._storage, this._clock, this._deviceKey) {
    _keys[_clock.deviceId] = _deviceKey.publicKey;
  }

  final DeviceKey _deviceKey;

  /// deviceId -> public key. Seeded with our own so we can verify our own ops.
  final Map<String, Uint8List> _keys = {};

  /// This device's public key, for the `hello` message. Section 6.1.
  Uint8List get publicKey => _deviceKey.publicKey;

  /// Every device key known to this replica, for the `keys` message.
  Map<String, Uint8List> knownKeys() => Map.of(_keys);

  /// Records a peer's public key.
  ///
  /// Returns false when the key does not hash to the claimed id. That check is
  /// what makes the directory self-validating: a peer may relay keys it
  /// learned from others but cannot invent one for somebody else.
  bool learnKey(String deviceId, Uint8List publicKey) {
    if (deviceIdFromPublicKey(publicKey) != deviceId) return false;
    _keys[deviceId] = publicKey;
    return true;
  }

  final StorageAdapter _storage;
  final HybridLogicalClock _clock;
  final List<void Function(ChangeEvent)> _subscribers = [];

  /// Serializes mutations. Dart is single-threaded but writes are async, so
  /// two interleaved commits could otherwise read a stale frontier.
  Future<void> _mutex = Future.value();

  String get deviceId => _clock.deviceId;

  /// Opens a replica on [storage].
  ///
  /// [deviceId] is optional and should usually be omitted. Section 4.3 requires
  /// it to be generated once per device per space and then persisted: a replica
  /// that mints a fresh id on every launch still converges, but every launch
  /// adds a permanent entry to the frontier that every peer then carries
  /// forever.
  ///
  /// The persisted clock already records the deviceId, so it is recovered from
  /// there. On a fresh store an id is generated and written immediately, before
  /// any data op, so the identity survives even if the app is killed before the
  /// first write.
  ///
  /// Passing [deviceId] explicitly is for tests and for restoring a known
  /// identity. It throws if it disagrees with what the store already holds,
  /// because two live replicas sharing one identity breaks HLC uniqueness.
  static Future<SyncEngine> open({
    required StorageAdapter storage,
    int Function()? physicalClock,
  }) async {
    var key = await storage.getDeviceKey();
    if (key == null) {
      // Claim the identity before any data op, so it survives being killed
      // early. Section 4.3.
      key = await generateDeviceKey();
      await storage.setDeviceKey(key);
    }

    final persisted = await storage.getClock();
    final clock = HybridLogicalClock(
      deviceId: deviceIdFromPublicKey(key.publicKey),
      physicalClock: physicalClock,
      millis: persisted?.millis ?? 0,
      counter: persisted?.counter ?? 0,
    );
    final engine = SyncEngine._(storage, clock, key);

    if (persisted == null) {
      await storage.applyBatch(BatchWrite(
        ops: const [],
        winners: const {},
        frontier: await storage.getFrontier(),
        clock: clock.state,
      ));
    }

    return engine;
  }

  // ---------- reads ----------

  Future<RowData?> get(String table, String row) async {
    final cells = await _storage.getRow(table, row);
    if (cells == null) return null;
    return _materialize(row, cells);
  }

  Future<List<RowData>> list(String table) async {
    final out = <RowData>[];
    for (final row in await _storage.listRows(table)) {
      final cells = await _storage.getRow(table, row);
      if (cells == null) continue;
      final data = _materialize(row, cells);
      if (data != null) out.add(data);
    }
    return out;
  }

  /// Whole materialized state, shaped like the conformance vectors'
  /// `expectedState`.
  Future<Map<String, Map<String, Map<String, Object?>>>> dump() async {
    final out = <String, Map<String, Map<String, Object?>>>{};
    for (final table in await _storage.listTables()) {
      for (final row in await _storage.listRows(table)) {
        final cells = await _storage.getRow(table, row);
        if (cells == null) continue;
        final data = _materialize(row, cells);
        if (data == null) continue;
        final copy = Map<String, Object?>.of(data)..remove('id');
        (out[table] ??= {})[row] = copy;
      }
    }
    return out;
  }

  /// Section 5. Returns null when the row is invisible: tombstoned, or with
  /// no surviving cells.
  RowData? _materialize(String row, Map<String, Op> cells) {
    final tomb = cells[tombstoneColumn];
    if (tomb != null && tomb.value == true) return null;

    final data = <String, Object?>{'id': row};
    for (final entry in cells.entries) {
      if (entry.key == tombstoneColumn) continue;
      // A winning null clears the cell; the column disappears from the row.
      if (entry.value.value == null) continue;
      data[entry.key] = entry.value.value;
    }
    return data.length == 1 ? null : data;
  }

  Future<Frontier> frontier() => _storage.getFrontier();

  Future<List<Op>> opsSince(Frontier frontier) => _storage.opsSince(frontier);

  // ---------- writes ----------

  Future<String> insert(String table, Map<String, Object?> values) async {
    final row = ulid(_clock.state.millis == 0 ? null : _clock.state.millis);
    await update(table, row, values);
    return row;
  }

  /// One op per column. Section 3.
  Future<void> update(String table, String row, Map<String, Object?> values) =>
      _locked(() async {
        final ops = <Op>[];
        for (final entry in values.entries) {
          ops.add(await _makeLocalOp(table, row, entry.key, entry.value));
        }
        await _commit(ops, 'local');
      });

  /// Row tombstone. Section 5.
  Future<void> delete(String table, String row) => _locked(() async {
        await _commit([await _makeLocalOp(table, row, tombstoneColumn, true)], 'local');
      });

  Future<Op> _makeLocalOp(
      String table, String row, String column, Object? value) async {
    final hlc = _clock.now().encode();
    // Encrypt-then-sign would apply here if a cipher were configured; the
    // signature always covers whatever `value` holds by then. Section 12.
    final payload = signedPayload(
      id: hlc,
      table: table,
      row: row,
      column: column,
      value: value,
      hlc: hlc,
      device: _clock.deviceId,
    );
    final op = Op(
      id: hlc,
      table: table,
      row: row,
      column: column,
      value: value,
      hlc: hlc,
      device: _clock.deviceId,
      sig: await signPayload(payload, _deviceKey.privateKey),
    );
    op.validate();
    return op;
  }

  /// Apply ops from a peer. Section 6 step 4.
  ///
  /// Validation and the drift check run over the whole batch before anything
  /// is written, so a bad batch leaves no partial state (section 4.5).
  Future<int> applyRemoteOps(List<Object?> raw) => _locked(() async {
        if (raw.length > maxBatchOps) {
          throw BadOpError('batch exceeds $maxBatchOps ops');
        }

        final ops = <Op>[];
        for (final item in raw) {
          final op = item is Op ? item : Op.fromJson(item);
          if (item is Op) op.validate();

          // Signature first: an unauthenticated peer must not be able to
          // provoke a clock error, and a forged op must never reach storage.
          final publicKey = _keys[op.device];
          if (publicKey == null) {
            throw BadOpError('unknown device ${op.device}; no key to verify against');
          }
          if (!await verifyOp(op, publicKey)) {
            throw BadOpError('bad signature on op ${op.id}');
          }

          // Throws ClockDriftError, failing the batch before any write.
          _clock.receive(Hlc.decode(op.hlc));
          ops.add(op);
        }

        return _commit(ops, 'remote');
      });

  /// Section 5. Idempotent: ops already in the log are skipped.
  Future<int> _commit(List<Op> ops, String origin) async {
    if (ops.isEmpty) return 0;

    var frontier = await _storage.getFrontier();
    final fresh = <Op>[];
    final winners = <CellKey, Op>{};
    final changed = <String, RowChange>{};

    for (final op in ops) {
      if (await _storage.hasOp(op.id)) continue;
      if (fresh.any((o) => o.id == op.id)) continue;

      fresh.add(op);
      frontier = advanceFrontier(frontier, op);

      final key = CellKey(op.table, op.row, op.column);
      // Compare against the current winner, and against any earlier op in
      // this same batch, since a batch may contain several writes to one cell.
      final current = winners[key] ?? await _storage.getWinner(op.table, op.row, op.column);
      if (current == null || op.hlc.compareTo(current.hlc) > 0) {
        winners[key] = op;
        changed['${op.table} ${op.row}'] = RowChange(op.table, op.row);
      }
    }

    if (fresh.isEmpty) return 0;

    await _storage.applyBatch(BatchWrite(
      ops: fresh,
      winners: winners,
      frontier: frontier,
      clock: origin == 'local' ? _clock.state : _clock.state,
    ));

    final event = ChangeEvent(
      changes: changed.values.toList(),
      ops: fresh,
      origin: origin,
    );
    for (final sub in List.of(_subscribers)) {
      sub(event);
    }
    return fresh.length;
  }

  Future<T> _locked<T>(Future<T> Function() body) {
    final result = _mutex.then((_) => body());
    _mutex = result.then<void>((_) {}, onError: (_) {});
    return result;
  }

  // ---------- compaction (section 9) ----------

  /// Records what a peer has told us it holds, which is what the horizon is
  /// computed from. Called by the replicator on `since` and `ack`.
  Future<void> recordPeerFrontier(String peer, Frontier frontier) =>
      _storage.setPeerFrontier(peer, frontier);

  /// Reclaims superseded ops, and optionally whole tombstoned rows.
  ///
  /// Never changes what a reader sees: it drops ops that can no longer affect
  /// materialization, and nothing else. That invariant is what the conformance
  /// vectors assert hardest.
  Future<CompactionStats> compact([CompactionOptions? options]) =>
      _locked(() async {
        final opts = options ?? const CompactionOptions();
        final ops = await _storage.allOps();
        final own = await _storage.getFrontier();
        final peers = await _storage.getPeerFrontiers();

        final winners = <String, Op>{};
        for (final table in await _storage.listTables()) {
          for (final row in await _storage.listRows(table)) {
            final cells = await _storage.getRow(table, row);
            if (cells == null) continue;
            cells.forEach((column, op) => winners['$table $row $column'] = op);
          }
        }

        final plan = planCompaction(
          ops,
          winners,
          compactionHorizon(own, peers),
          opts,
        );

        if (!opts.dryRun && plan.opIds.isNotEmpty) {
          await _storage.compact(
            plan.opIds,
            [for (final c in plan.cellKeys) CellKey(c.table, c.row, c.column)],
          );
        }

        return CompactionStats(
          scanned: plan.stats.scanned,
          removed: plan.stats.removed,
          rowsReclaimed: plan.stats.rowsReclaimed,
          retainedWinners: plan.stats.retainedWinners,
          retainedAboveHorizon: plan.stats.retainedAboveHorizon,
          blockedBy: blockingPeers(own, peers),
        );
      });

  Future<int> opCount() => _storage.opCount();

  // ---------- subscriptions ----------

  /// Called after every committed batch, local or remote.
  /// Returns an unsubscribe function.
  void Function() subscribe(void Function(ChangeEvent) cb) {
    _subscribers.add(cb);
    return () => _subscribers.remove(cb);
  }
}

