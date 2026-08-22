/// The sync session — PROTOCOL.md section 6.
///
/// The transport is any bidirectional message channel; this file contains no
/// networking, which is what lets the session logic be tested over a loopback
/// and then run unchanged over a WebRTC DataChannel.
library;

import 'dart:async';
import 'dart:typed_data';
import 'dart:convert';

import 'engine.dart';
import 'op.dart';

const int wireVersion = 2;

/// Ops per `ops` message. Section 6 recommends <= 500.
const int opsPerMessage = 500;

/// A bidirectional message channel to one or more peers.
///
/// Implementations deliver whole messages; framing is the transport's problem.
abstract class Transport {
  /// Peers currently reachable.
  List<String> get connectedPeers;

  /// Sends [message] to [peer], or to every peer when [peer] is null.
  Future<void> send(Map<String, Object?> message, {String? peer});

  /// Messages arriving from peers, tagged with the sender.
  Stream<({String from, Map<String, Object?> message})> get incoming;

  /// Fires when a peer becomes reachable, so catch-up can start.
  Stream<String> get peerConnected;

  Future<void> close();
}

/// Drives one engine's side of the session over one transport.
class Replicator {
  Replicator({
    required this.engine,
    required this.transport,
    required this.space,
    this.onError,
  });

  final SyncEngine engine;
  final Transport transport;
  final String space;
  final void Function(Object error, {String? peer})? onError;

  final Map<String, Frontier> _peerFrontiers = {};
  StreamSubscription<void>? _incomingSub;
  StreamSubscription<String>? _connectedSub;
  void Function()? _unsubscribeEngine;

  List<String> get peerIds => _peerFrontiers.keys.toList();

  /// Frontier last advertised by [peer], which is what compaction needs to
  /// know how far behind the slowest peer is.
  Frontier? frontierOf(String peer) => _peerFrontiers[peer];

  Future<void> start() async {
    _incomingSub = transport.incoming.listen((event) {
      _handle(event.from, event.message).catchError((Object e) {
        onError?.call(e, peer: event.from);
      });
    });

    _connectedSub = transport.peerConnected.listen((peer) {
      _greet(peer).catchError((Object e) => onError?.call(e, peer: peer));
    });

    // Live tail: forward local writes as they happen. Remote-origin ops are
    // skipped because the peer that sent them already has them, and echoing
    // would loop.
    _unsubscribeEngine = engine.subscribe((event) {
      if (event.origin != 'local') return;
      _broadcast(event.ops).catchError((Object e) => onError?.call(e));
    });

    for (final peer in transport.connectedPeers) {
      await _greet(peer);
    }
  }

  /// Section 6 steps 1 and 2, sent together: hello is not a gate, so there is
  /// no reason to wait for the peer's before advertising our frontier.
  Future<void> _greet(String peer) async {
    await transport.send({
      't': 'hello',
      'v': wireVersion,
      'space': space,
      'clock': (await engine.frontier())[engine.deviceId] ?? '',
      'key': _hex(engine.publicKey),
    }, peer: peer);

    // Keys before ops, always: an op from a device whose key the receiver does
    // not hold is rejected (section 12).
    await _sendKeys(peer);

    await transport.send({
      't': 'since',
      'have': await engine.frontier(),
    }, peer: peer);
  }

  Future<void> _handle(String peer, Map<String, Object?> message) async {
    switch (message['t']) {
      case 'hello':
        if (message['space'] != space) {
          throw StateError('SPACE_MISMATCH: peer is in space ${message['space']}');
        }
        final key = message['key'];
        if (key is String) engine.learnKey(peer, _unhex(key));

        final isNew = !_peerFrontiers.containsKey(peer);
        _peerFrontiers.putIfAbsent(peer, () => <String, String>{});

        // Greet back the first time we hear from someone. Our own hello may
        // have been sent before they were listening — which is the normal case
        // when one peer starts first — and without this they would never learn
        // our key and would reject every op we send.
        if (isNew) await _greet(peer);

      case 'keys':
        final entries = (message['keys'] as Map?) ?? const {};
        for (final e in entries.entries) {
          // learnKey discards anything that does not hash to its claimed id,
          // so a peer cannot invent a key for somebody else.
          engine.learnKey(e.key as String, _unhex(e.value as String));
        }

      case 'since':
        final have = (message['have'] as Map?)?.cast<String, String>() ?? {};
        _peerFrontiers[peer] = have;
        await _sendOpsSince(peer, have);

      case 'ops':
        final ops = (message['ops'] as List?) ?? const [];
        if (ops.isNotEmpty) {
          await engine.applyRemoteOps(ops.cast<Object?>());
        }
        // Section 6 step 4. Informational: the sender does not wait for it.
        await transport.send({
          't': 'ack',
          'frontier': await engine.frontier(),
        }, peer: peer);

      case 'ack':
        final frontier = (message['frontier'] as Map?)?.cast<String, String>();
        if (frontier != null) _peerFrontiers[peer] = frontier;

      default:
        // Unknown message types are ignored rather than fatal, so a newer
        // peer can add messages without breaking this one. Section 6.1.
        break;
    }
  }

  Future<void> _sendOpsSince(String peer, Frontier have) async {
    final ops = await engine.opsSince(have);
    if (ops.isNotEmpty) await _sendKeys(peer);
    for (var i = 0; i < ops.length; i += opsPerMessage) {
      final end = (i + opsPerMessage).clamp(0, ops.length);
      await transport.send({
        't': 'ops',
        'ops': [for (final op in ops.sublist(i, end)) op.toJson()],
      }, peer: peer);
    }
  }

  /// Every key we hold, so a peer can verify anything we forward.
  Future<void> _sendKeys(String? peer) async {
    final keys = <String, String>{};
    engine.knownKeys().forEach((id, k) => keys[id] = _hex(k));
    await transport.send({'t': 'keys', 'keys': keys}, peer: peer);
  }

  Future<void> _broadcast(List<Op> ops) async {
    if (ops.isEmpty) return;
    for (var i = 0; i < ops.length; i += opsPerMessage) {
      final end = (i + opsPerMessage).clamp(0, ops.length);
      await transport.send({
        't': 'ops',
        'ops': [for (final op in ops.sublist(i, end)) op.toJson()],
      });
    }
  }

  Future<void> stop() async {
    await _incomingSub?.cancel();
    await _connectedSub?.cancel();
    _unsubscribeEngine?.call();
  }
}

/// Convenience for tests and for a one-shot sync between two local replicas.
Future<void> syncOnce(SyncEngine a, SyncEngine b) async {
  // Keys before ops, mirroring section 6.1.
  a.knownKeys().forEach(b.learnKey);
  b.knownKeys().forEach(a.learnKey);

  final fa = await a.frontier();
  final fb = await b.frontier();
  final aToB = await a.opsSince(fb);
  final bToA = await b.opsSince(fa);
  if (aToB.isNotEmpty) {
    await b.applyRemoteOps([for (final op in aToB) jsonDecode(jsonEncode(op.toJson()))]);
  }
  if (bToA.isNotEmpty) {
    await a.applyRemoteOps([for (final op in bToA) jsonDecode(jsonEncode(op.toJson()))]);
  }
}

String _hex(Uint8List b) =>
    b.map((x) => x.toRadixString(16).padLeft(2, '0')).join();

Uint8List _unhex(String s) => Uint8List.fromList(
      [for (final m in RegExp('..').allMatches(s)) int.parse(m.group(0)!, radix: 16)],
    );
