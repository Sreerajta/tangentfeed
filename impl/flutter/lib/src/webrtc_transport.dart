/// WebRTC transport — PROTOCOL.md section 6 over real DataChannels.
///
/// Wire-compatible with the TypeScript transport, which matters because the
/// two must interoperate:
///
///   - signaling is the blind relay in packages/signaling-server: `join`,
///     `peers`, `peer-joined`, `peer-left`, `signal`
///   - the DataChannel label is `tangentfeed`
///   - the LOWER deviceId is the initiator; it creates the channel and the
///     offer. Deriving the role from the ids rather than negotiating it is
///     what avoids a glare handshake.
library;

import 'dart:async';
import 'dart:convert';

import 'package:flutter_webrtc/flutter_webrtc.dart';
import 'package:tangentfeed/tangentfeed.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

const String _channelLabel = 'tangentfeed';

class _Peer {
  _Peer(this.connection);
  final RTCPeerConnection connection;
  RTCDataChannel? channel;
  bool get isOpen => channel?.state == RTCDataChannelState.RTCDataChannelOpen;
}

class WebRTCTransport implements Transport {
  WebRTCTransport({
    required this.space,
    required this.deviceId,
    required this.signalingUrl,
    List<Map<String, dynamic>>? iceServers,
  }) : _iceServers = iceServers ??
            const [
              {'urls': 'stun:stun.l.google.com:19302'},
            ];

  final String space;
  final String deviceId;
  final String signalingUrl;
  final List<Map<String, dynamic>> _iceServers;

  final Map<String, _Peer> _peers = {};
  final _incoming =
      StreamController<({String from, Map<String, Object?> message})>.broadcast();
  final _connected = StreamController<String>.broadcast();

  WebSocketChannel? _signaling;
  StreamSubscription<dynamic>? _signalingSub;

  @override
  List<String> get connectedPeers =>
      [for (final e in _peers.entries) if (e.value.isOpen) e.key];

  @override
  Stream<({String from, Map<String, Object?> message})> get incoming => _incoming.stream;

  @override
  Stream<String> get peerConnected => _connected.stream;

  Future<void> start() async {
    final socket = WebSocketChannel.connect(Uri.parse(signalingUrl));
    _signaling = socket;
    await socket.ready;

    _signalingSub = socket.stream.listen(
      (raw) => _onSignal(jsonDecode(raw as String) as Map<String, dynamic>),
      onError: (Object _) {},
    );

    _signalSend({'t': 'join', 'space': space, 'device': deviceId});
  }

  void _signalSend(Map<String, Object?> message) =>
      _signaling?.sink.add(jsonEncode(message));

  Future<void> _onSignal(Map<String, dynamic> msg) async {
    switch (msg['t']) {
      case 'peers':
        for (final d in (msg['devices'] as List).cast<String>()) {
          await _ensurePeer(d);
        }
      case 'peer-joined':
        await _ensurePeer(msg['device'] as String);
      case 'peer-left':
        await _dropPeer(msg['device'] as String);
      case 'signal':
        await _onPeerSignal(msg['from'] as String, msg['data'] as Map<String, dynamic>);
    }
  }

  /// The lower deviceId initiates. Both sides compute this identically, so
  /// exactly one offer is created and there is no glare to resolve.
  bool _isInitiator(String remote) => deviceId.compareTo(remote) < 0;

  Future<_Peer> _ensurePeer(String remote) async {
    final existing = _peers[remote];
    if (existing != null) return existing;

    final connection = await createPeerConnection({
      'iceServers': _iceServers,
      'sdpSemantics': 'unified-plan',
    });
    final peer = _Peer(connection);
    _peers[remote] = peer;

    connection.onIceCandidate = (candidate) {
      _signalSend({
        't': 'signal',
        'to': remote,
        'data': {
          'candidate': {
            'candidate': candidate.candidate,
            'sdpMid': candidate.sdpMid,
            'sdpMLineIndex': candidate.sdpMLineIndex,
          }
        },
      });
    };

    if (_isInitiator(remote)) {
      final channel = await connection.createDataChannel(
        _channelLabel,
        RTCDataChannelInit()..ordered = true,
      );
      _attach(remote, peer, channel);

      final offer = await connection.createOffer();
      await connection.setLocalDescription(offer);
      _signalSend({
        't': 'signal',
        'to': remote,
        'data': {
          'sdp': {'type': offer.type, 'sdp': offer.sdp}
        },
      });
    } else {
      connection.onDataChannel = (channel) => _attach(remote, peer, channel);
    }

    return peer;
  }

  void _attach(String remote, _Peer peer, RTCDataChannel channel) {
    peer.channel = channel;
    channel.onDataChannelState = (state) {
      if (state == RTCDataChannelState.RTCDataChannelOpen) {
        // The replicator starts catch-up from here, which is what makes a
        // late joiner receive everything written before it arrived.
        _connected.add(remote);
      }
    };
    channel.onMessage = (message) {
      if (!message.isBinary) {
        _incoming.add((
          from: remote,
          message: jsonDecode(message.text) as Map<String, Object?>,
        ));
      }
    };
  }

  Future<void> _onPeerSignal(String remote, Map<String, dynamic> data) async {
    final peer = await _ensurePeer(remote);

    if (data['sdp'] != null) {
      final sdp = data['sdp'] as Map<String, dynamic>;
      await peer.connection.setRemoteDescription(
        RTCSessionDescription(sdp['sdp'] as String, sdp['type'] as String),
      );
      if (sdp['type'] == 'offer') {
        final answer = await peer.connection.createAnswer();
        await peer.connection.setLocalDescription(answer);
        _signalSend({
          't': 'signal',
          'to': remote,
          'data': {
            'sdp': {'type': answer.type, 'sdp': answer.sdp}
          },
        });
      }
      return;
    }

    if (data['candidate'] != null) {
      final c = data['candidate'] as Map<String, dynamic>;
      await peer.connection.addCandidate(RTCIceCandidate(
        c['candidate'] as String?,
        c['sdpMid'] as String?,
        c['sdpMLineIndex'] as int?,
      ));
    }
  }

  Future<void> _dropPeer(String remote) async {
    final peer = _peers.remove(remote);
    if (peer == null) return;
    await peer.channel?.close();
    await peer.connection.close();
  }

  @override
  Future<void> send(Map<String, Object?> message, {String? peer}) async {
    final payload = jsonEncode(message);
    for (final entry in _peers.entries) {
      if (peer != null && entry.key != peer) continue;
      if (!entry.value.isOpen) continue;
      await entry.value.channel!.send(RTCDataChannelMessage(payload));
    }
  }

  @override
  Future<void> close() async {
    await _signalingSub?.cancel();
    await _signaling?.sink.close();
    for (final remote in _peers.keys.toList()) {
      await _dropPeer(remote);
    }
    await _incoming.close();
    await _connected.close();
  }
}
