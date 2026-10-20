import { afterAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import bcrypt from "bcrypt";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { abortLocalUploadSession } from "../src/lib/localVideoStorage.js";
import { uploadsDir, thumbsDir } from "../src/upload.js";

const route = "/api/v1/properties/drafts/current";
const agents: string[] = [];
const clients: string[] = [];
const sessions: string[] = [];
const properties: string[] = [];
const generatedFiles: string[] = [];
let sequence = 0;
const suffix = String(Date.now()).slice(-6);

async function actor() {
  const phone = `+99291${suffix}${++sequence}`;
  const row = await prisma.agent.create({ data: { fullName: "Draft lifecycle integration", phone, passwordHash: await bcrypt.hash("testpass123", 4), role: "AGENT" } });
  agents.push(row.id);
  vi.stubEnv("LOGIN_CODE_DEV_ECHO", "1");
  const issued = await request(app).post("/api/v1/auth/login/code").send({ phone });
  expect(issued.status).toBe(200); expect(issued.body.devCode).toMatch(/^\d{6}$/);
  const login = await request(app).post("/api/v1/auth/login/verify-code").send({ pendingToken: issued.body.pendingToken, code: issued.body.devCode });
  expect(login.status).toBe(200);
  const auth = `Bearer ${login.body.accessToken}`;
  return { id: row.id, auth };
}
async function start(auth: string, revision = 0) {
  const sessionId = randomUUID();
  const res = await request(app).post(`${route}/start`).set("Authorization", auth).send({ sessionId, revision });
  expect(res.status).toBe(200);
  return res.body.draft;
}

afterAll(async () => {
  for (const id of sessions) await abortLocalUploadSession(id);
  await prisma.propertyDraft.deleteMany({ where: { agentId: { in: agents } } });
  await prisma.property.deleteMany({ where: { id: { in: properties } } });
  for (const file of generatedFiles) fs.rmSync(file, { force: true });
  await prisma.client.deleteMany({ where: { assignedAgentId: { in: agents } } });
  await prisma.client.deleteMany({ where: { id: { in: clients } } });
  await prisma.agent.deleteMany({ where: { id: { in: agents } } });
  await prisma.$disconnect();
  vi.unstubAllEnvs();
});

describe("versioned draft lifecycle with real PostgreSQL", () => {
  it("deleting an empty server also blocks a first legacy autosave already in flight", async () => {
    const a = await actor();
    const deleted = await request(app).delete(route).set("Authorization", a.auth);
    expect(deleted.status).toBe(204);
    const late = await request(app).put(route).set("Authorization", a.auth).send({ values: { address: "Late first draft" }, step: 0 });
    expect(late.status).toBe(409);
    expect((await request(app).get(route).set("Authorization", a.auth)).body.draft).toBeNull();
  });
  it("a late PUT and a delayed START cannot resurrect a deleted session", async () => {
    const a = await actor(); const draft = await start(a.auth);
    const deleted = await request(app).delete(route).set("Authorization", a.auth).send({ draftId: draft.id, revision: draft.revision });
    expect(deleted.status).toBe(200);
    expect(deleted.body).toEqual({ draft: null, revision: draft.revision + 1 });
    const late = await request(app).put(route).set("Authorization", a.auth).send({ draftId: draft.id, revision: draft.revision, values: { address: "Late address" }, step: 3 });
    expect(late.status).toBe(409); expect(late.body.code).toBe("DRAFT_CONFLICT");
    const delayedStart = await request(app).post(`${route}/start`).set("Authorization", a.auth).send({ sessionId: draft.id, revision: deleted.body.revision });
    expect(delayedStart.status).toBe(409);
    const state = await request(app).get(route).set("Authorization", a.auth);
    expect(state.body).toEqual({ draft: null, revision: deleted.body.revision });
    const next = await start(a.auth, deleted.body.revision);
    expect(next.revision).toBe(deleted.body.revision + 1);
    const oldAgain = await request(app).put(route).set("Authorization", a.auth).send({ draftId: draft.id, revision: draft.revision, values: { address: "Old session" }, step: 0 });
    expect(oldAgain.status).toBe(409);
    const legacy = await request(app).put(route).set("Authorization", a.auth).send({ values: { address: "Missing proof" }, step: 0 });
    expect(legacy.status).toBe(409);
  });

  it("concurrent autosaves accept one revision and reject the stale write", async () => {
    const a = await actor(); const draft = await start(a.auth);
    const saves = await Promise.all(["First", "Second"].map(address => request(app).put(route).set("Authorization", a.auth).send({ draftId: draft.id, revision: draft.revision, values: { address }, step: 2 })));
    expect(saves.map(r => r.status).sort()).toEqual([200, 409]);
    const current = await request(app).get(route).set("Authorization", a.auth);
    expect(current.body.draft.revision).toBe(draft.revision + 1);
    expect(current.body.draft.values.address).toBe(saves.find(r => r.status === 200)!.body.draft.values.address);
  });

  it("stale or missing media generation cannot enter a new draft", async () => {
    const a = await actor(); const draft = await start(a.auth);
    for (const header of [undefined, randomUUID()]) {
      const req = request(app).post(`${route}/videos/sessions`).set("Authorization", a.auth);
      if (header) req.set("X-Property-Draft-Id", header);
      const res = await req.send({ uploadKey: randomUUID(), filename: "test.mp4", sizeBytes: 1, contentType: "video/mp4" });
      expect(res.status).toBe(409);
    }
    expect(await prisma.propertyDraftMedia.count({ where: { draftId: draft.id } })).toBe(0);
  });

  it("parallel video parts retain both acknowledgments and reject wrong byte lengths", async () => {
    const a = await actor(); const draft = await start(a.auth);
    const opened = await request(app).post(`${route}/videos/sessions`).set("Authorization", a.auth).set("X-Property-Draft-Id", draft.id).send({ uploadKey: randomUUID(), filename: "two-parts.mp4", sizeBytes: 8388609, contentType: "video/mp4" });
    expect(opened.status).toBe(201); const mediaId = opened.body.mediaId; sessions.push(mediaId);
    const bad = await request(app).put(`${route}/videos/${mediaId}/parts/1`).set("Authorization", a.auth).set("X-Property-Draft-Id", draft.id).set("Content-Type", "application/octet-stream").send(Buffer.alloc(1));
    expect(bad.status).toBe(400);
    const uploaded = await Promise.all([Buffer.alloc(8388608), Buffer.alloc(1)].map((buffer, n) => request(app).put(`${route}/videos/${mediaId}/parts/${n+1}`).set("Authorization", a.auth).set("X-Property-Draft-Id", draft.id).set("Content-Type", "application/octet-stream").send(buffer)));
    expect(uploaded.map(r => r.status)).toEqual([200, 200]);
    expect((await prisma.propertyDraftMedia.findUniqueOrThrow({ where: { id: mediaId } })).parts).toEqual([{ partNumber: 1 }, { partNumber: 2 }]);
  });

  it("a failed DELETE returns an error and leaves recoverable state", async () => {
    const a = await actor(); const draft = await start(a.auth);
    const failedTransaction = vi.spyOn(prisma, "$transaction").mockRejectedValueOnce(new Error("simulated database failure"));
    try {
      const res = await request(app).delete(route).set("Authorization", a.auth).send({ draftId: draft.id, revision: draft.revision });
      expect(res.status).toBe(500);
    } finally { failedTransaction.mockRestore(); }
    const row = await prisma.propertyDraft.findUniqueOrThrow({ where: { id: draft.id } });
    expect(row.closedAt).toBeNull(); expect(row.revision).toBe(draft.revision);
  });

  it("GET and nightly expiry use the same active-upload protection", async () => {
    const a = await actor(); const draft = await start(a.auth);
    await prisma.propertyDraft.update({ where: { id: draft.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const media = await prisma.propertyDraftMedia.create({ data: { draftId: draft.id, kind: "VIDEO", status: "UPLOADING", uploadKey: randomUUID(), filename: "active.mp4", contentType: "video/mp4", sizeBytes: 1 } });
    const active = await request(app).get(route).set("Authorization", a.auth);
    expect(active.body.draft.id).toBe(draft.id);
    await prisma.$executeRaw`UPDATE "PropertyDraftMedia" SET "updatedAt" = ${new Date(Date.now() - 7 * 3600000)} WHERE "id" = ${media.id}`;
    const expired = await request(app).get(route).set("Authorization", a.auth);
    expect(expired.body.draft).toBeNull();
    expect((await prisma.propertyDraft.findUniqueOrThrow({ where: { id: draft.id } })).closedAt).not.toBeNull();
  });

  it("seller import protects another text draft and merges manual corrections", async () => {
    const a = await actor(); const draft = await start(a.auth);
    const seller = await prisma.client.create({ data: { fullName: "Import seller", phone: `+99292${suffix}${++sequence}`, kind: "SELLER", source: "WALK_IN", assignedAgentId: a.id, acceptedAt: new Date(), address: "Imported address" } });
    clients.push(seller.id);
    const saved = await request(app).put(route).set("Authorization", a.auth).send({ draftId: draft.id, revision: draft.revision, values: { address: "Manual address", price: "900000", documentsOther: "Manual document" }, step: 4 });
    const reference = { draftId: draft.id, revision: saved.body.draft.revision };
    const conflict = await request(app).post(`/api/v1/properties/drafts/from-client/${seller.id}`).set("Authorization", a.auth).send(reference);
    expect(conflict.status).toBe(409); expect(conflict.body.code).toBe("DRAFT_REPLACE_CONFIRM");
    expect(conflict.body.draft.values.price).toBe("900000");
    const merged = await request(app).post(`/api/v1/properties/drafts/from-client/${seller.id}`).set("Authorization", a.auth).send({ ...reference, mode: "merge" });
    expect(merged.status).toBe(200);
    expect(merged.body.draft.values).toMatchObject({ address: "Manual address", price: "900000", documentsOther: "Manual document", sellerClientId: seller.id });
    expect(merged.body.draft.step).toBe(4);
    const repeated = await request(app).post(`/api/v1/properties/drafts/from-client/${seller.id}`).set("Authorization", a.auth).send({ draftId: draft.id, revision: merged.body.draft.revision });
    expect(repeated.status).toBe(200); expect(repeated.body.draft.values.address).toBe("Manual address");
  });

  it("create rejects stale revisions before insertion and consumes a current draft atomically", async () => {
    const a = await actor(); const draft = await start(a.auth);
    const saved = await request(app).put(route).set("Authorization", a.auth).send({ draftId: draft.id, revision: draft.revision, values: { price: "400000" }, step: 4 });
    const body = { type: "APARTMENT", areaSqm: 60, price: 400000, currency: "TJS", condition: "GOOD", rooms: 2, floor: 3, totalFloors: 9, windowCount: 4, ownerContact: `+99293${suffix}${++sequence}`, offSite: true, draftId: draft.id };
    const stale = await request(app).post("/api/v1/properties").set("Authorization", a.auth).send({ ...body, draftRevision: draft.revision });
    expect(stale.status).toBe(409);
    expect(await prisma.property.count({ where: { createdById: a.id } })).toBe(0);
    const created = await request(app).post("/api/v1/properties").set("Authorization", a.auth).send({ ...body, draftRevision: saved.body.draft.revision });
    expect(created.status).toBe(201); properties.push(created.body.id);
    const consumed = await prisma.propertyDraft.findUniqueOrThrow({ where: { agentId: a.id } });
    expect(consumed.closedAt).not.toBeNull(); expect(consumed.revision).toBe(saved.body.draft.revision + 1);
    const repeated = await request(app).post("/api/v1/properties").set("Authorization", a.auth).send({ ...body, draftRevision: saved.body.draft.revision });
    expect(repeated.status).toBe(409);
    expect(await prisma.property.count({ where: { createdById: a.id } })).toBe(1);
    const late = await request(app).put(route).set("Authorization", a.auth).send({ draftId: draft.id, revision: saved.body.draft.revision, values: { price: "400000" }, step: 4 });
    expect(late.status).toBe(409);
  });

  it("failed media transfer rolls back insertion, retains source files and allows one successful retry", async () => {
    const a = await actor(); const draft = await start(a.auth);
    const jpeg = await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 27, g: 68, b: 41 } } }).jpeg().toBuffer();
    const upload = await request(app).post(`${route}/photos`).set("Authorization", a.auth).set("X-Property-Draft-Id", draft.id)
      .field("uploadKeys", randomUUID()).attach("photos", jpeg, "rollback.jpg");
    expect(upload.status).toBe(201);
    const media = await prisma.propertyDraftMedia.findUniqueOrThrow({ where: { id: upload.body[0].id } });
    const files = [path.join(uploadsDir, path.basename(media.url!)), path.join(thumbsDir, path.basename(media.thumbUrl!))];
    generatedFiles.push(...files);
    // The draft table permits partial metadata. A READY row with a missing URL cannot
    // satisfy the target PropertyPhoto constraint, so the real transfer fails inside tx.
    await prisma.propertyDraftMedia.update({ where: { id: media.id }, data: { url: null } });
    const body = { type: "APARTMENT", areaSqm: 60, price: 410000, currency: "TJS", condition: "GOOD", rooms: 2, floor: 3, totalFloors: 9, windowCount: 4,
      ownerContact: `+99293${suffix}${++sequence}`, offSite: true, draftId: draft.id, draftRevision: draft.revision };
    const failed = await request(app).post("/api/v1/properties").set("Authorization", a.auth).send(body);
    expect(failed.status).toBe(500);
    expect(await prisma.property.count({ where: { createdById: a.id } })).toBe(0);
    const retained = await prisma.propertyDraft.findUniqueOrThrow({ where: { id: draft.id }, include: { media: true } });
    expect(retained.closedAt).toBeNull(); expect(retained.revision).toBe(draft.revision);
    expect(retained.media.map(m => m.id)).toEqual([media.id]);
    expect(files.map(file => fs.existsSync(file))).toEqual([true, true]);

    await prisma.propertyDraftMedia.update({ where: { id: media.id }, data: { url: media.url } });
    const retried = await request(app).post("/api/v1/properties").set("Authorization", a.auth).send(body);
    expect(retried.status).toBe(201); properties.push(retried.body.id);
    expect(await prisma.propertyPhoto.count({ where: { propertyId: retried.body.id } })).toBe(1);
    expect((await prisma.propertyDraft.findUniqueOrThrow({ where: { id: draft.id } })).closedAt).not.toBeNull();
    const duplicate = await request(app).post("/api/v1/properties").set("Authorization", a.auth).send(body);
    expect(duplicate.status).toBe(409);
    expect(await prisma.property.count({ where: { createdById: a.id } })).toBe(1);
  });
});
