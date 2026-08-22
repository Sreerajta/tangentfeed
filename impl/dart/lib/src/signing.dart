/// Operation signing — PROTOCOL.md section 12.
///
/// Ed25519 comes from package:cryptography and is asynchronous; pointycastle,
/// already a dependency for scrypt, has no Ed25519 at all. SHA-256 does come
/// from pointycastle so that deviceId derivation stays synchronous — it is
/// called from constructors and comparisons where a Future would be poison.
library;

import 'dart:convert';
import 'dart:typed_data';

import 'package:cryptography/cryptography.dart';
import 'package:pointycastle/digests/sha256.dart';

/// Prefixed to every signed payload so a signature can never be valid in
/// another context.
const String signingDomain = 'tangentfeed/v2/op';

final Ed25519 _ed25519 = Ed25519();

class DeviceKey {
  const DeviceKey({required this.publicKey, required this.privateKey});

  final Uint8List publicKey;

  /// The 32-byte Ed25519 seed, which is what package:cryptography calls the
  /// private key bytes.
  final Uint8List privateKey;
}

Future<DeviceKey> generateDeviceKey() async {
  final pair = await _ed25519.newKeyPair();
  return DeviceKey(
    publicKey: Uint8List.fromList((await pair.extractPublicKey()).bytes),
    privateKey: Uint8List.fromList(await pair.extractPrivateKeyBytes()),
  );
}

/// deviceId is the first 16 bytes of SHA-256(publicKey), lowercase hex.
///
/// 128 bits rather than v0.1's 64: the identifier became a security boundary
/// when it started deciding whose signature counts.
String deviceIdFromPublicKey(Uint8List publicKey) {
  final digest = SHA256Digest().process(publicKey);
  final buf = StringBuffer();
  for (var i = 0; i < 16; i++) {
    buf.write(digest[i].toRadixString(16).padLeft(2, '0'));
  }
  return buf.toString();
}

Future<String> signPayload(Uint8List payload, Uint8List privateKey) async {
  final pair = await _ed25519.newKeyPairFromSeed(privateKey);
  final signature = await _ed25519.sign(payload, keyPair: pair);
  return base64.encode(signature.bytes);
}

/// Returns false rather than throwing on malformed input: a bad signature from
/// a peer is a routine condition on an open network, not an exceptional one.
Future<bool> verifyPayload(
  Uint8List payload,
  String signature,
  Uint8List publicKey,
) async {
  try {
    final bytes = base64.decode(signature);
    if (bytes.length != 64) return false;
    return await _ed25519.verify(
      payload,
      signature: Signature(
        bytes,
        publicKey: SimplePublicKey(publicKey, type: KeyPairType.ed25519),
      ),
    );
  } catch (_) {
    return false;
  }
}
