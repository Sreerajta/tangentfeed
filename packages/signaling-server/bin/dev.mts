import { createSignalingServer } from "../src/index.js";
const port = Number(process.env.PORT ?? 8787);
const server = await createSignalingServer({ port });
console.log(`syncdb signaling server (dev) on ws://0.0.0.0:${server.port}`);
