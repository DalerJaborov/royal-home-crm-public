import { createHash, randomBytes } from "node:crypto";
import { propertyFieldShown } from "@royal-home/shared";
import { prisma } from "../../db.js";
import { logSystemError } from "../systemError.js";
import { describeError } from "../describeError.js";
import { propertyOwnerAgentId } from "../propertyOwner.js";
import { ttsQuotaPausedUntil } from "../../ai/tts.js";
import { removeWhisperFiles, whisperFilesExist, WHISPER_TTS_MODEL, WhisperQuotaPausedError } from "./whisperAudio.js";
import { assembleWhisper, whisperPiecesOnCooldown } from "./whisperClips.js";
import { loadWhisperSettings } from "./whisperSync.js";
import { resolveWhisperLanguage, type WhisperLanguage } from "./whisperText.js";

/**
 * ПОДСКАЗКА АГЕНТУ ПО ПРИМЕТАМ ОБЪЕКТА (24.09.2026, решение Dan).
 *
 * Звонок переводят агенту объекта — оператор с офисного телефона (deskTransfer.ts)
 * или консультант голосом (liveVoiceTransfer.ts). Перед соединением агент слышит,
 * о каком объекте речь, словами: «3-комнатная квартира, 80 квадратов, этаж 5 из 9,
 * улица Айни 45, ориентир Садбарг, 85 тысяч долларов». Номер объекта не звучит:
 * «агент номер не помнит, а прямо приметы» (Dan 08:59).
 *
 * Озвучка — ЗАРАНЕЕ, кроном, тем же путём, что подсказка о клиенте (whisperSync.ts):
 * синтез ограничен суточной квотой и на пути звонка его быть не может, а станция
 * забирает файлы по манифесту раз в минуту — файл, собранный в момент перевода,
 * до неё просто не успел бы доехать. Фраза собирается из кусочков (whisperClips.ts):
 * «3-комнатная квартира», «этаж 5 из 9», «район Сино» повторяются у сотен объектов и
 * озвучиваются один раз; заново синтезируются обычно только адрес и ориентир.
 *
 * Язык — того агента, который ведёт объект (ему и переводят), «off» у агента —
 * подсказки нет. Не готов файл — перевод идёт с подсказкой о клиенте или без неё:
 * звонок важнее подсказки.
 */

/** Какие объекты озвучиваем: те, по которым звонят и которые можно перевести агенту. */
const WHISPER_STATUSES = ["AVAILABLE", "RESERVED"] as const;

/** Сколько объектов собираем за проход. Кусочки подсказки о клиенте и объекте делят
 *  одну суточную квоту синтеза — объектам достаётся меньшая часть. */
const BATCH_LIMIT = 5;

/** Потолок выборки за проход — на базу, размер которой сегодня не представить. */
const POOL_LIMIT = 3000;

/** Меняется правило фразы — меняется отпечаток, и все подсказки пересобираются. */
const TEXT_RULES_VERSION = 1;

export type PropertyWhisperSource = {
  type: "APARTMENT" | "HOUSE" | "COMMERCIAL" | "LAND";
  rooms: number | null;
  areaSqm: unknown;
  landAreaSotka: unknown;
  floor: number | null;
  totalFloors: number | null;
  address: string | null;
  landmark: string | null;
  price: unknown;
  currency: "USD" | "TJS";
  district: { name: string } | null;
};

interface Dictionary {
  intro: string;
  kind: (type: PropertyWhisperSource["type"], rooms: number | null) => string;
  area: (sqm: number) => string;
  sotka: (value: number) => string;
  floor: (floor: number, total: number | null) => string;
  district: (name: string) => string;
  landmark: (text: string) => string;
  thousands: (value: number, currency: PropertyWhisperSource["currency"]) => string;
  millions: (value: string, currency: PropertyWhisperSource["currency"]) => string;
  units: (value: number, currency: PropertyWhisperSource["currency"]) => string;
}

/** Русское число со словом: 1 квадрат, 2 квадрата, 5 квадратов (11–14 — «квадратов»). */
function ru(n: number, one: string, few: string, many: string): string {
  const mod100 = Math.abs(n) % 100;
  const mod10 = mod100 % 10;
  if (!Number.isInteger(n)) return `${n} ${few}`;
  if (mod100 >= 11 && mod100 <= 14) return `${n} ${many}`;
  if (mod10 === 1) return `${n} ${one}`;
  if (mod10 >= 2 && mod10 <= 4) return `${n} ${few}`;
  return `${n} ${many}`;
}

const DICTIONARIES: Record<WhisperLanguage, Dictionary> = {
  ru: {
    intro: "Клиент по объекту",
    kind: (type, rooms) => {
      if (type === "APARTMENT") return rooms ? `${rooms}-комнатная квартира` : "квартира";
      if (type === "HOUSE") return rooms ? `дом, ${rooms} комнат` : "дом";
      return type === "LAND" ? "участок" : "коммерция";
    },
    area: (sqm) => ru(sqm, "квадрат", "квадрата", "квадратов"),
    sotka: (value) => ru(value, "сотка", "сотки", "соток"),
    floor: (floor, total) => (total ? `этаж ${floor} из ${total}` : `${floor} этаж`),
    district: (name) => `район ${name}`,
    landmark: (text) => `ориентир ${text}`,
    thousands: (value, currency) => `${ru(value, "тысяча", "тысячи", "тысяч")} ${currency === "USD" ? "долларов" : "сомони"}`,
    millions: (value, currency) =>
      `${/,/.test(value) ? `${value} миллиона` : ru(Number(value), "миллион", "миллиона", "миллионов")} ${currency === "USD" ? "долларов" : "сомони"}`,
    units: (value, currency) => (currency === "USD" ? ru(value, "доллар", "доллара", "долларов") : `${value} сомони`),
  },
  tg: {
    intro: "Мизоҷ оид ба объект",
    kind: (type, rooms) => {
      if (type === "APARTMENT") return rooms ? `манзили ${rooms}-ҳуҷрагӣ` : "манзил";
      if (type === "HOUSE") return rooms ? `ҳавлӣ, ${rooms} ҳуҷра` : "ҳавлӣ";
      return type === "LAND" ? "замин" : "тиҷоратӣ";
    },
    area: (sqm) => `${sqm} метри мураббаъ`,
    sotka: (value) => `${value} сотих`,
    floor: (floor, total) => (total ? `ошёнаи ${floor} аз ${total}` : `ошёнаи ${floor}`),
    district: (name) => `ноҳияи ${name}`,
    landmark: (text) => `ориентир ${text}`,
    thousands: (value, currency) => `${value} ҳазор ${currency === "USD" ? "доллар" : "сомонӣ"}`,
    millions: (value, currency) => `${value} миллион ${currency === "USD" ? "доллар" : "сомонӣ"}`,
    units: (value, currency) => `${value} ${currency === "USD" ? "доллар" : "сомонӣ"}`,
  },
};

function positive(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Свободный текст карточки — без значков и лишних пробелов, не длиннее разумного:
 *  клиент в это время слушает гудки. */
function spokenText(value: string | null, max = 60): string | null {
  const text = (value ?? "").replace(/[^\p{L}\p{M}\p{N}\s.,\-/«»"()]/gu, " ").replace(/\s+/g, " ").trim();
  if (!text) return null;
  return text.length > max ? text.slice(0, max).replace(/\s+\S*$/, "") : text;
}

/** Цена так, как её скажет человек: до тысяч, миллионы — с одним знаком. */
function pricePhrase(src: PropertyWhisperSource, dict: Dictionary): string | null {
  const price = positive(src.price);
  if (!price) return null;
  if (price >= 1_000_000) {
    const m = (Math.round(price / 100_000) / 10).toString().replace(".", ",");
    return dict.millions(m, src.currency);
  }
  if (price >= 1000) return dict.thousands(Math.round(price / 1000), src.currency);
  return dict.units(Math.round(price), src.currency);
}

/**
 * Куски фразы — каждый озвучивается и переиспользуется отдельно (whisperClips.ts).
 * Порядок — как агент узнаёт свой объект: что это, какой, где, почём. Район звучит,
 * только когда нет ни адреса, ни ориентира: иначе он лишь удлиняет гудки.
 */
export function propertyWhisperParts(src: PropertyWhisperSource, language: WhisperLanguage): string[] {
  const dict = DICTIONARIES[language];
  const area = positive(src.areaSqm);
  const sotka = positive(src.landAreaSotka);
  const address = spokenText(src.address);
  const landmark = spokenText(src.landmark, 40);
  return [
    dict.intro,
    dict.kind(src.type, src.rooms && src.rooms > 0 ? src.rooms : null),
    src.type === "LAND" && sotka ? dict.sotka(Math.round(sotka * 10) / 10) : area ? dict.area(Math.round(area)) : null,
    // Этаж — только у квартиры и коммерции; у дома его нет (propertyTypeFields.ts).
    propertyFieldShown(src.type, "floor") && src.floor && src.floor > 0 ? dict.floor(src.floor, src.totalFloors && src.totalFloors > 0 ? src.totalFloors : null) : null,
    !address && !landmark && src.district?.name ? dict.district(src.district.name) : null,
    address,
    landmark ? dict.landmark(landmark) : null,
    pricePhrase(src, dict),
  ].filter((part): part is string => !!part);
}

/** Те же приметы строкой — для записи в карточке клиента («перевёл по объекту: …»). */
export function propertyFeaturesText(src: PropertyWhisperSource): string {
  return propertyWhisperParts(src, "ru").slice(1).join(", ");
}

function digestOf(parts: string[], language: WhisperLanguage, voice: string): string {
  return createHash("sha1")
    .update(JSON.stringify({ parts, language, voice, rules: TEXT_RULES_VERSION }))
    .digest("hex");
}

/** Имя файла на станции СЛУЧАЙНОЕ, как у подсказки о клиенте: по имени не читается адрес. */
function newFileName(): string {
  return `rh${randomBytes(8).toString("hex")}`;
}

export const PROPERTY_WHISPER_SELECT = {
  id: true,
  shortId: true,
  type: true,
  rooms: true,
  areaSqm: true,
  landAreaSotka: true,
  floor: true,
  totalFloors: true,
  address: true,
  landmark: true,
  price: true,
  currency: true,
  district: { select: { name: true } },
} as const;

export interface PropertyWhisperSyncResult {
  rendered: number;
  removed: number;
  failed: number;
}

/**
 * Один проход: собрать недостающие и устаревшие подсказки, убрать лишние.
 * Выключенная подсказка в Настройках (callWhisperEnabled) выключает и эту:
 * без неё на станции не заведён обмен файлами, и играть было бы нечего.
 */
export async function syncPropertyWhispers(
  /** Только для тестов: пройти лишь эти объекты — общая база набора полна чужих. */
  scope?: { propertyIds: string[] }
): Promise<PropertyWhisperSyncResult> {
  const result: PropertyWhisperSyncResult = { rendered: 0, removed: 0, failed: 0 };
  const settings = await loadWhisperSettings();
  if (!settings.enabled) return result;

  // Свежие объекты первыми: по ним звонят чаще всего.
  const properties = await prisma.property.findMany({
    where: {
      deletedAt: null,
      status: { in: [...WHISPER_STATUSES] },
      ...(scope ? { id: { in: scope.propertyIds } } : {}),
    },
    select: { ...PROPERTY_WHISPER_SELECT, intakeAgentId: true, assignedAgentId: true, createdById: true },
    orderBy: { createdAt: "desc" },
    take: POOL_LIMIT,
  });
  const ownerIds = [...new Set(properties.map(propertyOwnerAgentId).filter((id): id is string => !!id))];
  const owners = await prisma.agent.findMany({
    where: { id: { in: ownerIds } },
    select: { id: true, whisperLanguage: true },
  });
  const ownerLanguage = new Map(owners.map((a) => [a.id, a.whisperLanguage]));
  const existing = await prisma.propertyWhisper.findMany({
    ...(scope ? { where: { propertyId: { in: scope.propertyIds } } } : {}),
    select: { id: true, propertyId: true, language: true, digest: true, fileName: true },
  });
  const byKey = new Map(existing.map((row) => [`${row.propertyId}:${row.language}`, row]));

  const wanted = new Set<string>();
  // Квота синтеза кончилась — пересборку не начинаем, уборка идёт как обычно
  // (тот же приём, что в whisperSync.ts).
  let voiceMuted = (await ttsQuotaPausedUntil(WHISPER_TTS_MODEL)) !== null;

  for (const property of properties) {
    const ownerId = propertyOwnerAgentId(property);
    if (!ownerId) continue;
    const language = resolveWhisperLanguage(ownerLanguage.get(ownerId), settings.language);
    if (!language) continue;
    const key = `${property.id}:${language}`;
    wanted.add(key);
    if (voiceMuted || result.rendered + result.failed >= BATCH_LIMIT) continue;

    const parts = propertyWhisperParts(property, language);
    const digest = digestOf(parts, language, settings.voice);
    const partialDigest = `${digest}:partial`;
    const current = byKey.get(key);
    const cooling = whisperPiecesOnCooldown(parts, language, settings.voice);
    if (cooling === parts.length) continue;
    const upToDate = current?.digest === digest || (current?.digest === partialDigest && cooling > 0);
    if (current && upToDate && (await whisperFilesExist(current.fileName))) continue;

    const fileName = current?.fileName ?? newFileName();
    try {
      const { durationMs, skipped } = await assembleWhisper(parts, { language, voice: settings.voice, fileName });
      const storedDigest = skipped > 0 ? partialDigest : digest;
      const text = parts.join(". ");
      await prisma.propertyWhisper.upsert({
        where: { propertyId_language: { propertyId: property.id, language } },
        create: { propertyId: property.id, language, digest: storedDigest, fileName, text, durationMs },
        update: { digest: storedDigest, fileName, text, durationMs },
      });
      result.rendered++;
    } catch (err) {
      if (err instanceof WhisperQuotaPausedError) {
        voiceMuted = true;
        continue;
      }
      result.failed++;
      await logSystemError("telephony", `Подсказка агенту об объекте №${property.shortId} не озвучилась: ${describeError(err)}`, { dedupKey: "Подсказка агенту об объекте №… не озвучилась: …" });
    }
  }

  // Лишние: объект продан, снят, в Корзине, сменил агента с другим языком, агент
  // отказался от подсказок. Объекты за потолком выборки не трогаем — их не видели.
  const seen = new Set(properties.map((p) => p.id));
  const outside = existing.filter((row) => !seen.has(row.propertyId));
  const stillLive = outside.length
    ? new Set(
        (
          await prisma.property.findMany({
            where: { id: { in: outside.map((row) => row.propertyId) }, deletedAt: null, status: { in: [...WHISPER_STATUSES] } },
            select: { id: true },
          })
        ).map((p) => p.id)
      )
    : new Set<string>();
  const doomed = existing.filter((row) =>
    seen.has(row.propertyId) ? !wanted.has(`${row.propertyId}:${row.language}`) : !stillLive.has(row.propertyId)
  );
  if (doomed.length) {
    // Сперва строка, потом файл — как в whisperSync.ts: манифест не должен обещать
    // станции файл, которого уже нет.
    await prisma.propertyWhisper.deleteMany({ where: { id: { in: doomed.map((row) => row.id) } } });
    await Promise.all(doomed.map((row) => removeWhisperFiles(row.fileName)));
    result.removed = doomed.length;
  }
  return result;
}

/**
 * Какой файл играть агенту при переводе по объекту. На пути звонка: один запрос,
 * никакой сборки. null — не готово или подсказки выключены; звонок идёт без неё.
 */
export async function propertyWhisperFile(input: {
  propertyId: string;
  agentWhisperLanguage: string | null | undefined;
}): Promise<string | null> {
  const settings = await loadWhisperSettings();
  if (!settings.enabled) return null;
  const language = resolveWhisperLanguage(input.agentWhisperLanguage, settings.language);
  if (!language) return null;
  const row = await prisma.propertyWhisper.findUnique({
    where: { propertyId_language: { propertyId: input.propertyId, language } },
    select: { fileName: true },
  });
  return row?.fileName ?? null;
}
