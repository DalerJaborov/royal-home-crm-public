// Перевод ВЕТОК КОММЕНТАРИЕВ LEGACY → ядро (шаг 3 удаления старого бота,
// решение владельца 31.10.2026) на настоящей базе и настоящем подписанном входе:
// ветка, начатая при старом боте (baseline LEGACY), при флаге и новом
// комментарии уходит в ядро поколением 1; старый handleComment её больше не
// трогает; повторы не дают второй строки, аудита или ответа; спам, ручной режим
// и незавершённая работа старого держат ветку в LEGACY; флаг выключен — как раньше.
import { createHmac, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";
import { encryptSecret } from "../src/crypto.js";
import { registerAuthenticatedMetaCustomerRequest } from "../src/lib/customerIngressAuthority.js";
import { persistVerifiedMetaPublicCommentBatch } from "../src/lib/customerPublicCommentProducer.js";
import { publicAgentCommentLane } from "../src/lib/customerPublicAgentTurn.js";
import { readCustomerPublicLegacyCutoverReadiness } from "../src/lib/customerAgentLegacyCutover.js";
import { handleComment, type QueuedComment } from "../src/messengers/comments.js";
import * as meta from "../src/messengers/meta.js";
import { createCustomerRolloutFixture } from "./helpers/customerRolloutFixture.js";

const tag = `public-cutover-${randomUUID()}`, accounts: string[] = [], resources: string[] = [], scopes: string[] = [];
let rollout: Awaited<ReturnType<typeof createCustomerRolloutFixture>>;
let savedSettings: { botEnabled: boolean; botCanAnswerComments: boolean; botInstagramEnabled: boolean; metaEnabled: boolean;
  metaVerifyToken: string | null } | null = null;

async function account() {
  const id = randomUUID(), resource = `${tag}-account-${accounts.length}`, secret = `${tag}-secret-${accounts.length}`;
  await prisma.messengerAccount.create({ data: { id, channel: "INSTAGRAM", externalId: resource, title: "Synthetic public cutover",
    token: encryptSecret(`${tag}-provider-token`), appSecret: encryptSecret(secret), enabled: true } });
  meta.resetMetaAccountCredsCache();
  accounts.push(id); resources.push(resource);
  const stamp = await rollout.allowPublic("INSTAGRAM", resource);
  scopes.push(stamp.installation.id);
  return { resource, secret, scopeId: stamp.installation.id };
}
type Account = Awaited<ReturnType<typeof account>>;
/** Настоящая подписанная доставка комментария; тот же commentId = повторная доставка. */
async function deliver(a: Account, input: { commentId: string; publication: string; parentId?: string; text: string }) {
  const rawBody = Buffer.from(JSON.stringify({ object: "instagram", entry: [{ id: a.resource, changes: [{ field: "comments", value: {
    id: input.commentId, media: { id: input.publication }, from: { id: `${tag}-author`, username: "synthetic_author" },
    text: input.text, ...(input.parentId ? { parent_id: input.parentId } : {}) } }] }] }));
  const request = { rawBody, get: (name: string) => name === "x-hub-signature-256"
    ? `sha256=${createHmac("sha256", a.secret).update(rawBody).digest("hex")}` : undefined };
  registerAuthenticatedMetaCustomerRequest(request);
  return persistVerifiedMetaPublicCommentBatch(request);
}
const comment = (commentId: string) => prisma.instagramComment.findUniqueOrThrow({ where: { commentId } });
const lanes = (scopeId: string) => prisma.$queryRaw<Array<{ id: string; lane: string; generation: number;
  supersedesAssignmentId: string | null; transitionReason: string | null }>>`
  SELECT "id","lane","generation","supersedesAssignmentId","transitionReason" FROM "CustomerAgentRolloutAssignment"
  WHERE "endpointScopeId"=${scopeId} AND "surface"='public_comment' ORDER BY "generation"`;
const audits = (scopeId: string) => prisma.auditLog.count({ where: { action: "CUSTOMER_AGENT_LANE_CUTOVER",
  meta: { path: ["endpointScopeId"], equals: scopeId } } });

/**
 * Ветка, начатая при старом боте: корневой комментарий старого движка (строка
 * без назначения, как до раскатки ядра), затем ответ в ветке — он записывается
 * в полосу как baseline LEGACY поколения 0. Старый движок его разобрал.
 */
async function legacyThread() {
  vi.stubEnv("CUSTOMER_AGENT_LEGACY_CUTOVER", "");
  const a = await account(), publication = `${tag}-publication-${randomUUID()}`, root = `${tag}-root-${randomUUID()}`;
  await prisma.instagramComment.create({ data: { channel: "INSTAGRAM", commentId: root, mediaId: publication, accountExternalId: a.resource,
    authorId: `${tag}-author`, text: "Нархаш чанд?", status: "REPLIED", replyText: "synthetic legacy reply", replyDueAt: new Date() } });
  const first = `${tag}-reply-${randomUUID()}`;
  expect(await deliver(a, { commentId: first, publication, parentId: root, text: "Ҳоло ҳам ҳаст?" })).toMatchObject({ status: "persisted" });
  const row = await comment(first);
  expect(row.status).toBe("PENDING"); expect(row.publicOriginCiphertext).toBeNull();
  expect(await publicAgentCommentLane(row.id)).toBe("legacy");
  const [original] = await lanes(a.scopeId);
  expect(original).toMatchObject({ lane: "LEGACY", generation: 0 });
  await prisma.instagramComment.update({ where: { id: row.id }, data: { status: "REPLIED", replyText: "synthetic legacy reply" } });
  return { a, publication, root, first: row, original };
}

beforeAll(async () => {
  savedSettings = await prisma.settings.findUniqueOrThrow({ where: { id: "singleton" }, select: {
    botEnabled: true, botCanAnswerComments: true, botInstagramEnabled: true, metaEnabled: true, metaVerifyToken: true } });
  await prisma.settings.update({ where: { id: "singleton" }, data: { botEnabled: true, botCanAnswerComments: true, botInstagramEnabled: true,
    metaEnabled: true, metaVerifyToken: encryptSecret(`${tag}-verify-token`) } });
  rollout = await createCustomerRolloutFixture();
  await prisma.customerRuntimePolicy.update({ where: { id: "singleton" }, data: { capabilities: { publicRead: true } } });
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Public lane cutover must not call providers"); }));
});
afterEach(() => { vi.unstubAllEnvs(); });
afterAll(async () => {
  try {
    await prisma.instagramComment.deleteMany({ where: { accountExternalId: { in: resources } } });
    await prisma.$executeRaw`DELETE FROM "CustomerAgentRolloutAssignment" WHERE "generation">0 AND "endpointScopeId" = ANY(${scopes})`;
    await prisma.$executeRaw`DELETE FROM "CustomerAgentRolloutAssignment" WHERE "endpointScopeId" = ANY(${scopes})`;
    await prisma.customerEndpointScope.deleteMany({ where: { realmKey: "customer-public", publicResourceId: { in: resources } } });
    await prisma.messengerAccount.deleteMany({ where: { id: { in: accounts } } });
  } finally {
    try {
      if (savedSettings) await prisma.settings.update({ where: { id: "singleton" }, data: savedSettings });
      await rollout?.restore();
    } finally { vi.unstubAllGlobals(); meta.resetMetaAccountCredsCache(); }
  }
});

it("flag off: a new comment of a legacy thread stays with the old engine, nothing is appended", async () => {
  const t = await legacyThread();
  const next = `${tag}-next-${randomUUID()}`;
  expect(await deliver(t.a, { commentId: next, publication: t.publication, parentId: t.root, text: "Чанд хона дорад?" })).toMatchObject({ status: "persisted" });
  const row = await comment(next);
  expect(row.publicRolloutAssignmentId).toBe(t.original.id); expect(row.publicOriginCiphertext).toBeNull();
  expect(await publicAgentCommentLane(row.id)).toBe("legacy");
  expect((await lanes(t.a.scopeId)).map(r => r.lane)).toEqual(["LEGACY"]);
  expect(await audits(t.a.scopeId)).toBe(0);
});

it("flag on: the next new comment moves the thread to the core once; the old engine is silent; redeliveries change nothing", async () => {
  const t = await legacyThread();
  vi.stubEnv("CUSTOMER_AGENT_LEGACY_CUTOVER", "on");
  const next = `${tag}-next-${randomUUID()}`;
  expect(await deliver(t.a, { commentId: next, publication: t.publication, parentId: t.root, text: "Чанд хона дорад?" })).toMatchObject({ status: "persisted" });
  const rows = await lanes(t.a.scopeId);
  expect(rows).toEqual([
    { id: t.original.id, lane: "LEGACY", generation: 0, supersedesAssignmentId: null, transitionReason: null },
    { id: expect.any(String), lane: "CORE", generation: 1, supersedesAssignmentId: t.original.id, transitionReason: "legacy_cutover_owner_31_10" },
  ]);
  const moved = await comment(next);
  expect(moved.publicRolloutAssignmentId).toBe(rows[1].id);
  expect(moved.publicOriginCiphertext).not.toBeNull(); // Ядро владеет комментарием.
  expect(await publicAgentCommentLane(moved.id)).toBe("managed"); // handleComment → ядро, не старый сценарий.
  const logged = await prisma.auditLog.findMany({ where: { action: "CUSTOMER_AGENT_LANE_CUTOVER", entityId: rows[1].id } });
  expect(logged).toHaveLength(1);
  expect(logged[0]).toMatchObject({ entityType: "CustomerAgentRolloutAssignment", agentId: null, meta: {
    fromAssignmentId: t.original.id, fromLane: "LEGACY", toLane: "CORE", reason: "legacy_cutover_owner_31_10", surface: "public_comment" } });

  // Повторная доставка нового комментария: та же строка и та же печать, без второго поколения/аудита.
  const before = moved.publicOriginCiphertext;
  expect(await deliver(t.a, { commentId: next, publication: t.publication, parentId: t.root, text: "Чанд хона дорад?" })).toMatchObject({ status: "persisted" });
  expect((await comment(next)).publicOriginCiphertext).toBe(before);
  // Повторная доставка СТАРОГО комментария ветки после перевода: не 503 навсегда и не второй ответ.
  expect(await deliver(t.a, { commentId: t.first.commentId, publication: t.publication, parentId: t.root, text: "Ҳоло ҳам ҳаст?" }))
    .toMatchObject({ status: "persisted" });
  const old = await comment(t.first.commentId);
  expect(old).toMatchObject({ status: "REPLIED", publicRolloutAssignmentId: t.original.id, publicOriginCiphertext: null });
  expect(await lanes(t.a.scopeId)).toHaveLength(2);
  expect(await audits(t.a.scopeId)).toBe(1);

  // Старый handleComment не отвечает в переведённой ветке даже по строке, привязанной к LEGACY.
  await prisma.instagramComment.update({ where: { id: old.id }, data: { status: "WORKING" } });
  expect(await publicAgentCommentLane(old.id)).toBe("moved");
  const queued = await prisma.instagramComment.findUniqueOrThrow({ where: { id: old.id } }) as QueuedComment;
  expect(await handleComment(queued)).toBe("skipped");
  expect(await comment(old.commentId)).toMatchObject({ status: "SKIPPED", note: "legacy_lane_moved" });

  // LEGACY-строка поколения 0 неизменна.
  await expect(prisma.$executeRaw`UPDATE "CustomerAgentRolloutAssignment" SET "lane"='CORE' WHERE "id"=${t.original.id}`).rejects.toThrow();
});

it("spam, manual mode and unfinished legacy work keep the thread LEGACY under the flag", async () => {
  const cases: Array<[string, (t: Awaited<ReturnType<typeof legacyThread>>) => Promise<unknown>]> = [
    ["spam_silenced", t => prisma.instagramComment.update({ where: { id: t.first.id }, data: { status: "HIDDEN", hiddenAt: new Date(), note: "spam" } })],
    ["human_owner", t => prisma.instagramComment.update({ where: { id: t.first.id }, data: { status: "ESCALATED" } })],
    ["human_owner", t => prisma.instagramComment.update({ where: { id: t.first.id }, data: { note: "manual_reply" } })],
    ["legacy_batch_pending", t => prisma.instagramComment.update({ where: { id: t.first.id }, data: { status: "PENDING" } })],
  ];
  for (const [reason, block] of cases) {
    const t = await legacyThread();
    await block(t);
    expect(await readCustomerPublicLegacyCutoverReadiness(prisma, { channel: "INSTAGRAM", accountExternalId: t.a.resource,
      publicationId: t.publication, threadId: t.root })).toEqual({ ready: false, reason });
    vi.stubEnv("CUSTOMER_AGENT_LEGACY_CUTOVER", "on");
    const next = `${tag}-next-${randomUUID()}`;
    expect(await deliver(t.a, { commentId: next, publication: t.publication, parentId: t.root, text: "Ҷавоб диҳед" })).toMatchObject({ status: "persisted" });
    expect(await publicAgentCommentLane((await comment(next)).id)).toBe("legacy");
    expect((await lanes(t.a.scopeId)).map(r => r.lane)).toEqual(["LEGACY"]);
    expect(await audits(t.a.scopeId)).toBe(0);
  }
});

it("an idle legacy thread is ready; the database accepts only the exact public cutover row", async () => {
  const t = await legacyThread();
  expect(await readCustomerPublicLegacyCutoverReadiness(prisma, { channel: "INSTAGRAM", accountExternalId: t.a.resource,
    publicationId: t.publication, threadId: t.root })).toEqual({ ready: true });
  const [a] = await prisma.$queryRaw<Array<{ cohortId: string; subjectKey: string; bucketBps: number; candidateRevisionId: string }>>`
    SELECT "cohortId","subjectKey","bucketBps","candidateRevisionId" FROM "CustomerAgentRolloutAssignment" WHERE "id"=${t.original.id}`;
  const insert = (generation: number, supersedes: string | null, reason: string | null, lane = "CORE") => prisma.$executeRaw`INSERT INTO "CustomerAgentRolloutAssignment"
    ("id","cohortId","surface","endpointScopeId","subjectKey","bucketBps","lane","candidateRevisionId","createdAt","generation","supersedesAssignmentId","transitionReason")
    VALUES (${randomUUID()},${a.cohortId},'public_comment',${t.a.scopeId},${a.subjectKey},${a.bucketBps},${lane},${a.candidateRevisionId},now(),${generation},${supersedes},${reason})`;
  await expect(insert(1, t.original.id, "other_reason")).rejects.toThrow();
  await expect(insert(2, t.original.id, "legacy_cutover_owner_31_10")).rejects.toThrow();
  await expect(insert(1, t.original.id, "legacy_cutover_owner_31_10", "LEGACY")).rejects.toThrow();
  expect(await insert(1, t.original.id, "legacy_cutover_owner_31_10")).toBe(1); // Ровно то, что пишет перевод.
});
