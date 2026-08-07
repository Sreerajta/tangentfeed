# @tangentfeed/crypto

End-to-end encryption for tangentfeed: XChaCha20-Poly1305 with HKDF key derivation, and scrypt for passphrases.

Cell values are encrypted before they enter the operation log, so storage, transports, and relays only ever hold ciphertext.

Part of [tangentfeed](https://github.com/sreerajta/tangentfeed). MIT licensed.
