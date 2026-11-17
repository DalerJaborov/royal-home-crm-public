import { z } from "zod";
import {
  PROPERTY_DELETE_REQUEST_REASONS,
  PROPERTY_STATUSES,
  PUBLISHED_PROPERTY_STATUSES,
  formatPropertyCode,
  isReadOnlyRole,
  propertyRemovalSchema,
  requiresPropertyModeration,
  type PropertyRemovalInput,
  type PropertyStatus,
} from "@royal-home/shared";
import { prisma, type PropertyRecord } from "../../../db.js";
import {
  AssistantActionError,
  type AssistantActionActor,
  type AssistantActionExecutor,
  type AssistantActionPreview,
} from "../../../lib/assistantActions.js";
import { PROPERTY_STATUS_LABEL_RU } from "../../../lib/propertyAutoStatus.js";
import { PROPERTY_MODERATION_REQUIRED_MESSAGE } from "../../../lib/propertyStatusDealGuards.js";
import {
  changePropertyStatus,
  checkPropertyStatusChange,
  propertyStatusChangeBlock,
  type PropertyStatusChangeFailure,
} from "../../../lib/propertyStatusChange.js";
import { makeChangeRequestExecutor } from "./changeRequestTool.js";
import { propertyHref } from "./propertyPresenter.js";
import { loadWriterRole } from "./propertyToolSupport.js";
import { plainField } from "./safeField.js";
import type { AssistantWriteToolPlugin } from "./types.js";

/**
 * change_property_status — смена статуса объекта (17.11.2026, класс «ответила — не сделала»).
 *
 * Раньше любая смена шла заявкой «Другое», которую исполнитель заявок принимал «к сведению»
 * и НИЧЕГО не менял: «верни объект в продажу» отвечало «одобрено», а объект стоял снятым.
 * Теперь, как в карточке CRM (одна дверь — lib/propertyStatusChange.ts, её же зовёт PATCH):
 *  - свой объект (или руководитель с правкой чужих), шаг по правам сотрудника — СРАЗУ после
 *    «Подтвердить», с теми же проверками и последствиями, что у карточки;
 *  - шаг маркетинга (возврат снятого в продажу), которого у сотрудника нет, — заявка
 *    руководителю; при «Принять» её исполняет ТА ЖЕ дверь правами принявшего, а не «к сведению»;
 *  - «Снять с продажи» — с причиной, как требует экран CRM (propertyRemovalSchema).
 * Права — те же, что у PATCH: `canManagePropertyAs` + проверки статуса; больше и меньше нельзя.
 */
const PUBLISHED = PUBLISHED_PROPERTY_STATUSES as readonly string[];

const argsSchema = z.object({
  ref: z.string().trim().min(1).max(200),
  status: z.enum(PROPERTY_STATUSES),
  removalReason: z.enum(PROPERTY_DELETE_REQUEST_REASONS).optional(),
  removalComment: z.string().trim().max(1000).optional(),
  comment: z.string().trim().max(500).optional(),
});
type Args = z.infer<typeof argsSchema>;

type Mode = "direct" | "request";

interface StatusSnap {
  propertyId: string;
  shortId: number;
  status: string;
  pendingRequestId: string | null;
  mode: Mode;
  [extra: string]: unknown;
}

/** Шаг маркетинга без права на него — заявкой руководителю; всё остальное — сразу. */
function modeFor(from: string, to: PropertyStatus, actor: AssistantActionActor): Mode {
  return requiresPropertyModeration(from as PropertyStatus, to) && !actor.can("properties.moderate") ? "request" : "direct";
}

function removalOf(args: Args): PropertyRemovalInput | null {
  return args.removalReason ? { removalReason: args.removalReason, removalComment: args.removalComment } : null;
}

function statusFailure(failure: PropertyStatusChangeFailure): AssistantActionError {
  return new AssistantActionError(
    failure.status,
    failure.code,
    failure.error,
    failure.code === "STALE" ? { stale: true } : {},
  );
}

/** Общие отказы обоих путей — до прав и сделок. */
function precheck(args: Args, property: PropertyRecord): void {
  const from = property.status as PropertyStatus;
  if (!PUBLISHED.includes(args.status)) {
    throw new AssistantActionError(
      409,
      "PIPELINE_STATUS",
      "Этапы подготовки (проверка, фото, видео, монтаж) двигает маркетинг кнопками в карточке — через помощника это не меняется.",
    );
  }
  // Из монтажа в продажу выводит «Готово», а не смена статуса (lib/propertyCompleteEditing.ts): ролик, сайт и очередь
  // монтажёра идут этим путём. Не заявка «Другое» и не отказ без выхода — модели называем инструмент (17.11.2026).
  if (args.status === "AVAILABLE" && from === "EDITING") {
    throw new AssistantActionError(
      409,
      "USE_COMPLETE_EDITING",
      "Объект на этапе «Монтаж»: в продажу его выводит не смена статуса, а инструмент complete_property_editing " +
        "(«Монтаж готов», то же, что кнопка «Готово»). Вызови его с этим же объектом: если чего-то не хватает " +
        "(фото, ссылки на ролик в Instagram), он назовёт причину. Заявку «Другое» не подавай.",
    );
  }
  if (args.status === from) {
    throw new AssistantActionError(400, "NO_CHANGE", `Объект ${formatPropertyCode(property.shortId)} уже в статусе «${PROPERTY_STATUS_LABEL_RU[from]}».`);
  }
  if (args.status === "WITHDRAWN") {
    // Экран CRM спрашивает причину снятия — помощник тоже (по ней строится карточка продавца и проверка).
    if (!args.removalReason) {
      throw new AssistantActionError(
        400,
        "REMOVAL_REASON_REQUIRED",
        "Почему снимаем с продажи? Собственник передумал, продан в обход агентства, дубль, ошибка в данных, тестовая карточка или другое (тогда в двух словах).",
      );
    }
    const removal = propertyRemovalSchema.safeParse(removalOf(args));
    if (!removal.success) throw new AssistantActionError(400, "BAD_ARGS", removal.error.issues[0]?.message ?? "Неверная причина снятия");
  }
}

async function loadProperty(propertyId: string): Promise<PropertyRecord> {
  const property = await prisma.property.findUnique({ where: { id: propertyId } });
  if (!property || property.deletedAt) throw new AssistantActionError(404, "ENTITY_NOT_FOUND", "Объект не найден");
  return property;
}

function whereLine(property: PropertyRecord): string {
  const code = formatPropertyCode(property.shortId);
  return `${code} · ${plainField(property.address, 80) ?? plainField(property.title, 80) ?? ""}`.trim();
}

/** Заявка руководителю: проверки карточки — сейчас, право на шаг маркетинга — у того, кто примет. */
const asRequest = makeChangeRequestExecutor<Args>({
  tool: "change_property_status",
  kind: "OTHER",
  parseArgs: (raw) => argsSchema.parse(raw),

  // Открытые и закрытые сделки входят в снимок: поменялись между превью и «Подтвердить» — STALE.
  async extraSnapshot(_args, property, db) {
    const openDeals = await db.deal.count({ where: { propertyId: property.id, stage: { notIn: ["COMPLETED", "CANCELLED"] } } });
    const completedDeals = await db.deal.count({ where: { propertyId: property.id, stage: "COMPLETED" } });
    return { openDeals, completedDeals };
  },

  async buildBody(args, property) {
    precheck(args, property);
    const block = await propertyStatusChangeBlock(property, args.status, { canModerate: true });
    if (block) throw new AssistantActionError(block.status, "STATUS_BLOCKED", block.error);
    const from = property.status as PropertyStatus;
    const text =
      `Сменить статус объекта ${formatPropertyCode(property.shortId)}: «${PROPERTY_STATUS_LABEL_RU[from]}» → «${PROPERTY_STATUS_LABEL_RU[args.status]}». ` +
      "Заявка из ИИ-помощника: после «Принять» статус сменится сам." +
      (args.comment ? ` Комментарий: ${args.comment}` : "");
    return { kind: "OTHER", payload: { text } };
  },

  // Машинная часть: исполнитель заявок по ней зовёт ту же дверь, что карточка.
  extraPayload: (args) => ({
    statusChange: {
      to: args.status,
      ...(args.removalReason ? { removalReason: args.removalReason } : {}),
      ...(args.removalComment ? { removalComment: args.removalComment } : {}),
    },
  }),

  describe(args, property) {
    const from = property.status as PropertyStatus;
    return {
      title: `Статус объекта ${formatPropertyCode(property.shortId)}: заявка руководителю`,
      was: {
        Объект: whereLine(property),
        Статус: PROPERTY_STATUS_LABEL_RU[from],
        "На сайте": property.publishedOnSite ? "опубликован" : "не опубликован",
      },
      becomes: {
        Статус: PROPERTY_STATUS_LABEL_RU[args.status],
        Заявка: "уйдёт руководителю; после «Принять» статус сменится сам",
      },
      risk: "Этот шаг — за маркетингом и руководством, поэтому сразу статус не изменится: после одобрения CRM сменит его сама.",
    };
  },
});

function missingRequestUndo(): never {
  throw new Error("change_property_status: у заявки нет отката");
}
const requestUndo = asRequest.transactionalUndo ?? missingRequestUndo();

function directPreview(args: Args, property: PropertyRecord): AssistantActionPreview {
  const from = property.status as PropertyStatus;
  const becomes: Record<string, unknown> = { Статус: PROPERTY_STATUS_LABEL_RU[args.status] };
  if (args.status === "WITHDRAWN") becomes.Причина = plainField(args.removalComment, 200) ?? args.removalReason;
  return {
    title: `Статус объекта ${formatPropertyCode(property.shortId)}`,
    was: {
      Объект: whereLine(property),
      Статус: PROPERTY_STATUS_LABEL_RU[from],
      "На сайте": property.publishedOnSite ? "опубликован" : "не опубликован",
    },
    becomes,
    risk:
      args.status === "WITHDRAWN"
        ? "Статус изменится сразу: объявление уйдёт с сайта, показы и посты по объекту закроются. Вернуть в продажу — через маркетинг."
        : "Статус изменится сразу — как кнопкой в карточке объекта. Вернуть прежний — новой просьбой.",
  };
}

function requireRequestRight(actor: AssistantActionActor): void {
  if (!actor.can("properties.requestChange")) {
    throw new AssistantActionError(403, "FORBIDDEN", `${PROPERTY_MODERATION_REQUIRED_MESSAGE} Подать заявку руководителю у вас нет права.`);
  }
}

export const changePropertyStatusExecutor: AssistantActionExecutor<Args> = {
  tool: "change_property_status",
  // Как PATCH: права проверяются по объекту (canManagePropertyAs), а не общей галочкой заявок.
  channels: ["crm", "telegram"],
  parseArgs: (raw) => argsSchema.parse(raw),
  authorize: asRequest.authorize,

  async snapshot(args, actor) {
    const snap = await asRequest.snapshot(args, actor);
    return { ...snap, mode: modeFor(String(snap.status), args.status, actor) };
  },

  async buildPreview(args, snapshot, actor) {
    const snap = snapshot as StatusSnap;
    if (snap.mode === "request") {
      const property = await loadProperty(snap.propertyId);
      precheck(args, property);
      requireRequestRight(actor);
      return asRequest.buildPreview(args, snapshot, actor);
    }
    const property = await loadProperty(snap.propertyId);
    precheck(args, property);
    const failure = await checkPropertyStatusChange(property, actor, args.status, removalOf(args));
    if (failure) throw statusFailure(failure);
    return directPreview(args, property);
  },

  async execute(args, actor, ctx) {
    await loadWriterRole(actor.agentId);
    const snap = ctx.snapshotBefore as StatusSnap;
    if (snap.mode === "request") {
      requireRequestRight(actor);
      return asRequest.execute(args, actor, ctx);
    }
    const property = await loadProperty(snap.propertyId);
    precheck(args, property);
    const outcome = await changePropertyStatus({
      propertyId: property.id,
      actor: { agentId: actor.agentId, can: actor.can },
      to: args.status,
      removal: removalOf(args),
      // Что видел человек в превью: статус успели сменить — STALE, а не затирание.
      expect: { status: snap.status },
      auditMeta: { source: "assistant", actionId: ctx.actionId, tool: "change_property_status" },
    });
    if (!outcome.ok) throw statusFailure(outcome);
    const from = outcome.before.status as PropertyStatus;
    const to = outcome.property.status as PropertyStatus;
    return {
      result: {
        status: "APPLIED",
        applied: true,
        from,
        to,
        propertyShortId: property.shortId,
        href: propertyHref(property.shortId),
        message: `Статус ${formatPropertyCode(property.shortId)}: «${PROPERTY_STATUS_LABEL_RU[from]}» → «${PROPERTY_STATUS_LABEL_RU[to]}».`,
      },
      audit: { entityType: "Property", entityId: property.id },
    };
  },

  // Откат — только у заявки (отозвать, пока ждёт решения). Смена «сразу» отката кнопкой не имеет:
  // обратный шаг подчиняется тем же правилам (возврат в продажу — за маркетингом).
  transactionalUndo: {
    matches: requestUndo.matches,
    execute: (args, actor, ctx) =>
      requestUndo.execute(args, actor, {
        ...ctx,
        // Снимок заявки собирается без «пути»; путь у отзываемой заявки всегда «заявка».
        assertSnapshot: (current) => ctx.assertSnapshot({ ...current, mode: "request" }),
      }),
  },
};

export const changePropertyStatusPlugin: AssistantWriteToolPlugin = {
  name: "change_property_status",
  level: "C",
  description:
    "Сменить статус объекта: снять с продажи, вернуть в продажу, поставить в резерв или отметить продажу. " +
    "Звать: «сними ОБ-88 с продажи», «верни ОБ-88 в продажу». Своему объекту статус меняется сразу после подтверждения — " +
    "как кнопкой в карточке; возврат снятого в продажу без права маркетинга уходит заявкой руководителю, и после одобрения " +
    "статус сменится сам. Для снятия спроси причину, если сотрудник её не назвал. Для цены есть отдельный инструмент. " +
    "Этапы подготовки (проверка, фото, видео, монтаж) ведёт маркетинг; объект на этапе «Монтаж» выводит в продажу " +
    "не этот инструмент, а complete_property_editing. «Продано» и «Резерв» оформляет сделка: " +
    "при открытой сделке снять или продать нельзя — перескажи причину из ответа. После вызова ответь одной фразой: «Подтвердите».",
  parameters: {
    type: "object",
    properties: {
      ref: { type: "string", description: "Номер объекта: «ОБ-000088», «88» или id" },
      status: {
        type: "string",
        enum: ["AVAILABLE", "RESERVED", "SOLD", "WITHDRAWN"],
        description: "Выбери статус по смыслу просьбы: вернуть в продажу, поставить в резерв, отметить продажу или снять с продажи. Код используется только в вызове.",
      },
      removalReason: {
        type: "string",
        enum: [...PROPERTY_DELETE_REQUEST_REASONS],
        description: "Только для снятия с продажи: причина по смыслу слов сотрудника. Код используется только в вызове.",
      },
      removalComment: { type: "string", description: "Причина снятия своими словами (обязательна, если причина «другое»)" },
      comment: { type: "string", description: "Пояснение руководителю, если назвал сотрудник (необязательно)" },
    },
    required: ["ref", "status"],
  },
  statusPhrase: "Готовлю смену статуса…",
  // Как карточка CRM: свой объект может сменить любой, кто не «только просмотр»; остальное решают проверки.
  allowed: (actor) => !isReadOnlyRole(actor.role),
  executor: changePropertyStatusExecutor as unknown as AssistantWriteToolPlugin["executor"],
};
