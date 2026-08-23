/// SQLite storage — PROTOCOL.md section 8.
///
/// Driver-agnostic on purpose, mirroring the TypeScript adapter: this package
/// stays dependency-light and the caller picks the engine. A Flutter app hands
/// in a sqflite-backed driver; tests hand in sqflite_common_ffi; a Dart server
/// could hand in package:sqlite3.
///
/// Section 8.2 is the requirement that matters. [applyBatch] wraps the log
/// append, the cell updates and the frontier advance in one transaction,
/// because a crash between them leaves a replica that disagrees with itself
/// and converges wrongly forever.
library;

import 'dart:convert';

import 'dart:typed_data';

import 'hlc.dart';
import 'signing.dart';
import 'op.dart';
import 'storage.dart';

/// The minimum a SQL engine must offer. Deliberately small so wrapping a new
/// driver is a few lines.
abstract class SqliteDriver {
  Future<void> execute(String sql, [List<Object?> params]);

  Future<List<Map<String, Object?>>> query(String sql, [List<Object?> params]);

  /// Runs [body] inside a transaction that rolls back if it throws.
  ///
  /// Must be a genuine transaction, not a no-op: this is what section 8.2
  /// relies on.
  Future<T> transaction<T>(Future<T> Function(SqliteDriver txn) body);

  Future<void> close();
}

const String _schema = '''
CREATE TABLE IF NOT EXISTS ops (
  id          TEXT PRIMARY KEY,
  table_name  TEXT NOT NULL,
  row_id      TEXT NOT NULL,
  column_name TEXT NOT NULL,
  value       TEXT NOT NULL,
  hlc         TEXT NOT NULL,
  device      TEXT NOT NULL,
  sig         TEXT NOT NULL    -- base64 Ed25519, section 12
);
''';

const List<String> _schemaExtra = [
  'CREATE INDEX IF NOT EXISTS ops_device_hlc ON ops (device, hlc);',
  '''
CREATE TABLE IF NOT EXISTS cells (
  table_name  TEXT NOT NULL,
  row_id      TEXT NOT NULL,
  column_name TEXT NOT NULL,
  op_json     TEXT NOT NULL,
  PRIMARY KEY (table_name, row_id, column_name)
);
''',
  '''
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
''',
];

class SqliteAdapter implements StorageAdapter {
  SqliteAdapter._(this._db);

  final SqliteDriver _db;

  static Future<SqliteAdapter> open(SqliteDriver driver) async {
    await driver.execute(_schema);
    for (final stmt in _schemaExtra) {
      await driver.execute(stmt);
    }
    return SqliteAdapter._(driver);
  }

  // Ops are stored as JSON rather than columns-plus-value so that a value of
  // `null` stays distinguishable from an absent column on the way back out.
  static Map<String, Object?> _decodeOpJson(String json) =>
      jsonDecode(json) as Map<String, Object?>;

  static Op _opFromRow(Map<String, Object?> row) => Op(
        id: row['id']! as String,
        table: row['table_name']! as String,
        row: row['row_id']! as String,
        column: row['column_name']! as String,
        value: _decodeOpJson(row['value']! as String)['v'],
        hlc: row['hlc']! as String,
        device: row['device']! as String,
        sig: row['sig']! as String,
      );

  static String _encodeValue(Object? v) => jsonEncode({'v': v});

  @override
  Future<Map<String, Op>?> getRow(String table, String row) async {
    final rows = await _db.query(
      'SELECT op_json FROM cells WHERE table_name = ? AND row_id = ?',
      [table, row],
    );
    if (rows.isEmpty) return null;
    final out = <String, Op>{};
    for (final r in rows) {
      final op = Op.fromJson(jsonDecode(r['op_json']! as String));
      out[op.column] = op;
    }
    return out;
  }

  @override
  Future<List<String>> listRows(String table) async {
    final rows = await _db.query(
      'SELECT DISTINCT row_id FROM cells WHERE table_name = ? ORDER BY row_id',
      [table],
    );
    return [for (final r in rows) r['row_id']! as String];
  }

  @override
  Future<List<String>> listTables() async {
    final rows = await _db.query(
      'SELECT DISTINCT table_name FROM cells ORDER BY table_name',
    );
    return [for (final r in rows) r['table_name']! as String];
  }

  @override
  Future<bool> hasOp(String id) async {
    final rows = await _db.query('SELECT 1 FROM ops WHERE id = ? LIMIT 1', [id]);
    return rows.isNotEmpty;
  }

  @override
  Future<Op?> getWinner(String table, String row, String column) async {
    final rows = await _db.query(
      'SELECT op_json FROM cells WHERE table_name = ? AND row_id = ? AND column_name = ?',
      [table, row, column],
    );
    if (rows.isEmpty) return null;
    return Op.fromJson(jsonDecode(rows.first['op_json']! as String));
  }

  @override
  Future<List<Op>> opsSince(Frontier frontier) async {
    // Filtering in SQL per device would need a dynamic OR-chain; the log is
    // append-only and the index makes the scan cheap, so filter in Dart and
    // keep the query simple.
    final rows = await _db.query('SELECT * FROM ops ORDER BY hlc');
    final out = <Op>[];
    for (final r in rows) {
      final op = _opFromRow(r);
      if (aboveFrontier(op, frontier)) out.add(op);
    }
    return out;
  }

  @override
  Future<Frontier> getFrontier() async {
    final rows = await _db.query("SELECT value FROM meta WHERE key = 'frontier'");
    if (rows.isEmpty) return {};
    return (jsonDecode(rows.first['value']! as String) as Map).cast<String, String>();
  }

  @override
  Future<DeviceKey?> getDeviceKey() async {
    final rows = await _db.query("SELECT value FROM meta WHERE key = 'deviceKey'");
    if (rows.isEmpty) return null;
    final m = jsonDecode(rows.first['value']! as String) as Map<String, Object?>;
    return DeviceKey(
      publicKey: _unhex(m['publicKey']! as String),
      privateKey: _unhex(m['privateKey']! as String),
    );
  }

  @override
  Future<void> setDeviceKey(DeviceKey key) async {
    // meta values are JSON, which has no byte-array type, so hex rather than
    // an array of numbers: half the size and unambiguous to read back.
    await _db.execute(
      "INSERT INTO meta (key, value) VALUES ('deviceKey', ?) "
      'ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      [
        jsonEncode({
          'publicKey': _hex(key.publicKey),
          'privateKey': _hex(key.privateKey),
        })
      ],
    );
  }

  @override
  Future<Hlc?> getClock() async {
    final rows = await _db.query("SELECT value FROM meta WHERE key = 'clock'");
    if (rows.isEmpty) return null;
    final m = jsonDecode(rows.first['value']! as String) as Map<String, Object?>;
    return Hlc(m['millis']! as int, m['counter']! as int, m['deviceId']! as String);
  }

  @override
  Future<void> applyBatch(BatchWrite batch) => _db.transaction((txn) async {
        for (final op in batch.ops) {
          await txn.execute(
            'INSERT OR IGNORE INTO ops '
            '(id, table_name, row_id, column_name, value, hlc, device, sig) '
            'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            [
              op.id,
              op.table,
              op.row,
              op.column,
              _encodeValue(op.value),
              op.hlc,
              op.device,
              op.sig,
            ],
          );
        }

        for (final entry in batch.winners.entries) {
          await txn.execute(
            'INSERT INTO cells (table_name, row_id, column_name, op_json) '
            'VALUES (?, ?, ?, ?) '
            'ON CONFLICT(table_name, row_id, column_name) '
            'DO UPDATE SET op_json = excluded.op_json',
            [
              entry.key.table,
              entry.key.row,
              entry.key.column,
              jsonEncode(entry.value.toJson()),
            ],
          );
        }

        await txn.execute(
          "INSERT INTO meta (key, value) VALUES ('frontier', ?) "
          'ON CONFLICT(key) DO UPDATE SET value = excluded.value',
          [jsonEncode(batch.frontier)],
        );

        if (batch.clock != null) {
          await txn.execute(
            "INSERT INTO meta (key, value) VALUES ('clock', ?) "
            'ON CONFLICT(key) DO UPDATE SET value = excluded.value',
            [
              jsonEncode({
                'millis': batch.clock!.millis,
                'counter': batch.clock!.counter,
                'deviceId': batch.clock!.deviceId,
              })
            ],
          );
        }
      });

  @override
  Future<Map<String, Frontier>> getPeerFrontiers() async {
    final rows = await _db.query("SELECT value FROM meta WHERE key = 'peers'");
    if (rows.isEmpty) return {};
    final raw = jsonDecode(rows.first['value']! as String) as Map<String, Object?>;
    return {
      for (final e in raw.entries)
        e.key: (e.value! as Map).cast<String, String>(),
    };
  }

  @override
  Future<void> setPeerFrontier(String peer, Frontier frontier) async {
    final current = await getPeerFrontiers();
    current[peer] = frontier;
    await _db.execute(
      "INSERT INTO meta (key, value) VALUES ('peers', ?) "
      'ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      [jsonEncode(current)],
    );
  }

  @override
  Future<void> compact(List<String> opIds, List<CellKey> cellKeys) =>
      // One transaction: dropping ops without their cells, or the reverse,
      // leaves the replica disagreeing with itself. Section 8.2 again.
      _db.transaction((txn) async {
        for (final id in opIds) {
          await txn.execute('DELETE FROM ops WHERE id = ?', [id]);
        }
        for (final c in cellKeys) {
          await txn.execute(
            'DELETE FROM cells WHERE table_name = ? AND row_id = ? AND column_name = ?',
            [c.table, c.row, c.column],
          );
        }
      });

  @override
  Future<int> opCount() async {
    final rows = await _db.query('SELECT COUNT(*) AS n FROM ops');
    return (rows.first['n']! as num).toInt();
  }

  @override
  Future<List<Op>> allOps() async {
    final rows = await _db.query('SELECT * FROM ops ORDER BY hlc');
    return [for (final r in rows) _opFromRow(r)];
  }

  Future<void> close() => _db.close();
}

String _hex(Uint8List b) =>
    b.map((x) => x.toRadixString(16).padLeft(2, '0')).join();

Uint8List _unhex(String s) => Uint8List.fromList(
      [for (final m in RegExp('..').allMatches(s)) int.parse(m.group(0)!, radix: 16)],
    );
