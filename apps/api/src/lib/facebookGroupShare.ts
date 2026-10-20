/**
 * «РАЗДАТЬ ПО ГРУППАМ FACEBOOK» — полуавтомат в карточке объекта (28.09.2026,
 * docs/agent-briefs/facebook-groups-share-28-09.md).
 *
 * Группы Facebook по недвижимости дают охват, но Groups API у Meta закрыт
 * (22.04.2024) — публиковать туда можно только руками, а браузерная
 * автоматизация нажатия «Опубликовать» = бан аккаунта. CRM делает всю
 * подготовку: хранит список групп (Settings.facebookShareGroups), для каждой
 * группы даёт СВОЙ вариант текста (один и тот же пост в 10 группах читается
 * как спам), копирует его в буфер и открывает группу — «Опубликовать» жмёт
 * человек, «Выложено» отмечает тоже он (PropertyGroupShare).
 *
 * Список групп — настройка (строка = `Название | ссылка`), а не таблица: тот
 * же приём, что у Settings.incomingInboundContexts (routes/settings.ts) —
 * список маленький, правит его владелец, отдельная админ-форма для него
 * избыточна. Сама отметка «выложено» — уже факт про пару (объект, группа), ей
 * нужна таблица с уникальностью (@@unique([propertyId, groupUrl])).
 */
import { prisma } from "../db.js";
import {
  generateReelsCaptionFromTemplates,
  reelsCaptionValuesFromProperty,
  applyContactFooter,
  type CaptionAgent,
} from "./reelsCaptionTemplate.js";
import { siteListingUrl, type LinkableProperty } from "./siteListingUrl.js";

export interface ParsedShareGroup {
  name: string;
  url: string;
}

/** Только группы Facebook — «facebook.com/groups/<что-то>», с www или без,
 *  co слэшем на конце или без него. Мусорную строку («просто ссылка на Страницу»,
 *  недописанный адрес) молча пропускаем: лучше не показать группу вовсе, чем
 *  открыть кнопкой битую ссылку. */
const GROUP_URL_RE = /^https:\/\/(www\.)?facebook\.com\/groups\/[^\s|]+\/?$/i;

/**
 * Textarea → список групп. Формат строки: `Название | https://www.facebook.com/groups/...`
 * (тот же «по одной в строке», что у InboundContextsSetting). Невалидные строки
 * и повторы (по ссылке, без учёта регистра и хвостового слэша) отбрасываются —
 * молча, без ошибки: список читает и владелец, вписавший лишнюю строку, и
 * серверный код, для которого это просто данные.
 */
export function parseShareGroups(raw: string[]): ParsedShareGroup[] {
  const seen = new Set<string>();
  const out: ParsedShareGroup[] = [];
  for (const line of raw) {
    const sep = line.indexOf("|");
    if (sep < 0) continue;
    const name = line.slice(0, sep).trim();
    const url = line.slice(sep + 1).trim();
    if (!name || !url || !GROUP_URL_RE.test(url)) continue;
    const key = url.replace(/\/+$/, "").toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name, url });
  }
  return out;
}

/**
 * Крючок первой строки — по индексу группы by design (не случайно): соседние
 * группы в списке не должны начинаться одинаково. Три варианта достаточно —
 * подряд идущих групп больше трёх в списке владельца не бывает, а с любым N
 * индекс просто идёт по кругу (% length).
 */
const GROUP_HOOKS = ["Свежий объект", "Только что в продаже", "Смотрите, что появилось"];

export interface GroupShareProperty extends LinkableProperty {
  shortId: number;
  reelsCaption: string | null;
  type: string;
  rooms: number | null;
  areaSqm: number | string | { toString(): string };
  floor: number | null;
  totalFloors: number | null;
  price: number | string | { toString(): string };
  currency: string;
  condition: string;
  stage?: string | null;
  marketType?: string | null;
  address: string | null;
  landAreaSotka?: number | string | { toString(): string } | null;
  amenities?: string[] | null;
  districtName: string;
}

/**
 * Текст для одной группы. Тело подписи — РЕШЕНИЕ ПО УМОЛЧАНИЮ (задание прямо не
 * уточняет): если у объекта уже есть подпись (`reelsCaption`, обычно есть к
 * моменту, когда объект в продаже и ролик вышел), берём её как есть — это
 * текст, который уже видел и, возможно, правил маркетинг, придумывать другой
 * незачем. Только если подписи ещё нет — она собирается из шаблонов с
 * `seed = "<propertyId>-group-<groupIndex>"`, и тогда варьируется не только
 * крючок, но и сам шаблон у соседних групп. Хвостовые хештеги шаблоны и так не
 * ставят (reelsCaptionTemplate.ts), поэтому дублировать их специально нечего.
 *
 * Ссылка на сайт — последней строкой, только если объект опубликован
 * (siteListingUrl возвращает null иначе); превью Facebook подтянет сам.
 */
export function groupShareText(property: GroupShareProperty, agent: CaptionAgent | null, groupIndex: number): string {
  const hook = GROUP_HOOKS[groupIndex % GROUP_HOOKS.length]!;
  const base =
    property.reelsCaption ??
    generateReelsCaptionFromTemplates(
      reelsCaptionValuesFromProperty({
        type: property.type,
        rooms: property.rooms,
        areaSqm: property.areaSqm,
        floor: property.floor,
        totalFloors: property.totalFloors,
        price: property.price,
        currency: property.currency,
        condition: property.condition,
        stage: property.stage ?? null,
        marketType: property.marketType ?? null,
        districtName: property.districtName,
        phone: null,
        address: property.address,
        landAreaSotka: property.landAreaSotka,
        amenities: property.amenities,
      }),
      null,
      `${property.id}-group-${groupIndex}`
    );
  const caption = applyContactFooter(base, agent);
  const link = siteListingUrl(property);
  const lines = [hook, "", caption];
  if (link) lines.push("", link);
  return lines.join("\n");
}

export interface GroupShareItem {
  name: string;
  url: string;
  sharedAt: string | null;
  agentName: string | null;
  text: string;
}

export type ShareStatusResult =
  | { ok: true; groups: GroupShareItem[]; done: number; total: number }
  | { ok: false; status: number; error: string };

const propertyIncludeForShare = {
  district: true,
  intakeAgent: { select: { fullName: true, phone: true } },
  assignedAgent: { select: { fullName: true, phone: true } },
  createdBy: { select: { fullName: true, phone: true } },
  groupShares: true,
} as const;

type PropertyWithShareContext = NonNullable<
  Awaited<ReturnType<typeof loadPropertyForShare>>
>;

function loadPropertyForShare(propertyId: string) {
  return prisma.property.findUnique({ where: { id: propertyId }, include: propertyIncludeForShare });
}

function toGroupShareProperty(property: PropertyWithShareContext): GroupShareProperty {
  return {
    id: property.id,
    publishedOnSite: property.publishedOnSite,
    siteListingId: property.siteListingId,
    shortId: property.shortId,
    reelsCaption: property.reelsCaption,
    type: property.type,
    rooms: property.rooms,
    areaSqm: property.areaSqm,
    floor: property.floor,
    totalFloors: property.totalFloors,
    price: property.price,
    currency: property.currency,
    condition: property.condition,
    stage: property.stage,
    marketType: property.marketType,
    address: property.address,
    landAreaSotka: property.landAreaSotka,
    amenities: property.amenities,
    districtName: property.district?.name ?? "",
  };
}

/**
 * Список групп с отметками для карточки объекта: название, ссылка, когда и кем
 * отмечено «выложено» (null — ещё нет), готовый текст под эту группу. Один
 * запрос на объект (include тянет district + агентов + все отметки сразу),
 * плюс один batched запрос на имена агентов, поставивших отметку — без N+1 по
 * числу групп.
 */
export async function shareStatus(propertyId: string): Promise<ShareStatusResult> {
  const [settings, property] = await Promise.all([
    prisma.settings.findUnique({ where: { id: "singleton" }, select: { facebookShareGroups: true } }),
    loadPropertyForShare(propertyId),
  ]);
  if (!property || property.deletedAt) return { ok: false, status: 404, error: "Объект не найден или удалён" };

  const groups = parseShareGroups(settings?.facebookShareGroups ?? []);
  const sharesByUrl = new Map(property.groupShares.map((s) => [s.groupUrl, s]));
  const agentIds = [...new Set(property.groupShares.map((s) => s.agentId).filter((id): id is string => !!id))];
  const agents = agentIds.length
    ? await prisma.agent.findMany({ where: { id: { in: agentIds } }, select: { id: true, fullName: true } })
    : [];
  const agentNameById = new Map(agents.map((a) => [a.id, a.fullName]));

  const captionAgent: CaptionAgent | null = property.intakeAgent ?? property.assignedAgent ?? property.createdBy ?? null;
  const gsProperty = toGroupShareProperty(property);

  const items: GroupShareItem[] = groups.map((g, i) => {
    const share = sharesByUrl.get(g.url);
    return {
      name: g.name,
      url: g.url,
      sharedAt: share ? share.sharedAt.toISOString() : null,
      agentName: share?.agentId ? (agentNameById.get(share.agentId) ?? null) : null,
      text: groupShareText(gsProperty, captionAgent, i),
    };
  });
  return { ok: true, groups: items, done: items.filter((it) => it.sharedAt).length, total: items.length };
}

export type MarkDoneResult = { ok: true } | { ok: false; status: number; error: string };

/** Найти группу по её позиции в текущем списке настроек — тот же индекс, что
 *  вернул shareStatus (список групп в Настройках короткий и правится редко,
 *  а адресовать группу по индексу в URL проще, чем прокидывать саму ссылку). */
async function resolveGroupByIndex(index: number): Promise<ParsedShareGroup | null> {
  const settings = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { facebookShareGroups: true } });
  const groups = parseShareGroups(settings?.facebookShareGroups ?? []);
  return groups[index] ?? null;
}

export async function markGroupShareDone(propertyId: string, index: number, agentId: string): Promise<MarkDoneResult> {
  const group = await resolveGroupByIndex(index);
  if (!group) return { ok: false, status: 404, error: "Такой группы нет в списке — список могли изменить в Настройках" };

  const property = await prisma.property.findUnique({ where: { id: propertyId }, select: { deletedAt: true } });
  if (!property || property.deletedAt) return { ok: false, status: 404, error: "Объект не найден или удалён" };

  await prisma.propertyGroupShare.upsert({
    where: { propertyId_groupUrl: { propertyId, groupUrl: group.url } },
    create: { propertyId, groupUrl: group.url, groupName: group.name, agentId },
    update: { sharedAt: new Date(), agentId, groupName: group.name },
  });
  return { ok: true };
}

export async function undoGroupShare(propertyId: string, index: number): Promise<MarkDoneResult> {
  const group = await resolveGroupByIndex(index);
  if (!group) return { ok: false, status: 404, error: "Такой группы нет в списке — список могли изменить в Настройках" };

  await prisma.propertyGroupShare.deleteMany({ where: { propertyId, groupUrl: group.url } });
  return { ok: true };
}

/**
 * Для утреннего дайджеста директора (cron.ts::sendDirectorDigest): сколько
 * объектов в продаже не раздано НИ В ОДНУ группу. `null` — список групп пуст
 * (настройка не заведена), тогда строку в дайджесте вообще не показываем, а не
 * пишем «0 из 0». Один запрос (`groupShares: { none: {} }`), без N+1.
 */
export async function countPropertiesWithNoGroupShare(): Promise<number | null> {
  // Счётчик необязательный: любой сбой здесь (в том числе частичный мок prisma в
  // тестах утренних чисел, где `prisma.settings` не задан) не должен ронять весь
  // утренний отчёт директора. Нет данных — нет строки, как при пустом списке групп.
  try {
    const settings = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { facebookShareGroups: true } });
    if (parseShareGroups(settings?.facebookShareGroups ?? []).length === 0) return null;
    return await prisma.property.count({
      where: { status: "AVAILABLE", deletedAt: null, groupShares: { none: {} } },
    });
  } catch {
    return null;
  }
}
