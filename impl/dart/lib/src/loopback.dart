/// An in-process transport whose wire can be cut.
///
/// Real for the protocol's purposes — messages are JSON-encoded and decoded,
/// so nothing passes by reference — but with no network, which makes it the
/// right place to test offline and reconnect behaviour deterministically.
library;

import 'dart:async';
import 'dart:convert';

import 'replicator.dart';

class LoopbackTransport implements Transport {
  LoopbackTransport(this.deviceId);

  final String deviceId;
  final _incoming = StreamController<({String from, Map<String, Object?> message})>.broadcast();
  final _connected = StreamController<String>.broadcast();
  final List<LoopbackTransport> _peers = [];

  /// Set false to take this replica offline. Queued writes still accumulate
  /// in its log, which is what reconnect then has to reconcile.
  bool online = true;

  /// Connects two transports and announces each to the other.
  static void connect(LoopbackTransport a, LoopbackTransport b) {
    a._peers.add(b);
    b._peers.add(a);
    scheduleMicrotask(() {
      a._connected.add(b.deviceId);
      b._connected.add(a.deviceId);
    });
  }

  @override
  List<String> get connectedPeers => [for (final p in _peers) p.deviceId];

  @override
  Stream<({String from, Map<String, Object?> message})> get incoming => _incoming.stream;

  @override
  Stream<String> get peerConnected => _connected.stream;

  @override
  Future<void> send(Map<String, Object?> message, {String? peer}) async {
    if (!online) return; // the wire is cut; the message is simply lost
    // Round-trip through JSON so nothing is shared by reference between the
    // two replicas, exactly as a real transport would behave.
    final encoded = jsonDecode(jsonEncode(message)) as Map<String, Object?>;
    for (final p in _peers) {
      if (peer != null && p.deviceId != peer) continue;
      if (!p.online) continue;
      p._incoming.add((from: deviceId, message: encoded));
    }
  }

  @override
  Future<void> close() async {
    await _incoming.close();
    await _connected.close();
  }

  /// Re-announces every peer, which is what a reconnect looks like from the
  /// replicator's point of view: steps 2 to 4 run again.
  void reconnect() {
    online = true;
    for (final p in _peers) {
      if (!p.online) continue;
      _connected.add(p.deviceId);
      p._connected.add(deviceId);
    }
  }
}
