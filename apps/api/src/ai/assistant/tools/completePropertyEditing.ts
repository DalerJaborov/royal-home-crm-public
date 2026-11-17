import { z } from "zod";
import { PROPERTY_PIPELINE_STATUSES, formatPropertyCode, isReadOnlyRole, type PropertyStatus } from "@royal-home/shared";
import { prisma } from "../../../db.js";
import {
  AssistantActionError,
  type AssistantActionExecutor,
  type AssistantActionPreview,
} from "../../../lib/assistantActions.js";
import { PROPERTY_STATUS_LABEL_RU } from "../../../lib/propertyAutoStatus.js";
import {
  checkCompleteEditing,
  completeEditing,
  saleBlockerAdvice,
  type CompleteEditingCandidate,
  type CompleteEditingFailure,
} from "../../../lib/propertyCompleteEditing.js";
import { propertyHref } from "./propertyPresenter.js";
import { loadWriterRole, resolveRefOrThrow } from "./propertyToolSupport.js";
import { plainField } from "./safeField.js";
import type { AssistantWriteToolPlugin } from "./types.js";

/**
 * complete_property_editing — «МОНТАЖ ГОТОВ, ВЫВЕДИ ОБЪЕКТ В ПРОДАЖУ» (17.11.2026, класс
 * «ответила — не сделала»). Живой случай владельца: ОБ-000193 стоял на «Монтаж» без ссылки на
 * ролик в Instagram, помощница не знала причины и предлагала «заявку на смену статуса», хотя
 * дверь из монтажа одна — кнопка «Готово» (POST /properties/:id/complete-editing).
 *
 * Инструмент — тонкая обёртка над той же функцией, что и кнопка: `lib/propertyCompleteEditing.ts`
 * (проверки, условный перевод, публикация, журнал, пуши). Права — как у кнопки
 * (`canManagePropertyAs`: ведущий, приёмщик, создатель или руководитель с правкой чужих).
 *
 * Не готов к продаже (мало фото, нет ссылки на ролик в Instagram) — карточка подтверждения
 * НЕ создаётся: модель получает причины и что сделать, а человек — внятный ответ вместо
 * кнопки, которая всё равно отказала бы.
 */
const argsSchema = z.object({ ref: z.string().trim().min(1).max(200) });
type Args = z.infer<typeof argsSchema>;

interface Snap {
  propertyId: string;
  shortId: number;
  status: string;
  photoCount: number;
  hasInstagramLink: boolean;
  [extra: string]: unknown;
}

type LoadedProperty = CompleteEditingCandidate & {
  id: string;
  shortId: number;
  title: string;
  address: string | null;
};

async function loadProperty(propertyId: string): Promise<LoadedProperty | null> {
  const property = await prisma.property.findUnique({
    where: { id: propertyId },
    include: { _count: { select: { photos: true } } },
  });
  return property && { ...property, photoCount: property._count.photos };
}

const PIPELINE: readonly string[] = PROPERTY_PIPELINE_STATUSES;

/** Отказ двери «Готово» — человеческими словами и с шагом, что делать (читает модель, пересказывает человеку). */
function refusal(failure: CompleteEditingFailure, property: LoadedProperty | null): AssistantActionError {
  const code = property ? formatPropertyCode(property.shortId) : "Объект";
  if (failure.code === "NOT_FOUND") return new AssistantActionError(404, "ENTITY_NOT_FOUND", "Объект не найден");
  if (failure.code === "FORBIDDEN") {
    return new AssistantActionError(
      403,
      "FORBIDDEN",
      "Недостаточно прав: «Готово» нажимает тот, кто ведёт объект, или руководитель.",
    );
  }
  if (failure.code === "NOT_EDITING") {
    const status = property?.status as PropertyStatus | undefined;
    const label = status ? PROPERTY_STATUS_LABEL_RU[status] : null;
    let message = "Объект уже не на этапе «Монтаж»: возможно, его уже вывели в продажу.";
    if (status === "AVAILABLE") message = `${code} уже в продаже — выводить из монтажа нечего.`;
    else if (status && PIPELINE.includes(status)) {
      message = `${code} сейчас на этапе «${label}», до монтажа ещё не дошёл: этапы подготовки (проверка, фото, видео) двигает маркетинг.`;
    } else if (label) {
      message = `${code} в статусе «${label}»: «Монтаж готов» работает только для объектов на этапе «Монтаж».`;
    }
    return new AssistantActionError(409, "NOT_EDITING", message);
  }
  // NOT_READY: причины и что сделать, чтобы объект вышел в продажу.
  const advice = property ? saleBlockerAdvice(property) : [];
  const reasons = advice.length > 0 ? advice.map((a) => a.problem) : (failure.blockers ?? []);
  const fixes = advice.map((a) => a.fix).join(" ");
  return new AssistantActionError(
    409,
    "NOT_READY_FOR_SALE",
    `${code} пока не может выйти в продажу: ${reasons.join("; ")}.` + (fixes ? ` Что сделать: ${fixes}` : "") +
      " Карточку подтверждения не создаю: как только это исправлено, повторите просьбу.",
  );
}

function whereLine(property: LoadedProperty): string {
  return `${formatPropertyCode(property.shortId)} · ${plainField(property.address, 80) ?? plainField(property.title, 80) ?? ""}`.trim();
}

export const completePropertyEditingExecutor: AssistantActionExecutor<Args> = {
  tool: "complete_property_editing",
  channels: ["crm", "telegram"],
  // Публикация на сайт и уведомления агенту — не при чужих глазах в общей группе (вторая стена к GROUP_HIDDEN_TOOLS).
  privateTelegram: true,
  parseArgs: (raw) => argsSchema.parse(raw),

  // Отказ двери — здесь же, до карточки. После исполнения объект уже не на монтаже: снимок «после»
  // упадёт — брокер это переносит (отката у выхода в продажу нет), повтор получает сохранённый итог.
  async snapshot(args, actor): Promise<Snap> {
    await loadWriterRole(actor.agentId);
    const { id } = await resolveRefOrThrow(args.ref);
    const property = await loadProperty(id);
    const failure = checkCompleteEditing(property, { agentId: actor.agentId, can: actor.can });
    if (failure) throw refusal(failure, property);
    return {
      propertyId: property!.id,
      shortId: property!.shortId,
      status: property!.status,
      photoCount: property!.photoCount,
      hasInstagramLink: Boolean(property!.instagramUrl?.trim()),
    };
  },

  async buildPreview(_args, raw): Promise<AssistantActionPreview> {
    const snap = raw as Snap;
    const property = await loadProperty(snap.propertyId);
    if (!property) throw new AssistantActionError(404, "ENTITY_NOT_FOUND", "Объект не найден");
    const code = formatPropertyCode(snap.shortId);
    return {
      title: `Вывести объект ${code} из монтажа в продажу`,
      was: {
        Объект: whereLine(property),
        Статус: PROPERTY_STATUS_LABEL_RU.EDITING,
        Фото: snap.photoCount,
        "Ссылка на видео-обзор": snap.hasInstagramLink ? "есть" : "нет",
      },
      becomes: {
        Статус: PROPERTY_STATUS_LABEL_RU.AVAILABLE,
        "На сайте": "опубликуется сразу",
        Агент: "получит уведомление, что объект в продаже",
      },
      risk:
        "Объект сразу станет «В продаже» и уйдёт на сайт — как кнопкой «Готово» в карточке. " +
        "Вернуть его на монтаж можно только через маркетинг.",
    };
  },

  async execute(_args, actor, ctx) {
    await loadWriterRole(actor.agentId);
    const snap = ctx.snapshotBefore as Snap;
    const outcome = await completeEditing({
      propertyId: snap.propertyId,
      actor: { agentId: actor.agentId, can: actor.can },
      // Автор в журнале — тот, кто нажал «Подтвердить»; источник — помощник.
      audit: { agentId: actor.agentId, meta: { source: "assistant", actionId: ctx.actionId, tool: "complete_property_editing" } },
    });
    if (!outcome.ok) throw refusal(outcome, await loadProperty(snap.propertyId));
    const code = formatPropertyCode(snap.shortId);
    // Статус в CRM сменился, а сайт объект не принял — «изменено, но не всё» (как у смены статуса).
    const partial = Boolean(outcome.siteSyncError);
    return {
      result: {
        status: partial ? "PARTIAL" : "APPLIED",
        applied: true,
        from: "EDITING",
        to: outcome.property.status,
        propertyShortId: snap.shortId,
        href: propertyHref(snap.shortId),
        message: partial
          ? `${code} вышел в продажу в CRM, но сайт его пока не принял (${outcome.siteSyncError}). Опубликуйте повторно кнопкой в карточке, когда сайт ответит.`
          : `${code} вышел из монтажа в продажу и опубликован на сайте.`,
      },
      audit: { entityType: "Property", entityId: snap.propertyId },
    };
  },
};

export const completePropertyEditingPlugin: AssistantWriteToolPlugin = {
  name: "complete_property_editing",
  level: "C",
  description:
    "Вывести объект из МОНТАЖА в продажу — то же, что кнопка «Готово» в карточке. " +
    "Звать: «выведи ОБ-193 в продажу», «монтаж ОБ-193 готов», «нажми Готово», «почему не в продаже — сделай, чтобы вышел»; " +
    "по-таджикски: «ба фурӯш баровар», «монтаж тайёр аст», «объектро ба фурӯш бароред». " +
    "Работает только для объекта на этапе «Монтаж»; сначала можно спросить причину через get_property_work_status. " +
    "Если объекту чего-то не хватает (мало фото, нет ссылки на ролик в Instagram), карточка подтверждения не создаётся, " +
    "а в ответе придут причины и что сделать — перескажи их человеку своими словами, заявку «Другое» не подавай. " +
    "Нажать «Готово» может тот, кто ведёт объект, или руководитель. Объект сразу выйдет в продажу и опубликуется на сайте. " +
    "После вызова ответь одной фразой: «Подтвердите».",
  parameters: {
    type: "object",
    properties: {
      ref: { type: "string", description: "Номер объекта: «ОБ-000193», «193» или id" },
    },
    required: ["ref"],
  },
  statusPhrase: "Проверяю, готов ли объект к продаже…",
  // Как кнопка «Готово»: свой объект может любой, кто не «только просмотр»; остальное решают проверки.
  allowed: (actor) => !isReadOnlyRole(actor.role),
  executor: completePropertyEditingExecutor as unknown as AssistantWriteToolPlugin["executor"],
};
