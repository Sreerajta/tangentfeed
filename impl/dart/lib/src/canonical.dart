/// Canonical JSON — RFC 8785 (JCS), PROTOCOL.md section 8.1.
///
/// Not `jsonEncode`. Dart gets two of the three hard parts right for free —
/// String.compareTo is UTF-16 code unit order, which is exactly what JCS
/// requires, and double.toString() matches ECMAScript for non-whole values —
/// but it separates int from double where JSON does not, so `100.0` would
/// encode as `100.0` instead of `100`. Under encryption the plaintext is
/// canonical JSON, so that single character produces ciphertext no other
/// implementation can authenticate.
library;

/// Serializes [value] to its RFC 8785 canonical form.
///
/// Accepts the JSON value types only: null, bool, num, String, List, Map with
/// String keys. Anything else, and any non-finite number, throws.
String canonicalJson(Object? value) {
  final buf = StringBuffer();
  _write(buf, value);
  return buf.toString();
}

void _write(StringBuffer buf, Object? v) {
  if (v == null) {
    buf.write('null');
    return;
  }
  if (v is bool) {
    buf.write(v ? 'true' : 'false');
    return;
  }
  if (v is num) {
    buf.write(canonicalNumber(v));
    return;
  }
  if (v is String) {
    writeCanonicalString(buf, v);
    return;
  }
  if (v is List) {
    buf.write('[');
    for (var i = 0; i < v.length; i++) {
      if (i > 0) buf.write(',');
      _write(buf, v[i]);
    }
    buf.write(']');
    return;
  }
  if (v is Map) {
    final keys = <String>[];
    for (final k in v.keys) {
      if (k is! String) {
        throw ArgumentError.value(k, 'key', 'JSON object keys must be strings');
      }
      keys.add(k);
    }
    // JCS sorts by UTF-16 code unit. Dart's String.compareTo does exactly
    // that, so no custom comparator is needed here — unlike most languages.
    keys.sort();

    buf.write('{');
    for (var i = 0; i < keys.length; i++) {
      if (i > 0) buf.write(',');
      writeCanonicalString(buf, keys[i]);
      buf.write(':');
      _write(buf, v[keys[i]]);
    }
    buf.write('}');
    return;
  }
  throw ArgumentError.value(v, 'value', 'not a JSON value');
}

/// ECMAScript `Number::toString`, which is what JCS mandates.
String canonicalNumber(num v) {
  if (v is int) return v.toString();

  final d = v.toDouble();
  if (d.isNaN || d.isInfinite) {
    throw ArgumentError.value(v, 'value', 'non-finite numbers are not valid JSON');
  }

  // Covers both 0.0 and -0.0; JCS requires plain "0" for each.
  if (d == 0) return '0';

  // A whole-valued double is an integer in JSON. Below 1e21 ECMAScript prints
  // it positionally; at or above, it switches to exponent form, and
  // double.toString() already agrees there.
  if (d == d.truncateToDouble() && d.abs() < 1e21) {
    return d.toStringAsFixed(0);
  }

  // For everything else Dart's shortest-round-trip output matches ECMAScript,
  // including the exponent forms ("1e+30", "1e-7").
  return d.toString();
}

const _hexDigits = '0123456789abcdef';

/// Writes [s] as a JSON string using the shortest escapes, per JCS.
void writeCanonicalString(StringBuffer buf, String s) {
  buf.write('"');
  for (var i = 0; i < s.length; i++) {
    final c = s.codeUnitAt(i);
    switch (c) {
      case 0x22:
        buf.write(r'\"');
      case 0x5c:
        buf.write(r'\\');
      case 0x08:
        buf.write(r'\b');
      case 0x0c:
        buf.write(r'\f');
      case 0x0a:
        buf.write(r'\n');
      case 0x0d:
        buf.write(r'\r');
      case 0x09:
        buf.write(r'\t');
      default:
        if (c < 0x20) {
          buf
            ..write(r'\u00')
            ..write(_hexDigits[(c >> 4) & 0xf])
            ..write(_hexDigits[c & 0xf]);
        } else if (_isLoneSurrogate(s, i, c)) {
          // Well-formed JSON output cannot contain an unpaired surrogate, so
          // it is escaped rather than emitted raw.
          buf
            ..write(r'\u')
            ..write(_hexDigits[(c >> 12) & 0xf])
            ..write(_hexDigits[(c >> 8) & 0xf])
            ..write(_hexDigits[(c >> 4) & 0xf])
            ..write(_hexDigits[c & 0xf]);
        } else {
          buf.writeCharCode(c);
        }
    }
  }
  buf.write('"');
}

bool _isLoneSurrogate(String s, int i, int c) {
  final isHigh = c >= 0xd800 && c <= 0xdbff;
  final isLow = c >= 0xdc00 && c <= 0xdfff;
  if (!isHigh && !isLow) return false;
  if (isHigh) {
    if (i + 1 >= s.length) return true;
    final next = s.codeUnitAt(i + 1);
    return !(next >= 0xdc00 && next <= 0xdfff);
  }
  // Low surrogate is paired only if the previous unit was a high surrogate.
  if (i == 0) return true;
  final prev = s.codeUnitAt(i - 1);
  return !(prev >= 0xd800 && prev <= 0xdbff);
}
