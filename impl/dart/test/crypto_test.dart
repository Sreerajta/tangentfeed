/// Milestone 6 — end-to-end encryption (PROTOCOL.md section 7).
///
/// A self-round-trip proves almost nothing here: an implementation that gets
/// the HKDF info string or the AAD wrong, but wrong consistently, passes it.
/// The real check is decrypting envelopes the TypeScript implementation
/// produced, which is what interop_fixture.json holds.
library;

import 'dart:convert';
import 'dart:io';

import 'package:test/test.dart';
import 'package:tangentfeed/tangentfeed.dart';

void main() {
  final fixtureFile = File('test/interop_fixture.json');
  final fixture = jsonDecode(fixtureFile.readAsStringSync()) as Map<String, dynamic>;
  final secret = (fixture['secret'] as List).cast<int>();

  group('milestone 6 — encryption (section 7)', () {
    test('round-trips every JSON value shape within Dart', () async {
      final cipher = await SpaceCipher.fromSecret(secret);
      const opId = '018bcfe56800-0000-aaaaaaaaaaaaaaaa';

      for (final value in <Object?>[
        'hello',
        42,
        3.5,
        true,
        null,
        <String, Object?>{'a': 1, 'b': <Object?>[1, 2]},
        <Object?>['x', <String, Object?>{'y': 'z'}],
        '',
      ]) {
        final envelope = await cipher.encrypt(value, opId);
        expect(envelope.startsWith('e1:'), isTrue);
        expect(await cipher.decrypt(envelope, opId), equals(value));
      }
    });

    test('a fresh nonce is used for every encryption', () async {
      final cipher = await SpaceCipher.fromSecret(secret);
      const opId = '018bcfe56800-0000-aaaaaaaaaaaaaaaa';
      final a = await cipher.encrypt('same', opId);
      final b = await cipher.encrypt('same', opId);
      expect(a, isNot(equals(b)));
    });

    test('decrypts envelopes produced by the TypeScript implementation', () async {
      final cipher = await SpaceCipher.fromSecret(secret);
      for (final c in fixture['cases'] as List) {
        final got = await cipher.decrypt(c['envelope'], c['opId'] as String);
        expect(got, equals(c['value']),
            reason: 'failed on ${jsonEncode(c['value'])}');
      }
    });

    test('AAD binds a ciphertext to one op id', () async {
      final cipher = await SpaceCipher.fromSecret(secret);
      final m = fixture['aadMismatch'] as Map<String, dynamic>;

      // Correct op id: decrypts.
      expect(await cipher.decrypt(m['envelope'], m['opId'] as String),
          equals(m['value']));

      // Same ciphertext, different op id: must fail rather than silently
      // relocating the value into another cell.
      expect(
        () => cipher.decrypt(m['envelope'], m['wrongOpId'] as String),
        throwsA(isA<DecryptError>()),
      );
    });

    test('a wrong key fails authentication', () async {
      final wrong = await SpaceCipher.fromSecret(List<int>.filled(32, 9));
      final c = (fixture['cases'] as List).first;
      expect(
        () => wrong.decrypt(c['envelope'], c['opId'] as String),
        throwsA(isA<DecryptError>()),
      );
    });

    test('plaintext values pass through untouched (section 7.3)', () async {
      final cipher = await SpaceCipher.fromSecret(secret);
      expect(await cipher.decrypt('not encrypted', 'op'), equals('not encrypted'));
      expect(await cipher.decrypt(42, 'op'), equals(42));
      expect(await cipher.decrypt(null, 'op'), isNull);
    });

    test('rejects a truncated envelope', () async {
      final cipher = await SpaceCipher.fromSecret(secret);
      expect(() => cipher.decrypt('e1:AAAA', 'op'), throwsA(isA<DecryptError>()));
    });

    test('rejects a secret that is too short', () {
      expect(() => SpaceCipher.fromSecret(List<int>.filled(8, 0)), throwsArgumentError);
    });

    test('passphrase derivation matches the reference scrypt parameters', () async {
      // Section 7.1 leaves the KDF open, so nothing but this proves a Dart
      // peer and a JavaScript peer land on the same key from one passphrase.
      final p = fixture['passphrase'] as Map<String, dynamic>;
      final cipher = await SpaceCipher.fromPassphrase(
        p['passphrase'] as String,
        p['space'] as String,
      );
      expect(await cipher.decrypt(p['envelope'], p['opId'] as String),
          equals(p['value']));
    }, timeout: const Timeout(Duration(minutes: 2)));
  });
}
