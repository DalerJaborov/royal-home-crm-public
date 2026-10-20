import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db.js";
import { requireAuth, requirePermission } from "../auth/middleware.js";
import { loadEventPoints, recordScoreEventsAtomic, type ScoreEventKind } from "../lib/scoreJournal.js";
import { logSystemError } from "../lib/systemError.js";
import { logAudit } from "../lib/audit.js";

export const royalScoreEventsRouter = Router();

const OVERRIDABLE_KINDS = ["client_lost_agent_fault", "client_lost_no_fault"] as const;

const overrideSchema = z.object({
  override: z.enum(OVERRIDABLE_KINDS),
  comment: z.string().trim().max(500).optional(),
});

/**
 * Событие «клиент потерян по вине/без вины агента» для КОНКРЕТНОГО клиента, если
 * оно есть, — чтобы директор увидел его на карточке клиента и мог переопределить,
 * не разыскивая id вручную (08.09.2026, разведка по мёртвому коду: право и PATCH
 * существовали больше года без единой кнопки в интерфейсе, ни один директор им ни
 * разу не воспользовался).
 *
 * sourceId `client-lost-${clientId}` детерминирован (routes/clients/lifecycle.ts) —
 * у клиента может быть максимум ОДНО такое событие за всё время, им и адресуемся,
 * а не общим списком журнала.
 */
royalScoreEventsRouter.get(
  "/by-client/:clientId",
  requireAuth,
  requirePermission("score.clientLossOverride"),
  async (req, res) => {
    const original = await prisma.royalScoreEvent.findFirst({
      where: { sourceId: `client-lost-${req.params.clientId}`, kind: { in: [...OVERRIDABLE_KINDS] } },
    });
    if (!original) return res.json({ event: null });

    // Уже переопределяли — исходная строка своего kind НЕ МЕНЯЕТ (журнал только
    // на дозапись, см. комментарий у PATCH ниже), поэтому текущий вид смотрим по
    // корректирующей записи, если она есть.
    const correction = await prisma.royalScoreEvent.findFirst({
      where: { sourceId: `override-apply-${original.id}` },
      select: { kind: true, at: true },
    });

    res.json({
      event: {
        id: original.id,
        currentKind: (correction?.kind ?? original.kind) as (typeof OVERRIDABLE_KINDS)[number],
        overridden: !!correction,
        overriddenAt: correction?.at ?? null,
      },
    });
  }
);

/**
 * Ручное переопределение вины агента в потере клиента (docs/spec-compliance,
 * Этап 1, «Автофиксация... + ручное переопределение»). Только для событий
 * client_lost_agent_fault/client_lost_no_fault — не общая правка счёта: та
 * запрещена всем с 03.08.2026 (Fair Play), см. scoreJournal.ts.
 *
 * НЕ ПРАВИМ ИСХОДНУЮ СТРОКУ. Журнал — только на дозапись (см. комментарий в
 * scoreJournal.ts: «журнал, из которого можно вычеркнуть строку, не разрешает
 * спор, а создаёт его»). Переопределение добавляет КОРРЕКТИРУЮЩЕЕ событие:
 * гасит эффект исходного (delta = -исходная) и сразу начисляет верный (delta
 * = событие противоположного вида) — обе строки остаются в журнале навсегда,
 * видно и то, что было автоматически, и то, что поправил директор, и когда.
 */
royalScoreEventsRouter.patch(
  "/:id/override",
  requireAuth,
  requirePermission("score.clientLossOverride"),
  async (req, res) => {
    const parsed = overrideSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Некорректные данные", details: parsed.error.flatten() });

    const event = await prisma.royalScoreEvent.findUnique({ where: { id: req.params.id } });
    if (!event) return res.status(404).json({ error: "Событие не найдено" });
    if (!OVERRIDABLE_KINDS.includes(event.kind as (typeof OVERRIDABLE_KINDS)[number])) {
      return res.status(409).json({ error: "Переопределить можно только client_lost_agent_fault/client_lost_no_fault" });
    }

    // Уже переопределяли: `event.kind` — поле ИСХОДНОЙ строки, оно не меняется
    // никогда (журнал только на дозапись), поэтому сравнение с ним одно не
    // ловит повторную попытку. Без этой проверки второй PATCH молча превращался
    // бы в no-op (уникальность БД на sourceId гасит повторную запись, а
    // recordScoreEvent такой конфликт не считает ошибкой) — директор видел бы
    // «ok: true» и решал, что переопределил уже дважды, а на деле сработал раз.
    const existingCorrection = await prisma.royalScoreEvent.findFirst({
      where: { sourceId: `override-apply-${event.id}` },
      select: { kind: true },
    });
    if (existingCorrection) {
      if (existingCorrection.kind === parsed.data.override) {
        return res.status(409).json({ error: "Событие уже такого вида" });
      }
      return res.status(409).json({ error: "Это событие уже переопределяли — второй раз нельзя" });
    }
    if (event.kind === parsed.data.override) {
      return res.status(409).json({ error: "Событие уже такого вида" });
    }

    const points = await loadEventPoints();
    const newKind = parsed.data.override as ScoreEventKind;
    const actorId = req.agent!.id;

    // Гасим исходное событие (сумма = 0 за него) и начисляем корректный вид —
    // обе строки со sourceId, зависящим от id исходной записи, чтобы повторный
    // PATCH на то же событие не задваивал корректировку (уникальность в БД).
    // Ждём записи: ответ 200 уходит директору, интерфейс сразу перечитывает журнал —
    // без await он успевал прочитать его до появления корректировки.
    // ОДНА ТРАНЗАКЦИЯ (находка №161): две записи по отдельности при сбое второй
    // оставляли агента с минусом от первой, а ответ был «ok». Теперь — обе или ни
    // одной; при сбое директор получает ошибку и может повторить.
    try {
      await recordScoreEventsAtomic([
        {
          agentId: event.agentId,
          kind: event.kind as ScoreEventKind,
          delta: -event.delta,
          reason: `Переопределено директором: было «${event.kind}»${
            parsed.data.comment ? ` — ${parsed.data.comment}` : ""
          }`,
          initiatorId: actorId,
          sourceId: `override-revert-${event.id}`,
        },
        {
          agentId: event.agentId,
          kind: newKind,
          delta: points[newKind],
          reason: `Переопределено директором: стало «${newKind}»${
            parsed.data.comment ? ` — ${parsed.data.comment}` : ""
          }`,
          initiatorId: actorId,
          sourceId: `override-apply-${event.id}`,
        },
      ]);
    } catch (err) {
      // Уникальность sourceId: параллельный PATCH успел раньше — это не сбой.
      if ((err as { code?: string }).code === "P2002") {
        return res.status(409).json({ error: "Это событие уже переопределяли — второй раз нельзя" });
      }
      const message = err instanceof Error ? err.message : String(err);
      void logSystemError("api", `Royal Score: переопределение события ${event.id} не записано — ${message}`, {
        stack: err instanceof Error ? err.stack : undefined,
      });
      return res.status(500).json({
        error: "Не удалось сохранить корректировку баллов — ничего не изменилось, попробуйте ещё раз",
        code: "SCORE_OVERRIDE_FAILED",
      });
    }

    logAudit(req, "ROYAL_SCORE_EVENT_OVERRIDE", "RoyalScoreEvent", event.id, {
      from: event.kind,
      to: newKind,
      agentId: event.agentId,
    });

    res.json({ ok: true });
  }
);
