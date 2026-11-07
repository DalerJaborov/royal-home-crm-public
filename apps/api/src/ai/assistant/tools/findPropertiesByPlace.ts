import { z } from "zod";
import { PROPERTY_CONDITION_LABELS, PROPERTY_TYPE_LABELS, formatClientCode, formatClientName, formatPropertyCode } from "@royal-home/shared";
import { prisma } from "../../../db.js";
import { stripOwnerContact } from "../../../lib/ownerContact.js";
import { clientNamePhoneSafe } from "../../../lib/clientPhone.js";
import { dushanbeDateString } from "../../../lib/dushanbeTime.js";
import { loadMoneyContext, toTjs } from "../../../lib/money.js";
import { searchPropertiesForStaff, type StaffSearchScope } from "../../../lib/staffPropertySearch.js";
import {
  canOpenTrashedPropertyPage,
  canRestorePropertyAs,
  canSeeTrashedClient,
  canSeeTrashedProperties,
  clientTrashScopeFor,
} from "../../../lib/trashAccess.js";
import { trashActorOf } from "../actor.js";
import { propertyHref } from "./propertyPresenter.js";
import { safeField } from "./safeField.js";
import type { AssistantReadToolPlugin } from "./types.js";

/**
 * find_properties_by_place — ОБЪЕКТЫ ПО ОРИЕНТИРУ, АДРЕСУ И ПРИЗНАКАМ, В ТОМ ЧИСЛЕ В КОРЗИНЕ
 * (07.11.2026). Место разбирает код (lib/searchPlace.ts — то же правило, что у голосового
 * консультанта), радиус расширяется сам.
 *
 * КОРЗИНА ОБЪЕКТОВ — СПРАВКА ДЛЯ ВСЕХ (решение владельца 07.11.2026, lib/trashAccess.ts):
 * объекты общие, агент видит удалённый объект с датой и тем, кто удалил. У каждого удалённого —
 * canRestore: может ли ЭТОТ человек вернуть его (директор/админ или хозяин объекта). Удалённая
 * карточка ПРОДАВЦА — только её хозяину и руководству; в общей группе Telegram — никому.
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

export const findPropertiesByPlaceTool: AssistantReadToolPlugin = {
  name: "find_properties_by_place",
  level: "A",
  description:
    "Основной поиск объектов по ОРИЕНТИРУ, адресу и признакам. Зови всегда, когда в вопросе есть «около/возле/рядом с/в стороне/у …», " +
    "название места (Ашан, Воданасос, 82 мкр, базар), «коробка», этаж, площадь или цена в сомони/долларах. " +
    "landmark — место СЛОВАМИ ЧЕЛОВЕКА, как сказано («у Ашана», «в стороне Воданасоса»): район и точку на карте определяет сам инструмент, не угадывай. " +
    "Радиус расширяется сам; можно задать radiusM. Тип: APARTMENT/HOUSE (хавли, дом)/COMMERCIAL/LAND. shell=true — «коробка» (без ремонта). " +
    "Цена: minPrice/maxPrice + currency (TJS или USD; «2,5 млн» без слова — сомони, а малая сумма без валюты — спроси валюту). " +
    "scope: live — живые, trash — удалённые (Корзина), both — оба; по умолчанию both. Корзина объектов — справка для всех сотрудников. " +
    "В ответе у каждого объекта inTrash/deletedAt/deletedBy/distanceM; у удалённого canRestore — может ли спросивший вернуть его " +
    "(тогда предложи restore_property, передав его code). Живые идут первыми, удалённых в выдаче не больше пяти (всего — searched.trashFound). " +
    "districtName ставь, только если район назвал сам человек. Если searched.zoneOnly, districtIgnored или placeOutsideDistrict — скажи это одной фразой. " +
    "«Нет» говори только когда searched покрывает и живые, и Корзину, " +
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
  async run(rawArgs, { actor, question }) {
    const parsed = argsSchema.safeParse(rawArgs);
    if (!parsed.success) return { error: "Неверные параметры поиска по ориентиру" };
    const args = parsed.data;
    const trashActor = trashActorOf(actor);
    // Право на Корзину — на сервере, общим правилом (lib/trashAccess.ts), а не в промте.
    const canTrash = canSeeTrashedProperties(trashActor);
    const wanted: StaffSearchScope = args.scope ?? "both";
    const scope: StaffSearchScope = canTrash ? wanted : "live";
    const canDelete = actor.permissions?.has("properties.delete") ?? false;
    const result = await searchPropertiesForStaff({
      ...args,
      // Слова человека: назвал ли он район сам или район додумала модель.
      ...(question ? { humanText: question } : {}),
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
          select: { id: true, shortId: true, kind: true, fullName: true, dualIntent: true, deletedAt: true, assignedAgentId: true },
          take: 40,
        })
      : [];
    const sellerById = new Map(sellers.map((s) => [s.id, s]));
    const items = result.hits.map(({ property: p, distanceM }) => {
      const sellerRaw = p.sellerClientId ? sellerById.get(p.sellerClientId) : undefined;
      const seller =
        sellerRaw && (sellerRaw.deletedAt === null || canSeeTrashedClient(trashActor, sellerRaw)) ? sellerRaw : undefined;
      return {
        code: formatPropertyCode(p.shortId),
        // Страница удалённого объекта открыта только с правом «Архив» (REST, lib/trashAccess.ts):
        // остальным ссылка вела бы на «Объект не найден» — справка без ссылки (пачка 2).
        ...(p.deletedAt === null || canOpenTrashedPropertyPage(trashActor) ? { href: propertyHref(p.shortId) } : {}),
        inTrash: p.deletedAt !== null,
        ...(p.deletedAt
          ? {
              deletedAt: dushanbeDateString(p.deletedAt),
              deletedBy: p.deletedBy?.fullName ?? null,
              canRestore: canRestorePropertyAs(trashActor, p),
            }
          : {}),
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
        ...(result.zoneOnly ? { zoneOnly: result.zoneOnly } : {}),
        ...(result.districtIgnored ? { districtIgnored: result.districtIgnored } : {}),
        ...(result.placeOutsideDistrict ? { placeOutsideDistrict: result.placeOutsideDistrict } : {}),
      },
      ...(items.length === 0
        ? {
            note:
              "В объектах ничего не нашлось. Прежде чем отвечать «нет», проверь карточки продавцов с этим ориентиром: " +
              "find_clients (kind=SELLER" + (clientTrashScopeFor(trashActor) !== "none" ? ", scope=both" : "") + ").",
          }
        : {}),
    };
  },
};
