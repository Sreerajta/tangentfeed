/// The batteries-included entry point.
///
/// Everything here is assembled from the pieces in this package, and all of
/// them stay available: import the engine, a storage adapter and a transport
/// directly if you want to build against the protocol yourself. This exists so
/// the common case is one call rather than seven.
library;

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
