/// Compaction conformance vectors (section 9).
///
/// The same file the TypeScript harness runs, so the two implementations
/// reclaim identically or the difference shows up here.
///
/// `does not change what a reader sees` is the assertion that matters.
/// Compaction reclaims storage; one that alters materialized state is a
/// data-loss bug, and every other number is secondary.
library;

import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:test/test.dart';
import 'package:tangentfeed/tangentfeed.dart';

final _root = Directory.current.path.endsWith('impl/dart')
    ? '../../conformance'
    : 'impl/dart/../../conformance';

final _keys = (jsonDecode(File('$_root/test-keys.json').readAsStringSync())
    as Map<String, dynamic>)['keys'] as Map<String, dynamic>;

Uint8List _unhex(String s) => Uint8List.fromList(
      [for (final m in RegExp('..').allMatches(s)) int.parse(m.group(0)!, radix: 16)],
    );

void _learnTestKeys(SyncEngine engine) {
  _keys.forEach((id, k) {
    engine.learnKey(id, _unhex((k as Map<String, dynamic>)['publicKey'] as String));
  });
}

final _suite =
    jsonDecode(File('$_root/compaction/01-compaction.json').readAsStringSync())
        as Map<String, dynamic>;

Future<SyncEngine> _replicaFor(Map<String, dynamic> v) async {
  final engine = await SyncEngine.open(
    storage: MemoryAdapter(),
    physicalClock: () => 0x018f6e2bffff,
  );
  _learnTestKeys(engine);
  await engine.applyRemoteOps((v['ops'] as List).cast<Object?>());
  final peers = (v['peerFrontiers'] as Map).cast<String, dynamic>();
  for (final e in peers.entries) {
    await engine.recordPeerFrontier(e.key, (e.value as Map).cast<String, String>());
  }
  return engine;
}

CompactionOptions _optionsOf(Map<String, dynamic> v) {
  final o = (v['options'] as Map).cast<String, dynamic>();
  return CompactionOptions(
    includeTombstones: (o['includeTombstones'] as bool?) ?? false,
    dryRun: (o['dryRun'] as bool?) ?? false,
  );
}

void main() {
  group('compaction vectors (section 9)', () {
    for (final raw in _suite['vectors'] as List) {
      final v = raw as Map<String, dynamic>;
      final expected = (v['expected'] as Map).cast<String, dynamic>();

      group(v['name'] as String, () {
        test('reclaims what it should', () async {
          final engine = await _replicaFor(v);
          final stats = await engine.compact(_optionsOf(v));

          expect(stats.removed, equals(expected['removed']));
          expect(stats.rowsReclaimed, equals(expected['rowsReclaimed']));
          expect(stats.blockedBy..sort(),
              equals((expected['blockedBy'] as List).cast<String>()..sort()));
        });

        test('leaves the log at the expected size', () async {
          final engine = await _replicaFor(v);
          await engine.compact(_optionsOf(v));
          expect(await engine.opCount(), equals(expected['opCountAfter']));
        });

        test('does not change what a reader sees', () async {
          final engine = await _replicaFor(v);
          final before = await engine.dump();
          await engine.compact(_optionsOf(v));
          expect(await engine.dump(), equals(before));
        });

        test('is idempotent: compacting twice removes nothing more', () async {
          final engine = await _replicaFor(v);
          await engine.compact(_optionsOf(v));
          final afterFirst = await engine.opCount();
          final second = await engine.compact(_optionsOf(v));
          expect(await engine.opCount(), equals(afterFirst));
          if (!_optionsOf(v).dryRun) expect(second.removed, equals(0));
        });

        test('a compacted replica still converges with one that did not', () async {
          // The point of the horizon: a compacted replica must remain a valid
          // sync partner. If it dropped something a peer still needed, here is
          // where it shows.
          final compacted = await _replicaFor(v);
          await compacted.compact(_optionsOf(v));

          final fresh = await _replicaFor(v);
          await fresh.applyRemoteOps(await compacted.opsSince({}));

          expect(await fresh.dump(), equals(await compacted.dump()));
        });
      });
    }
  });
}
