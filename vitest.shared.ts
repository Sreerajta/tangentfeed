import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

/**
 * Shared vitest config. Package manifests point `main` at dist (correct for
 * consumers), so tests alias @tangentfeed/* back to source — no build step needed
 * to run the suite, and no stale-dist confusion.
 */
const pkg = (name: string, dir: string) => [name, resolve(__dirname, `packages/${dir}/src/index.ts`)] as const;

export const aliases = Object.fromEntries([
  pkg("@tangentfeed/core", "core"),
  pkg("@tangentfeed/adapter-idb", "adapter-idb"),
  pkg("@tangentfeed/adapter-sqlite", "adapter-sqlite"),
  pkg("@tangentfeed/crypto", "crypto"),
  pkg("@tangentfeed/transport-broadcast", "transport-broadcast"),
  pkg("@tangentfeed/transport-webrtc", "transport-webrtc"),
  pkg("@tangentfeed/signaling-server", "signaling-server"),
  pkg("tangentfeed", "tangentfeed"),
]);

export default defineConfig({ resolve: { alias: aliases } });
