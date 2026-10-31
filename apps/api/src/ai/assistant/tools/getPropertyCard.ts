import { z } from "zod";
import { findPropertiesByRef } from "../../../lib/propertyRefLookup.js";
import { loadMoneyContext } from "../../../lib/money.js";
import { presentPropertyCard } from "./propertyPresenter.js";
import type { AssistantReadToolPlugin } from "./types.js";

/**
 * get_property_card — КАРТОЧКА ОБЪЕКТА ЦЕЛИКОМ (П3, группа «read»): поля, цена в валюте
 * объекта и в сомони, статус, агент, ролик, публикация. Подача — `presentPropertyCard`
 * (контакт собственника по правилу REST). Принимает id из find_property или номер.
 */
const argsSchema = z.object({ propertyId: z.string().trim().min(1).max(100) });

export const getPropertyCardTool: AssistantReadToolPlugin = {
  name: "get_property_card",
  level: "A",
  description:
    "Полная карточка ОДНОГО объекта: цена, статус, агент, ролик, публикация на сайте. Зови, когда нужны детали " +
    "объекта, уже найденного через find_property/search_properties. НЕ зови для поиска — для него find_property.",
  parameters: {
    type: "object",
    properties: {
      propertyId: { type: "string", description: "id объекта из ответа find_property или номер (ОБ-000088, 88)" },
    },
    required: ["propertyId"],
  },
  statusPhrase: "Открываю карточку объекта…",
  async run(rawArgs, { actor }) {
    const parsed = argsSchema.safeParse(rawArgs);
    if (!parsed.success) return { error: "Укажите объект" };
    const canDelete = actor.permissions?.has("properties.delete") ?? false;
    const found = await findPropertiesByRef(parsed.data.propertyId, {
      hideOwnPendingDeleteFor: canDelete ? undefined : actor.id,
      limit: 1,
    });
    // Карточка — только по точному id/номеру: подставить «похожий по адресу» объект нельзя.
    const property = found.kind === "id" || found.kind === "shortId" ? found.properties[0] : undefined;
    if (!property) return { error: "Объект не найден — найдите его через find_property и передайте id или номер" };
    return presentPropertyCard(property, actor, await loadMoneyContext());
  },
};
