/// Milestone 4 against real SQLite, not memory.
///
/// conformance/IMPLEMENTING.md says to re-run the merge vectors against your
/// storage rather than trusting the in-memory adapter, because the failures
/// that matter — atomicity, value round-tripping, ordering — only appear once
/// a real engine is underneath.
library;

import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:sqlite3/sqlite3.dart' as raw;
import 'package:test/test.dart';
import 'package:tangentfeed/tangentfeed.dart';

/// A [SqliteDriver] over package:sqlite3, which is what a Dart server or a
/// desktop Flutter target would use. A mobile Flutter app substitutes sqflite;
/// nothing in SqliteAdapter changes.
class Sqlite3Driver implements SqliteDriver {
  Sqlite3Driver(this._db);

  factory Sqlite3Driver.memory() => Sqlite3Driver(raw.sqlite3.openInMemory());

  final raw.Database _db;

  @override
  Future<void> execute(String sql, [List<Object?> params = const []]) async {
    _db.execute(sql, params);
  }

  @override
  Future<List<Map<String, Object?>>> query(String sql,
      [List<Object?> params = const []]) async {
    final result = _db.select(sql, params);
    return [for (final row in result) Map<String, Object?>.of(row)];
  }

  @override
  Future<T> transaction<T>(Future<T> Function(SqliteDriver txn) body) async {
    _db.execute('BEGIN IMMEDIATE');
    try {
      final out = await body(this);
      _db.execute('COMMIT');
      return out;
    } catch (_) {
      _db.execute('ROLLBACK');
      rethrow;
    }
  }

  @override
  Future<void> close() async => _db.close();
}

final _root = Directory.current.path.endsWith('impl/dart')
    ? '../../conformance'
    : 'impl/dart/../../conformance';

final _testKeys = (jsonDecode(File('$_root/test-keys.json').readAsStringSync())
    as Map<String, dynamic>)['keys'] as Map<String, dynamic>;

Uint8List _unhex(String s) => Uint8List.fromList(
      [for (final m in RegExp('..').allMatches(s)) int.parse(m.group(0)!, radix: 16)],
    );

void learnTestKeys(SyncEngine engine) {
  _testKeys.forEach((id, k) {
    engine.learnKey(id, _unhex((k as Map<String, dynamic>)['publicKey'] as String));
  });
}

void main() {
  group('milestone 4 — SQLite storage (section 8)', () {
    late SqliteAdapter adapter;

    setUp(() async {
      adapter = await SqliteAdapter.open(Sqlite3Driver.memory());
    });

    tearDown(() async => adapter.close());

    // The same vectors that milestone 3 runs against MemoryAdapter.
    final files = (Directory('$_root/merge').listSync().whereType<File>().toList()
          ..sort((a, b) => a.path.compareTo(b.path)))
        .where((f) => f.path.endsWith('.json'));

    for (final file in files) {
      final vector = jsonDecode(file.readAsStringSync()) as Map<String, dynamic>;

      test('${vector['name']} converges on SQLite', () async {
        final engine = await SyncEngine.open(
          storage: adapter,
          physicalClock: () => 0x018f6e2bffff,
        );
        learnTestKeys(engine);
        await engine.applyRemoteOps((vector['ops'] as List).cast<Object?>());
        expect(await engine.dump(), equals(vector['expectedState']));
        expect(await engine.frontier(), equals(vector['expectedFrontier']));
      });

      test('${vector['name']} converges on SQLite, reversed and duplicated', () async {
        final engine = await SyncEngine.open(
          storage: adapter,
          physicalClock: () => 0x018f6e2bffff,
        );
        learnTestKeys(engine);
        final ops = (vector['ops'] as List).cast<Object?>();
        await engine.applyRemoteOps([...ops.reversed, ...ops]);
        expect(await engine.dump(), equals(vector['expectedState']));
        expect(await engine.frontier(), equals(vector['expectedFrontier']));
      });
    }

    test('values survive a round trip through SQL, null included', () async {
      final engine = await SyncEngine.open(
        storage: adapter,
        physicalClock: () => 0x018f6e2bffff,
      );
      learnTestKeys(engine);
      final id = await engine.insert('things', {
        'text': 'hello',
        'number': 42,
        'float': 3.5,
        'flag': false,
        'list': [1, 'two', null],
        'nested': {'a': 1},
      });

      final row = await engine.get('things', id);
      expect(row!['text'], equals('hello'));
      expect(row['number'], equals(42));
      expect(row['float'], equals(3.5));
      expect(row['flag'], equals(false));
      expect(row['list'], equals([1, 'two', null]));
      expect(row['nested'], equals({'a': 1}));
    });

    test('state persists across reopening the adapter', () async {
      final driver = Sqlite3Driver.memory();
      final first = await SqliteAdapter.open(driver);
      final engine = await SyncEngine.open(
        storage: first,
        physicalClock: () => 0x018f6e2bffff,
      );
      learnTestKeys(engine);
      final id = await engine.insert('tasks', {'title': 'persisted'});
      final frontierBefore = await engine.frontier();

      // Same underlying database, a new adapter and engine on top.
      final second = await SqliteAdapter.open(driver);
      final reopened = await SyncEngine.open(
        storage: second,
        physicalClock: () => 0x018f6e2bffff,
      );
      learnTestKeys(engine);

      expect((await reopened.get('tasks', id))!['title'], equals('persisted'));
      expect(await reopened.frontier(), equals(frontierBefore));
    });

    test('a failed batch leaves nothing behind (section 8.2)', () async {
      final driver = _FailingDriver(raw.sqlite3.openInMemory());
      final failing = await SqliteAdapter.open(driver);
      final engine = await SyncEngine.open(
        storage: failing,
        physicalClock: () => 0x018f6e2bffff,
      );
      learnTestKeys(engine);

      driver.failOnCells = true;
      await expectLater(
        engine.insert('tasks', {'title': 'should not survive'}),
        throwsA(anything),
      );

      driver.failOnCells = false;
      expect(await failing.opCount(), equals(0),
          reason: 'the log must roll back with the cells');
      expect(await failing.getFrontier(), isEmpty);
    });
  });
}

/// Injects a failure partway through applyBatch, after the log insert and
/// before the cells land, to prove the transaction actually rolls back.
class _FailingDriver extends Sqlite3Driver {
  _FailingDriver(super.db);

  bool failOnCells = false;

  @override
  Future<void> execute(String sql, [List<Object?> params = const []]) async {
    if (failOnCells && sql.contains('INTO cells')) {
      throw StateError('simulated storage failure');
    }
    return super.execute(sql, params);
  }
}
