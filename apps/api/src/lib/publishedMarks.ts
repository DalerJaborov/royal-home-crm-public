import { prisma } from "../db.js";
import { Prisma } from "../generated/prisma/client.js";
import { logSystemError } from "./systemError.js";

/**
 * ПОМЕТКИ ВЫШЕДШИХ КАНАЛОВ — ОДНО МЕСТО ЗАПИСИ (аудит Codex 04.10.2026, PUB06/PUB07).
 *
 * `Property.publishedChannels` и `Property.publishedPostIds` пишут сразу несколько
 * независимых процессов: публикация (applySucceededPublishResults), снятие
 * (removeFromSocial), ночная сверка (publishedChannelsAudit), отложенные контейнеры
 * Instagram, YouTube/TikTok. Каждый раньше читал карточку, минуты ходил по сети
 * и писал ЦЕЛИКОМ устаревший снимок: id, сохранённый в это время другим
 * процессом, пропадал, и снять или обновить такой ролик было уже невозможно.
 *
 * Здесь запись условная: читаем СВЕЖЕЕ состояние, считаем следующее чистой
 * функцией от него и пишем только если никто не изменил обе пометки с момента
 * чтения (`updateMany ... where` по текущим значениям); иначе перечитываем и
 * считаем заново. Вызывающий передаёт ДЕЛЬТУ, а не готовый снимок.
 */

export interface PublishedMarks {
  channels: string[];
  postIds: Record<string, unknown>;
}

export interface PublishedMarksChange extends PublishedMarks {
  /** Остальные поля карточки, которые пишутся тем же условным обновлением (instagramUrl и т. п.). */
  data?: Prisma.PropertyUncheckedUpdateManyInput;
}

const MAX_ATTEMPTS = 5;

function readMarks(row: { publishedChannels: string[] | null; publishedPostIds: Prisma.JsonValue | null }): PublishedMarks {
  const raw = row.publishedPostIds;
  const postIds = raw && typeof raw === "object" && !Array.isArray(raw) ? ({ ...(raw as Record<string, unknown>) } as Record<string, unknown>) : {};
  return { channels: [...(row.publishedChannels ?? [])], postIds };
}

/**
 * ХОЗЯИН ПОМЕТОК (12.10.2026, свободные ролики). Пометки «где уже вышло» и служебные
 * метки страховки от дублей лежат на строке-хозяине публикации: у ролика объекта это
 * `Property`, у свободного промо-ролика — `SocialVideoPost` (обе таблицы хранят их
 * в одних и тех же двух колонках). Алгоритм записи один и тот же, поэтому он общий.
 */
export type MarksOwner = { kind: "property"; id: string } | { kind: "freeVideo"; id: string };

interface MarksRow {
  publishedChannels: string[] | null;
  publishedPostIds: Prisma.JsonValue | null;
}

interface MarksStore {
  find(id: string): Promise<MarksRow | null>;
  /** Условная запись: пишет, только если обе пометки всё ещё равны прочитанным. Возвращает число записанных строк. */
  swap(id: string, seen: MarksRow, next: PublishedMarksChange): Promise<number>;
}

const propertyStore: MarksStore = {
  find: (id) => prisma.property.findUnique({ where: { id }, select: { publishedChannels: true, publishedPostIds: true } }),
  async swap(id, seen, next) {
    const { data, ...marks } = next;
    const written = await prisma.property.updateMany({
      where: {
        id,
        publishedChannels: { equals: seen.publishedChannels ?? [] },
        publishedPostIds: seen.publishedPostIds == null ? { equals: Prisma.DbNull } : { equals: seen.publishedPostIds as Prisma.InputJsonValue },
      },
      data: {
        ...(data ?? {}),
        publishedChannels: marks.channels,
        publishedPostIds: marks.postIds as Prisma.InputJsonValue,
      },
    });
    return written.count;
  },
};

const freeVideoStore: MarksStore = {
  find: (id) => prisma.socialVideoPost.findUnique({ where: { id }, select: { publishedChannels: true, publishedPostIds: true } }),
  async swap(id, seen, next) {
    // У свободного ролика нет полей карточки объекта (instagramUrl и т. п.) — молча терять их нельзя.
    if (next.data && Object.keys(next.data).length > 0) throw new Error("updateOwnerMarks: поле data не поддерживается для свободного ролика");
    const written = await prisma.socialVideoPost.updateMany({
      where: {
        id,
        publishedChannels: { equals: seen.publishedChannels ?? [] },
        publishedPostIds: seen.publishedPostIds == null ? { equals: Prisma.DbNull } : { equals: seen.publishedPostIds as Prisma.InputJsonValue },
      },
      data: {
        publishedChannels: next.channels,
        publishedPostIds: next.postIds as Prisma.InputJsonValue,
      },
    });
    return written.count;
  },
};

const storeFor = (owner: MarksOwner): MarksStore => (owner.kind === "property" ? propertyStore : freeVideoStore);

const ownerLabel = (owner: MarksOwner): string => (owner.kind === "property" ? `Объект ${owner.id}` : `Свободный ролик ${owner.id}`);

/** Свежие пометки хозяина или null, если строки нет. Для чтения служебных меток (TikTok/YouTube/Facebook). */
export async function readOwnerMarks(owner: MarksOwner): Promise<PublishedMarks | null> {
  const row = await storeFor(owner).find(owner.id);
  return row ? readMarks(row) : null;
}

/**
 * `compute` получает свежие пометки и возвращает следующие либо `null` («менять
 * нечего»). Вызывается заново на каждой попытке, поэтому обязана быть чистой.
 *
 * Возвращает `applied: true`, если запись выполнена; `false` — карточки нет, менять
 * было нечего либо за все попытки пометки менялись под руками (редко; пишем в журнал).
 */
export async function updateOwnerMarks(
  owner: MarksOwner,
  compute: (current: PublishedMarks) => PublishedMarksChange | null
): Promise<{ applied: boolean; marks: PublishedMarks | null }> {
  const store = storeFor(owner);
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const row = await store.find(owner.id);
    if (!row) return { applied: false, marks: null };
    const current = readMarks(row);
    const next = compute(current);
    if (!next) return { applied: false, marks: current };

    const written = await store.swap(owner.id, row, next);
    if (written === 1) return { applied: true, marks: { channels: next.channels, postIds: next.postIds } };
  }
  void logSystemError("meta", `${ownerLabel(owner)}: пометки опубликованных каналов менялись ${MAX_ATTEMPTS} раз подряд — запись пропущена`, {
    dedupKey: "published-marks-contended",
  });
  return { applied: false, marks: null };
}

/** Прежнее имя для объектов — все существующие вызовы остаются как были. */
export function updatePublishedMarks(
  propertyId: string,
  compute: (current: PublishedMarks) => PublishedMarksChange | null
): Promise<{ applied: boolean; marks: PublishedMarks | null }> {
  return updateOwnerMarks({ kind: "property", id: propertyId }, compute);
}
