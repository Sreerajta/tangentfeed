/// Offline-first, peer-to-peer data sync.
///
/// Dart implementation of the tangentfeed protocol. `PROTOCOL.md` at the
/// repository root is normative; `conformance/` is the contract, and this
/// package's tests run against those files directly.
library;

export 'src/canonical.dart' show canonicalJson;
export 'src/compaction.dart'
    show CompactionOptions, CompactionStats, blockingPeers, compactionHorizon;
export 'src/cipher.dart' show DecryptError, SpaceCipher, cipherPrefix, isEncryptedValue;
export 'src/engine.dart'
    show ChangeEvent, RowChange, RowData, SyncEngine;
export 'src/loopback.dart' show LoopbackTransport;
export 'src/replicator.dart'
    show Replicator, Transport, opsPerMessage, syncOnce, wireVersion;
export 'src/op.dart'
    show
        BadOpError,
        Frontier,
        Op,
        aboveFrontier,
        signedPayload,
        verifyOp,
        advanceFrontier,
        maxBatchOps,
        maxOpBytes,
        tombstoneColumn;
export 'src/space.dart' show Space, TransportFactory, openSpace;
export 'src/signing.dart'
    show
        DeviceKey,
        deviceIdFromPublicKey,
        generateDeviceKey,
        signPayload,
        signingDomain,
        verifyPayload;
export 'src/sqlite.dart' show SqliteAdapter, SqliteDriver;
export 'src/storage.dart' show BatchWrite, CellKey, MemoryAdapter, StorageAdapter;
export 'src/ulid.dart' show ulid;
export 'src/hlc.dart'
    show
        ClockDriftError,
        Hlc,
        HybridLogicalClock,
        isValidDeviceId,
        maxCounter,
        maxDriftMs,
        maxMillis;
