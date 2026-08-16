/// ULID row ids — PROTOCOL.md section 4.4.
///
/// 26 characters of Crockford base32: 10 of timestamp, 16 of randomness. The
/// timestamp prefix makes ids sort roughly by creation time, which keeps
/// range scans over rows useful.
library;

import 'dart:math';

const String _crockford = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
final Random _random = Random.secure();

/// Generates a ULID. [millis] defaults to the wall clock.
String ulid([int? millis]) {
  var time = millis ?? DateTime.now().millisecondsSinceEpoch;

  final chars = List<String>.filled(26, '0');
  for (var i = 9; i >= 0; i--) {
    chars[i] = _crockford[time % 32];
    time = time ~/ 32;
  }
  for (var i = 10; i < 26; i++) {
    chars[i] = _crockford[_random.nextInt(32)];
  }
  return chars.join();
}
