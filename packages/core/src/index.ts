export {
  HybridLogicalClock,
  ClockDriftError,
  encodeHlc,
  decodeHlc,
  compareHlc,
  isValidDeviceId,
  MAX_COUNTER,
  MAX_MILLIS,
  MAX_DRIFT_MS,
  DEVICE_ID_HEX,
  HLC_LENGTH,
  type Hlc,
} from "./hlc.js";
export {
  BadOpError,
  validateOp,
  signedPayload,
  verifyOp,
  aboveFrontier,
  advanceFrontier,
  TOMBSTONE_COLUMN,
  MAX_OP_BYTES,
  MAX_BATCH_OPS,
  type Op,
  type Json,
  type Frontier,
} from "./op.js";
export { ulid } from "./ulid.js";
export {
  MemoryAdapter,
  cellKey,
  type StorageAdapter,
  type BatchWrite,
  type ClockState,
} from "./storage.js";
export {
  SyncEngine,
  syncOnce,
  type EngineOptions,
  type RowData,
  type RowChange,
  type Subscriber,
} from "./engine.js";
export {
  Replicator,
  WIRE_VERSION,
  OPS_PER_MESSAGE,
  type Transport,
  type WireMsg,
  type ReplicatorEvents,
} from "./replicator.js";
export type { ChangeEvent } from "./engine.js";
export {
  CIPHER_PREFIX,
  isEncryptedValue,
  DecryptError,
  type Cipher,
} from "./cipher.js";
export {
  compactionHorizon,
  blockingPeers,
  planCompaction,
  winningCells,
  type CompactionOptions,
  type CompactionStats,
} from "./compaction.js";
export type { CompactionWrite } from "./storage.js";
export {
  SIGNING_DOMAIN,
  canonicalJson,
  deviceIdFromPublicKey,
  generateDeviceKey,
  signPayload,
  verifyPayload,
  type DeviceKey,
} from "./signing.js";
