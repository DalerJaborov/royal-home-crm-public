import {
  createPropertyChangeRequestSchema,
  formatPropertyCode,
  isReadOnlyRole,
  PROPERTY_CHANGE_KIND_LABELS,
  type CreatePropertyChangeRequestInput,
  type PropertyChangeKind,
} from "@royal-home/shared";
import { loadAgentAccess } from "../../../auth/middleware.js";
import { prisma, type TxClient } from "../../../db.js";
import type { Property } from "../../../generated/prisma/client.js";
import {
  AssistantActionError,
  type AssistantActionActor,
  type AssistantActionExecutor,
  type AssistantActionPreview,
} from "../../../lib/assistantActions.js";
import { toCents } from "../../../lib/money.js";
import { appliedPriceUndoResult } from "../../../lib/assistantPriceUndoJournal.js";
import { canManagePropertyAs } from "../../../lib/propertyAccess.js";
import { approvePropertyChangeRequest } from "../../../routes/properties/changeRequestExecutor.js";
import {
  cancelPropertyChangeRequest,
  cancelPropertyChangeRequestInTransaction,
  checkPropertyChangeRequest,
  createPropertyChangeRequest,
} from "../../../lib/propertyChangeRequestService.js";
import { lockPropertyInTransaction } from "../../../lib/videoHandoff.js";
import { changeActor, failureToError, loadWriterRole, resolveRefOrThrow } from "./propertyToolSupport.js";
import { propertyHref } from "./propertyPresenter.js";

/**
 * ОБЩИЙ ИСПОЛНИТЕЛЬ ИНСТРУМЕНТОВ, КОТОРЫЕ ПОДАЮТ ЗАЯВКУ НА ИЗМЕНЕНИЕ ОБЪЕКТА
 * (цена, статус, «данные/снять/другое») — П3, группа «prop», фаза 1
 * (docs/design/internal-assistant-architecture-2026-10-31.md §3).
 *
 * Помощник ничего в объекте не меняет сам: он подаёт ТУ ЖЕ заявку, что кнопка
 * «Запросить изменение» в карточке (`lib/propertyChangeRequestService.ts`), а
 * руководитель одобряет её существующим экраном. Поэтому подтверждение человека
 * здесь — это «подать заявку», а не «поменять цену».
 *
 * Условность записи: снимок несёт цену, валюту, статус объекта И id ждущей заявки
 * этого вида. Брокер сравнивает его перед исполнением; в самой записи те же поля
 * перепроверяются под замком объекта (`expect`), так что «успели поменять» между
 * сравнением и записью тоже даёт 409 STALE. Откат — отзыв заявки, пока она ждёт
 * решения (условный переход PENDING → CANCELLED).
 */
export interface ChangeRequestToolSpec<A extends { ref: string }> {
  tool: string;
  /** Вид заявки; у инструмента с несколькими видами — функция от аргументов. */
  kind: PropertyChangeKind | ((args: A) => PropertyChangeKind);
  /** Разбор аргументов от модели (zod). */
  parseArgs: (raw: unknown) => A;
  /**
   * Тело заявки для сервиса + проверки, специфичные для инструмента (бросают
   * AssistantActionError). Вызывается и на превью, и на исполнении — состояние
   * перепроверяется свежим.
   */
  buildBody: (args: A, property: Property, actor: AssistantActionActor) => Promise<CreatePropertyChangeRequestInput>;
  /** Карточка «было → станет» по уже проверенному телу. */
  describe: (args: A, property: Property, checkedPayload: object) => Omit<AssistantActionPreview, "title"> & { title: string };
  /**
   * Своему объекту (и руководителю с editForeign) изменение применяется СРАЗУ после «Подтвердить»:
   * заявка создаётся и принимается автором через тот же исполнитель, что кнопка «Принять» директора
   * (одна дверь, журнал и эффекты те же). Решение владельца 03.11.2026, только для цены.
   */
  directForOwner?: boolean;
  /** Дополнительные поля снимка (например, число открытых сделок). */
  extraSnapshot?: (args: A, property: Property, db: TxClient) => Promise<Record<string, unknown>>;

}

interface Snap {
  propertyId: string;
  shortId: number;
  price: number;
  currency: string;
  status: string;
  /** Ждущая заявка ЭТОГО вида (null — нет). После исполнения — наша. */
  pendingRequestId: string | null;
  [extra: string]: unknown;
}

function pendingRequestId(result: unknown): string | undefined {
  if (!result || typeof result !== "object") return undefined;
  const done = result as { requestId?: unknown; status?: unknown; applied?: unknown };
  return typeof done.requestId === "string" && done.requestId && done.applied !== true &&
    (done.status === "PENDING" || done.status === undefined) ? done.requestId : undefined;
}

async function requirePropertyUndoAccess(actorId: string, db: TxClient = prisma): Promise<void> {
  // Passing the DB client bypasses the short-lived authentication cache.
  const access = await loadAgentAccess(actorId, db);
  if (!access?.isActive || isReadOnlyRole(access.role) || !access.permissions.has("properties.requestChange")) {
    throw new AssistantActionError(403, "FORBIDDEN", "Нет права отменить это действие");
  }
}

/**
 * «Уже есть ждущая заявка» — понятно человеку. Правило REST (одна ждущая на пару
 * «объект + вид») не меняется; но смена статуса и «попросить руководителя» у
 * помощника обе идут видом «Другое» (своего вида у статуса нет) и блокируют друг
 * друга — поэтому для «Другое» прямо говорим, ЧТО именно ждёт (ревью П3).
 */
function duplicateError(kind: PropertyChangeKind, shortId: number): AssistantActionError {
  const code = formatPropertyCode(shortId);
  const message =
    kind === "OTHER"
      ? `По объекту ${code} уже есть ждущая заявка «Другое» — дождитесь решения руководителя или отзовите её в карточке объекта. ` +
        "Пока она ждёт, новую заявку «Другое» (в том числе смену статуса через помощника) подать нельзя."
      : `По объекту ${code} уже есть такая заявка («${PROPERTY_CHANGE_KIND_LABELS[kind]}»), она ждёт решения руководителя. ` +
        "Дождитесь решения или отзовите её в карточке объекта.";
  return new AssistantActionError(409, "DUPLICATE", message);
}

export function makeChangeRequestExecutor<A extends { ref: string }>(
  spec: ChangeRequestToolSpec<A>
): AssistantActionExecutor<A> {
  const kindOf = (args: A): PropertyChangeKind => (typeof spec.kind === "function" ? spec.kind(args) : spec.kind);

  async function loadProperty(snapshotOrRef: { propertyId: string } | { ref: string }, db: TxClient = prisma): Promise<Property> {
    const id = "propertyId" in snapshotOrRef ? snapshotOrRef.propertyId : (await resolveRefOrThrow(snapshotOrRef.ref)).id;
    const property = await db.property.findUnique({ where: { id } });
    if (!property || property.deletedAt) throw new AssistantActionError(404, "ENTITY_NOT_FOUND", "Объект не найден");
    return property;
  }

  async function checkedBody(args: A, property: Property, actor: AssistantActionActor) {
    const body = await spec.buildBody(args, property, actor);
    // Тело проходит ту же схему, что на REST-границе (дефолты, пределы).
    const parsedBody = createPropertyChangeRequestSchema.safeParse(body);
    if (!parsedBody.success) {
      throw new AssistantActionError(400, "BAD_ARGS", parsedBody.error.issues[0]?.message ?? "Неверные данные заявки");
    }
    const checked = checkPropertyChangeRequest(property, changeActor(actor), parsedBody.data);
    if (!checked.ok) throw failureToError(checked);
    return { body: parsedBody.data, payloadObject: checked.payloadObject };
  }

  const isDirect = (args: A, property: Property, actor: AssistantActionActor) =>
    spec.directForOwner === true &&
    kindOf(args) === "PRICE_CHANGE" &&
    // Объект в резерве (есть сделка) — цену меняет руководство: как и у REST, прямой путь закрыт.
    (property.status !== "RESERVED" || actor.can("properties.editForeign")) &&
    canManagePropertyAs({ agentId: actor.agentId, can: actor.can }, property);

  async function snapshotForProperty(args: A, property: Property, db: TxClient): Promise<Snap> {
    const pending = await db.propertyChangeRequest.findFirst({
      where: { propertyId: property.id, kind: kindOf(args), status: "PENDING" },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });
    return {
      propertyId: property.id,
      shortId: property.shortId,
      price: Number(property.price),
      currency: property.currency,
      status: property.status,
      pendingRequestId: pending?.id ?? null,
      ...(spec.extraSnapshot ? await spec.extraSnapshot(args, property, db) : {}),
    };
  }

  return {
    tool: spec.tool,
    requires: ["properties.requestChange"],
    // Заявка уходит руководителю, step-up у REST-аналога нет — из Telegram можно (П5).
    channels: ["crm", "telegram"],
    parseArgs: spec.parseArgs,
    async authorize(_args, actor, action) {
      if (action.status === "UNDONE" && (pendingRequestId(action.result) || appliedPriceUndoResult(action.result))) {
        await requirePropertyUndoAccess(actor.agentId);
      }
    },

    async snapshot(args, actor) {
      await loadWriterRole(actor.agentId);
      const property = await loadProperty({ ref: args.ref });
      return snapshotForProperty(args, property, prisma);
    },

    async buildPreview(args, snapshot, actor) {
      const snap = snapshot as Snap;
      const property = await loadProperty(snap);
      const { payloadObject } = await checkedBody(args, property, actor);
      if (snap.pendingRequestId) throw duplicateError(kindOf(args), property.shortId);
      const described = spec.describe(args, property, payloadObject);
      if (isDirect(args, property, actor)) {
        const { Заявка: _request, ...becomes } = described.becomes as Record<string, unknown>;
        return {
          ...described,
          title: described.title.replace(": заявка руководителю", ""),
          becomes,
          risk: "Цена изменится сразу — на сайте и в подписях. Передумали — кнопка «Отменить» вернёт прежнюю цену.",
        };
      }
      return {
        ...described,
        risk:
          described.risk ??
          "Объект уже опубликован, поэтому изменение пойдёт заявкой руководителю: сразу ничего не поменяется.",
      };
    },

    async execute(args, actor, ctx) {
      await loadWriterRole(actor.agentId);
      const before = ctx.snapshotBefore as Snap;
      const property = await loadProperty(before);
      const { body } = await checkedBody(args, property, actor);
      const created = await createPropertyChangeRequest({
        propertyId: property.id,
        actor: changeActor(actor),
        body,
        // Что человек видел в превью: расхождение под замком объекта — STALE, заявка не создаётся.
        expect: { priceCents: toCents(before.price), currency: before.currency, status: before.status },
        auditSource: { source: "assistant", actionId: ctx.actionId, tool: spec.tool },
      });
      if (!created.ok) {
        throw created.code === "DUPLICATE" ? duplicateError(kindOf(args), property.shortId) : failureToError(created);
      }
      if (isDirect(args, property, actor)) {
        const applied = await approvePropertyChangeRequest({
          requestId: created.request.id,
          actorId: actor.agentId,
          note: "Свой объект: применено автором через ИИ-помощника",
        }).catch((err: unknown) => ({ ok: false as const, status: 500, error: err instanceof Error ? err.message : "сбой применения" }));
        if (!applied.ok) {
          // Не применилось — висящую заявку не оставляем.
          await cancelPropertyChangeRequest({ requestId: created.request.id, actorId: actor.agentId, note: "Не применено: " + applied.error });
          throw new AssistantActionError(applied.status, "REFUSED", applied.error);
        }
        return {
          result: {
            requestId: created.request.id,
            kind: kindOf(args),
            status: "APPLIED",
            applied: true,
            ...(applied.writtenPropertyVersion !== undefined ? { appliedPropertyVersion: applied.writtenPropertyVersion } : {}),
            propertyShortId: property.shortId,
            href: propertyHref(property.shortId),
            message: applied.message,
          },
          audit: { entityType: "Property", entityId: property.id },
        };
      }
      return {
        result: {
          requestId: created.request.id,
          kind: kindOf(args),
          status: created.request.status,
          propertyShortId: property.shortId,
          href: propertyHref(property.shortId, `?changeRequest=${created.request.id}`),
          message: "Заявка отправлена руководителю. Объект изменится после одобрения.",
        },
        audit: { entityType: "Property", entityId: property.id },
      };
    },

    transactionalUndo: {
      matches: (result) => Boolean(pendingRequestId(result)),
      async execute(args, actor, ctx) {
        const requestId = pendingRequestId(ctx.result);
        const snap = ctx.snapshotAfter as Snap;
        if (!requestId || requestId !== snap.pendingRequestId || !snap.propertyId) {
          throw new AssistantActionError(409, "UNDO_STALE", "Заявка уже изменилась — отозвать её нельзя");
        }
        // Approval uses the same property lock; permissions cannot be revoked halfway through the undo.
        await lockPropertyInTransaction(ctx.tx, snap.propertyId);
        await ctx.tx.$queryRaw`SELECT "id" FROM "Agent" WHERE "id" = ${actor.agentId} FOR SHARE`;
        await requirePropertyUndoAccess(actor.agentId, ctx.tx);
        const property = await loadProperty(snap, ctx.tx);
        const current = await snapshotForProperty(args, property, ctx.tx);
        if (current.pendingRequestId !== requestId) {
          throw new AssistantActionError(409, "UNDO_STALE", "Заявка уже не ждёт решения — отозвать её нельзя.");
        }
        ctx.assertSnapshot(current);
        const cancelled = await cancelPropertyChangeRequestInTransaction(ctx.tx, {
          requestId,
          propertyId: property.id,
          actorId: actor.agentId,
          note: "Отозвана автором (отмена в ИИ-помощнике)",
          auditSource: { source: "assistant.undo", actionId: ctx.actionId },
        });
        if (!cancelled.ok) {
          throw new AssistantActionError(
            cancelled.status,
            cancelled.status === 409 ? "UNDO_STALE" : "REFUSED",
            cancelled.status === 409 ? "По заявке уже вынесено решение — откатить нельзя." : cancelled.error,
          );
        }
        return { afterCommit: cancelled.afterCommit };
      },
    },

    recoverableUndo: {
      matches: (result) => Boolean(appliedPriceUndoResult(result)),
      async execute(_args, actor, ctx) {
        await requirePropertyUndoAccess(actor.agentId);
        const applied = appliedPriceUndoResult(ctx.result);
        if (!applied) throw new AssistantActionError(409, "NOT_UNDOABLE", "Нечего откатывать");
        const prior = ctx.snapshotBefore as Snap;
        const after = ctx.snapshotAfter as Snap;
        const retry = () => new AssistantActionError(503, "UNDO_RETRY", "Не удалось подтвердить откат. Проверьте позже или повторите.");
        const stale = () => new AssistantActionError(409, "UNDO_STALE", "Объект уже изменился. Прежнюю цену не вернула.");
        // The same linked request is resumed after staging, including after a worker restart.
        const back = await createPropertyChangeRequest({
          propertyId: prior.propertyId,
          actor: changeActor(actor),
          expect: {
            priceCents: toCents(after.price),
            currency: after.currency,
            status: after.status,
            propertyVersion: applied.propertyVersion,
            guardPriceUndo: true,
          },
          assistantUndo: { actionId: ctx.actionId, channel: actor.channel, now: ctx.now, undoUntil: ctx.undoUntil },
          body: {
            kind: "PRICE_CHANGE",
            payload: { newPrice: prior.price, currency: prior.currency as "USD" | "TJS", remake: false },
          },
          auditSource: { source: "assistant.undo", actionId: ctx.actionId },
        }).catch(() => { throw retry(); });
        if (!back.ok) {
          if (back.code === "STALE") throw stale();
          throw failureToError(back);
        }
        if (back.request.status === "CANCELLED") throw stale();
        if (back.request.status === "REJECTED") throw new AssistantActionError(409, "REFUSED", "Заявка на откат отклонена.");
        if (back.request.status === "PENDING") {
          const reverted = await approvePropertyChangeRequest({
            requestId: back.request.id, actorId: actor.agentId, note: "Откат цены в ИИ-помощнике",
          }).catch(() => null);
          if (reverted?.ok && reverted.writtenPropertyVersion !== undefined) return { replay: false };
          if (reverted && !reverted.ok && reverted.code === "UNDO_STALE") throw stale();
          if (reverted && !reverted.ok && reverted.status === 403) {
            throw new AssistantActionError(403, "FORBIDDEN", reverted.error);
          }
        }

        // Commit acknowledgement or post-commit work can fail. Only a durable receipt proves success.
        const persisted = await prisma.assistantAction.findUnique({
          where: { id: ctx.actionId }, select: { status: true },
        }).catch(() => null);
        if (persisted?.status === "UNDONE") return { replay: true };
        throw retry();
      },
    },
  };
}
