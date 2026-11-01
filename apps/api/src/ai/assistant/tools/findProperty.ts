import { z } from "zod";
import { findPropertiesByRef } from "../../../lib/propertyRefLookup.js";
import { loadMoneyContext } from "../../../lib/money.js";
import { presentPropertyBrief } from "./propertyPresenter.js";
import type { AssistantReadToolPlugin } from "./types.js";

/**
 * find_property — ОБЪЕКТ ПО НОМЕРУ, ССЫЛКЕ ИЛИ АДРЕСУ (П3, группа «read»).
 *
 * «ОБ-000088», «88», ссылка на пост Instagram, адрес — до 5 карточек. В отличие от
 * `search_properties` ищет среди ВСЕХ неудалённых, и проданный/снятый объект находится
 * со своим статусом. Разбор «ссылки» — lib/propertyRefLookup.ts. Права как у списка
 * объектов в REST: каталог общий для всех ролей; Корзина скрыта; своя висящая заявка
 * на удаление прячет объект у автора заявки (тому, у кого нет properties.delete).
 */
const argsSchema = z.object({ ref: z.string().trim().min(1).max(300) });

export const findPropertyTool: AssistantReadToolPlugin = {
  name: "find_property",
  level: "A",
  description:
    "Найти объект недвижимости по номеру («ОБ-000088», «88»), ссылке на пост Instagram или адресу/названию. " +
    "Возвращает до 5 карточек со статусом (в том числе проданные и снятые) и ссылкой href. Зови, когда человек " +
    "назвал КОНКРЕТНЫЙ объект. НЕ зови для подбора под требования клиента (бюджет, комнаты, район) — для него " +
    "search_properties. " +
    "Ссылки Somon в карточках не хранятся — искать по ним нельзя.",
  parameters: {
    type: "object",
    properties: {
      ref: { type: "string", description: "Номер ОБ-000088 или 88, ссылка Instagram, либо слова адреса/названия" },
    },
    required: ["ref"],
  },
  statusPhrase: "Ищу объект…",
  async run(rawArgs, { actor }) {
    const parsed = argsSchema.safeParse(rawArgs);
    if (!parsed.success) return { error: "Укажите номер, ссылку или адрес объекта" };
    const canDelete = actor.permissions?.has("properties.delete") ?? false;
    const found = await findPropertiesByRef(parsed.data.ref, {
      hideOwnPendingDeleteFor: canDelete ? undefined : actor.id,
      limit: 5,
    });
    if (found.kind === "somon") {
      return { total: 0, items: [], note: "Ссылки Somon в карточке объекта не хранятся — найти объект по ним нельзя" };
    }
    const money = await loadMoneyContext();
    return {
      total: found.properties.length,
      matchedBy: found.kind,
      items: found.properties.map((p) => presentPropertyBrief(p, money)),
      ...(found.properties.length === 0 ? { note: "Объект не найден" } : {}),
    };
  },
};
