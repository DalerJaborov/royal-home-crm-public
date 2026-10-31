import {
  createPropertyChangeRequestSchema,
  formatPropertyCode,
  PROPERTY_CHANGE_KIND_LABELS,
  type CreatePropertyChangeRequestInput,
  type PropertyChangeKind,
} from "@royal-home/shared";
import { prisma } from "../../../db.js";
import type { Property } from "../../../generated/prisma/client.js";
import {
  AssistantActionError,
  type AssistantActionActor,
  type AssistantActionExecutor,
  type AssistantActionPreview,
} from "../../../lib/assistantActions.js";
import { toCents } from "../../../lib/money.js";
import {
  cancelPropertyChangeRequest,
  checkPropertyChangeRequest,
  createPropertyChangeRequest,
} from "../../../lib/propertyChangeRequestService.js";
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
  /** Дополнительные поля снимка (например, число открытых сделок). */
  extraSnapshot?: (args: A, property: Property) => Promise<Record<string, unknown>>;

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

  async function loadProperty(snapshotOrRef: { propertyId: string } | { ref: string }): Promise<Property> {
    const id = "propertyId" in snapshotOrRef ? snapshotOrRef.propertyId : (await resolveRefOrThrow(snapshotOrRef.ref)).id;
    const property = await prisma.property.findUnique({ where: { id } });
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

  return {
    tool: spec.tool,
    requires: ["properties.requestChange"],
    parseArgs: spec.parseArgs,

    async snapshot(args, actor) {
      await loadWriterRole(actor.agentId);
      const property = await loadProperty({ ref: args.ref });
      const pending = await prisma.propertyChangeRequest.findFirst({
        where: { propertyId: property.id, kind: kindOf(args), status: "PENDING" },
        orderBy: { createdAt: "desc" },
        select: { id: true },
      });
      const snap: Snap = {
        propertyId: property.id,
        shortId: property.shortId,
        price: Number(property.price),
        currency: property.currency,
        status: property.status,
        pendingRequestId: pending?.id ?? null,
        ...(spec.extraSnapshot ? await spec.extraSnapshot(args, property) : {}),
      };
      return snap;
    },

    async buildPreview(args, snapshot, actor) {
      const snap = snapshot as Snap;
      const property = await loadProperty(snap);
      const { payloadObject } = await checkedBody(args, property, actor);
      if (snap.pendingRequestId) throw duplicateError(kindOf(args), property.shortId);
      const described = spec.describe(args, property, payloadObject);
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

    /** Откат — отзыв заявки, пока по ней нет решения. Решили уже — 409, откатывать нечего. */
    async undo(_args, actor, ctx) {
      await loadWriterRole(actor.agentId);
      const requestId = (ctx.result as { requestId?: string } | null)?.requestId;
      if (!requestId) throw new AssistantActionError(409, "NOT_UNDOABLE", "Нечего откатывать");
      const cancelled = await cancelPropertyChangeRequest({
        requestId,
        actorId: actor.agentId,
        note: "Отозвана автором (отмена в ИИ-помощнике)",
        auditSource: { source: "assistant.undo", actionId: ctx.actionId },
      });
      if (!cancelled.ok) {
        throw new AssistantActionError(
          cancelled.status === 409 ? 409 : cancelled.status,
          cancelled.status === 409 ? "STALE" : "REFUSED",
          cancelled.status === 409 ? "По заявке уже вынесено решение — откатить нельзя." : cancelled.error,
        );
      }
    },
  };
}
