/// Offline-first, peer-to-peer data sync.
///
/// Dart implementation of the tangentfeed protocol. `PROTOCOL.md` at the
/// repository root is normative; `conformance/` is the contract, and this
/// package's tests run against those files directly.
library;

export 'src/canonical.dart' show canonicalJson;
export 'src/engine.dart'
    show ChangeEvent, RowChange, RowData, SyncEngine, generateDeviceId;
export 'src/op.dart'
    show
        BadOpError,
        Frontier,
        Op,
        aboveFrontier,
        advanceFrontier,
        maxBatchOps,
        maxOpBytes,
        tombstoneColumn;
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
