/// End-to-end encryption — PROTOCOL.md section 7.
///
/// Encryption is per space and invisible to the rest of the protocol: an
/// encrypted value is just a string, so a peer without the key still merges
/// correctly and still forwards the ciphertext byte-exact. That is what
/// `merge/05-encrypted-values.json` pins down, and it is why the engine never
/// needs to decrypt in order to converge.
library;

import 'dart:convert';
import 'dart:typed_data';

import 'package:cryptography/cryptography.dart';
import 'package:pointycastle/export.dart' as pc;

import 'canonical.dart';

/// Envelope marker for an encrypted value. Section 7.1.
const String cipherPrefix = 'e1:';

const int _nonceBytes = 24; // XChaCha20 takes a 192-bit nonce
const int _keyBytes = 32;

/// The HKDF `info` string is normative — it changed when the project was
/// renamed, and getting it wrong yields a key that decrypts nothing.
const String _hkdfInfo = 'tangentfeed/v1/cells';

bool isEncryptedValue(Object? v) => v is String && v.startsWith(cipherPrefix);

/// Thrown when an envelope fails authentication.
///
/// Distinct from a merge failure on purpose: a peer that cannot decrypt must
/// still be able to store and forward the value.
class DecryptError implements Exception {
  DecryptError(this.message);
  final String message;
  @override
  String toString() => 'DecryptError: $message';
}

/// Encrypts and decrypts cell values for one space.
class SpaceCipher {
  SpaceCipher._(this._key);

  final SecretKey _key;
  static final _algorithm = Xchacha20.poly1305Aead();

  /// Derives the cell key from a 32-byte space secret. Section 7.1.
  static Future<SpaceCipher> fromSecret(List<int> secret) async {
    if (secret.length < 16) {
      throw ArgumentError('space secret must be at least 16 bytes; '
          'use fromPassphrase for text');
    }
    final hkdf = Hkdf(hmac: Hmac.sha256(), outputLength: _keyBytes);
    final key = await hkdf.deriveKey(
      secretKey: SecretKey(secret),
      nonce: const <int>[], // salt = "" per section 7.1
      info: utf8.encode(_hkdfInfo),
    );
    return SpaceCipher._(key);
  }

  /// Derives a secret from a human passphrase, salted with the space id.
  ///
  /// Section 7.1 leaves the KDF to the implementation, and the reference one
  /// uses scrypt with N=2^15, r=8, p=1. Matching those exactly is what lets a
  /// Dart peer and a JavaScript peer share a passphrase, so they are not
  /// tunable here.
  ///
  /// scrypt comes from pointycastle because package:cryptography ships only
  /// Argon2id and PBKDF2.
  static Future<SpaceCipher> fromPassphrase(String passphrase, String space) async {
    final derivator = pc.Scrypt()
      ..init(pc.ScryptParameters(
        1 << 15, // N
        8, // r
        1, // p
        _keyBytes,
        Uint8List.fromList(utf8.encode(space)),
      ));
    final secret = derivator.process(Uint8List.fromList(utf8.encode(passphrase)));
    return fromSecret(secret);
  }

  /// Encrypts a cell value, binding it to [opId] as AAD.
  ///
  /// The AAD means a ciphertext lifted out of one op and pasted into another
  /// fails authentication instead of silently relocating a value.
  Future<String> encrypt(Object? value, String opId) async {
    final plaintext = utf8.encode(canonicalJson(value));
    final box = await _algorithm.encrypt(
      plaintext,
      secretKey: _key,
      nonce: _algorithm.newNonce(),
      aad: utf8.encode(opId),
    );

    final envelope = Uint8List(box.nonce.length + box.cipherText.length + box.mac.bytes.length)
      ..setAll(0, box.nonce)
      ..setAll(box.nonce.length, box.cipherText)
      ..setAll(box.nonce.length + box.cipherText.length, box.mac.bytes);

    return '$cipherPrefix${base64.encode(envelope)}';
  }

  /// Decrypts an envelope produced by [encrypt].
  ///
  /// Values without the `e1:` prefix are returned unchanged: a space may hold
  /// plaintext written before encryption was enabled (section 7.3).
  Future<Object?> decrypt(Object? value, String opId) async {
    if (!isEncryptedValue(value)) return value;

    final Uint8List raw;
    try {
      raw = base64.decode((value! as String).substring(cipherPrefix.length));
    } on FormatException {
      throw DecryptError('envelope is not valid base64');
    }

    final macLength = _algorithm.macAlgorithm.macLength;
    if (raw.length < _nonceBytes + macLength) {
      throw DecryptError('envelope too short');
    }

    final box = SecretBox(
      raw.sublist(_nonceBytes, raw.length - macLength),
      nonce: raw.sublist(0, _nonceBytes),
      mac: Mac(raw.sublist(raw.length - macLength)),
    );

    final List<int> plaintext;
    try {
      plaintext = await _algorithm.decrypt(box, secretKey: _key, aad: utf8.encode(opId));
    } catch (_) {
      // Wrong key, tampered ciphertext, or an AAD from a different op.
      throw DecryptError('authentication failed for op $opId');
    }

    return jsonDecode(utf8.decode(plaintext));
  }
}
