import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";
import { cleanupSomonReceipts, finishSomonDelivery, reserveSomonDelivery } from "../src/lib/somonLeads/deliveryStore.js";
import { claimSomonRequest, recordSomonResponse } from "../src/lib/somonLeads/sourceBudgetStore.js";
import { replaceSomonRecipients } from "../src/lib/somonLeads/recipients.js";
import { finishShrunkBaseline, recordBaselinePage, recordNewObservations } from "../src/lib/somonLeads/discoveryStore.js";
import { somonKeyFingerprint } from "../src/lib/somonLeads/contactIdentity.js";
import { fetchSomon } from "../src/lib/somonLeads/sourceClient.js";

const prefix = "stand-somon-owner-";
const ids = [prefix + "a", prefix + "b"];
let previousMonitor: Awaited<ReturnType<typeof prisma.somonMonitor.findUnique>> = null;
let previousRecipients: Awaited<ReturnType<typeof prisma.somonRecipient.findMany>> = [];

describe("Somon durable delivery reservation", () => {
  beforeAll(async () => {
    vi.stubEnv("SETTINGS_ENCRYPTION_KEY", "1".repeat(64));
    previousMonitor = await prisma.somonMonitor.findUnique({ where: { id: "singleton" } });
    previousRecipients = await prisma.somonRecipient.findMany();
    await prisma.somonRecipient.deleteMany();
    await prisma.somonContactReceipt.deleteMany({ where: { agentId: { in: ids } } });
    await prisma.somonDelivery.deleteMany({ where: { advertId: { in: ["987650001", "987650002", "987650003", "987650004"] } } });
    await prisma.somonSeenAdvert.deleteMany({ where: { advertId: { in: ["987650001", "987650002", "987650003", "987650004"] } } });
    await prisma.somonSeenAdvert.deleteMany({ where: { advertId: { in: ["987650008", "987650009"] } } });
    await prisma.client.deleteMany({ where: { id: "stand-somon-existing-client" } });
    await prisma.somonRecipient.deleteMany({ where: { agentId: { in: ids } } });
    await prisma.agent.deleteMany({ where: { id: { in: ids } } });
    await prisma.agent.createMany({ data: ids.map((id, i) => ({ id, fullName: `Test Agent ${i}`, phone: `stand-somon-${i}`, telegramChatId: `stand-chat-${i}`, role: "AGENT" })) });
    await prisma.somonRecipient.createMany({ data: ids.map((agentId, position) => ({ agentId, position: 40000 + position })) });
    await prisma.somonMonitor.upsert({ where: { id: "singleton" }, create: { id: "singleton", enabled: true, activatedAt: new Date("2026-10-27T10:00:00Z"), baselineAt: new Date("2026-10-27T10:00:00Z") }, update: { enabled: true, activatedAt: new Date("2026-10-27T10:00:00Z"), baselineAt: new Date("2026-10-27T10:00:00Z"), lastAssignedAgentId: null } });
    await prisma.somonMonitor.update({ where: { id: "singleton" }, data: { contactKeyFingerprint: somonKeyFingerprint() } });
    await prisma.somonSeenAdvert.createMany({ data: [
      { advertId: "987650001", baseline: true, status: "BASELINE" },
      { advertId: "987650002", seenAt: new Date("2026-10-27T10:00:01Z"), slug: "987650002_example" },
      { advertId: "987650003", seenAt: new Date("2026-10-27T10:00:01Z"), slug: "987650003_example" },
      { advertId: "987650008", seenAt: new Date("2026-10-27T10:00:01Z"), slug: "987650008_example" },
      { advertId: "987650009", seenAt: new Date("2026-10-27T10:00:01Z"), slug: "987650009_example" },
    ] });
    await prisma.client.create({ data: { id: "stand-somon-existing-client", fullName: "Stand client", phone: "992900000003", source: "WEBSITE" } });
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    await prisma.somonContactReceipt.deleteMany({ where: { agentId: { in: ids } } });
    await prisma.somonDelivery.deleteMany({ where: { advertId: { in: ["987650001", "987650002", "987650003", "987650004"] } } });
    await prisma.somonSeenAdvert.deleteMany({ where: { advertId: { in: ["987650001", "987650002", "987650003", "987650004"] } } });
    await prisma.somonSeenAdvert.deleteMany({ where: { advertId: { in: ["987650005", "987650006", "987650007"] } } });
    await prisma.somonSeenAdvert.deleteMany({ where: { advertId: { in: ["987650008", "987650009"] } } });
    await prisma.client.deleteMany({ where: { id: "stand-somon-existing-client" } });
    await prisma.somonRecipient.deleteMany();
    if (previousRecipients.length) await prisma.somonRecipient.createMany({ data: previousRecipients });
    await prisma.agent.deleteMany({ where: { id: { in: ids } } });
    if (previousMonitor) await prisma.somonMonitor.update({ where: { id: "singleton" }, data: previousMonitor });
    else await prisma.somonMonitor.deleteMany({ where: { id: "singleton" } });
  });
  it("never sends a baseline listing or a verified old listing", async () => {
    expect((await reserveSomonDelivery("987650001", "+992900000001", { kind: "uncertain" })).status).toBe("not_new");
    expect((await reserveSomonDelivery("987650002", "+992900000001", { kind: "verified", publishedAt: new Date("2026-10-26T10:00:00Z") })).status).toBe("not_new");
  });
  it("stops matching if the contact hash key changes", async () => {
    vi.stubEnv("SETTINGS_ENCRYPTION_KEY", "2".repeat(64));
    expect((await reserveSomonDelivery("987650002", "+992900000001", { kind: "uncertain" }, new Date("2026-10-27T10:01:00Z"))).status).toBe("disabled");
    vi.stubEnv("SETTINGS_ENCRYPTION_KEY", "1".repeat(64));
  });
  it("serializes simultaneous reservations, retains ambiguous outcomes, and alternates agents", async () => {
    const date = new Date("2026-10-27T10:00:01Z");
    const now = new Date("2026-10-27T10:01:00Z");
    const both = await Promise.all([reserveSomonDelivery("987650002", "+992900000001", { kind: "uncertain" }, now), reserveSomonDelivery("987650002", "+992900000001", { kind: "uncertain" }, now)]);
    expect(both.map(x => x.status).sort()).toEqual(["duplicate", "reserved"]);
    const first = both.find(x => x.status === "reserved");
    expect(first?.status === "reserved" && first.agentId).toBe(ids[0]);
    expect(await finishSomonDelivery("987650002", "UNKNOWN")).toBe(true);
    expect((await prisma.somonDelivery.findUnique({ where: { advertId: "987650002" } }))?.dateUncertain).toBe(true);
    expect((await reserveSomonDelivery("987650002", "+992900000001", { kind: "uncertain" }, now)).status).toBe("duplicate");
    const second = await reserveSomonDelivery("987650003", "+992900000002", { kind: "verified", publishedAt: date }, now);
    expect(second.status === "reserved" && second.agentId).toBe(ids[1]);
    expect((await reserveSomonDelivery("987650008", "+992900000001", { kind: "uncertain" }, now)).status).toBe("known_contact");
    expect((await reserveSomonDelivery("987650009", "+992900000003", { kind: "uncertain" }, now)).status).toBe("known_contact");
  });
  it("shares request budget and pauses after 429 or 403", async () => {
    const now = new Date("2026-10-27T12:00:00Z");
    await prisma.somonMonitor.update({ where: { id: "singleton" }, data: { blockedUntil: null, sourceStopped: false, requestLeaseToken: null, requestLeaseUntil: null } });
    const claims = await Promise.all([claimSomonRequest(now, 5000), claimSomonRequest(now, 5000)]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    const token = claims.find((x): x is string => !!x)!;
    expect(await claimSomonRequest(new Date(now.getTime() + 6000), 5000)).toBeNull();
    await recordSomonResponse(token, 429, now, 120000);
    expect(await claimSomonRequest(new Date(now.getTime() + 119999), 5000)).toBeNull();
    await recordSomonResponse(token, 403, now);
    expect(await claimSomonRequest(new Date(now.getTime() + 200000), 5000)).toBeNull();
  });
  it("never calls another host and persists the source's retry pause", async () => {
    const fake = vi.fn().mockResolvedValue(new Response("", { status: 429, headers: { "retry-after": "120" } }));
    await expect(fetchSomon("https://example.com/", new Date(), fake)).rejects.toThrow("Invalid Somon source path");
    expect(fake).not.toHaveBeenCalled();
    await prisma.somonMonitor.update({ where: { id: "singleton" }, data: { enabled: true, blockedUntil: null, sourceStopped: false, requestLeaseToken: null, requestLeaseUntil: null } });
    const before = Date.now();
    await expect(fetchSomon("/api/items/get_phone/123/", new Date(), fake)).rejects.toMatchObject({ status: 429 });
    const state = await prisma.somonMonitor.findUniqueOrThrow({ where: { id: "singleton" } });
    expect(state.blockedUntil!.getTime()).toBeGreaterThanOrEqual(before + 120000);
    expect(state.requestLeaseToken).toBeNull();
  });
  it("updates the selected order and rejects invalid agents without deleting the list", async () => {
    await replaceSomonRecipients([ids[1], ids[0]]);
    expect((await prisma.somonRecipient.findMany({ orderBy: { position: "asc" } })).map(x => x.agentId)).toEqual([ids[1], ids[0]]);
    await expect(replaceSomonRecipients(["stand-nonexistent"])).rejects.toThrow();
    expect(await prisma.somonRecipient.count()).toBe(2);
  });
  it("does not release a newer source lease when an older request finishes late", async () => {
    const now = new Date("2026-10-27T12:00:00Z");
    await prisma.somonMonitor.update({ where: { id: "singleton" }, data: { enabled: true, blockedUntil: null, sourceStopped: false, requestLeaseToken: null, requestLeaseUntil: null } });
    const first = await claimSomonRequest(now, 5000);
    const second = await claimSomonRequest(new Date(now.getTime() + 21000), 5000);
    expect(first).toBeTruthy(); expect(second).toBeTruthy();
    await recordSomonResponse(first!, 403, new Date(now.getTime() + 22000));
    const state = await prisma.somonMonitor.findUniqueOrThrow({ where: { id: "singleton" } });
    expect(state.sourceStopped).toBe(true);
    expect(state.requestLeaseToken).toBe(second);
  });
  it("backs off repeatedly and stops after five source failures", async () => {
    await prisma.somonMonitor.update({ where: { id: "singleton" }, data: { enabled: true, blockedUntil: null, sourceStopped: false, sourceFailures: 0, requestLeaseToken: null, requestLeaseUntil: null } });
    let now = new Date("2026-10-27T12:00:00Z");
    for (let i = 0; i < 5; i++) {
      const token = await claimSomonRequest(now, 5000);
      expect(token).toBeTruthy();
      await recordSomonResponse(token!, 429, now);
      const state = await prisma.somonMonitor.findUniqueOrThrow({ where: { id: "singleton" } });
      expect(state.sourceFailures).toBe(i + 1);
      expect(state.blockedUntil!.getTime() - now.getTime()).toBeGreaterThanOrEqual(60000 * 2 ** i);
      now = new Date(state.blockedUntil!.getTime() + 1);
    }
    expect((await prisma.somonMonitor.findUniqueOrThrow({ where: { id: "singleton" } })).sourceStopped).toBe(true);
    expect(await claimSomonRequest(now, 5000)).toBeNull();
  });
  it("does not reset source failures when successful pages alternate with 429", async () => {
    await prisma.somonMonitor.update({ where: { id: "singleton" }, data: { enabled: true, blockedUntil: null, sourceStopped: false, sourceFailures: 0, sourceLastFailureAt: null, requestLeaseToken: null, requestLeaseUntil: null } });
    let now = new Date("2026-10-27T12:00:00Z");
    for (let i = 0; i < 5; i++) {
      const token = await claimSomonRequest(now, 5000);
      await recordSomonResponse(token!, 429, now);
      const state = await prisma.somonMonitor.findUniqueOrThrow({ where: { id: "singleton" } });
      expect(state.sourceFailures).toBe(i + 1);
      if (i === 4) { expect(state.sourceStopped).toBe(true); break; }
      now = new Date(state.blockedUntil!.getTime() + 1);
      const success = await claimSomonRequest(now, 5000);
      await recordSomonResponse(success!, 200, now);
      now = new Date(now.getTime() + 5001);
    }
  });
  it("cleans accepted records while retaining uncertain attempts", async () => {
    const old = new Date("2026-08-01T00:00:00Z");
    await prisma.somonDelivery.createMany({ data: [
      { advertId: "987650001", agentId: ids[0], status: "ACCEPTED", updatedAt: old },
      { advertId: "987650004", agentId: ids[0], status: "UNKNOWN", updatedAt: old },
    ] });
    expect(await cleanupSomonReceipts(new Date("2026-10-27T00:00:00Z"))).toBe(1);
    expect(await prisma.somonDelivery.findUnique({ where: { advertId: "987650004" } })).not.toBeNull();
  });
  it("does not admit listings until the baseline scan completes", async () => {
    const start = new Date("2026-10-27T10:00:00Z"), later = new Date("2026-10-27T10:00:01Z");
    await prisma.somonSeenAdvert.deleteMany({ where: { advertId: { in: ["987650005", "987650006", "987650007"] } } });
    await prisma.somonMonitor.update({ where: { id: "singleton" }, data: { baselineAt: null, activatedAt: null, baselineNextPage: 1, baselineLastPage: null } });
    expect(await recordBaselinePage(1, 2, ["987650005"], start)).toBe("saved");
    expect(await recordNewObservations([{ id: "987650007", slug: "987650007_example" }], later)).toBe(0);
    expect(await recordBaselinePage(2, 2, ["987650006"], start)).toBe("complete");
    expect(await recordNewObservations([{ id: "987650005", slug: "987650005_example" }, { id: "987650007", slug: "987650007_example" }], later)).toBe(1);
    expect((await prisma.somonSeenAdvert.findUnique({ where: { advertId: "987650005" } }))?.status).toBe("BASELINE");
  });
  it("finishes a shrinking baseline only after the new end is below the cursor", async () => {
    const now = new Date("2026-10-27T10:00:00Z");
    await prisma.somonMonitor.update({ where: { id: "singleton" }, data: { enabled: true, baselineAt: null, activatedAt: null, baselineNextPage: 1, baselineLastPage: null } });
    await recordBaselinePage(1, 3, ["987650005"], now);
    expect(await finishShrunkBaseline(2, 2, now)).toBe(false);
    expect(await finishShrunkBaseline(2, 1, now)).toBe(true);
  });
});

