import { z } from "zod";
import { PROPERTY_CONDITION_LABELS, PROPERTY_TYPE_LABELS, formatClientCode, formatClientName, formatPropertyCode } from "@royal-home/shared";
import { prisma } from "../../../db.js";
import { stripOwnerContact } from "../../../lib/ownerContact.js";
import { clientNamePhoneSafe } from "../../../lib/clientPhone.js";
import { dushanbeDateString } from "../../../lib/dushanbeTime.js";
import { loadMoneyContext, toTjs } from "../../../lib/money.js";
import { searchPropertiesForStaff, type StaffSearchScope } from "../../../lib/staffPropertySearch.js";
import { propertyHref } from "./propertyPresenter.js";
import { safeField } from "./safeField.js";
import type { AssistantReadToolPlugin } from "./types.js";

/**
 * find_properties_by_place — ОБЪЕКТЫ ПО ОРИЕНТИРУ, АДРЕСУ И ПРИЗНАКАМ, В ТОМ ЧИСЛЕ В КОРЗИНЕ
 * (07.11.2026). Место разбирает код (lib/searchPlace.ts — то же правило, что у голосового
 * консультанта), радиус расширяется сам. Корзина — ТОЛЬКО при праве archive.view, и право
 * проверяется здесь, на сервере, а не в промте: без него Корзина не открывается и в ответе
 * честно сказано, что её не смотрели.
 */
const argsSchema = z.object({
  landmark: z.string().trim().max(200).optional(),
  radiusM: z.coerce.number().min(100).max(10_000).optional(),
  text: z.string().trim().max(200).optional(),
  districtName: z.string().trim().max(100).optional(),
  type: z.enum(["APARTMENT", "HOUSE", "COMMERCIAL", "LAND"]).optional(),
  minRooms: z.coerce.number().int().min(0).max(50).optional(),
  maxRooms: z.coerce.number().int().min(0).max(50).optional(),
  minFloor: z.coerce.number().int().min(-5).max(200).optional(),
  maxFloor: z.coerce.number().int().min(-5).max(200).optional(),
  minAreaSqm: z.coerce.number().min(0).max(100_000).optional(),
  maxAreaSqm: z.coerce.number().min(0).max(100_000).optional(),
  minPrice: z.coerce.number().min(0).optional(),
  maxPrice: z.coerce.number().min(0).optional(),
  currency: z.enum(["TJS", "USD"]).optional(),
  shell: z.boolean().optional(),
  condition: z.enum(["NEEDS_REPAIR", "GOOD", "EXCELLENT", "NEW_BUILDING"]).optional(),
  status: z.enum(["AVAILABLE", "RESERVED", "SOLD", "WITHDRAWN"]).optional(),
  scope: z.enum(["live", "trash", "both"]).optional(),
  limit: z.coerce.number().int().min(1).max(20).optional(),
});

export const TRASH_FOR_MANAGEMENT_ONLY =
  "Корзина удалённых — это у руководства (директор, администратор). Я могу поискать среди живых.";

export const findPropertiesByPlaceTool: AssistantReadToolPlugin = {
  name: "find_properties_by_place",
  level: "A",
  description:
    "Основной поиск объектов по ОРИЕНТИРУ, адресу и признакам. Зови всегда, когда в вопросе есть «около/возле/рядом с/в стороне/у …», " +
    "название места (Ашан, Воданасос, 82 мкр, базар), «коробка», этаж, площадь или цена в сомони/долларах. " +
    "landmark — место СЛОВАМИ ЧЕЛОВЕКА, как сказано («у Ашана», «в стороне Воданасоса»): район и точку на карте определяет сам инструмент, не угадывай. " +
    "Радиус расширяется сам; можно задать radiusM. Тип: APARTMENT/HOUSE (хавли, дом)/COMMERCIAL/LAND. shell=true — «коробка» (без ремонта). " +
    "Цена: minPrice/maxPrice + currency (TJS или USD; «2,5 млн» без слова — сомони, а малая сумма без валюты — спроси валюту). " +
    "scope: live — живые, trash — удалённые (Корзина), both — оба; по умолчанию both, если у человека есть доступ к Корзине. " +
    "Корзину открывает только руководство (право Архив): у остальных инструмент ищет в живых и пишет, что Корзину не смотрел. " +
    "В ответе у каждого объекта inTrash/deletedAt/distanceM. «Нет» говори только когда searched покрывает и живые, и Корзину (если доступна), " +
    "и карточки продавцов проверены через find_clients.",
  parameters: {
    type: "object",
    properties: {
      landmark: { type: "string", description: "Ориентир словами человека: «Ашан», «в стороне Воданасоса», «82 мкр»" },
      radiusM: { type: "number", description: "Радиус в метрах (100–10000). Обычно не нужен." },
      text: { type: "string", description: "Слова из адреса, названия или описания" },
      districtName: { type: "string", description: "Район, например Сино" },
      type: { type: "string", enum: ["APARTMENT", "HOUSE", "COMMERCIAL", "LAND"] },
      minRooms: { type: "number" },
      maxRooms: { type: "number" },
      minFloor: { type: "number" },
      maxFloor: { type: "number" },
      minAreaSqm: { type: "number" },
      maxAreaSqm: { type: "number" },
      minPrice: { type: "number" },
      maxPrice: { type: "number" },
      currency: { type: "string", enum: ["TJS", "USD"], description: "Валюта minPrice/maxPrice" },
      shell: { type: "boolean", description: "true — «коробка», без ремонта" },
      condition: { type: "string", enum: ["NEEDS_REPAIR", "GOOD", "EXCELLENT", "NEW_BUILDING"] },
      status: { type: "string", enum: ["AVAILABLE", "RESERVED", "SOLD", "WITHDRAWN"], description: "Пусто — любой статус" },
      scope: { type: "string", enum: ["live", "trash", "both"], description: "Где искать: живые / Корзина / оба" },
      limit: { type: "number", description: "До 20, по умолчанию 10" },
    },
  },
  statusPhrase: "Ищу объекты по ориентиру…",
  async run(rawArgs, { actor }) {
    const parsed = argsSchema.safeParse(rawArgs);
    if (!parsed.success) return { error: "Неверные параметры поиска по ориентиру" };
    const args = parsed.data;
    const canTrash = actor.permissions?.has("archive.view") ?? false;
    const wanted: StaffSearchScope = args.scope ?? (canTrash ? "both" : "live");
    // Право на Корзину — на сервере, а не в промте.
    if (!canTrash && wanted === "trash") return { error: TRASH_FOR_MANAGEMENT_ONLY };
    const scope: StaffSearchScope = canTrash ? wanted : "live";
    const trashNotChecked = !canTrash && wanted === "both";
    const canDelete = actor.permissions?.has("properties.delete") ?? false;
    const result = await searchPropertiesForStaff({
      ...args,
      scope,
      hideOwnPendingDeleteFor: canDelete ? undefined : actor.id,
    });
    if (result.error) return { error: result.error };

    const money = await loadMoneyContext();
    // Собственник — по правилу карточки объекта (stripOwnerContact): имя и ссылка только тому,
    // кому открыт контакт собственника; удалённую карточку продавца — только с правом «Архив».
    const viewOwners = actor.permissions?.has("properties.viewOwners") ?? false;
    const mayShowSeller = (p: (typeof result.hits)[number]["property"]) =>
      !stripOwnerContact(p, actor.id, viewOwners).ownerContactHidden;
    const sellerIds = [
      ...new Set(
        result.hits
          .filter((h) => mayShowSeller(h.property))
          .map((h) => h.property.sellerClientId)
          .filter((v): v is string => Boolean(v)),
      ),
    ];
    const sellers = sellerIds.length
      ? await prisma.client.findMany({
          where: { id: { in: sellerIds } },
          select: { id: true, shortId: true, kind: true, fullName: true, dualIntent: true, deletedAt: true },
          take: 40,
        })
      : [];
    const sellerById = new Map(sellers.map((s) => [s.id, s]));
    const items = result.hits.map(({ property: p, distanceM }) => {
      const sellerRaw = p.sellerClientId ? sellerById.get(p.sellerClientId) : undefined;
      const seller = sellerRaw && (sellerRaw.deletedAt === null || canTrash) ? sellerRaw : undefined;
      return {
        code: formatPropertyCode(p.shortId),
        href: propertyHref(p.shortId),
        inTrash: p.deletedAt !== null,
        ...(p.deletedAt ? { deletedAt: dushanbeDateString(p.deletedAt), deletedBy: p.deletedBy?.fullName ?? null } : {}),
        title: safeField(p.title),
        type: PROPERTY_TYPE_LABELS[p.type] ?? p.type,
        rooms: p.rooms,
        areaSqm: Number(p.areaSqm),
        floor: p.floor,
        totalFloors: p.totalFloors,
        stage: p.stage,
        condition: PROPERTY_CONDITION_LABELS[p.condition] ?? p.condition,
        district: p.district?.name ?? null,
        address: safeField(p.address, 200),
        landmark: safeField(p.landmark, 200),
        price: Number(p.price),
        currency: p.currency,
        priceTjs: Math.round(toTjs(p.price, p.currency, money)),
        status: p.status,
        agent: p.assignedAgent?.fullName ?? null,
        distanceM,
        ...(seller
          ? {
              seller: {
                code: formatClientCode(seller.shortId, seller.kind),
                href: `/clients/${seller.shortId}`,
                name: safeField(clientNamePhoneSafe(formatClientName(seller), actor.canViewPhone)),
                inTrash: seller.deletedAt !== null,
              },
            }
          : {}),
        description: safeField(p.description, 160),
      };
    });
    return {
      total: result.totalFound,
      shown: items.length,
      items,
      searched: {
        scope,
        liveFound: result.liveCount,
        trashFound: result.trashCount,
        place: result.placeName,
        placeResolved: result.placeResolved,
        radiusM: result.radiusM,
        radiusWidened: result.widened,
        ...(trashNotChecked ? { trashNotChecked: "Корзину не смотрела: она открыта только руководству" } : {}),
      },
      ...(items.length === 0
        ? {
            note:
              "В объектах ничего не нашлось. Прежде чем отвечать «нет», проверь карточки продавцов с этим ориентиром: " +
              "find_clients (kind=SELLER" + (canTrash ? ", scope=both" : "") + ").",
          }
        : {}),
    };
  },
};
