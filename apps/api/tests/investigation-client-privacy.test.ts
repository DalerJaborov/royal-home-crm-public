import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { signAccessToken } from "../src/auth/jwt.js";

const run = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const privateText = `private-investigation-evidence-${run}`;
const publicText = "Клиент просит квартиру с балконом";
const agentIds: string[] = [];
let clientId: string;
let clientShortId: number;
let publicId: string;
let privateId: string;
let agentToken: string;
let adminToken: string;
let securityToken: string;
let managerToken: string;

beforeAll(async () => {
  for (const role of ["AGENT", "ADMIN", "SECURITY", "MANAGER"] as const) {
    const agent = await prisma.agent.create({ data: {
      fullName: `Investigation fixture ${role} ${run}`, phone: `test-investigation-${role}-${run}`,
      passwordHash: "test-placeholder", role,
      // A grant cannot reopen the protected audience for the old SECURITY role.
      ...(role === "SECURITY" ? { permissions: { granted: ["clients.securityReview"], revoked: [] } } : {}),
    } });
    agentIds.push(agent.id);
    const token = signAccessToken({ sub: agent.id, role });
    if (role === "AGENT") agentToken = token;
    if (role === "ADMIN") adminToken = token;
    if (role === "SECURITY") securityToken = token;
    if (role === "MANAGER") managerToken = token;
  }
  const client = await prisma.client.create({ data: {
    fullName: `Investigation privacy fixture ${run}`, phone: `test-client-${run}`,
    source: "PHONE_CALL", kind: "BUYER", assignedAgentId: agentIds[0], acceptedAt: new Date(),
    securityReview: "PENDING", securityNote: privateText, securityReviewedById: agentIds[1],
  } });
  clientId = client.id;
  clientShortId = client.shortId;
  publicId = (await prisma.interaction.create({ data: {
    clientId, agentId: agentIds[0], type: "CALL", notes: publicText, transcript: publicText,
  } })).id;
  privateId = (await prisma.interaction.create({ data: {
    clientId, agentId: agentIds[0], type: "CALL", investigationOnly: true,
    notes: privateText, transcript: privateText, transcriptRu: privateText,
    nextAction: privateText, nextActionDate: new Date(Date.now() + 86_400_000),
    recordingUrl: "test-investigation/private-recording.mp3",
    recordingDurationSec: 86400,
  } })).id;
  await prisma.showingSurveyCall.create({ data: {
    interactionId: privateId, clientId, agentId: agentIds[0], redFlags: [{ category: "test", detail: privateText }],
  } });
});

afterAll(async () => {
  if (clientId) {
    await prisma.showingSurveyCall.deleteMany({ where: { clientId } });
    await prisma.interaction.deleteMany({ where: { clientId } });
    await prisma.client.deleteMany({ where: { id: clientId } });
  }
  await prisma.agent.deleteMany({ where: { id: { in: agentIds } } });
});

const get = (path: string, token: string) => request(app).get(`/api/v1${path}`).set("Authorization", `Bearer ${token}`);

describe("private investigations are absent from ordinary client surfaces", () => {
  it("property activity hides a private showing before counting", async () => {
    const showing = await prisma.interaction.create({ data: {
      clientId, agentId: agentIds[0], type: "SHOWING", investigationOnly: true, notes: privateText,
    } });
    try {
      const agent = await get(`/clients/${clientId}/property-activity?section=showings`, agentToken);
      expect(agent.status).toBe(200);
      expect(agent.body.total).toBe(0);
      expect(agent.body.items).toEqual([]);
      const admin = await get(`/clients/${clientId}/property-activity?section=showings`, adminToken);
      expect(admin.status).toBe(200);
      expect(admin.body.total).toBe(1);
      expect(admin.body.items[0].id).toBe(showing.id);
    } finally {
      await prisma.interaction.delete({ where: { id: showing.id } });
    }
  });
  it("manager employee overview and live activity exclude investigations, while admin retains flags", async () => {
    const overview = await get(`/agents/${agentIds[0]}/overview`, managerToken);
    expect(overview.status).toBe(200);
    expect(overview.body.violations).toEqual({ flaggedShowingCalls: 0, lastFlags: [] });
    expect(overview.body.activity.recentInteractions.map((row: { id: string }) => row.id)).toEqual([publicId]);
    expect(JSON.stringify(overview.body)).not.toContain(privateText);
    const live = await get(`/agents/${agentIds[0]}/live`, managerToken);
    expect(live.status).toBe(200);
    expect(live.body.calls.weekTotal).toBe(1);
    expect(live.body.calls.last.map((row: { id: string }) => row.id)).toEqual([publicId]);
    expect(live.body.now.nextTask).toBeNull();
    const admin = await get(`/agents/${agentIds[0]}/overview`, adminToken);
    expect(admin.status).toBe(200);
    expect(admin.body.violations.flaggedShowingCalls).toBe(1);
    expect(JSON.stringify(admin.body.violations)).toContain(privateText);
  });
  it("default agent sees ordinary history and accurate public count, without private metadata or placeholder", async () => {
    const res = await get(`/clients/${clientShortId}`, agentToken);
    expect(res.status).toBe(200);
    expect(res.body.interactions.map((row: { id: string }) => row.id)).toEqual([publicId]);
    expect(res.body.interactionsTotal).toBe(1);
    expect(res.body.callsCount).toBe(1);
    expect(res.body.hadRealCall).toBe(false);
    expect(res.body.nextStep).toBeNull();
    for (const key of ["securityReview", "securityNote", "securityReviewedAt", "securityReviewedById"]) {
      expect(res.body).not.toHaveProperty(key);
    }
    expect(JSON.stringify(res.body)).not.toContain(privateText);
    expect(JSON.stringify(res.body)).not.toContain(privateId);
  });

  it("all-mine search does not expose security state or hidden reason", async () => {
    const res = await get(`/clients?scope=allMine&search=${encodeURIComponent(run)}`, agentToken);
    expect(res.status).toBe(200);
    const row = res.body.items.find((item: { id: string }) => item.id === clientId);
    expect(row).toBeDefined();
    expect(row).not.toHaveProperty("securityReview");
    expect(row).not.toHaveProperty("securityNote");
    expect(row.hiddenReason?.kind).not.toBe("securityReview");
    expect(row.nextStep).toBeNull();
    expect(JSON.stringify(row)).not.toContain(privateText);
  });

  it("paginated timeline count and cursor do not disclose a hidden event", async () => {
    const res = await get(`/clients/${clientShortId}/timeline?limit=1`, agentToken);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.hasMore).toBe(false);
    expect(res.body.items.map((row: { id: string }) => row.id)).toEqual([publicId]);
    expect(JSON.stringify(res.body)).not.toContain(privateText);
  });

  it("activity feed and summary count public events before pagination", async () => {
    const feed = await get("/interactions", agentToken);
    expect(feed.status).toBe(200);
    expect(feed.body.total).toBe(1);
    expect(feed.body.items.map((row: { id: string }) => row.id)).toEqual([publicId]);
    const summary = await get("/interactions/summary", agentToken);
    expect(summary.status).toBe(200);
    expect(summary.body.total).toBe(1);
  });

  it("administrator retains full card, timeline count and transcript", async () => {
    const card = await get(`/clients/${clientShortId}`, adminToken);
    expect(card.status).toBe(200);
    expect(card.body.securityReview).toBe("PENDING");
    expect(card.body.securityNote).toBe(privateText);
    expect(card.body.interactionsTotal).toBe(2);
    expect(card.body.callsCount).toBe(2);
    expect(card.body.interactions.map((row: { id: string }) => row.id)).toContain(privateId);
    const timeline = await get(`/clients/${clientShortId}/timeline?limit=1`, adminToken);
    expect(timeline.status).toBe(200);
    expect(timeline.body.total).toBe(2);
    expect(timeline.body.hasMore).toBe(true);
    const transcript = await get(`/interactions/${privateId}/transcript`, adminToken);
    expect(transcript.status).toBe(200);
    expect(JSON.stringify(transcript.body)).toContain(privateText);
  });

  it.each(["agent", "security"] as const)("%s cannot fetch private recording/transcript by a known ID", async role => {
    const token = role === "agent" ? agentToken : securityToken;
    for (const suffix of ["recording", "transcript"]) {
      const res = await get(`/interactions/${privateId}/${suffix}`, token);
      expect(res.status).toBe(404);
      expect(JSON.stringify(res.body)).not.toContain(privateText);
      expect(JSON.stringify(res.body)).not.toContain("investigation");
    }
  });

  it("ordinary own transcript remains readable", async () => {
    const res = await get(`/interactions/${publicId}/transcript`, agentToken);
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).toContain(publicText);
  });
});
