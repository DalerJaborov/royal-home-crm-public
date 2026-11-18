import type { TxClient } from "../db.js";
import { Prisma } from "../generated/prisma/client.js";
import { socialPublishRetryDedupeKeys } from "../jobs/socialPublishRetryPolicy.js";
import { tiktokPublishRetryDedupeKey } from "../jobs/tiktokPublishRetryPolicy.js";

/**
 * ЗАЯВКА НА ЗАМЕНУ ВЫШЕДШЕГО РОЛИКА — ОДНА ДВЕРЬ (18.11.2026, второе ревью вслепую). Её открывают подмена ролика новой
 * озвучкой (lib/narrationPreview.ts::replaceFinalWithMix) и возврат монтажёру «когда выйдет новый»
 * (lib/publishedVideoFix.ts::sendBackToMontajer). Замену ведёт lib/remakeOldPosts.ts.
 *
 * Случай, ради которого дверь одна: вторая замена, пока первая ещё не закрыта (TikTok ждёт повтора до двух суток).
 * Версия А уже вышла в Instagram/Facebook/YouTube, цена опять поменялась, утвердили версию Б. Без этой двери новой
 * заявки не было: снимок не брался заново, публикация пропускала сети, где стоит А, — Б туда не выходила, старая цена
 * висела, карточка писала «выходит». Теперь:
 *  • открытая заявка, у которой публикация ещё не начиналась (снимка нет), — та же, новая не нужна: её снимок возьмёт
 *    то, что опубликовано на момент выпуска;
 *  • иначе прежние открытые заявки закрываются, а их НЕрешённые старые посты (новый там ещё не вышел) переходят в новую
 *    (carriedOldPosts). Снимок новой заявки возьмёт посты А как «старые», плюс перенесённые, и Б выйдет во все сети.
 *  • ждущие повторы публикации прошлого ролика (TikTok, Meta) гасятся: прошлый ролик больше не нужен нигде.
 */
export type CarriedOldPost = { channel: string; postIds: Record<string, unknown>; instagramUrl: string | null };

/** Ключи publishedPostIds, которые относятся к каналу (второй id Facebook, ссылка Threads, доп. чаты Telegram). */
const COMPANIONS: Record<string, string[]> = { FACEBOOK: ["FACEBOOK_POST"], THREADS: ["THREADS_URL"], TELEGRAM: ["TELEGRAM_EXTRA"] };
export const postKeysOf = (channel: string) => [channel, ...(COMPANIONS[channel] ?? [])];

const asRecord = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? { ...(v as Record<string, unknown>) } : {});
export function readCarried(v: unknown): CarriedOldPost[] {
  return Array.isArray(v) ? v.filter((x): x is CarriedOldPost => !!x && typeof x === "object" && typeof (x as CarriedOldPost).channel === "string")
    .map((x) => ({ channel: x.channel, postIds: asRecord(x.postIds), instagramUrl: typeof x.instagramUrl === "string" ? x.instagramUrl : null })) : [];
}

const UNRESOLVED = new Set(["WAITING", "REMOVING"]);

export type OpenReplacementInput = {
  propertyId: string; reason: string; requestedById: string; comment?: string | null; messageText?: string | null;
  /** Версия озвучки, ради которой замена (18.11.2026): карточка показывает ход выпуска именно её. */
  narrationVersionId?: string | null;
  /** false — повторы публикации прошлого ролика пока не гасить (staffClip: файл ещё не принят, откат должен быть полным);
   *  погасить потом, когда новый ролик принят, — cancelPreviousClipRetries. По умолчанию гасит сразу. */
  cancelRetries?: boolean;
};

/** Ждущие повторы публикации прошлого ролика (TikTok, Meta): новый ролик принят — прошлый не нужен нигде. */
export async function cancelPreviousClipRetries(tx: TxClient, propertyId: string): Promise<void> {
  await tx.backgroundJob.deleteMany({ where: { status: "PENDING", dedupeKey: { in: [tiktokPublishRetryDedupeKey(propertyId), ...socialPublishRetryDedupeKeys(propertyId)] } } });
}

/**
 * Открыть замену старых постов (или вернуть уже открытую, если её публикация не начиналась). Внутри транзакции
 * вызывающего, под его замком объекта. Возвращает id заявки, которая теперь ведёт замену.
 */
export async function openReplacement(tx: TxClient, input: OpenReplacementInput, now: Date = new Date()): Promise<{ id: string; reused: boolean; closedIds: string[] }> {
  const open = await tx.videoRemakeRequest.findMany({ where: { propertyId: input.propertyId, replaceOldPostsOnPublish: true, oldPostsReplacedAt: null },
    orderBy: { createdAt: "desc" }, select: { id: true, oldPosts: true, oldPostsOutcome: true, carriedOldPosts: true } });
  const latest = open[0];
  if (latest && latest.oldPosts === null) {
    // Публикация ещё не начиналась: заявка та же; старшие открытые (дубли прежних возвратов) сливаются в неё.
    const carried = [...readCarried(latest.carriedOldPosts), ...collectUnresolvedOldPosts(open.slice(1))];
    // Новая озвучка поверх возврата монтажёру: выпуск — очередью новой озвучки (schedulePublishAfterAccept смотрит причину).
    if (input.reason === "NARRATION_CHANGED" || input.narrationVersionId) await tx.videoRemakeRequest.update({ where: { id: latest.id },
      data: { ...(input.reason === "NARRATION_CHANGED" ? { reason: input.reason } : {}), ...(input.narrationVersionId ? { narrationVersionId: input.narrationVersionId } : {}) } });
    if (open.length > 1) {
      await tx.videoRemakeRequest.updateMany({ where: { id: { in: open.slice(1).map((r) => r.id) } }, data: { oldPostsReplacedAt: now } });
      await tx.videoRemakeRequest.update({ where: { id: latest.id }, data: { carriedOldPosts: carried as unknown as Prisma.InputJsonValue } });
    }
    return { id: latest.id, reused: true, closedIds: open.slice(1).map((r) => r.id) };
  }
  const carried = collectUnresolvedOldPosts(open);
  if (open.length) await tx.videoRemakeRequest.updateMany({ where: { id: { in: open.map((r) => r.id) } }, data: { oldPostsReplacedAt: now } });
  // Повторы публикации прошлого ролика: выйдут уже с новым файлом своими путями, но заявка закрыта — дубли. Гасим.
  if (input.cancelRetries !== false) await cancelPreviousClipRetries(tx, input.propertyId);
  const created = await tx.videoRemakeRequest.create({ data: { propertyId: input.propertyId, reason: input.reason, requestedById: input.requestedById,
    comment: input.comment ?? null, messageText: input.messageText ?? null, replaceOldPostsOnPublish: true, narrationVersionId: input.narrationVersionId ?? null,
    ...(carried.length ? { carriedOldPosts: carried as unknown as Prisma.InputJsonValue } : {}) } });
  return { id: created.id, reused: false, closedIds: open.map((r) => r.id) };
}

/**
 * Откат открытия (ролик так и не принят, staffClip): созданная заявка удаляется, закрытые ею — снова открыты.
 * Полный откат только при открытии с cancelRetries: false — погашенные повторы восстановить нельзя.
 */
export async function undoReplacement(tx: TxClient, opened: { id: string; reused: boolean; closedIds: string[] }): Promise<void> {
  if (!opened.reused) await tx.videoRemakeRequest.deleteMany({ where: { id: opened.id, oldPosts: { equals: Prisma.DbNull } } });
  if (!opened.reused && opened.closedIds.length) await tx.videoRemakeRequest.updateMany({ where: { id: { in: opened.closedIds } }, data: { oldPostsReplacedAt: null } });
}

/** Запись возврата в историю (без замены постов) — тоже здесь: VideoRemakeRequest пишет только этот модуль. */
export async function recordRemakeHistory(tx: TxClient, input: OpenReplacementInput): Promise<void> {
  await tx.videoRemakeRequest.create({ data: { propertyId: input.propertyId, reason: input.reason, requestedById: input.requestedById,
    comment: input.comment ?? null, messageText: input.messageText ?? null, replaceOldPostsOnPublish: false } });
}

/** НЕрешённые старые посты закрываемых заявок: сети, где новый ещё не вышел (WAITING/REMOVING), с их id из снимков. */
export function collectUnresolvedOldPosts(rows: { oldPosts: Prisma.JsonValue | null; oldPostsOutcome: Prisma.JsonValue | null; carriedOldPosts: Prisma.JsonValue | null }[]): CarriedOldPost[] {
  const out: CarriedOldPost[] = [];
  for (const r of rows) {
    if (r.oldPosts === null) { out.push(...readCarried(r.carriedOldPosts)); continue; }
    const snap = asRecord(r.oldPosts);
    const outcome = asRecord(r.oldPostsOutcome) as Record<string, { state?: string }>;
    const main = Array.isArray(snap.main) ? (snap.main as string[]) : Array.isArray(snap.channels) ? (snap.channels as string[]) : [];
    const postIds = asRecord(snap.postIds);
    for (const channel of Array.isArray(snap.channels) ? (snap.channels as string[]) : []) {
      if (!UNRESOLVED.has(outcome[channel]?.state ?? "WAITING")) continue;
      if (main.includes(channel)) {
        out.push({ channel, postIds: Object.fromEntries(postKeysOf(channel).filter((k) => postIds[k] !== undefined).map((k) => [k, postIds[k]])),
          instagramUrl: channel === "INSTAGRAM" && typeof snap.instagramUrl === "string" ? snap.instagramUrl : null });
      }
      out.push(...readCarried(snap.extra).filter((e) => e.channel === channel));
    }
  }
  return out;
}
