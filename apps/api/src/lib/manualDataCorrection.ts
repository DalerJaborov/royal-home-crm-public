import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { manualDataCorrectionSchema, parsePermissionOverrides, resolvePermissions } from "@royal-home/shared";
import { z } from "zod";
import { prisma, type TxClient } from "../db.js";
import { logTimeline } from "./timeline.js";

export class ManualCorrectionConflict extends Error {}
const snapshotSchema = z.array(z.object({
  clientId: z.string().uuid(), revision: z.number().int().nonnegative(),
  before: z.object({ fullName: z.string(), lastName: z.string().nullable() }).strict(),
  patch: z.object({ fullName: z.string().min(2).max(200).optional(), lastName: z.string().max(100).optional() }).strict(),
}).strict());
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
}
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");

/** Actual installed/source files are hashed. A changed reader requires a fresh plan. */
export async function manualCorrectionImpact() {
  const root = new URL("../", import.meta.url);
  const paths: Array<{ url: URL; relative: string }> = [];
  async function walk(dir: URL, prefix = "") {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (["generated", "node_modules", "tests", ".git"].includes(entry.name)) continue;
      const relative = `${prefix}${entry.name}`;
      if (entry.isDirectory()) await walk(new URL(`${entry.name}/`, dir), `${relative}/`);
      else if (/\.(?:ts|js)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) paths.push({ url: new URL(entry.name, dir), relative });
    }
  }
  await walk(root);
  const modules: Array<{ module: string; fields: string[]; hash: string }> = [];
  // Bounded asynchronous I/O: conservative inventory of direct readers plus the scheduler.
  for (let start = 0; start < paths.length; start += 8) {
    const batch = await Promise.all(paths.slice(start, start + 8).map(async file => {
      const bytes = await fs.readFile(file.url), text = bytes.toString("utf8");
      const fields = ["fullName", "lastName"].filter(field => new RegExp(`\\b${field}\\b`).test(text));
      return fields.length || /^cron\./.test(file.relative) ? { module: file.relative, fields, hash: createHash("sha256").update(bytes).digest("hex") } : null;
    }));
    for (const row of batch) if (row) modules.push(row);
  }
  modules.sort((a, b) => a.module.localeCompare(b.module));
  if (!modules.length || !modules.some(row => /^cron\./.test(row.module))) throw new ManualCorrectionConflict("Не удалось проверить установленный код и фоновые механизмы");
  const ownHash = createHash("sha256").update(await fs.readFile(new URL(import.meta.url))).digest("hex");
  return { operation: "CLIENT_LABELS", fields: ["fullName", "lastName"], modules,
    artifactHash: digest({ ownHash, modules }), writesWorkflow: false, triggersExternalCalls: false,
    analysis: "CONSERVATIVE_STATIC_FIELD_READERS_NOT_PROOF_OF_DYNAMIC_EFFECTS",
    review: "Исправление только имени/фамилии. Владение, роли, статусы, задачи, СБ, номера и KPI запрещены этому обработчику. Реестр включает одноимённые поля сотрудников; оператор проверяет применимость." };
}
async function authorized(tx: TxClient, actorId: string) {
  await tx.$queryRaw`SELECT id FROM "Agent" WHERE id=${actorId} FOR SHARE`;
  const actor = await tx.agent.findUnique({ where: { id: actorId } });
  if (!actor?.isActive || !["ADMIN", "DIRECTOR"].includes(actor.role)
    || !resolvePermissions(actor.role, parsePermissionOverrides(actor.permissions)).has("settings.manage")
    || !resolvePermissions(actor.role, parsePermissionOverrides(actor.permissions)).has("clients.viewPhone")) {
    throw new ManualCorrectionConflict("Ручное исправление разрешено только действующему администратору или директору с правом настроек");
  }
  return actor;
}

/** Read-only default; persisting a plan is a separate explicit action. */
export async function previewManualCorrection(input: unknown, persist = false) {
  const parsed = manualDataCorrectionSchema.parse(input);
  const impact = await manualCorrectionImpact();
  return prisma.$transaction(async tx => {
    await authorized(tx, parsed.actorId);
    const targets = [];
    for (const request of [...parsed.targets].sort((a, b) => a.clientId.localeCompare(b.clientId))) {
      const client = await tx.client.findFirst({ where: { id: request.clientId, deletedAt: null },
        select: { id: true, mutationRevision: true, fullName: true, lastName: true } });
      if (!client) throw new ManualCorrectionConflict("Карточка отсутствует или находится в корзине");
      targets.push({ clientId: client.id, revision: client.mutationRevision,
        before: { fullName: client.fullName, lastName: client.lastName }, patch: request.patch });
    }
    const planHash = digest({ actorId: parsed.actorId, reason: parsed.reason, operation: parsed.operation, targets, impact });
    if (!persist) return { mode: "DRY_RUN" as const, planHash, targets, impact, writes: 0 };
    const existing = await tx.manualDataCorrection.findUnique({ where: { requestKey: parsed.requestKey } });
    if (existing) {
      if (existing.planHash !== planHash) throw new ManualCorrectionConflict("Ключ уже связан с другим планом; данные могли измениться");
      return existing;
    }
    return tx.manualDataCorrection.create({ data: { requestKey: parsed.requestKey, actorId: parsed.actorId,
      reason: parsed.reason, operation: parsed.operation, planHash, targets, impact } });
  });
}

export async function applyManualCorrection(input: unknown) {
  const command = z.object({ planId: z.string().uuid(), actorId: z.string().uuid(),
    planHash: z.string().regex(/^[a-f0-9]{64}$/), impactReviewed: z.literal(true) }).strict().parse(input);
  const currentImpact = await manualCorrectionImpact();
  return prisma.$transaction(async tx => {
    const actor = await authorized(tx, command.actorId);
    await tx.$queryRaw`SELECT id FROM "ManualDataCorrection" WHERE id=${command.planId} FOR UPDATE`;
    const plan = await tx.manualDataCorrection.findUnique({ where: { id: command.planId } });
    if (!plan || plan.actorId !== actor.id || plan.planHash !== command.planHash) throw new ManualCorrectionConflict("План не найден или не принадлежит этому автору");
    const targets = snapshotSchema.parse(plan.targets);
    if (plan.operation !== "CLIENT_LABELS" || digest({ actorId: plan.actorId, reason: plan.reason, operation: plan.operation, targets, impact: plan.impact }) !== plan.planHash) {
      throw new ManualCorrectionConflict("Содержимое плана изменено");
    }
    if (plan.status === "APPLIED") return { status: "ALREADY_APPLIED", result: plan.result };
    if (plan.status !== "PLANNED" || Date.now() - plan.createdAt.getTime() > 30 * 60_000) throw new ManualCorrectionConflict("План истёк; подготовьте новый");
    if (digest(currentImpact) !== digest(plan.impact)) throw new ManualCorrectionConflict("Код читающих механизмов изменился; нужен новый план");
    const evidence = [];
    for (const target of targets) {
      await tx.$queryRaw`SELECT id FROM "Client" WHERE id=${target.clientId} FOR UPDATE`;
      const result = await tx.client.updateMany({ where: { id: target.clientId, deletedAt: null, mutationRevision: target.revision,
        fullName: target.before.fullName, lastName: target.before.lastName }, data: target.patch });
      if (result.count !== 1) throw new ManualCorrectionConflict("Карточка изменилась после предпросмотра; ничего не применено");
      const history = await logTimeline({ clientId: target.clientId, type: "SYSTEM", tx,
        actor: { kind: "system", source: "manual-data-correction" },
        notes: `Система (ручное исправление, ${actor.fullName}): уточнены имя/фамилия. План ${plan.id}.` });
      const after = await tx.client.findUniqueOrThrow({ where: { id: target.clientId }, select: { fullName: true, lastName: true } });
      if (after.fullName !== (target.patch.fullName ?? target.before.fullName) || after.lastName !== (target.patch.lastName ?? target.before.lastName)) {
        throw new ManualCorrectionConflict("Контрольное чтение не подтвердило исправление");
      }
      await tx.auditLog.create({ data: { action: "CLIENT_MANUAL_CORRECTION", entityType: "Client", entityId: target.clientId,
        agentId: actor.id, agentName: actor.fullName, meta: { correctionId: plan.id, fields: Object.keys(target.patch),
          beforeHash: digest(target.before), afterHash: digest(after), impactHash: digest(plan.impact) } } });
      evidence.push({ clientId: target.clientId, historyId: history.id, fields: Object.keys(target.patch), afterHash: digest(after) });
    }
    await tx.manualDataCorrection.update({ where: { id: plan.id }, data: { status: "APPLIED", appliedAt: new Date(), result: evidence } });
    return { status: "APPLIED", result: evidence };
  }, { timeout: 30_000 });
}
