/// Widget bindings, driven headlessly.
///
/// No transport and no platform channels: openSpace over MemoryAdapter is pure
/// Dart, so the whole reactive path can be exercised in `flutter test`.
library;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tangentfeed/tangentfeed.dart';
import 'package:tangentfeed_flutter/tangentfeed_flutter.dart';

/// Streams settle a microtask after a write, so a plain pump is not enough.
Future<void> sync(WidgetTester tester) async {
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 10));
}

Widget wrap(Space space, Widget child) => TangentfeedScope(
      space: space,
      child: MaterialApp(home: Scaffold(body: child)),
    );

void main() {
  late Space db;

  setUp(() async {
    db = await openSpace(space: 'widget-test', storage: MemoryAdapter());
  });

  tearDown(() async => db.close());

  group('RowsBuilder', () {
    testWidgets('renders rows that already exist', (tester) async {
      await db.insert('tasks', {'title': 'already here'});

      await tester.pumpWidget(wrap(
        db,
        RowsBuilder(
          table: 'tasks',
          builder: (context, rows) => Column(
            children: [for (final r in rows) Text('${r['title']}')],
          ),
        ),
      ));
      await sync(tester);

      expect(find.text('already here'), findsOneWidget);
    });

    testWidgets('rebuilds when a row is added', (tester) async {
      await tester.pumpWidget(wrap(
        db,
        RowsBuilder(
          table: 'tasks',
          builder: (context, rows) => Text('${rows.length} tasks'),
        ),
      ));
      await sync(tester);
      expect(find.text('0 tasks'), findsOneWidget);

      await db.insert('tasks', {'title': 'new'});
      await sync(tester);

      expect(find.text('1 tasks'), findsOneWidget);
    });

    testWidgets('rebuilds when a row is deleted', (tester) async {
      final id = await db.insert('tasks', {'title': 'doomed'});

      await tester.pumpWidget(wrap(
        db,
        RowsBuilder(
          table: 'tasks',
          builder: (context, rows) => Text('${rows.length} tasks'),
        ),
      ));
      await sync(tester);
      expect(find.text('1 tasks'), findsOneWidget);

      await db.delete('tasks', id);
      await sync(tester);

      expect(find.text('0 tasks'), findsOneWidget);
    });

    testWidgets('does not rebuild for an unrelated table', (tester) async {
      var builds = 0;
      await tester.pumpWidget(wrap(
        db,
        RowsBuilder(
          table: 'tasks',
          builder: (context, rows) {
            builds++;
            return Text('${rows.length}');
          },
        ),
      ));
      await sync(tester);
      final before = builds;

      await db.insert('notes', {'body': 'unrelated'});
      await sync(tester);

      expect(builds, equals(before));
    });

    testWidgets('an explicit space wins over the scope', (tester) async {
      final other = await openSpace(space: 'other', storage: MemoryAdapter());
      await other.insert('tasks', {'title': 'from the explicit space'});

      await tester.pumpWidget(wrap(
        db, // scope holds db, but the widget is told to use `other`
        RowsBuilder(
          space: other,
          table: 'tasks',
          builder: (context, rows) => Text(
            rows.isEmpty ? 'empty' : '${rows.single['title']}',
          ),
        ),
      ));
      await sync(tester);

      expect(find.text('from the explicit space'), findsOneWidget);
      await other.close();
    });

    testWidgets('switching table re-subscribes', (tester) async {
      await db.insert('tasks', {'title': 't'});
      await db.insert('notes', {'body': 'n1'});
      await db.insert('notes', {'body': 'n2'});

      Widget build(String table) => wrap(
            db,
            RowsBuilder(
              table: table,
              builder: (context, rows) => Text('${rows.length}'),
            ),
          );

      await tester.pumpWidget(build('tasks'));
      await sync(tester);
      expect(find.text('1'), findsOneWidget);

      await tester.pumpWidget(build('notes'));
      await sync(tester);
      expect(find.text('2'), findsOneWidget);
    });
  });

  group('RowBuilder', () {
    testWidgets('follows one row, and reports null once deleted', (tester) async {
      final id = await db.insert('tasks', {'title': 'watch me'});

      await tester.pumpWidget(wrap(
        db,
        RowBuilder(
          table: 'tasks',
          row: id,
          builder: (context, row) => Text(row == null ? 'gone' : '${row['title']}'),
        ),
      ));
      await sync(tester);
      expect(find.text('watch me'), findsOneWidget);

      await db.update('tasks', id, {'title': 'renamed'});
      await sync(tester);
      expect(find.text('renamed'), findsOneWidget);

      await db.delete('tasks', id);
      await sync(tester);
      expect(find.text('gone'), findsOneWidget);
    });
  });

  group('TangentfeedScope', () {
    testWidgets('of() returns the space', (tester) async {
      late Space found;
      await tester.pumpWidget(wrap(
        db,
        Builder(builder: (context) {
          found = TangentfeedScope.of(context);
          return const SizedBox.shrink();
        }),
      ));
      expect(identical(found, db), isTrue);
    });

    testWidgets('maybeOf() returns null with no scope above', (tester) async {
      Space? found = db;
      await tester.pumpWidget(MaterialApp(
        home: Builder(builder: (context) {
          found = TangentfeedScope.maybeOf(context);
          return const SizedBox.shrink();
        }),
      ));
      expect(found, isNull);
    });
  });
}
