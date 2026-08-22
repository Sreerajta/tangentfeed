/// Storage — PROTOCOL.md section 8.
///
/// The protocol mandates capabilities, not an engine. Implement
/// [StorageAdapter] against whatever your platform offers; the one
/// non-negotiable is that [applyBatch] is atomic (section 8.2).
library;

import 'hlc.dart';
import 'signing.dart';
import 'op.dart';

/// One atomic unit of work: log append, cell updates and frontier advance.
///
/// These MUST land together. A crash between the log write and the cell write
/// leaves a replica that disagrees with itself and converges wrongly forever.
class BatchWrite {
  const BatchWrite({
    required this.ops,
    required this.winners,
    required this.frontier,
    this.clock,
  });

  /// New ops to append to the log.
  final List<Op> ops;

  /// Cells whose winning op changed, keyed by (table, row, column).
  final Map<CellKey, Op> winners;

  /// The frontier after applying [ops].
  final Frontier frontier;

  /// Local clock state to persist, when a local write advanced it.
  final Hlc? clock;
}

/// Identity of one cell. Section 8.
class CellKey {
  const CellKey(this.table, this.row, this.column);

  final String table;
  final String row;
  final String column;

  @override
  bool operator ==(Object other) =>
      other is CellKey &&
      other.table == table &&
      other.row == row &&
      other.column == column;

  @override
  int get hashCode => Object.hash(table, row, column);

  @override
  String toString() => '$table/$row/$column';
}

abstract class StorageAdapter {
  /// All winning cells of a row: column to winning op. Null if none.
  Future<Map<String, Op>?> getRow(String table, String row);

  /// Row ids with at least one cell op in this table, including tombstoned.
  Future<List<String>> listRows(String table);

  /// Table names with at least one op.
  Future<List<String>> listTables();

  Future<bool> hasOp(String id);

  Future<Op?> getWinner(String table, String row, String column);

  /// Every stored op strictly above [frontier], ascending by hlc.
  /// Section 6 step 3.
  Future<List<Op>> opsSince(Frontier frontier);

  Future<Frontier> getFrontier();

  Future<Hlc?> getClock();

  /// The device's signing keypair, or null on a fresh store. Section 12.
  ///
  /// Stored in the clear beside the data it protects. On a device this belongs
  /// in Keychain or Keystore; the space secret already carries the same
  /// exposure, so this does not widen it.
  Future<DeviceKey?> getDeviceKey();
  Future<void> setDeviceKey(DeviceKey key);

  /// Atomic, all-or-nothing. Section 8.2.
  Future<void> applyBatch(BatchWrite batch);

  Future<int> opCount();

  /// Every op in the log, ascending by hlc.
  Future<List<Op>> allOps();
}

/// Reference in-memory adapter.
///
/// Not durable, but it is the shortest complete statement of what an adapter
/// has to do, and it is what the conformance vectors run against first.
class MemoryAdapter implements StorageAdapter {
  final Map<String, Op> _log = {};
  final Map<CellKey, Op> _winners = {};
  Frontier _frontier = {};
  Hlc? _clock;
  DeviceKey? _deviceKey;

  @override
  Future<Map<String, Op>?> getRow(String table, String row) async {
    Map<String, Op>? out;
    for (final entry in _winners.entries) {
      if (entry.key.table == table && entry.key.row == row) {
        (out ??= {})[entry.key.column] = entry.value;
      }
    }
    return out;
  }

  @override
  Future<List<String>> listRows(String table) async {
    final rows = <String>{};
    for (final key in _winners.keys) {
      if (key.table == table) rows.add(key.row);
    }
    final list = rows.toList()..sort();
    return list;
  }

  @override
  Future<List<String>> listTables() async {
    final tables = <String>{for (final key in _winners.keys) key.table};
    final list = tables.toList()..sort();
    return list;
  }

  @override
  Future<bool> hasOp(String id) async => _log.containsKey(id);

  @override
  Future<Op?> getWinner(String table, String row, String column) async =>
      _winners[CellKey(table, row, column)];

  @override
  Future<List<Op>> opsSince(Frontier frontier) async {
    final out = _log.values.where((op) => aboveFrontier(op, frontier)).toList();
    out.sort((a, b) => a.hlc.compareTo(b.hlc));
    return out;
  }

  @override
  Future<Frontier> getFrontier() async => Map.of(_frontier);

  @override
  Future<DeviceKey?> getDeviceKey() async => _deviceKey;

  @override
  Future<void> setDeviceKey(DeviceKey key) async => _deviceKey = key;

  @override
  Future<Hlc?> getClock() async => _clock;

  @override
  Future<void> applyBatch(BatchWrite batch) async {
    // Single-threaded and synchronous, so this is trivially atomic. A durable
    // adapter needs a real transaction here.
    for (final op in batch.ops) {
      _log[op.id] = op;
    }
    _winners.addAll(batch.winners);
    _frontier = Map.of(batch.frontier);
    if (batch.clock != null) _clock = batch.clock;
  }

  @override
  Future<int> opCount() async => _log.length;

  @override
  Future<List<Op>> allOps() async {
    final out = _log.values.toList();
    out.sort((a, b) => a.hlc.compareTo(b.hlc));
    return out;
  }
}
