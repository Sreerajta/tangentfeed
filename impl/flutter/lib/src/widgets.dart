/// Widget bindings.
///
/// Thin by design. `Space.watch` already does the work — these only remove the
/// `StreamBuilder` boilerplate and the passing of a `Space` down through
/// constructors.
library;

import 'package:flutter/widgets.dart';
import 'package:tangentfeed/tangentfeed.dart';

/// Makes a [Space] available to the widgets below it.
///
/// ```dart
/// TangentfeedScope(
///   space: db,
///   child: MaterialApp(home: TaskList()),
/// )
/// ```
class TangentfeedScope extends InheritedWidget {
  const TangentfeedScope({
    required this.space,
    required super.child,
    super.key,
  });

  final Space space;

  /// The nearest enclosing [Space]. Throws if there is none, because a missing
  /// scope is a wiring mistake rather than a state to handle.
  static Space of(BuildContext context) {
    final scope = context.dependOnInheritedWidgetOfExactType<TangentfeedScope>();
    assert(scope != null, 'No TangentfeedScope found above this widget');
    return scope!.space;
  }

  /// The nearest enclosing [Space], or null when there is none.
  static Space? maybeOf(BuildContext context) =>
      context.dependOnInheritedWidgetOfExactType<TangentfeedScope>()?.space;

  @override
  bool updateShouldNotify(TangentfeedScope oldWidget) => space != oldWidget.space;
}

/// Rebuilds whenever [table] changes.
///
/// [builder] receives the rows. Because `watch` emits the current contents on
/// listen rather than after a round trip, [loading] is usually only visible for
/// one frame — supply it if that frame matters to you.
///
/// ```dart
/// RowsBuilder(
///   table: 'tasks',
///   builder: (context, rows) => ListView(
///     children: [for (final r in rows) Text('${r['title']}')],
///   ),
/// )
/// ```
class RowsBuilder extends StatefulWidget {
  const RowsBuilder({
    required this.table,
    required this.builder,
    this.space,
    this.loading,
    this.onError,
    super.key,
  });

  final String table;
  final Widget Function(BuildContext context, List<RowData> rows) builder;

  /// Defaults to the nearest [TangentfeedScope].
  final Space? space;

  final WidgetBuilder? loading;
  final Widget Function(BuildContext context, Object error)? onError;

  @override
  State<RowsBuilder> createState() => _RowsBuilderState();
}

class _RowsBuilderState extends State<RowsBuilder> {
  Stream<List<RowData>>? _stream;
  Space? _space;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _resubscribeIfNeeded();
  }

  @override
  void didUpdateWidget(RowsBuilder old) {
    super.didUpdateWidget(old);
    if (old.table != widget.table || old.space != widget.space) {
      _stream = null;
      _resubscribeIfNeeded();
    }
  }

  /// The stream is held in state rather than rebuilt in [build], because a
  /// fresh stream on every rebuild would re-subscribe and re-read continuously.
  void _resubscribeIfNeeded() {
    final space = widget.space ?? TangentfeedScope.of(context);
    if (_stream != null && identical(space, _space)) return;
    _space = space;
    _stream = space.watch(widget.table);
  }

  @override
  Widget build(BuildContext context) => StreamBuilder<List<RowData>>(
        stream: _stream,
        builder: (context, snapshot) {
          if (snapshot.hasError && widget.onError != null) {
            return widget.onError!(context, snapshot.error!);
          }
          final rows = snapshot.data;
          if (rows == null) {
            return widget.loading?.call(context) ?? const SizedBox.shrink();
          }
          return widget.builder(context, rows);
        },
      );
}

/// Rebuilds whenever one row changes. The row is null when absent or deleted.
class RowBuilder extends StatefulWidget {
  const RowBuilder({
    required this.table,
    required this.row,
    required this.builder,
    this.space,
    this.loading,
    this.onError,
    super.key,
  });

  final String table;
  final String row;
  final Widget Function(BuildContext context, RowData? row) builder;
  final Space? space;
  final WidgetBuilder? loading;
  final Widget Function(BuildContext context, Object error)? onError;

  @override
  State<RowBuilder> createState() => _RowBuilderState();
}

class _RowBuilderState extends State<RowBuilder> {
  Stream<RowData?>? _stream;
  Space? _space;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _resubscribeIfNeeded();
  }

  @override
  void didUpdateWidget(RowBuilder old) {
    super.didUpdateWidget(old);
    if (old.table != widget.table || old.row != widget.row || old.space != widget.space) {
      _stream = null;
      _resubscribeIfNeeded();
    }
  }

  void _resubscribeIfNeeded() {
    final space = widget.space ?? TangentfeedScope.of(context);
    if (_stream != null && identical(space, _space)) return;
    _space = space;
    _stream = space.watchRow(widget.table, widget.row);
  }

  @override
  Widget build(BuildContext context) => StreamBuilder<RowData?>(
        stream: _stream,
        builder: (context, snapshot) {
          if (snapshot.hasError && widget.onError != null) {
            return widget.onError!(context, snapshot.error!);
          }
          if (snapshot.connectionState == ConnectionState.waiting) {
            return widget.loading?.call(context) ?? const SizedBox.shrink();
          }
          return widget.builder(context, snapshot.data);
        },
      );
}

/// Reachable peers, polled.
///
/// Polled rather than pushed because connection state lives on the transport
/// and arrives through its own callbacks, not the engine's change stream.
class PeersBuilder extends StatefulWidget {
  const PeersBuilder({
    required this.builder,
    this.space,
    this.interval = const Duration(seconds: 1),
    super.key,
  });

  final Widget Function(BuildContext context, List<String> peers) builder;
  final Space? space;
  final Duration interval;

  @override
  State<PeersBuilder> createState() => _PeersBuilderState();
}

class _PeersBuilderState extends State<PeersBuilder> {
  List<String> _peers = const [];
  bool _running = false;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (!_running) {
      _running = true;
      _poll();
    }
  }

  Future<void> _poll() async {
    while (mounted) {
      final space = widget.space ?? TangentfeedScope.maybeOf(context);
      final peers = space?.peers() ?? const <String>[];
      if (mounted && !_sameAs(peers)) setState(() => _peers = peers);
      await Future<void>.delayed(widget.interval);
    }
  }

  bool _sameAs(List<String> next) {
    if (next.length != _peers.length) return false;
    for (var i = 0; i < next.length; i++) {
      if (next[i] != _peers[i]) return false;
    }
    return true;
  }

  @override
  Widget build(BuildContext context) => widget.builder(context, _peers);
}
