import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { afterAll, vi } from "vitest";
import { pinTestEnv } from "../testEnvPin.js";
import { standOwnership } from "./standOwnership.js";
import { ReplayLedger } from "./ledger.js";
import { installOfflineSandbox } from "./sandbox.js";
import { ScriptedModel, type ScriptedResult } from "./scriptedModel.js";
import { ReplayTasks } from "./taskTracker.js";
import type { Server } from "node:http";
import { persistViolation } from "./violationMarker.js";

if (process.env.TEST_ENV_PIN === "0") throw new Error("Replay forbids pin opt-out");
pinTestEnv(process.env);
for (const key of ["IG_PROXY_URL", "IG_PROXY_KEY", "GEMINI_PROXY_URL", "GEMINI_PROXY_KEY"]) delete process.env[key];
vi.doMock("../../src/loadEnv.js", () => ({}));
const worktree = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const ownership = standOwnership(process.env.DATABASE_URL, process.env.REPLAY_STAND_MARKER, worktree);
process.env.DATABASE_URL = ownership.url;
process.env.BOT_TURN_TRACE_ENABLED = "0";
export const standLedger = new ReplayLedger(persistViolation);
const tasks = new ReplayTasks();
const localHttpPorts = new Set<number>();
export function registerOwnedHttpServer(server: Server): () => void {
  const address = server.address(); if (!address || typeof address === "string" || address.address !== "127.0.0.1") throw new Error("Expected explicitly bound own loopback server");
  localHttpPorts.add(address.port); return () => localHttpPorts.delete(address.port);
}
export async function assertStandDrained(): Promise<void> {
  const { drainBackgroundTasks } = await import("../../src/lib/shutdownState.js"); await drainBackgroundTasks(2000); tasks.assertSettled(standLedger); standLedger.assertClean();
}
installOfflineSandbox(standLedger, { host: ownership.marker.host, port: ownership.marker.port }, localHttpPorts); // No restored-provider window before worker exit.
const check = new Client({ connectionString: ownership.url });
try {
  await check.connect();
  const result = await check.query("SELECT shobj_description(oid, 'pg_database') AS owner FROM pg_database WHERE datname=current_database()");
  if (result.rows[0]?.owner !== ownership.expectedComment) standLedger.deny("db", "ownership-marker-mismatch");
} finally { await check.end(); }
let model: ScriptedModel | undefined;
export function useStandModel(script: readonly ScriptedResult[]) { model = new ScriptedModel(script, standLedger); return model; }
export const observedProcessOutputs: { shouldReply: boolean | undefined; empty: boolean; aiUnavailable: boolean | undefined; managed: boolean }[] = [];
vi.doMock("../../src/messengers/conversation.js", async () => {
  const original = await vi.importActual<typeof import("../../src/messengers/conversation.js")>("../../src/messengers/conversation.js");
  return { ...original, processMessengerTurn: async (...args: Parameters<typeof original.processMessengerTurn>) => {
    const result = await original.processMessengerTurn(...args);
    observedProcessOutputs.push({ shouldReply: result.shouldReply, empty: !result.reply, aiUnavailable: result.aiUnavailable, managed: Boolean(result.customerPropertyReply) });
    return result;
  } };
});
let fetchFixture: ((input: string | URL | Request, init?: RequestInit) => Promise<Response>) | undefined;
export function useFakeGraphFetch(fixture: typeof fetchFixture) { fetchFixture = fixture; }
// Only the versioned fake Graph boundary executes; original fetch stays denied.
globalThis.fetch = async (input, init) => {
  const value = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const url = new URL(value);
  if (url.protocol !== "https:" || !["graph.facebook.com", "graph.instagram.com"].includes(url.hostname) || !fetchFixture) return standLedger.deny("network", "unregistered-fetch");
  standLedger.record("effect", "fake-graph-fetch", true); return fetchFixture(input, init);
};
vi.doMock("../../src/messengers/meta.js", async () => ({ ...(await vi.importActual<typeof import("../../src/messengers/meta.js")>("../../src/messengers/meta.js")), fetchInstagramProfile: async () => ({ name: "Synthetic visitor" }), showReadAndTyping: async () => {} }));
vi.doMock("../../src/messengers/humanPacing.js", async () => ({ ...(await vi.importActual<typeof import("../../src/messengers/humanPacing.js")>("../../src/messengers/humanPacing.js")), sleep: async () => {} }));
vi.doMock("../../src/ai/client.js", async () => ({ ...(await vi.importActual<typeof import("../../src/ai/client.js")>("../../src/ai/client.js")),
  callAiText: async (input: { endpoint: string }) => model ? model.call(input.endpoint) : standLedger.deny("model", "missing-script") }));
// Fake external publication; real admission/focus/history/storage stay intact.
vi.doMock("../../src/lib/livePublish.js", async () => ({ ...(await vi.importActual<typeof import("../../src/lib/livePublish.js")>("../../src/lib/livePublish.js")), publishMessageNew: async () => {}, publish: () => {} }));
vi.doMock("../../src/lib/shutdownState.js", async () => {
  const original = await vi.importActual<typeof import("../../src/lib/shutdownState.js")>("../../src/lib/shutdownState.js");
  return { ...original, trackBackgroundTask: <T>(promise: Promise<T>) => original.trackBackgroundTask(tasks.track(promise)) };
});
afterAll(async () => {
  await assertStandDrained();
  const { prisma } = await import("../../src/db.js"); await prisma.$disconnect(); standLedger.assertClean();
});
