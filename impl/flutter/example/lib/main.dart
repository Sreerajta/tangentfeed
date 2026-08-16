/// Two-peer sync demo.
///
/// Storage is in-memory on purpose: this exists to prove the transport and the
/// merge, and swapping in SqfliteDriver would stop it running on the web,
/// which is the frictionless target.
library;

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
  static const _space = 'kitchen-42';
  static const _signaling = 'ws://localhost:8787';

  SyncEngine? _engine;
  WebRTCTransport? _transport;
  Replicator? _replicator;

  final _input = TextEditingController();
  List<RowData> _rows = const [];
  String _status = 'starting…';
  String _deviceId = '';

  @override
  void initState() {
    super.initState();
    _start();
  }

  Future<void> _start() async {
    try {
      final deviceId = generateDeviceId();
      final engine = await SyncEngine.open(
        deviceId: deviceId,
        storage: MemoryAdapter(),
      );

      final transport = WebRTCTransport(
        space: _space,
        deviceId: deviceId,
        signalingUrl: _signaling,
      );

      final replicator = Replicator(
        engine: engine,
        transport: transport,
        space: _space,
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
        _status = 'connected to signaling; waiting for a peer';
      });

      await _refresh();
      _pollPeers();
    } catch (e) {
      _setStatus('failed to start: $e');
    }
  }

  /// Peer count comes from the transport rather than the engine, so it is
  /// polled rather than pushed.
  void _pollPeers() {
    Future.doWhile(() async {
      await Future<void>.delayed(const Duration(seconds: 1));
      if (!mounted) return false;
      final peers = _transport?.connectedPeers ?? const [];
      _setStatus(peers.isEmpty
          ? 'no peers yet — open a second window'
          : 'synced with ${peers.length} peer(s)');
      return true;
    });
  }

  void _setStatus(String s) {
    if (mounted) setState(() => _status = s);
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
    await _engine!.update('tasks', row['id']! as String, {
      'done': row['done'] != true,
    });
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
    _input.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(
          title: const Text('tangentfeed'),
          bottom: PreferredSize(
            preferredSize: const Size.fromHeight(34),
            child: Padding(
              padding: const EdgeInsets.only(left: 16, right: 16, bottom: 8),
              child: Align(
                alignment: Alignment.centerLeft,
                child: Text(
                  '$_status   ·   device ${_deviceId.isEmpty ? "…" : _deviceId.substring(0, 6)}',
                  style: Theme.of(context).textTheme.bodySmall,
                ),
              ),
            ),
          ),
        ),
        body: Column(
          children: [
            Padding(
              padding: const EdgeInsets.all(12),
              child: Row(
                children: [
                  Expanded(
                    child: TextField(
                      controller: _input,
                      onSubmitted: (_) => _add(),
                      decoration: const InputDecoration(
                        hintText: 'Add a task',
                        border: OutlineInputBorder(),
                        isDense: true,
                      ),
                    ),
                  ),
                  const SizedBox(width: 8),
                  FilledButton(onPressed: _add, child: const Text('Add')),
                ],
              ),
            ),
            Expanded(
              child: _rows.isEmpty
                  ? const Center(child: Text('No tasks yet'))
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
      );
}
