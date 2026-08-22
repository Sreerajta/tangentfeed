/// Operations and frontiers — PROTOCOL.md sections 3, 5 and 6.
library;

import 'dart:convert';

import 'dart:typed_data';

import 'canonical.dart';
import 'hlc.dart';
import 'signing.dart';

/// The reserved column carrying a row tombstone. Section 5.
const String tombstoneColumn = '-';

const int maxOpBytes = 64 * 1024;
const int maxBatchOps = 1000;

final RegExp _nameRe = RegExp(r'^[a-zA-Z_][a-zA-Z0-9_]{0,63}$');
final RegExp _ulidRe = RegExp(r'^[0-9A-HJKMNP-TV-Z]{26}$', caseSensitive: false);

/// Section 11, code BAD_OP.
class BadOpError implements Exception {
  BadOpError(this.message);
  final String message;
  @override
  String toString() => 'BAD_OP: $message';
}

/// A single cell write. Section 3.
///
/// In v0.1 [id] and [hlc] are the same string, and [device] must equal the
/// deviceId suffix of [hlc]; both are checked by [validate].
class Op {
  const Op({
    required this.id,
    required this.table,
    required this.row,
    required this.column,
    required this.value,
    required this.hlc,
    required this.device,
    required this.sig,
  });

  final String id;
  final String table;
  final String row;
  final String column;
  final Object? value;
  final String hlc;
  final String device;

  /// Base64 Ed25519 signature over signedPayload(op). Section 12.
  final String sig;

  bool get isTombstone => column == tombstoneColumn;

  Map<String, Object?> toJson() => {
        'id': id,
        'table': table,
        'row': row,
        'column': column,
        'value': value,
        'hlc': hlc,
        'device': device,
        'sig': sig,
      };

  /// Parses and validates an op as it appears on the wire.
  static Op fromJson(Object? raw) {
    if (raw is! Map) throw BadOpError('not an object');

    String str(String field) {
      final v = raw[field];
      if (v is! String) throw BadOpError('field $field must be a string');
      return v;
    }

    if (!raw.containsKey('value')) throw BadOpError('missing value');

    final op = Op(
      id: str('id'),
      table: str('table'),
      row: str('row'),
      column: str('column'),
      value: raw['value'],
      hlc: str('hlc'),
      device: str('device'),
      sig: str('sig'),
    );
    op.validate();
    return op;
  }

  /// Section 3, with the error codes of section 11.
  void validate() {
    final Hlc decoded;
    try {
      decoded = Hlc.decode(hlc);
    } on FormatException {
      throw BadOpError('malformed hlc: $hlc');
    }

    if (id != hlc) throw BadOpError('id must equal hlc in v0.1');
    if (device != decoded.deviceId) {
      throw BadOpError('device does not match hlc suffix');
    }
    if (!_nameRe.hasMatch(table)) throw BadOpError('bad table name: $table');
    if (column != tombstoneColumn && !_nameRe.hasMatch(column)) {
      throw BadOpError('bad column name: $column');
    }
    if (!_ulidRe.hasMatch(row)) throw BadOpError('row is not a ULID: $row');
    _assertJson(value, 'value');

    if (jsonEncode(toJson()).length > maxOpBytes) {
      throw BadOpError('op exceeds 64 KiB');
    }
  }

  static void _assertJson(Object? v, String path) {
    if (v == null || v is bool || v is String) return;
    if (v is num) {
      if (v is double && (v.isNaN || v.isInfinite)) {
        throw BadOpError('$path: non-finite numbers are not valid JSON');
      }
      return;
    }
    if (v is List) {
      for (var i = 0; i < v.length; i++) {
        _assertJson(v[i], '$path[$i]');
      }
      return;
    }
    if (v is Map) {
      for (final entry in v.entries) {
        if (entry.key is! String) throw BadOpError('$path: object keys must be strings');
        _assertJson(entry.value, '$path.${entry.key}');
      }
      return;
    }
    throw BadOpError('$path: not a JSON value');
  }

  @override
  String toString() => 'Op($table.$row.$column @ $hlc)';
}

/// A version vector: deviceId to the highest HLC string seen from it.
/// Section 6.
typedef Frontier = Map<String, String>;

/// Whether [op] is strictly above [frontier].
///
/// Strictly: an op whose hlc equals the frontier entry has already been seen.
/// Treating this as "at or above" is the off-by-one that doubles sync traffic
/// forever without breaking correctness.
bool aboveFrontier(Op op, Frontier frontier) {
  final seen = frontier[op.device];
  if (seen == null) return true;
  return op.hlc.compareTo(seen) > 0;
}

/// Returns [frontier] advanced to include [op].
Frontier advanceFrontier(Frontier frontier, Op op) {
  final seen = frontier[op.device];
  if (seen == null || op.hlc.compareTo(seen) > 0) {
    return {...frontier, op.device: op.hlc};
  }
  return frontier;
}

/// The exact bytes a signature covers: the domain, then the canonical JSON of
/// every field except `sig` itself.
///
/// `sig` is excluded because including it would require knowing the signature
/// before computing it, and because a verifier can then rebuild the payload
/// from the op it received with nothing extra to agree on.
Uint8List signedPayload({
  required String id,
  required String table,
  required String row,
  required String column,
  required Object? value,
  required String hlc,
  required String device,
}) {
  final canonical = canonicalJson(<String, Object?>{
    'id': id,
    'table': table,
    'row': row,
    'column': column,
    'value': value,
    'hlc': hlc,
    'device': device,
  });
  return Uint8List.fromList(utf8.encode(signingDomain + canonical));
}

Uint8List signedPayloadOf(Op op) => signedPayload(
      id: op.id,
      table: op.table,
      row: op.row,
      column: op.column,
      value: op.value,
      hlc: op.hlc,
      device: op.device,
    );

/// Whether `op.sig` is a valid signature by [publicKey]. Section 12.
Future<bool> verifyOp(Op op, Uint8List publicKey) =>
    verifyPayload(signedPayloadOf(op), op.sig, publicKey);
