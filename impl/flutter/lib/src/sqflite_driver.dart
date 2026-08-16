/// sqflite behind the driver seam — PROTOCOL.md section 8.
///
/// SqliteAdapter in the pure Dart package holds all the logic and is already
/// verified against the conformance vectors; this file only teaches it to
/// speak sqflite, so there is nothing here that a vector could test.
library;

import 'package:sqflite/sqflite.dart' as sqflite;
import 'package:tangentfeed/tangentfeed.dart';

class SqfliteDriver implements SqliteDriver {
  SqfliteDriver(this._db);

  /// Opens a database at an absolute [path].
  static Future<SqfliteDriver> open(String path) async {
    final db = await sqflite.openDatabase(path, version: 1);
    return SqfliteDriver(db);
  }

  /// Opens [name] in the platform's default database directory.
  ///
  /// The usual entry point on a device, where you want persistence but do not
  /// care where the file lands.
  static Future<SqfliteDriver> openNamed(String name) async {
    final dir = await sqflite.getDatabasesPath();
    return open('$dir/$name');
  }

  final sqflite.DatabaseExecutor _db;

  @override
  Future<void> execute(String sql, [List<Object?> params = const []]) =>
      _db.execute(sql, params.isEmpty ? null : params);

  @override
  Future<List<Map<String, Object?>>> query(String sql,
      [List<Object?> params = const []]) =>
      _db.rawQuery(sql, params.isEmpty ? null : params);

  @override
  Future<T> transaction<T>(Future<T> Function(SqliteDriver txn) body) {
    final db = _db;
    if (db is! sqflite.Database) {
      // Already inside a transaction; sqflite does not nest, and re-entering
      // would silently commit early.
      return body(this);
    }
    return db.transaction((txn) => body(SqfliteDriver(txn)));
  }

  @override
  Future<void> close() async {
    final db = _db;
    if (db is sqflite.Database) await db.close();
  }
}
