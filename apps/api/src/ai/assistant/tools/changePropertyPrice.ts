import { z } from "zod";
import { isReadOnlyRole } from "@royal-home/shared";
import { CURRENCIES, PROPERTY_CHANGE_KIND_HINTS, formatPropertyCode } from "@royal-home/shared";
import { formatPrice } from "../../seoGenerator.js";
import { roundMoney } from "../../../lib/money.js";
import { makeChangeRequestExecutor } from "./changeRequestTool.js";
import { plainField } from "./safeField.js";
import type { AssistantWriteToolPlugin } from "./types.js";

/**
 * change_property_price — ФАЗА 1 (док. §3): цена опубликованного объекта меняется
 * не напрямую, а заявкой `PRICE_CHANGE`, как кнопкой «Цена изменилась» в
 * карточке; руководитель одобряет существующим экраном, и CRM обновляет сайт и
 * подписи. Прямое изменение (фаза 2, lib/propertyUpdate.ts) — отдельная пачка.
 * Деньги — только через lib/money.ts (`roundMoney`, `toCents` в сервисе).
 */
const argsSchema = z.object({
  ref: z.string().trim().min(1).max(200),
  // Модель иногда присылает число строкой — принимаем, как принял бы форму.
  newPrice: z.coerce.number().positive().max(1_000_000_000),
  currency: z.enum(CURRENCIES).optional(),
});

export const changePropertyPriceExecutor = makeChangeRequestExecutor<z.infer<typeof argsSchema>>({
  tool: "change_property_price",
  kind: "PRICE_CHANGE",
  parseArgs: (raw) => argsSchema.parse(raw),
  async buildBody(args) {
    return {
      kind: "PRICE_CHANGE",
      payload: { newPrice: roundMoney(args.newPrice), currency: args.currency, remake: false },
    };
  },
  describe(args, property) {
    const code = formatPropertyCode(property.shortId);
    const currency = args.currency ?? property.currency;
    const channels = (property.publishedChannels ?? []).join(", ");
    return {
      title: `Цена объекта ${code}: заявка руководителю`,
      was: {
        Объект: `${code} · ${plainField(property.address, 80) ?? plainField(property.title, 80) ?? ""}`.trim(),
        Цена: formatPrice(Number(property.price), property.currency),
        "На сайте": property.publishedOnSite ? "опубликован" : "не опубликован",
        "В соцсетях": channels || "нигде",
      },
      becomes: {
        Цена: formatPrice(roundMoney(args.newPrice), currency),
        Заявка: "будет создана и уйдёт руководителю на одобрение",
      },
      risk: `Цена не изменится сразу: будет создана заявка руководителю. ${PROPERTY_CHANGE_KIND_HINTS.PRICE_CHANGE}`,
    };
  },
});

export const changePropertyPricePlugin: AssistantWriteToolPlugin = {
  name: "change_property_price",
  level: "C",
  description:
    "Подать заявку руководителю на изменение ЦЕНЫ опубликованного объекта (было → станет, потом человек подтверждает). " +
    "Звать, когда просят поменять/снизить/поднять цену объекта: «подними цену ОБ-88 до 95 000». " +
    "НЕ звать для поиска объекта (find_property), для смены статуса (change_property_status) и для объектов, " +
    "которые ещё не опубликованы (их карточку правят руками). Цена сама не меняется — после подтверждения " +
    "уйдёт заявка, одобряет руководитель. После вызова ответь одной фразой: «Подтвердите заявку».",
  parameters: {
    type: "object",
    properties: {
      ref: { type: "string", description: "Номер объекта: «ОБ-000088», «88» или id" },
      newPrice: { type: "number", description: "Новая цена числом, без пробелов" },
      currency: { type: "string", enum: ["USD", "TJS"], description: "Валюта новой цены; не указывай, если валюта объекта не меняется" },
    },
    required: ["ref", "newPrice"],
  },
  statusPhrase: "Готовлю заявку на новую цену…",
  allowed: (actor) => actor.canRequestChange && !isReadOnlyRole(actor.role),
  executor: changePropertyPriceExecutor as unknown as AssistantWriteToolPlugin["executor"],
};
