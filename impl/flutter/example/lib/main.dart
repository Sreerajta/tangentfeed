/// Two-peer sync demo.
///
/// Storage differs by platform on purpose: sqflite on a device, so running
/// this on a phone actually exercises that binding, and in-memory on the web,
/// where sqflite does not exist.
library;

import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:flutter/material.dart';
import 'package:tangentfeed/tangentfeed.dart';
import 'package:tangentfeed_flutter/tangentfeed_flutter.dart';

void main() => runApp(const DemoApp());

class DemoApp extends StatelessWidget {
  const DemoApp({super.key});

  @override
  Widget build(BuildContext context) => MaterialApp(
        title: 'tangentfeed',
        theme: ThemeData(colorSchemeSeed: Colors.teal, useMaterial3: true),
        home: const TaskPage(),
      );
}

class TaskPage extends StatefulWidget {
  const TaskPage({super.key});

  @override
  State<TaskPage> createState() => _TaskPageState();
}

class _TaskPageState extends State<TaskPage> {
  /// On the web both peers are on this machine, so localhost is right. On a
  /// phone localhost is the phone, so this has to be edited to your Mac's LAN
  /// address — which is why it is a field and not a constant.
  final _signaling = TextEditingController(text: 'ws://localhost:8787');
  final _space = TextEditingController(text: 'kitchen-42');
  final _input = TextEditingController();

  SyncEngine? _engine;
  WebRTCTransport? _transport;
  Replicator? _replicator;

  List<RowData> _rows = const [];
  String _status = 'not connected';
  final String _storageKind = kIsWeb ? 'memory' : 'sqflite';
  String _deviceId = '';
  bool _connecting = false;

  Future<void> _connect() async {
    if (_connecting || _engine != null) return;
    setState(() {
      _connecting = true;
      _status = 'connecting…';
    });

    try {
      final deviceId = generateDeviceId();
      final space = _space.text.trim();

      // The whole point of the driver seam: identical engine either side.
      final StorageAdapter storage;
      if (kIsWeb) {
        storage = MemoryAdapter();
      } else {
        storage = await SqliteAdapter.open(
          await SqfliteDriver.openNamed('tangentfeed_$space.db'),
        );
      }

      final engine = await SyncEngine.open(deviceId: deviceId, storage: storage);

      final transport = WebRTCTransport(
        space: space,
        deviceId: deviceId,
        signalingUrl: _signaling.text.trim(),
      );

      final replicator = Replicator(
        engine: engine,
        transport: transport,
        space: space,
        onError: (e, {peer}) => _setStatus('error: $e'),
      );

      engine.subscribe((_) => _refresh());

      await transport.start();
      await replicator.start();

      setState(() {
        _engine = engine;
        _transport = transport;
        _replicator = replicator;
        _deviceId = deviceId;
        _connecting = false;
        _status = 'waiting for a peer';
      });

      await _refresh();
      _pollPeers();
    } catch (e) {
      setState(() {
        _connecting = false;
        _status = 'failed: $e';
      });
    }
  }

  /// Peer count lives on the transport rather than the engine, so it is polled.
  void _pollPeers() {
    Future.doWhile(() async {
      await Future<void>.delayed(const Duration(seconds: 1));
      if (!mounted || _transport == null) return false;
      final peers = _transport!.connectedPeers;
      _setStatus(peers.isEmpty
          ? 'waiting for a peer'
          : 'synced with ${peers.length} peer(s)');
      return true;
    });
  }

  void _setStatus(String s) {
    if (mounted && _status != s) setState(() => _status = s);
  }

  Future<void> _refresh() async {
    final engine = _engine;
    if (engine == null) return;
    final rows = await engine.list('tasks');
    if (mounted) setState(() => _rows = rows);
  }

  Future<void> _add() async {
    final title = _input.text.trim();
    if (title.isEmpty || _engine == null) return;
    _input.clear();
    await _engine!.insert('tasks', {'title': title, 'done': false});
    await _refresh();
  }

  Future<void> _toggle(RowData row) async {
    await _engine!.update('tasks', row['id']! as String, {'done': row['done'] != true});
    await _refresh();
  }

  Future<void> _delete(RowData row) async {
    await _engine!.delete('tasks', row['id']! as String);
    await _refresh();
  }

  @override
  void dispose() {
    _replicator?.stop();
    _transport?.close();
    _signaling.dispose();
    _space.dispose();
    _input.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final connected = _engine != null;

    return Scaffold(
      appBar: AppBar(title: const Text('tangentfeed')),
      body: SafeArea(
        child: Column(
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(12, 12, 12, 0),
              child: Column(
                children: [
                  TextField(
                    controller: _signaling,
                    enabled: !connected,
                    keyboardType: TextInputType.url,
                    autocorrect: false,
                    decoration: const InputDecoration(
                      labelText: 'Signaling server',
                      helperText: 'On a phone use your Mac\'s LAN address, not localhost',
                      border: OutlineInputBorder(),
                      isDense: true,
                    ),
                  ),
                  const SizedBox(height: 8),
                  Row(
                    children: [
                      Expanded(
                        child: TextField(
                          controller: _space,
                          enabled: !connected,
                          autocorrect: false,
                          decoration: const InputDecoration(
                            labelText: 'Space',
                            border: OutlineInputBorder(),
                            isDense: true,
                          ),
                        ),
                      ),
                      const SizedBox(width: 8),
                      FilledButton(
                        onPressed: connected || _connecting ? null : _connect,
                        child: Text(connected ? 'Connected' : 'Connect'),
                      ),
                    ],
                  ),
                ],
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(14, 10, 14, 6),
              child: Align(
                alignment: Alignment.centerLeft,
                child: Text(
                  '$_status  ·  storage: $_storageKind'
                  '${_deviceId.isEmpty ? "" : "  ·  device ${_deviceId.substring(0, 6)}"}',
                  style: Theme.of(context).textTheme.bodySmall,
                ),
              ),
            ),
            const Divider(height: 1),
            Padding(
              padding: const EdgeInsets.all(12),
              child: Row(
                children: [
                  Expanded(
                    child: TextField(
                      controller: _input,
                      enabled: connected,
                      onSubmitted: (_) => _add(),
                      decoration: const InputDecoration(
                        hintText: 'Add a task',
                        border: OutlineInputBorder(),
                        isDense: true,
                      ),
                    ),
                  ),
                  const SizedBox(width: 8),
                  FilledButton(
                    onPressed: connected ? _add : null,
                    child: const Text('Add'),
                  ),
                ],
              ),
            ),
            Expanded(
              child: _rows.isEmpty
                  ? Center(
                      child: Text(connected ? 'No tasks yet' : 'Press Connect to start'),
                    )
                  : ListView.builder(
                      itemCount: _rows.length,
                      itemBuilder: (context, i) {
                        final row = _rows[i];
                        return ListTile(
                          leading: Checkbox(
                            value: row['done'] == true,
                            onChanged: (_) => _toggle(row),
                          ),
                          title: Text('${row['title']}'),
                          trailing: IconButton(
                            icon: const Icon(Icons.delete_outline),
                            onPressed: () => _delete(row),
                          ),
                        );
                      },
                    ),
            ),
          ],
        ),
      ),
    );
  }
}
