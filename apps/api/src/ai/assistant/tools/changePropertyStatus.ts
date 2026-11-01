import { z } from "zod";
import { isReadOnlyRole } from "@royal-home/shared";
import {
  PROPERTY_STATUSES,
  PUBLISHED_PROPERTY_STATUSES,
  formatPropertyCode,
  requiresPropertyModeration,
  type PropertyStatus,
} from "@royal-home/shared";
import { prisma } from "../../../db.js";
import { AssistantActionError } from "../../../lib/assistantActions.js";
import { isPipelineStatus } from "../../../lib/propertyPipeline.js";
import { PROPERTY_STATUS_LABEL_RU } from "../../../lib/propertyAutoStatus.js";
import {
  PROPERTY_MODERATION_REQUIRED_MESSAGE,
  completedDealRevertBlock,
  manualStatusChangeBlock,
  saleReadinessBlock,
} from "../../../lib/propertyStatusDealGuards.js";
import { makeChangeRequestExecutor } from "./changeRequestTool.js";
import { plainField } from "./safeField.js";
import type { AssistantWriteToolPlugin } from "./types.js";

/**
 * change_property_status — ФАЗА 1 (док. §3): смена статуса опубликованного объекта
 * заявкой. Отдельного вида заявки «статус» в системе НЕТ (виды: цена, данные,
 * перемонтаж, снять из соцсетей, другое), поэтому используется существующий вид
 * `OTHER` с понятным текстом; руководитель решает сам, CRM по такой заявке
 * ничего не выполняет (shared/propertyChangeRequest.ts). Мы не придумываем
 * новой логики статусов: допустимость перехода проверяют те же функции, что
 * `PATCH /properties/:id` (lib/propertyStatusDealGuards.ts + shared).
 */
const PUBLISHED = PUBLISHED_PROPERTY_STATUSES as readonly string[];

const argsSchema = z.object({
  ref: z.string().trim().min(1).max(200),
  status: z.enum(PROPERTY_STATUSES),
  comment: z.string().trim().max(500).optional(),
});

export const changePropertyStatusExecutor = makeChangeRequestExecutor<z.infer<typeof argsSchema>>({
  tool: "change_property_status",
  kind: "OTHER",
  parseArgs: (raw) => argsSchema.parse(raw),

  // Открытые и закрытые сделки входят в снимок: поменялись между превью и «Подтвердить» — STALE.
  async extraSnapshot(_args, property) {
    const [openDeals, completedDeals] = await Promise.all([
      prisma.deal.count({ where: { propertyId: property.id, stage: { notIn: ["COMPLETED", "CANCELLED"] } } }),
      prisma.deal.count({ where: { propertyId: property.id, stage: "COMPLETED" } }),
    ]);
    return { openDeals, completedDeals };
  },

  async buildBody(args, property, actor) {
    const from = property.status as PropertyStatus;
    const to = args.status;
    if (to === from) {
      throw new AssistantActionError(400, "NO_CHANGE", `Объект ${formatPropertyCode(property.shortId)} уже в статусе «${PROPERTY_STATUS_LABEL_RU[from]}».`);
    }
    if (!PUBLISHED.includes(to)) {
      throw new AssistantActionError(
        409,
        "PIPELINE_STATUS",
        "Этапы подготовки (проверка, фото, видео, монтаж) двигает маркетинг кнопками в карточке — через помощника это не меняется.",
      );
    }
    const canModerate = actor.can("properties.moderate");
    const block = await manualStatusChangeBlock(property, to, canModerate);
    if (block) throw new AssistantActionError(block.status, "STATUS_BLOCKED", block.error);
    if (requiresPropertyModeration(from, to) && !canModerate) {
      throw new AssistantActionError(403, "FORBIDDEN", PROPERTY_MODERATION_REQUIRED_MESSAGE);
    }
    if (to === "AVAILABLE" && (isPipelineStatus(from) || from === "WITHDRAWN")) {
      const notReady = await saleReadinessBlock(property);
      if (notReady) throw new AssistantActionError(notReady.status, "NOT_READY", notReady.error);
    }
    const revert = await completedDealRevertBlock(property, to);
    if (revert) throw new AssistantActionError(revert.status, "STATUS_BLOCKED", revert.error);

    const code = formatPropertyCode(property.shortId);
    const text =
      `Сменить статус объекта ${code}: «${PROPERTY_STATUS_LABEL_RU[from]}» → «${PROPERTY_STATUS_LABEL_RU[to]}». ` +
      `Заявка из ИИ-помощника.` +
      (args.comment ? ` Комментарий: ${args.comment}` : "");
    return { kind: "OTHER", payload: { text } };
  },

  describe(args, property) {
    const code = formatPropertyCode(property.shortId);
    const from = property.status as PropertyStatus;
    return {
      title: `Статус объекта ${code}: заявка руководителю`,
      was: {
        Объект: `${code} · ${plainField(property.address, 80) ?? plainField(property.title, 80) ?? ""}`.trim(),
        Статус: PROPERTY_STATUS_LABEL_RU[from],
        "На сайте": property.publishedOnSite ? "опубликован" : "не опубликован",
      },
      becomes: {
        Статус: PROPERTY_STATUS_LABEL_RU[args.status],
        Заявка: "будет создана и уйдёт руководителю на решение",
      },
      risk:
        "Статус не изменится сразу: уйдёт заявка «Другое» с этим текстом, руководитель решит и поменяет статус сам. " +
        "CRM по такой заявке ничего не выполняет автоматически.",
    };
  },
});

export const changePropertyStatusPlugin: AssistantWriteToolPlugin = {
  name: "change_property_status",
  level: "C",
  description:
    "Подать заявку руководителю на смену СТАТУСА опубликованного объекта: снять с продажи (WITHDRAWN), вернуть в продажу " +
    "(AVAILABLE), резерв (RESERVED), продан (SOLD). Звать: «сними ОБ-88 с продажи». НЕ звать для цены " +
    "(change_property_price) и для этапов подготовки объекта (проверка, фото, видео, монтаж) — их двигает маркетинг. " +
    "«Продано» и «Резерв» оформляет сделка: при открытой сделке снять/продать нельзя — сообщи причину из ответа. " +
    "Статус сам не меняется: после подтверждения уйдёт заявка. После вызова ответь одной фразой: «Подтвердите заявку».",
  parameters: {
    type: "object",
    properties: {
      ref: { type: "string", description: "Номер объекта: «ОБ-000088», «88» или id" },
      status: {
        type: "string",
        enum: ["AVAILABLE", "RESERVED", "SOLD", "WITHDRAWN"],
        description: "Новый статус: AVAILABLE — в продаже, RESERVED — резерв, SOLD — продан, WITHDRAWN — снят с продажи",
      },
      comment: { type: "string", description: "Причина, если назвал сотрудник (необязательно)" },
    },
    required: ["ref", "status"],
  },
  statusPhrase: "Готовлю заявку на смену статуса…",
  allowed: (actor) => actor.canRequestChange && !isReadOnlyRole(actor.role),
  executor: changePropertyStatusExecutor as unknown as AssistantWriteToolPlugin["executor"],
};
