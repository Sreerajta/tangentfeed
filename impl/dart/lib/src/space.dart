/// The batteries-included entry point.
///
/// Everything here is assembled from the pieces in this package, and all of
/// them stay available: import the engine, a storage adapter and a transport
/// directly if you want to build against the protocol yourself. This exists so
/// the common case is one call rather than seven.
library;

import 'dart:async';

import 'engine.dart';
import 'op.dart';
import 'replicator.dart';
import 'storage.dart';

/// Builds a transport once the space knows its identity.
///
/// A function rather than an instance because a transport needs the deviceId,
/// and the deviceId is not known until storage has been opened.
typedef TransportFactory = Future<Transport> Function({
  required String space,
  required String deviceId,
});

/// A local database that syncs.
class Space {
  Space._(this.engine, this._transports, this._replicators);

  /// The underlying replica, for protocol-level work.
  final SyncEngine engine;

  final List<Transport> _transports;
  final List<Replicator> _replicators;

  String get deviceId => engine.deviceId;

  // ---------- data ----------

  Future<String> insert(String table, Map<String, Object?> values) =>
      engine.insert(table, values);

  Future<void> update(String table, String row, Map<String, Object?> values) =>
      engine.update(table, row, values);

  Future<void> delete(String table, String row) => engine.delete(table, row);

  Future<RowData?> get(String table, String row) => engine.get(table, row);

  Future<List<RowData>> list(String table) => engine.list(table);

  /// Called after every committed change, local or remote. Returns an
  /// unsubscribe function.
  void Function() subscribe(void Function(ChangeEvent) cb) => engine.subscribe(cb);

  /// Every visible row in [table], re-emitted whenever that table changes.
  ///
  /// Emits the current contents immediately on listen, so a UI has something
  /// to paint on first frame. Changes to other tables do not wake it.
  ///
  /// ```dart
  /// StreamBuilder(
  ///   stream: db.watch('tasks'),
  ///   builder: (context, snapshot) => …,
  /// )
  /// ```
  Stream<List<RowData>> watch(String table) =>
      _watch(() => list(table), (event) => event.changes.any((c) => c.table == table));

  /// One row, or null when it is absent or deleted.
  Stream<RowData?> watchRow(String table, String row) => _watch(
        () => get(table, row),
        (event) => event.changes.any((c) => c.table == table && c.row == row),
      );

  /// Shared plumbing: read once on listen, then again on every matching event.
  ///
  /// Reads are serialized behind [_pending] because they are async and a burst
  /// of changes would otherwise race, letting a stale read land last and leave
  /// the UI showing data older than what is stored.
  Stream<T> _watch<T>(Future<T> Function() read, bool Function(ChangeEvent) matches) {
    late StreamController<T> controller;
    void Function()? unsubscribe;
    Future<void> pending = Future.value();

    void schedule() {
      pending = pending.then((_) async {
        if (controller.isClosed) return;
        final value = await read();
        if (!controller.isClosed) controller.add(value);
      }).catchError((Object e, StackTrace s) {
        if (!controller.isClosed) controller.addError(e, s);
      });
    }

    controller = StreamController<T>(
      onListen: () {
        unsubscribe = subscribe((event) {
          if (matches(event)) schedule();
        });
        schedule();
      },
      onCancel: () {
        unsubscribe?.call();
        unsubscribe = null;
      },
    );

    return controller.stream;
  }

  // ---------- sync ----------

  /// deviceIds currently reachable across all transports.
  List<String> peers() {
    final ids = <String>{};
    for (final t in _transports) {
      ids.addAll(t.connectedPeers);
    }
    return ids.toList();
  }

  Future<Frontier> frontier() => engine.frontier();

  Future<void> close() async {
    for (final r in _replicators) {
      await r.stop();
    }
    for (final t in _transports) {
      await t.close();
    }
  }
}

/// Opens a space, wiring storage, identity, transports and replication.
///
/// ```dart
/// final db = await openSpace(
///   space: 'kitchen-42',
///   storage: MemoryAdapter(),
/// );
///
/// await db.insert('tasks', {'title': 'Buy oat milk', 'done': false});
/// db.subscribe((_) async => render(await db.list('tasks')));
/// ```
///
/// [deviceId] is deliberately absent from this signature: identity is derived
/// from [storage] and persisted there, so a restart keeps the same replica
/// rather than minting a new one. See [SyncEngine.open] for why that matters.
Future<Space> openSpace({
  required String space,
  required StorageAdapter storage,
  List<TransportFactory> transports = const [],
  void Function(Object error, {String? peer})? onError,
  int Function()? physicalClock,
}) async {
  final engine = await SyncEngine.open(
    storage: storage,
    physicalClock: physicalClock,
  );

  final built = <Transport>[];
  final replicators = <Replicator>[];

  try {
    for (final make in transports) {
      final transport = await make(space: space, deviceId: engine.deviceId);
      built.add(transport);

      final replicator = Replicator(
        engine: engine,
        transport: transport,
        space: space,
        onError: onError,
      );
      replicators.add(replicator);
      await replicator.start();
    }
  } catch (_) {
    // Never leave half-open transports behind for the caller to find.
    for (final r in replicators) {
      await r.stop();
    }
    for (final t in built) {
      await t.close();
    }
    rethrow;
  }

  return Space._(engine, built, replicators);
}
