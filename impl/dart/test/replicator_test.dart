/// The sync session driven end to end over a transport (section 6).
///
/// session/01-two-party-catchup.json pins which ops a peer owes for a given
/// frontier; this exercises the surrounding protocol — greeting, catch-up,
/// live tail, and the offline-then-reconnect heal that is the whole point of
/// the system.
library;

import 'package:test/test.dart';
import 'package:tangentfeed/tangentfeed.dart';

Future<void> settle() async {
  for (var i = 0; i < 40; i++) {
    await Future<void>.delayed(Duration.zero);
  }
}

class Peer {
  Peer(this.engine, this.transport, this.replicator);

  final SyncEngine engine;
  final LoopbackTransport transport;
  final Replicator replicator;

  static Future<Peer> create([String? _unused]) async {
    final engine = await SyncEngine.open(
      storage: MemoryAdapter(),
    );
    // The transport must carry the engine's derived identity, not a made-up
    // one: `from` on every message is what a peer verifies against.
    final transport = LoopbackTransport(engine.deviceId);
    final replicator = Replicator(
      engine: engine,
      transport: transport,
      space: 'test-space',
    );
    return Peer(engine, transport, replicator);
  }
}

void main() {
  group('sync session over a transport (section 6)', () {
    test('two peers converge on live edits', () async {
      final a = await Peer.create('aaaaaaaaaaaaaaaa');
      final b = await Peer.create('bbbbbbbbbbbbbbbb');
      LoopbackTransport.connect(a.transport, b.transport);
      await a.replicator.start();
      await b.replicator.start();
      await settle();

      final id = await a.engine.insert('tasks', {'title': 'from a'});
      await settle();

      expect((await b.engine.get('tasks', id))!['title'], equals('from a'));
    });

    test('a late joiner receives everything written before it connected', () async {
      final a = await Peer.create('aaaaaaaaaaaaaaaa');
      await a.replicator.start();
      final id = await a.engine.insert('tasks', {'title': 'written alone'});

      final b = await Peer.create('bbbbbbbbbbbbbbbb');
      LoopbackTransport.connect(a.transport, b.transport);
      await b.replicator.start();
      await settle();

      expect((await b.engine.get('tasks', id))!['title'], equals('written alone'));
    });

    test('offline edits on both sides converge after reconnect', () async {
      final a = await Peer.create('aaaaaaaaaaaaaaaa');
      final b = await Peer.create('bbbbbbbbbbbbbbbb');
      LoopbackTransport.connect(a.transport, b.transport);
      await a.replicator.start();
      await b.replicator.start();
      await settle();

      final shared = await a.engine.insert('tasks', {'title': 'shared'});
      await settle();

      // Cut the wire. Both keep writing, which is the case the whole design
      // exists for.
      a.transport.online = false;
      b.transport.online = false;

      await a.engine.update('tasks', shared, {'noteA': 'written offline by a'});
      await b.engine.update('tasks', shared, {'noteB': 'written offline by b'});
      final onlyA = await a.engine.insert('tasks', {'title': 'a alone'});
      final onlyB = await b.engine.insert('tasks', {'title': 'b alone'});
      await settle();

      // Still diverged.
      expect(await b.engine.get('tasks', onlyA), isNull);
      expect(await a.engine.get('tasks', onlyB), isNull);

      a.transport.reconnect();
      b.transport.reconnect();
      await settle();

      final rowA = (await a.engine.get('tasks', shared))!;
      final rowB = (await b.engine.get('tasks', shared))!;
      expect(rowA['noteA'], equals('written offline by a'));
      expect(rowA['noteB'], equals('written offline by b'));
      expect(rowB, equals(rowA), reason: 'both replicas must agree');

      expect((await b.engine.get('tasks', onlyA))!['title'], equals('a alone'));
      expect((await a.engine.get('tasks', onlyB))!['title'], equals('b alone'));
      expect(await a.engine.frontier(), equals(await b.engine.frontier()));
    });

    test('concurrent edits to one cell resolve the same way on both sides', () async {
      final a = await Peer.create('aaaaaaaaaaaaaaaa');
      final b = await Peer.create('bbbbbbbbbbbbbbbb');
      LoopbackTransport.connect(a.transport, b.transport);
      await a.replicator.start();
      await b.replicator.start();
      await settle();

      final id = await a.engine.insert('tasks', {'title': 'original'});
      await settle();

      a.transport.online = false;
      b.transport.online = false;
      await a.engine.update('tasks', id, {'title': 'a wins or loses'});
      await b.engine.update('tasks', id, {'title': 'b wins or loses'});
      await settle();

      a.transport.reconnect();
      b.transport.reconnect();
      await settle();

      final rowA = (await a.engine.get('tasks', id))!;
      final rowB = (await b.engine.get('tasks', id))!;
      expect(rowA['title'], equals(rowB['title']),
          reason: 'LWW must pick the same winner on both replicas');
    });

    test('a deletion propagates', () async {
      final a = await Peer.create('aaaaaaaaaaaaaaaa');
      final b = await Peer.create('bbbbbbbbbbbbbbbb');
      LoopbackTransport.connect(a.transport, b.transport);
      await a.replicator.start();
      await b.replicator.start();
      await settle();

      final id = await a.engine.insert('tasks', {'title': 'doomed'});
      await settle();
      expect(await b.engine.get('tasks', id), isNotNull);

      await a.engine.delete('tasks', id);
      await settle();
      expect(await b.engine.get('tasks', id), isNull);
    });

    test('a peer in a different space is rejected', () async {
      // Both sides collect errors: whichever peer's hello lands second is the
      // one that reports the mismatch, and that depends on subscribe ordering
      // rather than on anything the protocol guarantees.
      final errors = <Object>[];

      Future<({SyncEngine engine, LoopbackTransport transport, Replicator replicator})>
          make(String space) async {
        final engine = await SyncEngine.open(
          storage: MemoryAdapter(),
        );
        final transport = LoopbackTransport(engine.deviceId);
        final replicator = Replicator(
          engine: engine,
          transport: transport,
          space: space,
          onError: (e, {peer}) => errors.add(e),
        );
        return (engine: engine, transport: transport, replicator: replicator);
      }

      final a = await make('test-space');
      final b = await make('a-different-space');

      LoopbackTransport.connect(a.transport, b.transport);
      await a.replicator.start();
      await b.replicator.start();
      await settle();

      expect(errors, isNotEmpty, reason: 'a space mismatch must be surfaced');
      expect(errors.map((e) => e.toString()).join('\n'), contains('SPACE_MISMATCH'));
    });

    test('unknown message types are ignored, not fatal (section 6.1)', () async {
      final a = await Peer.create('aaaaaaaaaaaaaaaa');
      final b = await Peer.create('bbbbbbbbbbbbbbbb');
      LoopbackTransport.connect(a.transport, b.transport);
      await a.replicator.start();
      await b.replicator.start();
      await settle();

      await a.transport.send({'t': 'something-from-a-newer-version', 'x': 1});
      await settle();

      // Sync still works afterwards.
      final id = await a.engine.insert('tasks', {'title': 'still fine'});
      await settle();
      expect((await b.engine.get('tasks', id))!['title'], equals('still fine'));
    });

    test('three peers form a mesh and converge', () async {
      final a = await Peer.create('aaaaaaaaaaaaaaaa');
      final b = await Peer.create('bbbbbbbbbbbbbbbb');
      final c = await Peer.create('cccccccccccccccc');
      LoopbackTransport.connect(a.transport, b.transport);
      LoopbackTransport.connect(b.transport, c.transport);
      LoopbackTransport.connect(a.transport, c.transport);
      await a.replicator.start();
      await b.replicator.start();
      await c.replicator.start();
      await settle();

      await a.engine.insert('tasks', {'title': 'from a'});
      await b.engine.insert('tasks', {'title': 'from b'});
      await c.engine.insert('tasks', {'title': 'from c'});
      await settle();

      final da = await a.engine.dump();
      expect(await b.engine.dump(), equals(da));
      expect(await c.engine.dump(), equals(da));
      expect((da['tasks'] ?? {}).length, equals(3));
    });
  });
}
