import http from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { signAccessToken } from "../src/auth/jwt.js";
import { grantElevation, revokeElevation } from "../src/lib/stepUp.js";
import { getActive, publishAudio, publishTranscript, resetLiveVoiceMonitorForTests, sessionStarted } from "../src/lib/telephony/liveVoiceMonitor.js";

const marker = `synthetic-listen-revocation-${randomUUID()}`;
const actorIds: string[] = [];
let adminId: string;
let adminToken: string;
let server: http.Server;
let port: number;

beforeAll(async () => {
  const admin = await prisma.agent.create({ data: { fullName: marker, phone: `${marker}-admin`, role: "ADMIN", passwordHash: "synthetic-unused" } });
  adminId = admin.id;
  actorIds.push(adminId);
  adminToken = signAccessToken({ sub: adminId, role: "ADMIN" });
  grantElevation(adminId);
  server = http.createServer(app).listen(0);
  port = (server.address() as AddressInfo).port;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  revokeElevation(adminId);
  await prisma.agent.deleteMany({ where: { id: { in: actorIds } } });
});
afterEach(() => resetLiveVoiceMonitorForTests());

it.each(["permissions", "role", "deactivate", "2faReset"] as const)(
  "%s closes an already authenticated live audio stream", async (change) => {
    const listener = await prisma.agent.create({ data: {
      fullName: marker, phone: `${marker}-${change}`, role: "AGENT", passwordHash: "synthetic-unused",
      permissions: { granted: ["settings.manage", "calls.transcripts", "calls.hearRecording"], revoked: [] },
    } });
    actorIds.push(listener.id);
    const token = signAccessToken({ sub: listener.id, role: "AGENT" });
    const sessionId = randomUUID();
    sessionStarted({ key: sessionId, channelId: `synthetic-${change}`, callerNumber: null, direction: "inbound" });
    let incoming!: http.IncomingMessage;
    let outgoing!: http.ClientRequest;
    let chunks = "";
    let ended = false;
    await new Promise<void>((resolve, reject) => {
      outgoing = http.get({ port, path: `/api/v1/live-voice/${sessionId}/listen`, headers: { Authorization: `Bearer ${token}` } }, (res) => {
        incoming = res;
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => { chunks += chunk; if (chunks.includes("event: backlog")) resolve(); });
        res.on("end", () => { ended = true; });
        res.on("error", reject);
      });
      outgoing.on("error", reject);
    });
    try {
      expect(incoming.statusCode).toBe(200);
      expect(getActive(sessionId)?.listeners).toBe(1);
      const mutation = change === "permissions"
        ? request(app).put(`/api/v1/agents/${listener.id}/permissions`).send({ granted: [], revoked: [] })
        : change === "2faReset"
          ? request(app).post(`/api/v1/agents/${listener.id}/2fa/reset`).send({})
          : request(app).patch(`/api/v1/agents/${listener.id}`).send(change === "role" ? { role: "MANAGER" } : { isActive: false });
      const changed = await mutation.set("Authorization", `Bearer ${adminToken}`);
      expect(changed.status).toBe(200);
      // The completed management request must synchronously remove its listener;
      // a new transcript/audio publication may no longer reach this connection.
      expect(getActive(sessionId)?.listeners).toBe(0);
      publishTranscript(sessionId, "client", "synthetic-private-after-revoke");
      publishAudio(sessionId, "client", new Int16Array([100, 200]));
      await new Promise<void>((resolve, reject) => {
        if (ended) return resolve();
        const timeout = setTimeout(() => reject(new Error("revoked listener connection remained open")), 2000);
        incoming.once("end", () => { clearTimeout(timeout); resolve(); });
      });
      expect(chunks).not.toContain("synthetic-private-after-revoke");
      expect(chunks).not.toContain("event: audio");
      if (change !== "2faReset") {
        const reconnect = await request(app).get(`/api/v1/live-voice/${sessionId}/listen`).set("Authorization", `Bearer ${token}`);
        expect(reconnect.status).toBe(403);
      }
    } finally {
      incoming.destroy();
      outgoing.destroy();
    }
  }
);
