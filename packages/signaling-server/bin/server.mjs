#!/usr/bin/env node
// Standalone runner: PORT=8787 node bin/server.mjs
// Uses tsx-free plain import of built output; for dev: npx tsx bin/dev.mts
import { createSignalingServer } from "../dist/index.js";
const port = Number(process.env.PORT ?? 8787);
const server = await createSignalingServer({ port });
console.log(`tangentfeed signaling server listening on ws://0.0.0.0:${server.port}`);
process.on("SIGINT", async () => { await server.close(); process.exit(0); });
