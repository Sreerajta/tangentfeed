/// Runs the shared conformance vectors against the Dart implementation.
///
/// The vectors are read from ../../conformance directly rather than copied, so
/// this implementation cannot drift from the contract the TypeScript one is
/// held to.
library;

import 'dart:convert';
import 'dart:io';

import 'package:test/test.dart';
import 'package:tangentfeed/tangentfeed.dart';

final _root = Directory.current.path.endsWith('impl/dart')
    ? '../../conformance'
    : 'impl/dart/../../conformance';

Map<String, dynamic> _load(String relative) =>
    jsonDecode(File('$_root/$relative').readAsStringSync()) as Map<String, dynamic>;

List<String> _files(String dir) =>
    (Directory('$_root/$dir').listSync().whereType<File>().toList()
          ..sort((a, b) => a.path.compareTo(b.path)))
        .where((f) => f.path.endsWith('.json'))
        .map((f) => f.path.split('/').last)
        .toList();

void main() {
  group('milestone 1 — HLC (section 4)', () {
    final encoding = _load('hlc/01-encoding.json');

    for (final c in encoding['encode'] as List) {
      final h = c['hlc'] as Map<String, dynamic>;
      final hlc = Hlc(h['millis'] as int, h['counter'] as int, h['deviceId'] as String);

      test('encodes: ${c['description']}', () {
        expect(hlc.encode(), equals(c['expected']));
      });

      test('round-trips: ${c['description']}', () {
        expect(Hlc.decode(hlc.encode()), equals(hlc));
      });
    }

    for (final c in encoding['compare'] as List) {
      final a = Hlc.decode(c['a'] as String);
      final b = Hlc.decode(c['b'] as String);
      final want = c['expected'] as int;

      test('compares: ${c['description']}', () {
        expect(a.compareTo(b).sign, equals(want));
      });

      test('bytewise order agrees: ${c['description']}', () {
        expect((c['a'] as String).compareTo(c['b'] as String).sign, equals(want));
      });
    }

    for (final c in encoding['invalid'] as List) {
      test('rejects: ${c['description']}', () {
        expect(() => Hlc.decode(c['input'] as String), throwsFormatException);
      });
    }

    final algebra = _load('hlc/02-send-receive.json');
    final deviceId = algebra['deviceId'] as String;

    HybridLogicalClock clockAt(Map<String, dynamic> state, int pt) => HybridLogicalClock(
          deviceId: deviceId,
          millis: state['millis'] as int,
          counter: state['counter'] as int,
          physicalClock: () => pt,
        );

    for (final c in algebra['send'] as List) {
      test('send: ${c['description']}', () {
        final got = clockAt(c['state'] as Map<String, dynamic>, c['pt'] as int).now();
        expect(got.millis, equals((c['expected'] as Map)['millis']));
        expect(got.counter, equals((c['expected'] as Map)['counter']));
      });
    }

    for (final c in algebra['receive'] as List) {
      test('receive: ${c['description']}', () {
        final clock = clockAt(c['state'] as Map<String, dynamic>, c['pt'] as int);
        final r = c['remote'] as Map<String, dynamic>;
        final remote = Hlc(r['millis'] as int, r['counter'] as int, 'ffffffffffffffff');

        if (c['expectedError'] == 'CLOCK_DRIFT') {
          expect(() => clock.receive(remote), throwsA(isA<ClockDriftError>()));
          return;
        }

        final got = clock.receive(remote);
        expect(got.millis, equals((c['expected'] as Map)['millis']));
        expect(got.counter, equals((c['expected'] as Map)['counter']));
        expect(got.compareTo(remote) > 0, isTrue,
            reason: 'receive must yield a clock strictly greater than the remote');
      });
    }
  });

  group('milestone 2 — canonical JSON (section 8.1)', () {
    for (final file in _files('canonical')) {
      final vector = _load('canonical/$file');
      for (final c in vector['cases'] as List) {
        test('${c['description']}', () {
          expect(canonicalJson(c['input']), equals(c['expected']));
        });
      }

      test('$file: idempotent over its own output', () {
        for (final c in vector['cases'] as List) {
          final once = c['expected'] as String;
          expect(canonicalJson(jsonDecode(once)), equals(once));
        }
      });
    }

    test('rejects non-finite numbers', () {
      expect(() => canonicalJson(double.nan), throwsArgumentError);
      expect(() => canonicalJson(double.infinity), throwsArgumentError);
    });
  });

  group('milestone 3 — merge (sections 3, 5)', () {
    // A fixed clock near the vectors' era, so the drift check in section 4.5
    // is deterministic rather than depending on when the suite runs.
    Future<SyncEngine> freshEngine() => SyncEngine.open(
          deviceId: '1234567890abcdef',
          storage: MemoryAdapter(),
          physicalClock: () => 0x018f6e2bffff,
        );

    for (final file in _files('merge')) {
      final vector = _load('merge/$file');
      final ops = (vector['ops'] as List).cast<Object?>();

      // The contract in conformance/README.md: all five orderings must give
      // identical results, because merge is commutative, associative and
      // idempotent.
      final orderings = <String, List<Object?>>{
        'as given': ops,
        'reversed': ops.reversed.toList(),
        'shuffled(1)': _shuffled(ops, 1),
        'shuffled(42)': _shuffled(ops, 42),
        'with duplicates, shuffled(7)': _shuffled([...ops, ...ops], 7),
      };

      orderings.forEach((label, ordered) {
        test('${vector['name']} converges: $label', () async {
          final engine = await freshEngine();
          await engine.applyRemoteOps(ordered);
          expect(await engine.dump(), equals(vector['expectedState']));
          expect(await engine.frontier(), equals(vector['expectedFrontier']));
        });
      });

      test('${vector['name']} converges: one op at a time, shuffled(99)', () async {
        final engine = await freshEngine();
        for (final op in _shuffled(ops, 99)) {
          await engine.applyRemoteOps([op]);
        }
        expect(await engine.dump(), equals(vector['expectedState']));
        expect(await engine.frontier(), equals(vector['expectedFrontier']));
      });
    }
  });

  group('milestone 5 — sync session (section 6)', () {
    for (final file in _files('session')) {
      final vector = _load('session/$file');
      final localOps = (vector['localOps'] as List).cast<Object?>();
      final remoteOps = (vector['remoteOps'] as List).cast<Object?>();

      Future<SyncEngine> engineWith(String device, List<Object?> ops) async {
        final engine = await SyncEngine.open(
          deviceId: device,
          storage: MemoryAdapter(),
          physicalClock: () => 0x018f6e2bffff,
        );
        await engine.applyRemoteOps(ops);
        return engine;
      }

      test('advertises the right frontier', () async {
        final local = await engineWith(vector['localDevice'] as String, localOps);
        expect(await local.frontier(),
            equals((vector['advertisedFrontier'] as Map)['expected']));
      });

      for (final c in vector['diffCases'] as List) {
        test('sends the right ops: ${c['description']}', () async {
          final local = await engineWith(vector['localDevice'] as String, localOps);
          final sent = await local.opsSince(
              (c['peerFrontier'] as Map).cast<String, String>());
          final got = sent.map((o) => o.id).toList()..sort();
          final want = (c['expectedOpIds'] as List).cast<String>().toList()..sort();
          expect(got, equals(want));
        });
      }

      test('converges after applying remote ops', () async {
        final after = vector['afterApplyingRemote'] as Map;
        final local = await engineWith(vector['localDevice'] as String, localOps);
        await local.applyRemoteOps(remoteOps);
        expect(await local.dump(), equals(after['expectedState']));
        expect(await local.frontier(), equals(after['expectedFrontier']));
      });

      test('both peers reach the same state regardless of order', () async {
        final a = await engineWith(vector['localDevice'] as String, localOps);
        await a.applyRemoteOps(remoteOps);
        final b = await engineWith(vector['remoteDevice'] as String, remoteOps);
        await b.applyRemoteOps(localOps);
        expect(await b.dump(), equals(await a.dump()));
        expect(await b.frontier(), equals(await a.frontier()));
      });

      test('replaying the exchange changes nothing', () async {
        final after = vector['afterApplyingRemote'] as Map;
        final local = await engineWith(vector['localDevice'] as String, localOps);
        await local.applyRemoteOps(remoteOps);
        final once = await local.dump();
        await local.applyRemoteOps(remoteOps);
        await local.applyRemoteOps(localOps);
        expect(await local.dump(), equals(once));
        expect(await local.frontier(), equals(after['expectedFrontier']));
      });
    }
  });
}

/// Deterministic shuffle, so a failure is reproducible.
List<Object?> _shuffled(List<Object?> input, int seed) {
  final a = List<Object?>.of(input);
  var s = seed;
  for (var i = a.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) % 2147483648;
    final j = s % (i + 1);
    final tmp = a[i];
    a[i] = a[j];
    a[j] = tmp;
  }
  return a;
}
