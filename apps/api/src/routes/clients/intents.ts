import { investigationViewerRole } from "../../auth/investigations.js";
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { clientBuyerRequirementsSchema, confirmedClientIntents, confirmClientIntentSchema } from "@royal-home/shared";
import { can, canAccessAssignedAgent, requireAuth, scopeToOwnAgent } from "../../auth/middleware.js";
import { prisma } from "../../db.js";
import { logAudit } from "../../lib/audit.js";
import { logTimeline } from "../../lib/timeline.js";
import { publishClientUpdated } from "../../lib/livePublish.js";
import { foreignWriteDenied, presentClient, restoreMaskedNotes } from "./shared.js";
import { resolveClientIntentsAutomatically } from "../../lib/clientIntentResolution.js";
import { logSystemError } from "../../lib/systemError.js";
import { describeError } from "../../lib/describeError.js";
import { phoneSafeText } from "../../lib/clientPhone.js";
import { suggestionFingerprint, suggestRequirements } from "../../lib/requirementsFromSummary.js";

export const intentsRouter = Router();

async function editableClient(req: Request, res: Response) {
  const id = z.guid().safeParse(req.params.id);
  if (!id.success) { res.status(400).json({ error: "Неверный идентификатор клиента" }); return null; }
  const client = await prisma.client.findUnique({ where: { id: id.data } });
  if (!client || client.deletedAt) { res.status(404).json({ error: "Клиент не найден" }); return null; }
  const ownAgentId = scopeToOwnAgent(req);
  if (!canAccessAssignedAgent(req, client.assignedAgentId) || foreignWriteDenied(req, client, ownAgentId) || req.agent!.role === "SHAREHOLDER") {
    res.status(403).json({ error: "Карточку изменяет ответственный агент или руководитель" }); return null;
  }
  if (ownAgentId && !client.acceptedAt) { res.status(403).json({ error: "Сначала примите заявку" }); return null; }
  return client;
}

intentsRouter.post("/:id/intents", requireAuth, async (req, res) => {
  const input = confirmClientIntentSchema.safeParse(req.body);
  if (!input.success) return res.status(400).json({ error: "Укажите актуальные роли клиента" });
  const client = await editableClient(req, res);
  if (!client) return;
  if (client.kind === "OTHER") return res.status(409).json({ error: "Сначала выберите тип карточки: продавец или покупатель" });
  const dualIntent = input.data.dualIntent;
  const automatic = input.data.resolution === "AUTO";
  if (automatic && !["ADMIN", "DIRECTOR"].includes(req.agent!.role)) return res.status(403).json({ error: "Автоматическое определение после ручного решения включает администратор или директор" });
  const now = new Date();
  const updated = await prisma.$transaction(async tx => {
    // Reassignment or kind changes during confirmation must not authorize a stale form.
    const changed = await tx.client.updateMany({
      where: { id: client.id, assignedAgentId: client.assignedAgentId, kind: client.kind, acceptedAt: client.acceptedAt,
        updatedAt: client.updatedAt, mutationRevision: client.mutationRevision, assignmentCompletedAt: client.assignmentCompletedAt, deletedAt: null },
      data: automatic ? { dualIntentDecisionSource: "AUTO", dualIntentConfirmedById: null, dualIntentAnalyzedHash: null,
        dualIntentNeedsReview: false } : { dualIntent, dualIntentConfirmedAt: dualIntent ? now : null, dualIntentConfirmedById: dualIntent ? req.agent!.id : null,
        dualIntentDecisionSource: "MANUAL", dualIntentNeedsReview: false },
    });
    if (!changed.count) return null;
    await logTimeline({ clientId: client.id, actor: { kind: "agent", agentId: req.agent!.id }, type: "SYSTEM",
      notes: automatic ? "Администратор включил автоматическое определение актуальных ролей клиента" : dualIntent ? "Подтверждено: клиент одновременно продаёт и покупает недвижимость" : `Подтверждена одна актуальная роль: ${client.kind === "SELLER" ? "продавец" : "покупатель"}`, tx });
    return tx.client.findUniqueOrThrow({ where: { id: client.id } });
  });
  if (!updated) return res.status(409).json({ error: "Карточка изменилась. Обновите её и повторите подтверждение" });
  if (automatic) {
    try { await resolveClientIntentsAutomatically(client.id); }
    catch (error) { void logSystemError("ai", `Определение ролей после смены режима: ${describeError(error)}`); }
  }
  logAudit(req, "UPDATE", "Client", client.id, { dualIntent, confirmation: automatic ? "automatic-enabled" : "staff" });
  publishClientUpdated({ clientId: client.id, agentIds: [client.assignedAgentId], actorId: req.agent!.id });
  const current = automatic ? await prisma.client.findUniqueOrThrow({ where: { id: client.id } }) : updated;
  res.json(presentClient(current, can(req, "clients.viewPhone"), can(req, "clients.viewOrigin"), investigationViewerRole(req)));
});

type BuyerRequirementsInput = z.infer<typeof clientBuyerRequirementsSchema>;
type EditableClient = NonNullable<Awaited<ReturnType<typeof editableClient>>>;

/**
 * Запись пожеланий покупателя — ОДНА ДВЕРЬ для ручной правки и для «Взять из разговора». null — карточка сменилась за это
 * время (сравнение по updatedAt и ревизии): ни одна запись не затирает чужую правку.
 */
async function writeBuyerRequirements(req: Request, client: EditableClient, data: BuyerRequirementsInput) {
  const stale = client.requirementsFieldsKind != null && client.requirementsFieldsKind !== "BUYER";
  const updated = await prisma.$transaction(async tx => {
    const changed = await tx.client.updateMany({ where: { id: client.id, assignedAgentId: client.assignedAgentId, kind: client.kind, acceptedAt: client.acceptedAt, deletedAt: null,
      updatedAt: client.updatedAt, mutationRevision: client.mutationRevision, assignmentCompletedAt: client.assignmentCompletedAt,
      dualIntent: client.dualIntent, dualIntentConfirmedAt: client.dualIntentConfirmedAt }, data: {
      ...(stale ? { budgetMin: null, budgetMax: null, desiredType: null, desiredDistrictId: null, desiredRooms: null,
        desiredAreaMin: null, desiredFloorMin: null, desiredFloorMax: null, desiredTotalFloors: null, requirementsNotes: null } : {}),
      ...data, requirementsFieldsKind: "BUYER",
    } });
    if (!changed.count) return null;
    const previousPlaces = stale ? await tx.clientDesiredPlace.findMany({ where: { clientId: client.id }, select: { lat: true, lng: true, radiusM: true, label: true } }) : [];
    if (stale) await tx.clientDesiredPlace.deleteMany({ where: { clientId: client.id } });
    const previous = stale ? JSON.stringify({ budgetMin: client.budgetMin, budgetMax: client.budgetMax, currency: client.currency,
      desiredType: client.desiredType, desiredDistrictId: client.desiredDistrictId, desiredRooms: client.desiredRooms,
      desiredAreaMin: client.desiredAreaMin, desiredFloorMin: client.desiredFloorMin, desiredFloorMax: client.desiredFloorMax,
      desiredTotalFloors: client.desiredTotalFloors, requirementsNotes: client.requirementsNotes, desiredPlaces: previousPlaces }) : null;
    await logTimeline({ clientId: client.id, actor: { kind: "agent", agentId: req.agent!.id }, type: "SYSTEM",
      notes: `Уточнены пожелания покупателя${previous ? `. Прежние параметры другой роли сохранены в истории: ${previous}` : ""}`, tx });
    return tx.client.findUniqueOrThrow({ where: { id: client.id } });
  });
  if (!updated) return null;
  logAudit(req, "UPDATE", "Client", client.id, { requirementsFieldsKind: "BUYER" });
  publishClientUpdated({ clientId: client.id, agentIds: [client.assignedAgentId], actorId: req.agent!.id });
  return updated;
}

/**
 * «ВЗЯТЬ ИЗ РАЗГОВОРА» (20.11.2026; ревью #338): что из сводки клиента («Ищет: …») можно записать в пустые поля запроса
 * покупателя. GET только ГОВОРИТ, что предлагается (короткие подписи для кнопки): ни заметок клиента, ни цифр, ни самих
 * значений он не отдаёт — заметки приходят в карточку замаскированными (presentClient), и предложение не должно их обходить.
 * Запись — отдельный POST `…/apply`: сервер заново считает предложение по ТЕКУЩЕЙ карточке из базы и пишет его сам, дописывая
 * слова клиента к заметкам, которые лежат в базе сейчас (а не к тем, что видел экран). Права те же, что у записи пожеланий
 * (`editableClient`): кому менять карточку нельзя, тому и предлагать нечего. Без нового вызова ИИ.
 */
async function currentSuggestion(client: EditableClient) {
  const stale = client.requirementsFieldsKind != null && client.requirementsFieldsKind !== "BUYER";
  if (stale || !confirmedClientIntents(client).buys || !client.aiInsight) return null;
  const [districts, places] = await Promise.all([
    prisma.district.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" }, take: 200 }),
    prisma.clientDesiredPlace.count({ where: { clientId: client.id } }),
  ]);
  return suggestRequirements(client.aiInsight, {
    desiredType: client.desiredType, desiredRooms: client.desiredRooms, budgetMin: client.budgetMin, budgetMax: client.budgetMax,
    desiredDistrictId: client.desiredDistrictId, hasDesiredPlaces: places > 0, requirementsNotes: client.requirementsNotes,
  }, districts);
}

intentsRouter.get("/:id/requirements-suggestion", requireAuth, async (req, res) => {
  const client = await editableClient(req, res);
  if (!client) return;
  const suggestion = await currentSuggestion(client);
  if (!suggestion) return res.json({ available: false, labels: [] as string[] });
  // Подписи могут нести слова из сводки (район вне справочника): без права на номера — с маской, как сама сводка.
  res.json({ available: true, fingerprint: suggestionFingerprint(suggestion), labels: suggestion.labels.map((label) => phoneSafeText(label, can(req, "clients.viewPhone"))) });
});

intentsRouter.post("/:id/requirements-suggestion/apply", requireAuth, async (req, res) => {
  const client = await editableClient(req, res);
  if (!client) return;
  if (!confirmedClientIntents(client).buys) return res.status(409).json({ error: "Сначала подтвердите, что клиент покупает недвижимость" });
  const suggestion = await currentSuggestion(client);
  if (!suggestion) return res.status(409).json({ error: "Из разговора больше нечего взять: поля уже заполнены или сводка изменилась" });
  // Человек нажал кнопку с теми подписями, что видел: если предложение с тех пор изменилось, пишем не его, а просим посмотреть заново.
  const seen = typeof req.body?.fingerprint === "string" ? req.body.fingerprint : "";
  if (seen !== suggestionFingerprint(suggestion)) return res.status(409).json({ error: "Предложение обновилось, посмотрите ещё раз" });
  const notes = client.requirementsNotes?.trim() ?? "";
  const merged = suggestion.notesLine ? (notes ? `${notes}\n${suggestion.notesLine}` : suggestion.notesLine) : null;
  const input = clientBuyerRequirementsSchema.safeParse({ ...suggestion.fields, ...(merged !== null ? { requirementsNotes: merged } : {}) });
  if (!input.success) return res.status(400).json({ error: "Пожелания не поместились в карточку. Уточните их вручную" });
  const updated = await writeBuyerRequirements(req, client, input.data);
  if (!updated) return res.status(409).json({ error: "Карточка изменилась. Обновите её и повторите" });
  res.json(presentClient(updated, can(req, "clients.viewPhone"), can(req, "clients.viewOrigin"), investigationViewerRole(req)));
});

intentsRouter.post("/:id/buyer-requirements", requireAuth, async (req, res) => {
  const input = clientBuyerRequirementsSchema.safeParse(req.body);
  if (!input.success) return res.status(400).json({ error: "Проверьте пожелания покупателя", details: input.error.flatten() });
  const client = await editableClient(req, res);
  if (!client) return;
  if (!confirmedClientIntents(client).buys) return res.status(409).json({ error: "Сначала подтвердите, что клиент покупает недвижимость" });
  const data = input.data;
  if (typeof data.requirementsNotes === "string" && !can(req, "clients.viewPhone")) {
    const restored = restoreMaskedNotes(data.requirementsNotes, client.requirementsNotes);
    if (restored === null) return res.status(400).json({ error: "Нельзя изменять строку со скрытым контактом. Остальные пожелания можно уточнить" });
    data.requirementsNotes = restored;
  }
  const updated = await writeBuyerRequirements(req, client, data);
  if (!updated) return res.status(409).json({ error: "Роли карточки изменились. Обновите карточку и повторите" });
  res.json(presentClient(updated, can(req, "clients.viewPhone"), can(req, "clients.viewOrigin"), investigationViewerRole(req)));
});
