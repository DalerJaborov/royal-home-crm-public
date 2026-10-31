import { z } from "zod";
import { isReadOnlyRole } from "@royal-home/shared";
import {
  PROPERTY_CHANGE_KIND_HINTS,
  PROPERTY_CHANGE_KIND_LABELS,
  formatPropertyCode,
  type CreatePropertyChangeRequestInput,
} from "@royal-home/shared";
import { AssistantActionError } from "../../../lib/assistantActions.js";
import { makeChangeRequestExecutor } from "./changeRequestTool.js";
import { plainField } from "./safeField.js";
import type { AssistantWriteToolPlugin } from "./types.js";

/**
 * request_property_change — заявка руководителю на изменение ОПУБЛИКОВАННОГО объекта
 * в трёх видах: данные карточки (CARD_DATA), убрать из соцсетей (UNPUBLISH) и
 * «Другое» (OTHER). Цена и статус — отдельные инструменты. Перемонтаж — `send_to_remake`.
 * Право — `properties.requestChange` (как кнопка «Запросить изменение»).
 */
const KINDS = ["CARD_DATA", "UNPUBLISH", "OTHER"] as const;

const argsSchema = z.object({
  ref: z.string().trim().min(1).max(200),
  kind: z.enum(KINDS),
  /** OTHER: что нужно изменить своими словами. */
  text: z.string().trim().max(2000).optional(),
  /** CARD_DATA: поля карточки → новые значения (набор и типы проверяет сервис заявок). */
  patch: z.record(z.string(), z.unknown()).optional(),
  /** UNPUBLISH: каналы; пусто — все, где ролик вышел. */
  channels: z.array(z.string().min(1).max(40)).max(12).optional(),
  comment: z.string().trim().max(2000).optional(),
});

/** Значение поля для карточки: Decimal/дата → простой JSON. */
const plainValue = (v: unknown): unknown => (v === undefined ? null : JSON.parse(JSON.stringify(v)));

export const requestPropertyChangeExecutor = makeChangeRequestExecutor<z.infer<typeof argsSchema>>({
  tool: "request_property_change",
  kind: (args) => args.kind,
  parseArgs: (raw) => argsSchema.parse(raw),
  async buildBody(args): Promise<CreatePropertyChangeRequestInput> {
    switch (args.kind) {
      case "OTHER":
        if (!args.text) throw new AssistantActionError(400, "BAD_ARGS", "Опишите, что нужно изменить (поле text).");
        return { kind: "OTHER", payload: { text: args.text }, comment: args.comment };
      case "CARD_DATA":
        if (!args.patch || Object.keys(args.patch).length === 0) {
          throw new AssistantActionError(400, "BAD_ARGS", "Укажите, какие поля карточки поменять (поле patch).");
        }
        return { kind: "CARD_DATA", payload: { patch: args.patch, remake: false }, comment: args.comment };
      case "UNPUBLISH":
        return { kind: "UNPUBLISH", payload: { channels: args.channels }, comment: args.comment };
    }
  },
  describe(args, property, payload) {
    const code = formatPropertyCode(property.shortId);
    const where = `${code} · ${plainField(property.address, 80) ?? plainField(property.title, 80) ?? ""}`.trim();
    const label = PROPERTY_CHANGE_KIND_LABELS[args.kind];
    const patch = (payload as { patch?: Record<string, unknown> }).patch;
    const existing = property as unknown as Record<string, unknown>;
    const was: Record<string, unknown> = { Объект: where };
    const becomes: Record<string, unknown> = {};
    if (args.kind === "CARD_DATA" && patch) {
      for (const [field, value] of Object.entries(patch)) {
        was[field] = plainValue(existing[field]);
        becomes[field] = plainValue(value);
      }
    } else if (args.kind === "UNPUBLISH") {
      was["Ролик вышел в"] = (property.publishedChannels ?? []).join(", ") || "нигде";
      becomes["Снять из"] = args.channels?.length ? args.channels.join(", ") : "всех сетей, где вышел";
    } else {
      becomes["Что изменить"] = plainField(args.text, 300);
    }
    becomes["Заявка"] = "будет создана и уйдёт руководителю на решение";
    return {
      title: `${label}: ${code}, заявка руководителю`,
      was,
      becomes,
      risk: `Сразу ничего не изменится — заявку решает руководитель. ${PROPERTY_CHANGE_KIND_HINTS[args.kind]}`,
    };
  },
});

export const requestPropertyChangePlugin: AssistantWriteToolPlugin = {
  name: "request_property_change",
  level: "C",
  description:
    "Подать заявку руководителю на изменение ОПУБЛИКОВАННОГО объекта, кроме цены и статуса: kind=CARD_DATA " +
    "(поправить данные карточки: комнаты, площадь, этаж… — в patch), kind=UNPUBLISH (убрать ролик из соцсетей), " +
    "kind=OTHER (любая другая просьба, текст в text). Звать, когда просят «попроси директора поменять…». " +
    "НЕ звать для цены (change_property_price), статуса (change_property_status) и перемонтажа ролика (send_to_remake). " +
    "После вызова ответь одной фразой: «Подтвердите заявку».",
  parameters: {
    type: "object",
    properties: {
      ref: { type: "string", description: "Номер объекта: «ОБ-000088», «88» или id" },
      kind: { type: "string", enum: [...KINDS], description: "CARD_DATA — данные карточки, UNPUBLISH — убрать из соцсетей, OTHER — другое" },
      text: { type: "string", description: "Для kind=OTHER: что нужно изменить (не короче 10 символов)" },
      patch: { type: "object", description: "Для kind=CARD_DATA: поля карточки и новые значения, например {\"rooms\": 3}" },
      channels: { type: "array", items: { type: "string" }, description: "Для kind=UNPUBLISH: каналы (INSTAGRAM, FACEBOOK…); не указывай — все" },
      comment: { type: "string", description: "Пояснение руководителю (необязательно)" },
    },
    required: ["ref", "kind"],
  },
  statusPhrase: "Готовлю заявку руководителю…",
  allowed: (actor) => actor.canRequestChange && !isReadOnlyRole(actor.role),
  executor: requestPropertyChangeExecutor as unknown as AssistantWriteToolPlugin["executor"],
};
