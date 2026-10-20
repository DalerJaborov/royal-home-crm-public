import { Router } from "express";
import { z } from "zod";
import { requireAuth, requirePermission } from "../auth/middleware.js";
import { generateInsightDigest, notifyDirectorsAboutInsightDigest } from "../lib/insightDigestRunner.js";
import { insightDigestPeriod } from "../lib/insightDigestPeriod.js";
import { prisma } from "../db.js";
import { clientNamePhoneSafe, maskPhonesDeep } from "../lib/clientPhone.js";
import { insightCaseReviewSchema } from "@royal-home/shared";
// `JsonValue` в Prisma 7 живёт в пространстве имён сгенерированного клиента,
// а не в отдельном модуле `@prisma/client/runtime/library`.
import type { Prisma } from "../generated/prisma/client.js";
type JsonValue = Prisma.JsonValue;

export const insightsRouter = Router();

const generateBodySchema = z.object({
  periodStart: z.coerce.date().optional(),
  periodEnd: z.coerce.date().optional(),
  meetingAt: z.coerce.date().optional(),
}).optional();

/**
 * POST /insights/generate — ручная генерация диджеста «Инсайты от ИИ».
 *
 * Право settings.manage: генерация диджеста — административное действие,
 * доступное только руководству. Обычные агенты видят готовые диджесты
 * через GET-эндпоинты (не входят в этот роутер).
 *
 * Если период не указан — берётся текущий период по Душанбе: от прошлого
 * собрания до ближайшего (lib/insightDigestPeriod.ts), тот же, что у крона.
 */
insightsRouter.post("/generate", requireAuth, requirePermission("settings.manage"), async (req, res) => {
  const body = generateBodySchema.parse(req.body);

  let periodStart: Date;
  let periodEnd: Date;
  let meetingAt: Date;

  if (body?.periodStart && body?.periodEnd && body?.meetingAt) {
    periodStart = body.periodStart;
    periodEnd = body.periodEnd;
    meetingAt = body.meetingAt;
  } else {
    // Текущий период по Душанбе — та же функция, что у крона insight-digest.
    ({ periodStart, periodEnd, meetingAt } = insightDigestPeriod());
  }

  const digestId = await generateInsightDigest(periodStart, periodEnd, meetingAt);

  if (digestId === "DISABLED") {
    return res.status(409).json({ error: "Генерация инсайтов отключена в настройках" });
  }

  // Уведомляем директоров о готовности (или о повторной генерации). immediate:true —
  // директор сам только что нажал «Собрать сейчас», ждать часов алармов не нужно
  // (владелец 07.09.2026, см. doc-comment у notifyDirectorsAboutInsightDigest).
  await notifyDirectorsAboutInsightDigest(digestId, true);

  const digest = await prisma.insightDigest.findUnique({
    where: { id: digestId },
    include: { _count: { select: { cases: true } } },
  });

  res.json({
    id: digestId,
    status: digest?.status ?? "UNKNOWN",
    casesCount: digest?._count.cases ?? 0,
  });
});

/**
 * GET /insights — список диджестов (без кейсов), право insights.view.
 */
insightsRouter.get("/", requireAuth, requirePermission("insights.view"), async (_req, res) => {
  // Два выпуска в месяц: 60 записей — два с половиной года истории, дальше
  // архив никому не нужен на экране собрания.
  const digests = await prisma.insightDigest.findMany({
    orderBy: { periodStart: "desc" },
    include: { _count: { select: { cases: true } } },
    take: 60,
  });

  res.json(
    digests.map((d) => ({
      id: d.id,
      periodStart: d.periodStart,
      periodEnd: d.periodEnd,
      meetingAt: d.meetingAt,
      status: d.status,
      coverage: d.coverage,
      createdAt: d.createdAt,
      caseCount: d._count.cases,
      /** @deprecated старое имя, оставлено для совместимости — см. insightDigestListSchema. */
      casesCount: d._count.cases,
    }))
  );
});

/**
 * GET /insights/:id — кейсы диджеста с таймлайном и вердиктом, право insights.view.
 */
insightsRouter.get("/:id", requireAuth, requirePermission("insights.view"), async (req, res) => {
  const { id } = req.params;

  const digest = await prisma.insightDigest.findUnique({
    where: { id },
    // Сначала самые серьёзные — в таком порядке их и разбирают на собрании.
    include: { cases: { orderBy: [{ severity: "desc" }, { createdAt: "asc" }] } },
  });

  if (!digest) {
    return res.status(404).json({ error: "Диджест не найден" });
  }

  const canViewPhone = req.agent?.permissions.has("clients.viewPhone") ?? false;

  // Имена — одним запросом на всех, не в цикле по кейсам. Собрание разбирает
  // «агент + клиент», а не пары uuid.
  const agentIds = [...new Set(digest.cases.map((c) => c.agentId))];
  const clientIds = [...new Set(digest.cases.map((c) => c.clientId))];
  const [agents, clients] = await Promise.all([
    prisma.agent.findMany({ where: { id: { in: agentIds } }, select: { id: true, fullName: true } }),
    prisma.client.findMany({ where: { id: { in: clientIds } }, select: { id: true, fullName: true, shortId: true } }),
  ]);
  const agentName = new Map(agents.map((a) => [a.id, a.fullName]));
  const clientById = new Map(clients.map((c) => [c.id, c]));

  const cases = digest.cases.map((c) => {
    let timeline: JsonValue = c.timeline;
    if (!canViewPhone) {
      timeline = maskPhonesDeep(c.timeline, false) as JsonValue;
    }
    // Запись звонка отдаётся только защищённым маршрутом (право на прослушивание
    // проверяется там); сырой recordingUrl из снапшота наружу не уходит.
    const interactionId = c.sourceKey.startsWith("call:") ? c.sourceKey.slice("call:".length) : null;
    const client = clientById.get(c.clientId);

    return {
      id: c.id,
      agentId: c.agentId,
      agentName: agentName.get(c.agentId) ?? null,
      clientId: c.clientId,
      // Номер внутри имени («Входящий +992…») — тот же телефон, что и поле phone
      // (находка №156): без права clients.viewPhone закрываем и здесь.
      clientName: client ? clientNamePhoneSafe(client.fullName, canViewPhone) : null,
      clientShortId: client?.shortId ?? null,
      kind: c.kind,
      severity: c.severity,
      sourceKey: c.sourceKey,
      recordingUrl: interactionId ? `/interactions/${interactionId}/recording` : null,
      timeline,
      verdict: c.verdict,
      reviewedAt: c.reviewedAt,
      reviewedById: c.reviewedById,
      meetingNote: c.meetingNote,
    };
  });

  res.json(cases);
});

/**
 * PATCH /insights/cases/:id — отметить «разобрано на собрании», право insights.view.
 */
insightsRouter.patch("/cases/:id", requireAuth, requirePermission("insights.view"), async (req, res) => {
  const { id } = req.params;
  const body = insightCaseReviewSchema.parse(req.body);

  // Несуществующее дело — 404, а не «Внутренняя ошибка» от update (находка №156).
  const existing = await prisma.insightCase.findUnique({ where: { id }, select: { id: true } });
  if (!existing) return res.status(404).json({ error: "Дело не найдено" });

  const updatedCase = await prisma.insightCase.update({
    where: { id },
    data: {
      reviewedAt: body.reviewedAt ? new Date(body.reviewedAt) : undefined,
      reviewedById: body.reviewedAt ? req.agent!.id : undefined,
      meetingNote: body.meetingNote ?? null,
    },
  });

  res.json(updatedCase);
});