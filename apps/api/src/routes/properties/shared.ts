/**
 * Общие хелперы маршрутов объекта (Г3, docs/architecture-blueprint.md §1.3):
 * их используют несколько групп routes/properties/*. Код перенесён из
 * routes/properties.ts verbatim — только импорты и export.
 */
import type { Request } from "express";
import { z } from "zod";
import {
  PROPERTY_EDIT_LOCKED_CODE,
  PROPERTY_EDIT_LOCKED_MESSAGE,
  PROPERTY_EDIT_LOCKED_REASON_PUBLISHED,
  foldTajikLetters,
  propertyEditLocked,
  transliterateLatin,
  SALES_AGENT_ROLES,
} from "@royal-home/shared";
import { can } from "../../auth/middleware.js";
import { canManagePropertyAs, publishedActionDeniedReasonAs } from "../../lib/propertyAccess.js";
import { enqueueBackgroundJob } from "../../jobs/enqueue.js";
import { GEOCODE_MAX_ATTEMPTS } from "../../jobs/geocode.js";
import { prisma } from "../../db.js";
import type { Prisma } from "../../generated/prisma/client.js";

/** Best-effort, никогда не блокирует ответ на создание/сохранение объекта — Nominatim
 * может отвечать секунды, а адрес и так уже сохранён без координат. Раз получилось,
 * дописываем lat/lng отдельным PATCH и, если объект уже публикуется на сайте,
 * дотягиваем координаты туда следующим обычным циклом синхронизации.
 *
 * С 27.08.2026 — задание очереди (jobs/geocode.ts, пилот BackgroundJob): раньше
 * промис жил в HTTP-процессе без ретраев, и моргнувший Nominatim оставлял объект
 * без точки на карте навсегда. dedupeKey на объект: шквал правок адреса
 * схлопывается в один прогон, а после DONE следующая правка перезаводит заново. */
/**
 * Ключ для поиска дублей по адресу при создании объекта (docs/flow-audit-
 * property-11-09.md #3): регистр, лишние пробелы и типичная пунктуация («,»,
 * «.», «-», «№», «д.», «кв.») не должны превращать один и тот же дом в два
 * разных объекта только из-за того, что один агент напечатал адрес иначе.
 *
 * РАСШИРЕНО 15.09.2026 (проверка дублей на шаге «Где», решение владельца:
 * «пусть механизм будет быстрым и правильным, чтобы от себя не придумывал, что
 * это дубль») — единый вид сокращений, а не только пунктуация: «ул.»/«ул» и
 * «улица» — один и тот же токен, «мкр»/«мкрн» — «микрорайон», «пр.»/«пр» —
 * «проспект». Служебное «д.» перед номером дома («Рудаки д 12») удаляется
 * целиком — это не часть названия. Список ЯВНЫЙ и покрыт тестами
 * (property-address-normalize.test.ts) — каждое правило отдельным случаем,
 * никакой похожести «на глаз» здесь нет: результат либо совпадает буква в
 * букву с другим канонным адресом, либо нет.
 *
 * Эта же функция — источник для Property.canonicalAddress (см. schema.prisma):
 * значение считается ОДИН РАЗ при сохранении объекта (routes/properties/crud.ts)
 * и хранится колонкой, чтобы проверка дубля на шаге «Где» искала точным
 * равенством по индексу, а не пересчитывала канонизацию для всей таблицы на
 * каждый ввод буквы.
 */
const ADDRESS_ABBREVIATIONS: Record<string, string> = {
  ул: "улица",
  пр: "проспект",
  просп: "проспект",
  мкр: "микрорайон",
  мкрн: "микрорайон",
};

/**
 * ТАДЖИКСКОЕ НАПИСАНИЕ И ЛАТИНИЦА — ТОТ ЖЕ ДОМ (29.09.2026). «кучаи Дехоти 8»,
 * «улица Деҳотӣ 8» и «ul. Dehoti 8» — один адрес; прежний ключ давал три разных,
 * и проверка дублей на шаге «Где» молчала. Сверх прежних правил: латиница в
 * кириллицу и таджикские буквы к русским близнецам (одно правило с поиском мест,
 * `geoMatchKey`/`transliterateLatin` из @royal-home/shared), вид улицы
 * по-таджикски — к русскому.
 *
 * Сохранённые ключи посчитаны прежним правилом и пересчитываются разовым
 * скриптом (scripts/backfill-property-canonical-address.ts --recompute); пока
 * он не прошёл, проверка дублей ищет по ОБОИМ ключам — `propertyAddressKeys`.
 */
const TAJIK_STREET_KINDS: Record<string, string> = {
  куча: "улица",
  кучаи: "улица",
  хиебон: "проспект",
  хиебони: "проспект",
  гузаргох: "проезд",
  гузаргохи: "проезд",
};

export function normalizePropertyAddress(address: string): string {
  const cleaned = foldTajikLetters(transliterateLatin(address.toLowerCase()))
    .replace(/ё/g, "е")
    .replace(/[.,№"'«»]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return cleaned;
  const tokens = cleaned.split(" ");
  const result: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    // «д» перед номером дома («д 12») — служебное слово, не часть названия;
    // без этого правила «Рудаки д 12» и «Рудаки 12» канонизировались бы по-разному.
    if (token === "д" && tokens[i + 1] && /^\d/.test(tokens[i + 1])) continue;
    result.push(ADDRESS_ABBREVIATIONS[token] ?? TAJIK_STREET_KINDS[token] ?? token);
  }
  return result.join(" ");
}

/** Ключ по правилу до 29.09.2026 — только чтобы находить объекты, чей
 *  сохранённый ключ ещё не пересчитан. Убрать вместе с ним, когда пересчёт
 *  прошёл на сервере (`--recompute` печатает «расходятся: 0»). */
export function legacyPropertyAddressKey(address: string): string {
  const cleaned = address
    .toLowerCase()
    .replace(/[.,№"'«»]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return cleaned;
  const tokens = cleaned.split(" ");
  const result: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === "д" && tokens[i + 1] && /^\d/.test(tokens[i + 1])) continue;
    result.push(ADDRESS_ABBREVIATIONS[token] ?? token);
  }
  return result.join(" ");
}

/** Оба ключа адреса для поиска по сохранённой колонке, без повторов. */
export function propertyAddressKeys(address: string): string[] {
  return [...new Set([normalizePropertyAddress(address), legacyPropertyAddressKey(address)])].filter(Boolean);
}

/** Только id: адрес и район задание читает из базы в момент исполнения —
 *  см. шапку jobs/geocode.ts, почему адрес в payload устаревал. */
export function geocodeInBackground(propertyId: string) {
  void enqueueBackgroundJob({
    type: "geocode",
    payload: { propertyId },
    dedupeKey: `geocode:${propertyId}`,
    maxAttempts: GEOCODE_MAX_ATTEMPTS,
  });
}

/**
 * Видео объекта наружу — одной формой на все маршруты.
 *
 * `r2Key` (внутренний ключ файла в платном хранилище) и `uploadedById` не уходят
 * никуда: скачивание идёт по временной ссылке отдельным маршрутом, а знать, как
 * файл называется в чужом бакете, клиенту незачем. Раньше загрузка отдавала сырые
 * строки таблицы, а список — аккуратный набор полей: два разных ответа на один и
 * тот же ресурс рано или поздно расходятся, и клиент читает то, чего в другом нет.
 */
export function presentVideo(
  video: {
    id: string;
    filename: string;
    sizeBytes: number;
    uploadedAt: Date;
    /// Факты сырого файла (23.09.2026, задание C) — null, пока ffprobe не
    /// отработал в фоне после загрузки, или если файл нечитаем/бинарник
    /// недоступен. См. lib/rawVideoFacts.ts.
    hasAudio?: boolean | null;
    durationSec?: number | null;
    width?: number | null;
    height?: number | null;
    videoCodec?: string | null;
  },
  uploadedByName: string
) {
  return {
    id: video.id,
    filename: video.filename,
    sizeBytes: video.sizeBytes,
    uploadedAt: video.uploadedAt,
    uploadedByName,
    hasAudio: video.hasAudio ?? null,
    durationSec: video.durationSec ?? null,
    width: video.width ?? null,
    height: video.height ?? null,
    videoCodec: video.videoCodec ?? null,
  };
}

/** Кто может управлять объектом (правки, фото): руководитель — любым; агент —
 * своим (риелтор по сделке, интейкер или создатель карточки). Раньше проверка шла
 * только по assignedAgentId, но риелтор теперь появляется лишь в момент сделки —
 * без интейкера/создателя агент не смог бы вести собственный объект. */
export function canManageProperty(
  req: Request,
  property: { assignedAgentId?: string | null; intakeAgentId?: string | null; createdById?: string | null }
): boolean {
  if (!req.agent) return false;
  // Само правило — lib/propertyAccess.ts (одно на REST и на ИИ-помощника).
  return canManagePropertyAs({ agentId: req.agent.id, can: (permission) => can(req, permission) }, property);
}

/**
 * КТО ПРИНЯЛ И КТО ВЕДЁТ ОБЪЕКТ МЕНЯЕТ ТОЛЬКО РУКОВОДСТВО (решение владельца
 * 02.10.2026, «да, по советам»). properties.editForeign есть и у маркетинга, и у
 * монтажёра — им нужно править чужие карточки по конвейеру (фото, видео,
 * описание). Но смена приёмщика уводит долю за приём, смена ведущего — сделку,
 * а передача — ещё и продавца: это распределение работы между агентами, и
 * везде в CRM его делает тот, у кого clients.assign (директор, админ,
 * руководитель). Нужны оба права: правка чужого объекта и распределение.
 */
export function canReassignPropertyAgents(req: Request): boolean {
  return can(req, "properties.editForeign") && can(req, "clients.assign");
}

/**
 * СЛУЖБА БЕЗОПАСНОСТИ ОБЪЕКТЫ НЕ ЗАВОДИТ (решение владельца 02.10.2026, глубокая
 * проверка A12). Отдельного права «создавать объекты» в реестре нет, поэтому СБ
 * (у неё нет properties.editForeign) шла по агентской ветке POST /properties:
 * сама себе приёмщик и очки «Объект добавлен» в рейтинге агентов. СБ проверяет
 * работу, а не ведёт её — создание закрыто роли целиком; смотреть и проверять
 * объекты она по-прежнему может. Текст отказа или null.
 */
export function propertyCreateDeniedReason(req: Request): string | null {
  if (!req.agent) return "Недостаточно прав";
  if (req.agent.role === "SECURITY") return "Служба безопасности не заводит объекты — это делает агент";
  // Акционер (SHAREHOLDER) — только смотрит: объекты не заводит (спека ролей §2.4).
  if (req.agent.role === "SHAREHOLDER") return "Акционер только просматривает данные — объекты заводит агент";
  return null;
}

/**
 * ЗАМОК ПРАВКИ ПОСЛЕ ПУБЛИКАЦИИ (владелец 07.10.2026; до этого — замок на
 * время монтажа, 23.09.2026) — правило в @royal-home/shared (propertyEditLocked).
 * Отдаёт готовое тело ответа 409 или null. Зовут все маршруты, которые меняют сам
 * объект, его фото или видео: PATCH /:id, фото (загрузка, порядок, удаление),
 * видео (загрузка, докачка, удаление). Цена, площадь и подпись опубликованного
 * объекта уже живут в роликах, постах и на сайте — агент меняет их заявкой
 * директору или админу, а не напрямую.
 */
export function propertyEditLockBody(
  req: Request,
  property: { status: string; offSite?: boolean | null }
): { error: string; code: string; reason: string } | null {
  if (!propertyEditLocked(property, can(req, "properties.editForeign"))) return null;
  return {
    error: PROPERTY_EDIT_LOCKED_MESSAGE,
    code: PROPERTY_EDIT_LOCKED_CODE,
    reason: PROPERTY_EDIT_LOCKED_REASON_PUBLISHED,
  };
}

/**
 * КНОПКИ ВИДЕО-ИСПРАВЛЕНИЙ ПОСЛЕ ПУБЛИКАЦИИ — только руководству (07.10.2026).
 * «Вернуть монтажёру», «Снова на монтаж», «Обновить подписи», «Готово» после
 * правки, «Убрать из соцсетей» и загрузка готового ролика трогают то, что уже
 * видно подписчикам, и агенту-владельцу не доступны: он просит директора или
 * админа заявкой. Те же критерии, что у замка правки (право
 * properties.editForeign, закрытый объект не запирается). Отдаёт текст отказа
 * 403 или null (можно).
 */
export function publishedActionDeniedReason(
  req: Request,
  property: { status: string; offSite?: boolean | null }
): string | null {
  return publishedActionDeniedReasonAs({ agentId: req.agent?.id ?? "", can: (permission) => can(req, permission) }, property);
}

/**
 * Годится ли этот id в `intakeAgentId`/`assignedAgentId` объекта — дыра 11.09.2026
 * (Пачка 1 п.9): сервер проверял только право ПРИСЛАТЬ это поле (properties.editForeign
 * для чужого, самого себя — рядовой агент), но не то, что id вообще указывает на
 * живого действующего сотрудника с ролью «Агент». PATCH с id уволенного, гостя из
 * другой роли или вовсе несуществующей строкой раньше сохранялся как есть, и
 * карточка объекта показывала ответственным человека, который не может им быть.
 *
 * Возвращает текст ошибки или `null`, если id годится.
 */
export async function assignableAgentError(agentId: string): Promise<string | null> {
  const agent = await prisma.agent.findUnique({
    where: { id: agentId },
    select: { role: true, isActive: true, frozenAt: true },
  });
  if (!agent) return "Сотрудник не найден";
  if (!(SALES_AGENT_ROLES as readonly string[]).includes(agent.role)) return "Указанный сотрудник не может вести объекты (не агент)";
  if (!agent.isActive) return "Сотрудник уволен или деактивирован";
  if (agent.frozenAt) return "Сотрудник заморожен — назначьте другого";
  return null;
}

/**
 * Ключи повторной отправки: по одному на файл, в том же порядке, что и файлы.
 *
 * Приходят обычным полем формы рядом с файлами, поэтому значение может быть чем
 * угодно — разбираем строго. Одиночное поле multer отдаёт строкой, а не массивом
 * из одного элемента: пачка из одного файла иначе не прошла бы проверку длины.
 *
 * Ключей нет вовсе — это НЕ ошибка: так грузит вкладка со старой сборкой,
 * открытая до выката. Она просто не получает защиты от повторов, как и раньше.
 */
export type UploadKeysResult = { ok: true; keys: string[] | null } | { ok: false; error: string };

const uploadKeysSchema = z.array(z.string().min(1).max(64));

/**
 * Порядок сортировки медиа черновика — общий для drafts.ts (отдача черновика,
 * автосохранение) и draftAttach.ts (перенос файлов в объект).
 *
 * `order` пишется при создании строки как `currentCount + created` БЕЗ блокировки
 * (drafts.ts::POST /photos) — два параллельных запроса (переподключение, две
 * вкладки) могут посчитать одно и то же значение currentCount и создать две
 * записи с ОДИНАКОВЫМ order. Без второго ключа сортировки Postgres не гарантирует
 * стабильный порядок при равенстве первого — те же два снимка могли бы меняться
 * местами между перезагрузками страницы. `createdAt` монотонен на запись (у
 * каждой строки свой момент INSERT) и снимает эту неопределённость дёшево, без
 * транзакций и блокировок: итоговый порядок PropertyPhoto при переезде всё равно
 * пересчитывается заново по индексу отсортированного списка (draftAttach.ts), так
 * что даже сам факт дублирования `order` не проявляется — важна только
 * детерминированность сортировки.
 */
export const DRAFT_MEDIA_ORDER: Prisma.PropertyDraftMediaOrderByWithRelationInput[] = [
  { order: "asc" },
  { createdAt: "asc" },
];

export function parseUploadKeys(raw: unknown, fileCount: number): UploadKeysResult {
  if (raw === undefined || raw === null) return { ok: true, keys: null };
  const parsed = uploadKeysSchema.safeParse(Array.isArray(raw) ? raw : [raw]);
  if (!parsed.success) return { ok: false, error: "Неверные ключи загрузки" };
  if (parsed.data.length !== fileCount) {
    return { ok: false, error: "Число ключей загрузки не совпадает с числом файлов" };
  }
  // Два одинаковых ключа в одном запросе положили бы весь запрос на уникальном
  // индексе — отвечаем понятной ошибкой вместо 500.
  if (new Set(parsed.data).size !== parsed.data.length) {
    return { ok: false, error: "Ключи загрузки повторяются внутри одного запроса" };
  }
  return { ok: true, keys: parsed.data };
}
