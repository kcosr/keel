// Spawnable daemon for the kill -9 recovery test. Uses a delayed mock provider
// so a run can be caught mid-flight. Config via env: KEEL_SOCKET, KEEL_DB,
// KEEL_DELAY (ms), KEEL_OWNER.

import { MockProvider } from "../agents/mock.ts";
import { AgentProviderRegistry } from "../agents/types.ts";
import { KeelDaemon } from "./server.ts";

const delay = Number(process.env.KEEL_DELAY ?? "0");
const mock = new MockProvider({
  default: { outputs: ['{"value":1}'], delayMs: delay },
});
const daemon = new KeelDaemon({
  socketPath: process.env.KEEL_SOCKET as string,
  dbPath: process.env.KEEL_DB as string,
  agents: new AgentProviderRegistry().register(mock),
  ...(process.env.KEEL_OWNER ? { ownerId: process.env.KEEL_OWNER } : {}),
  heartbeatMs: 200,
});
await daemon.start();
process.stdout.write(`READY ${daemon.ownerId}\n`);
process.on("SIGTERM", () => {
  daemon.stop();
  process.exit(0);
});
await new Promise(() => {});
