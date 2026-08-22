/// Replica identity — PROTOCOL.md section 4.3.
///
/// deviceId must be generated once per device per space and persisted. A
/// replica that mints a fresh one each launch still converges, so nothing
/// visibly breaks; it just adds a permanent entry to the frontier on every
/// start, which every peer then carries forever. That silence is why this
/// deserves tests.
library;

import 'package:test/test.dart';
import 'package:tangentfeed/tangentfeed.dart';

void main() {
  group('replica identity (section 4.3)', () {
    test('an identity is generated and persisted on a fresh store', () async {
      final storage = MemoryAdapter();
      final engine = await SyncEngine.open(storage: storage);

      expect(isValidDeviceId(engine.deviceId), isTrue);

      // Written immediately, not deferred to the first data op, so the
      // identity survives being killed before anything is stored.
      expect((await storage.getClock())?.deviceId, equals(engine.deviceId));
      expect(await storage.opCount(), equals(0));
    });

    test('reopening the same storage keeps the same identity', () async {
      final storage = MemoryAdapter();
      final first = await SyncEngine.open(storage: storage);
      await first.insert('tasks', {'title': 'before restart'});

      final second = await SyncEngine.open(storage: storage);
      expect(second.deviceId, equals(first.deviceId));
    });

    test('reopening without writing anything still keeps the identity', () async {
      final storage = MemoryAdapter();
      final first = await SyncEngine.open(storage: storage);
      final second = await SyncEngine.open(storage: storage);
      expect(second.deviceId, equals(first.deviceId));
    });

    test('restarts do not accumulate frontier entries', () async {
      // The actual damage the bug caused: one phantom device per launch,
      // replicated to every peer and never removable.
      final storage = MemoryAdapter();
      for (var i = 0; i < 5; i++) {
        final engine = await SyncEngine.open(storage: storage);
        await engine.insert('tasks', {'title': 'launch $i'});
      }
      final frontier = await storage.getFrontier();
      expect(frontier.keys.length, equals(1),
          reason: 'five launches must leave one device in the frontier');
    });

    test('two separate stores get different identities', () async {
      final a = await SyncEngine.open(storage: MemoryAdapter());
      final b = await SyncEngine.open(storage: MemoryAdapter());
      expect(a.deviceId, isNot(equals(b.deviceId)));
    });



  });

  group('openSpace', () {
    test('opens, writes and reads without any manual wiring', () async {
      final db = await openSpace(space: 'kitchen-42', storage: MemoryAdapter());
      final id = await db.insert('tasks', {'title': 'oat milk', 'done': false});

      expect((await db.get('tasks', id))!['title'], equals('oat milk'));
      expect(await db.list('tasks'), hasLength(1));
      expect(db.peers(), isEmpty);
      await db.close();
    });

    test('keeps its identity across reopen', () async {
      final storage = MemoryAdapter();
      final first = await openSpace(space: 's', storage: storage);
      final id = first.deviceId;
      await first.close();

      final second = await openSpace(space: 's', storage: storage);
      expect(second.deviceId, equals(id));
      await second.close();
    });

    test('two spaces on a loopback pair converge', () async {
      final aTransport = LoopbackTransport('aaaaaaaaaaaaaaaa');
      final bTransport = LoopbackTransport('bbbbbbbbbbbbbbbb');
      LoopbackTransport.connect(aTransport, bTransport);

      final a = await openSpace(
        space: 'shared',
        storage: MemoryAdapter(),
        transports: [({required space, required deviceId}) async => aTransport],
      );
      final b = await openSpace(
        space: 'shared',
        storage: MemoryAdapter(),
        transports: [({required space, required deviceId}) async => bTransport],
      );

      await a.insert('tasks', {'title': 'from a'});
      for (var i = 0; i < 40; i++) {
        await Future<void>.delayed(Duration.zero);
      }

      expect(await b.list('tasks'), hasLength(1));
      expect(b.peers(), isNotEmpty);
      await a.close();
      await b.close();
    });
  });
}
