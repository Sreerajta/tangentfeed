/// Hybrid Logical Clock — PROTOCOL.md section 4.
///
/// The encoding is what everything else leans on: fixed-width lowercase hex
/// so that plain string comparison equals logical comparison, which lets
/// storage engines sort and range-scan HLCs as opaque strings.
library;

const int maxCounter = 0xffff;
const int maxMillis = 0xffffffffffff; // 2^48 - 1
const int maxDriftMs = 300000; // 5 minutes, section 4.5

/// Thrown when a remote timestamp is further ahead than section 4.5 allows.
///
/// The whole batch fails: partial application would leave the frontier
/// claiming ops that were dropped.
class ClockDriftError implements Exception {
  ClockDriftError(this.remoteMillis, this.physicalMillis);

  final int remoteMillis;
  final int physicalMillis;

  @override
  String toString() =>
      'ClockDriftError: remote clock is ${remoteMillis - physicalMillis}ms '
      'ahead (max allowed ${maxDriftMs}ms); check system time';
}

final RegExp _deviceIdPattern = RegExp(r'^[0-9a-f]{32}$');
final RegExp _hlcPattern = RegExp(r'^([0-9a-f]{12})-([0-9a-f]{4})-([0-9a-f]{32})$');

bool isValidDeviceId(String id) => _deviceIdPattern.hasMatch(id);

/// An immutable timestamp: (millis, counter, deviceId).
class Hlc implements Comparable<Hlc> {
  const Hlc(this.millis, this.counter, this.deviceId);

  final int millis;
  final int counter;
  final String deviceId;

  /// Section 4.2. Fixed width 50: 12 + 1 + 4 + 1 + 32.
  String encode() {
    final m = millis.toRadixString(16).padLeft(12, '0');
    final c = counter.toRadixString(16).padLeft(4, '0');
    return '$m-$c-$deviceId';
  }

  static Hlc decode(String s) {
    final match = _hlcPattern.firstMatch(s);
    if (match == null) {
      throw FormatException('malformed HLC string', s);
    }
    return Hlc(
      int.parse(match.group(1)!, radix: 16),
      int.parse(match.group(2)!, radix: 16),
      match.group(3)!,
    );
  }

  /// Logical ordering: millis, then counter, then deviceId.
  ///
  /// Guaranteed to agree with `encode().compareTo(other.encode())`, because
  /// every field is zero-padded to a fixed width and Dart compares strings by
  /// UTF-16 code unit.
  @override
  int compareTo(Hlc other) {
    if (millis != other.millis) return millis < other.millis ? -1 : 1;
    if (counter != other.counter) return counter < other.counter ? -1 : 1;
    return deviceId.compareTo(other.deviceId);
  }

  @override
  bool operator ==(Object other) =>
      other is Hlc &&
      other.millis == millis &&
      other.counter == counter &&
      other.deviceId == deviceId;

  @override
  int get hashCode => Object.hash(millis, counter, deviceId);

  @override
  String toString() => encode();
}

/// A device's clock for one space. Section 4.1.
class HybridLogicalClock {
  HybridLogicalClock({
    required this.deviceId,
    int Function()? physicalClock,
    int millis = 0,
    int counter = 0,
  })  : _physicalClock = physicalClock ?? _wallClock,
        _millis = millis,
        _counter = counter {
    if (!isValidDeviceId(deviceId)) {
      throw ArgumentError.value(deviceId, 'deviceId', 'must be 16 lowercase hex chars');
    }
    _checkBounds();
  }

  static int _wallClock() => DateTime.now().millisecondsSinceEpoch;

  final String deviceId;
  final int Function() _physicalClock;
  int _millis;
  int _counter;

  /// Current state, for persistence. Does not advance the clock.
  Hlc get state => Hlc(_millis, _counter, deviceId);

  /// Issue a timestamp for a new local op. Section 4.1 "send/local event".
  Hlc now() {
    final pt = _physicalClock();
    if (pt > _millis) {
      _millis = pt;
      _counter = 0;
    } else {
      _counter += 1;
      if (_counter > maxCounter) {
        _millis += 1;
        _counter = 0;
      }
    }
    _checkBounds();
    return state;
  }

  /// Observe a remote timestamp. Section 4.1 "receive".
  ///
  /// Afterwards the local clock is strictly greater than both its previous
  /// value and [remote], which is what preserves causality.
  Hlc receive(Hlc remote) {
    final pt = _physicalClock();
    if (remote.millis > pt + maxDriftMs) {
      throw ClockDriftError(remote.millis, pt);
    }

    final m = [_millis, remote.millis, pt].reduce((a, b) => a > b ? a : b);
    final int c;
    if (m == _millis && m == remote.millis) {
      c = (_counter > remote.counter ? _counter : remote.counter) + 1;
    } else if (m == _millis) {
      c = _counter + 1;
    } else if (m == remote.millis) {
      c = remote.counter + 1;
    } else {
      c = 0;
    }

    _millis = m;
    _counter = c;
    if (_counter > maxCounter) {
      _millis += 1;
      _counter = 0;
    }
    _checkBounds();
    return state;
  }

  void _checkBounds() {
    if (_millis > maxMillis) {
      throw StateError('HLC millis exceeded 48-bit range');
    }
  }
}
