/// Reactive reads.
///
/// These are what a UI binds to, so the properties that matter are: something
/// to paint on the first frame, no wake-ups for unrelated tables, and no stale
/// read landing after a fresher one.
library;

import 'package:test/test.dart';
import 'package:tangentfeed/tangentfeed.dart';

Future<void> settle() async {
  for (var i = 0; i < 20; i++) {
    await Future<void>.delayed(Duration.zero);
  }
}

void main() {
  late Space db;

  setUp(() async {
    db = await openSpace(space: 'watch-test', storage: MemoryAdapter());
  });

  tearDown(() async => db.close());

  group('watch', () {
    test('emits current contents immediately, before any change', () async {
      await db.insert('tasks', {'title': 'already here'});

      final first = await db.watch('tasks').first;
      expect(first, hasLength(1));
      expect(first.single['title'], equals('already here'));
    });

    test('emits an empty list for a table with nothing in it', () async {
      expect(await db.watch('tasks').first, isEmpty);
    });

    test('re-emits when the table changes', () async {
      final seen = <int>[];
      final sub = db.watch('tasks').listen((rows) => seen.add(rows.length));
      await settle();

      await db.insert('tasks', {'title': 'one'});
      await settle();
      await db.insert('tasks', {'title': 'two'});
      await settle();

      expect(seen.last, equals(2));
      await sub.cancel();
    });

    test('ignores changes to other tables', () async {
      var wakeups = 0;
      final sub = db.watch('tasks').listen((_) => wakeups++);
      await settle();
      final afterFirstEmit = wakeups;

      await db.insert('notes', {'body': 'unrelated'});
      await settle();

      expect(wakeups, equals(afterFirstEmit),
          reason: 'a write to notes must not wake a watcher on tasks');
      await sub.cancel();
    });

    test('reflects deletions', () async {
      final id = await db.insert('tasks', {'title': 'doomed'});
      final seen = <int>[];
      final sub = db.watch('tasks').listen((rows) => seen.add(rows.length));
      await settle();

      await db.delete('tasks', id);
      await settle();

      expect(seen.last, equals(0));
      await sub.cancel();
    });

    test('a burst of writes ends on the true final state', () async {
      // Reads are async, so without serialization a stale one could land last
      // and leave the UI showing fewer rows than exist.
      final seen = <int>[];
      final sub = db.watch('tasks').listen((rows) => seen.add(rows.length));
      await settle();

      for (var i = 0; i < 25; i++) {
        await db.insert('tasks', {'title': 'task $i'});
      }
      await settle();

      expect(seen.last, equals(25));
      expect(await db.list('tasks'), hasLength(25));
      await sub.cancel();
    });

    test('cancelling detaches from the engine', () async {
      var wakeups = 0;
      final sub = db.watch('tasks').listen((_) => wakeups++);
      await settle();
      await sub.cancel();

      final after = wakeups;
      await db.insert('tasks', {'title': 'after cancel'});
      await settle();

      expect(wakeups, equals(after));
    });

    test('two watchers on one table both see changes', () async {
      final a = <int>[];
      final b = <int>[];
      final subA = db.watch('tasks').listen((rows) => a.add(rows.length));
      final subB = db.watch('tasks').listen((rows) => b.add(rows.length));
      await settle();

      await db.insert('tasks', {'title': 'shared'});
      await settle();

      expect(a.last, equals(1));
      expect(b.last, equals(1));
      await subA.cancel();
      await subB.cancel();
    });
  });

  group('watchRow', () {
    test('emits the row, then null once it is deleted', () async {
      final id = await db.insert('tasks', {'title': 'watch me'});
      final seen = <RowData?>[];
      final sub = db.watchRow('tasks', id).listen(seen.add);
      await settle();

      expect(seen.last!['title'], equals('watch me'));

      await db.update('tasks', id, {'title': 'renamed'});
      await settle();
      expect(seen.last!['title'], equals('renamed'));

      await db.delete('tasks', id);
      await settle();
      expect(seen.last, isNull);

      await sub.cancel();
    });

    test('ignores changes to other rows of the same table', () async {
      final id = await db.insert('tasks', {'title': 'watched'});
      var wakeups = 0;
      final sub = db.watchRow('tasks', id).listen((_) => wakeups++);
      await settle();
      final after = wakeups;

      await db.insert('tasks', {'title': 'a different row'});
      await settle();

      expect(wakeups, equals(after));
      await sub.cancel();
    });

    test('emits null for a row that does not exist', () async {
      expect(await db.watchRow('tasks', '01HZX3NDEKTSV4RRFFQ69G5FAA').first, isNull);
    });
  });
}
