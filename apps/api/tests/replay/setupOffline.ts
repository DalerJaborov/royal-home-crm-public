import { afterAll, vi } from "vitest";
import { pinTestEnv } from "../testEnvPin.js";
import { ReplayLedger } from "./ledger.js";
import { installOfflineSandbox } from "./sandbox.js";
import { ScriptedModel, type ScriptedResult } from "./scriptedModel.js";
import { offlineDatabase } from "./fakeDatabase.js";
import { ReplayTasks } from "./taskTracker.js";
import { persistViolation } from "./violationMarker.js";

if (process.env.TEST_ENV_PIN === "0") throw new Error("Replay forbids TEST_ENV_PIN=0");
pinTestEnv(process.env);
delete process.env.DATABASE_URL;
process.env.BOT_TURN_TRACE_ENABLED = "0";
process.env.BOT_PROPERTY_CONTEXT_ENABLED = "0";
process.env.TZ = "UTC";
export const offlineLedger = new ReplayLedger(persistViolation);
let model: ScriptedModel | undefined;
export function useModel(script: readonly ScriptedResult[]) { model = new ScriptedModel(script, offlineLedger); return model; }
installOfflineSandbox(offlineLedger); // Keep original provider I/O denied until this isolated worker exits.
const tasks = new ReplayTasks();
export async function assertOfflineDrained(): Promise<void> {
  const { drainBackgroundTasks } = await import("../../src/lib/shutdownState.js");
  await drainBackgroundTasks(1000);
  tasks.assertSettled(offlineLedger);
}
// doMock is intentional: register before dynamic runtime import without ever
// evaluating loadEnv/db. No read/write ORM emulation or production connection.
vi.doMock("../../src/loadEnv.js", () => ({}));
const emptyReads = new Set(["property.findMany", "botLesson.findMany", "styleExample.findMany", "street.findMany", "landmark.findMany", "microdistrict.findMany", "livingArea.findMany", "geoAlias.findMany", "district.findMany"]);
const prisma = offlineDatabase(offlineLedger, { ...Object.fromEntries([...emptyReads].map((operation) => [operation, () => []])),
  "settings.findUnique": () => ({ usdToTjsRate: 11, botSystemPrompt: null, workHoursStart: "09:30", workHoursEnd: "18:00", companyDaysOff: [], sellerMaxQuestions: 3, sellerNotSelling: [], sellerAdvantages: [] }) });
vi.doMock("../../src/db.js", () => ({ prisma }));
vi.doMock("../../src/lib/shutdownState.js", async () => {
  const original = await vi.importActual<typeof import("../../src/lib/shutdownState.js")>("../../src/lib/shutdownState.js");
  return { ...original, trackBackgroundTask: <T>(promise: Promise<T>) => {
    tasks.track(promise); return original.trackBackgroundTask(promise);
  } };
});
vi.doMock("../../src/ai/client.js", async () => ({
  ...(await vi.importActual<typeof import("../../src/ai/client.js")>("../../src/ai/client.js")),
  callAiText: async (input: { endpoint: string }) => model ? model.call(input.endpoint) : offlineLedger.deny("model", "missing-script"),
}));
vi.doMock("../../src/lib/systemError.js", async () => ({
  ...(await vi.importActual<typeof import("../../src/lib/systemError.js")>("../../src/lib/systemError.js")),
  logSystemError: async () => { offlineLedger.record("diagnostic", "virtual-log", true); },
}));
vi.doMock("../../src/ai/guardMetrics.js", async () => ({
  ...(await vi.importActual<typeof import("../../src/ai/guardMetrics.js")>("../../src/ai/guardMetrics.js")),
  guardFired: () => { offlineLedger.record("diagnostic", "virtual-guard-counter", true); },
}));
afterAll(async () => {
  await assertOfflineDrained(); offlineLedger.assertClean();
});
