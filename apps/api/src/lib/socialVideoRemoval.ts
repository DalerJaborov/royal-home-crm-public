import { prisma } from "../db.js";
import { decryptSecretSafe } from "../crypto.js";
import { loadCredentials } from "../messengers/meta.js";
import { deleteChannelMessage } from "../telegram/api.js";
import { describeError } from "./describeError.js";
import { logSystemError } from "./systemError.js";
import { readOwnerMarks, updateOwnerMarks } from "./publishedMarks.js";
import { deleteFacebookVideo, deleteInstagramMedia, deleteThreadsPost, deleteYouTubeVideo } from "./socialPublish.js";
import { instagramManageToken, isTelegramMessageGone, youtubeCredentials } from "./publishedVideoFix.js";
import {
  SocialVideoError,
  getSocialVideo,
  labelOfKey,
  loadRow,
  parseDestinations,
  parseResults,
  patchChannel,
  type ResultsMap,
} from "./socialVideoPosts.js";
import {
  destinationKeyOf,
  parseDestinationKey,
  type SocialVideoItem,
  type SocialVideoRemovalOutcome,
  type SocialVideoStatus,
} from "@royal-home/shared";

/**
 * СНЯТЬ СВОБОДНЫЙ РОЛИК ИЗ СОЦСЕТЕЙ (12.10.2026, владелец: «убрать пост кнопкой из CRM»).
 *
 * Тот же набор вызовов, что у снятия постов объекта (lib/publishedVideoFix.ts::removeFromSocial):
 * Facebook, YouTube, Threads, Telegram (основной и дополнительные чаты) и Instagram основного аккаунта
 * (при ключе удаления) снимаются через API; TikTok и второй Instagram программа снять не может -
 * они попадают в `manual` с честной причиной, а «Я убрал(а) вручную» отмечает их снятыми.
 *
 * Исход пишется по каждому адресу сразу: снятый адрес получает состояние REMOVED, не вышедшее снятие
 * оставляет PUBLISHED с заметкой (пост на месте, повторить можно). Метки «где висит» чистятся условной
 * записью (updateOwnerMarks), как при публикации. Ролик, который сейчас публикуется, не трогаем: запись
 * публикации легла бы поверх «снятого».
 */

const REMOVABLE_FROM: SocialVideoStatus[] = ["DONE", "PARTIAL", "FAILED", "REMOVED"];

type OneRemoval =
  | { kind: "removed"; note: string | null; telegramExtraDone?: string[] }
  | { kind: "failed"; error: string; telegramExtraDone?: string[] }
  | { kind: "manual"; reason: string };

interface Marks {
  postIds: Record<string, unknown>;
}

const asText = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

async function removeTelegram(chatId: string, messageId: string | null): Promise<OneRemoval> {
  if (!messageId || !Number.isFinite(Number(messageId))) return { kind: "failed", error: "не сохранён номер сообщения Telegram — снять нечем" };
  try {
    await deleteChannelMessage(chatId, Number(messageId));
    return { kind: "removed", note: null };
  } catch (err) {
    // «Сообщения уже нет» - цель достигнута; любой другой отказ (нет прав, старое сообщение) - пост на месте.
    if (isTelegramMessageGone(err)) return { kind: "removed", note: "сообщения уже не было" };
    return { kind: "failed", error: describeError(err) };
  }
}

async function removeTelegramDefault(messageId: string | null, extras: Record<string, unknown>): Promise<OneRemoval> {
  const settings = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { telegramChannelId: true } });
  const mainChat = settings?.telegramChannelId?.trim() || null;
  const notes: string[] = [];
  const failures: string[] = [];
  const extraDone: string[] = [];

  if (messageId) {
    if (!mainChat) failures.push("Канал Telegram не указан в Настройках");
    else {
      const res = await removeTelegram(mainChat, messageId);
      if (res.kind === "failed") failures.push(res.error);
      else if (res.kind === "removed" && res.note) notes.push(res.note);
    }
  }
  // Адрес по умолчанию = основной канал плюс дополнительные чаты одним адресом.
  for (const [chatId, extraId] of Object.entries(extras)) {
    const id = asText(extraId);
    if (!id) {
      extraDone.push(chatId);
      continue;
    }
    const res = await removeTelegram(chatId, id);
    if (res.kind === "failed") failures.push(`чат ${chatId}: ${res.error}`);
    else extraDone.push(chatId);
  }
  if (failures.length > 0) return { kind: "failed", error: failures.join("; "), telegramExtraDone: extraDone };
  return { kind: "removed", note: notes.length > 0 ? notes.join("; ") : null, telegramExtraDone: extraDone };
}

async function removeOne(key: string, postId: string | null, marks: Marks): Promise<OneRemoval> {
  const dest = parseDestinationKey(key);
  if (!dest) return { kind: "failed", error: "неизвестный адрес" };

  switch (dest.channel) {
    case "INSTAGRAM": {
      if (dest.accountId) {
        return { kind: "manual", reason: "У дополнительного аккаунта Instagram нет ключа удаления — уберите ролик в приложении Instagram." };
      }
      const token = await instagramManageToken();
      if (!token) return { kind: "manual", reason: "Instagram не даёт снять пост без ключа удаления (Настройки → Instagram) — уберите ролик в приложении." };
      if (!postId) return { kind: "manual", reason: "Не сохранён номер публикации Instagram — уберите ролик в приложении." };
      const res = await deleteInstagramMedia(postId, token);
      if (res.ok) return { kind: "removed", note: res.ghost ? "поста уже не было" : null };
      return { kind: "manual", reason: `Снять через API не удалось (${res.error ?? "неизвестная ошибка"}) — уберите ролик в приложении.` };
    }
    case "FACEBOOK": {
      if (!postId) return { kind: "failed", error: "не сохранён номер публикации Facebook — снять нечем" };
      const creds = await loadCredentials();
      if (!creds.pageToken) return { kind: "failed", error: "Facebook не подключён в Настройках" };
      let res = await deleteFacebookVideo(postId, creds.pageToken);
      const secondary = asText(marks.postIds.FACEBOOK_POST);
      // У поста Страницы video id и post_id - разные объекты: первая попытка отказала - пробуем запасной.
      if (!res.ok && secondary) {
        const fallback = await deleteFacebookVideo(secondary, creds.pageToken);
        if (fallback.ok) res = fallback;
      }
      return res.ok ? { kind: "removed", note: res.ghost ? "поста уже не было" : null } : { kind: "failed", error: res.error ?? "неизвестная ошибка" };
    }
    case "YOUTUBE": {
      if (!postId) return { kind: "failed", error: "не сохранён номер видео YouTube — снять нечем" };
      const res = await deleteYouTubeVideo(await youtubeCredentials(), postId);
      return res.ok ? { kind: "removed", note: res.ghost ? "видео уже не было" : null } : { kind: "failed", error: res.error ?? "неизвестная ошибка" };
    }
    case "THREADS": {
      if (!postId) return { kind: "failed", error: "не сохранён номер публикации Threads — снять нечем" };
      const settings = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { threadsAccessToken: true } });
      const token = decryptSecretSafe(settings?.threadsAccessToken ?? null);
      if (!token) return { kind: "failed", error: "Threads не подключён в Настройках" };
      const res = await deleteThreadsPost(token, postId);
      return res.ok ? { kind: "removed", note: res.ghost ? "поста уже не было" : null } : { kind: "failed", error: res.error ?? "неизвестная ошибка" };
    }
    case "TELEGRAM":
      if (dest.accountId) return removeTelegram(dest.accountId, postId);
      return removeTelegramDefault(postId, (marks.postIds.TELEGRAM_EXTRA as Record<string, unknown> | undefined) ?? {});
    default:
      return { kind: "manual", reason: "TikTok не даёт удалять ролики через API — удалите ролик в приложении TikTok." };
  }
}

/** Канал остаётся в метках «где висит», пока у него есть хоть один живой адрес (второй Instagram, другой чат). */
function channelsStillPublished(results: ResultsMap): Set<string> {
  const left = new Set<string>();
  for (const [key, r] of Object.entries(results)) {
    if (r.state !== "PUBLISHED") continue;
    const dest = parseDestinationKey(key);
    if (dest) left.add(dest.channel);
  }
  return left;
}

interface RemovedEntry {
  key: string;
  note: string | null;
  telegramExtraDone?: string[];
}

/** Применить исход снятия: исход адресов, метки, статус ролика. Общая часть для API и ручной отметки. */
async function applyRemoval(id: string, entries: RemovedEntry[], partial: Array<{ key: string; note: string }>): Promise<void> {
  const now = new Date().toISOString();
  for (const e of entries) {
    await patchChannel(id, e.key, (current) => ({ ...current, state: "REMOVED", error: null, retriable: false, note: e.note, url: null, finishedAt: now }));
  }
  for (const p of partial) {
    await patchChannel(id, p.key, (current) => ({ ...current, note: p.note }));
  }
  const row = await prisma.socialVideoPost.findUnique({ where: { id }, select: { channelResults: true } });
  const results = parseResults(row?.channelResults);
  const alive = channelsStillPublished(results);
  if (entries.length > 0) {
    try {
      await updateOwnerMarks({ kind: "freeVideo", id }, (current) => {
        const postIds = { ...current.postIds } as Record<string, unknown>;
        for (const e of entries) {
          delete postIds[e.key];
          const dest = parseDestinationKey(e.key);
          if (dest?.channel === "FACEBOOK") delete postIds.FACEBOOK_POST;
          if (dest?.channel === "THREADS") delete postIds.THREADS_URL;
          if (dest?.channel === "TELEGRAM" && !dest.accountId) {
            const rest = { ...((postIds.TELEGRAM_EXTRA as Record<string, string> | undefined) ?? {}) };
            for (const chatId of e.telegramExtraDone ?? []) delete rest[chatId];
            if (Object.keys(rest).length > 0) postIds.TELEGRAM_EXTRA = rest;
            else delete postIds.TELEGRAM_EXTRA;
          }
        }
        return { channels: current.channels.filter((c) => alive.has(c)), postIds: postIds as typeof current.postIds };
      });
    } catch (err) {
      void logSystemError("api", `Свободный ролик ${id}: пост снят (${entries.map((e) => e.key).join(", ")}), но метки не обновились — ${describeError(err)}`, {
        dedupKey: "social-video-marks",
      });
    }
  }
  await recomputeStatusAfterRemoval(id, results);
}

async function recomputeStatusAfterRemoval(id: string, results: ResultsMap): Promise<void> {
  const row = await prisma.socialVideoPost.findUnique({ where: { id }, select: { status: true, channels: true, destinations: true } });
  if (!row || !REMOVABLE_FROM.includes(row.status as SocialVideoStatus)) return;
  const keys = parseDestinations(row.destinations, row.channels).map(destinationKeyOf);
  const published = keys.filter((k) => results[k]?.state === "PUBLISHED").length;
  const removed = keys.filter((k) => results[k]?.state === "REMOVED").length;
  let next = row.status as SocialVideoStatus;
  if (published === 0 && removed > 0) next = "REMOVED";
  else if (removed > 0 && published > 0) next = "PARTIAL";
  if (next !== row.status) await prisma.socialVideoPost.updateMany({ where: { id, status: { in: REMOVABLE_FROM } }, data: { status: next } });
}

export async function removeSocialVideoFromSocials(
  id: string,
  keys?: string[]
): Promise<{ item: SocialVideoItem; outcome: SocialVideoRemovalOutcome }> {
  const row = await loadRow(id);
  if (row.status === "PUBLISHING") throw new SocialVideoError("Ролик сейчас публикуется — снять можно после окончания", 409);
  if (!REMOVABLE_FROM.includes(row.status as SocialVideoStatus)) throw new SocialVideoError("Ролик ещё не опубликован — снимать нечего", 409);

  const results = parseResults(row.channelResults);
  const targets = (keys ?? Object.keys(results)).filter((k) => results[k]?.state === "PUBLISHED");
  if (targets.length === 0) throw new SocialVideoError("Нет опубликованных адресов, которые можно снять", 409);

  const marks = (await readOwnerMarks({ kind: "freeVideo", id })) ?? { channels: [], postIds: {} };
  const outcome: SocialVideoRemovalOutcome = { removed: [], failed: [], manual: [] };
  const entries: RemovedEntry[] = [];
  const partial: Array<{ key: string; note: string }> = [];

  for (const key of targets) {
    const label = await labelOfKey(key);
    const result = results[key];
    let res: OneRemoval;
    try {
      res = await removeOne(key, result.postId, marks as Marks);
    } catch (err) {
      res = { kind: "failed", error: describeError(err) };
    }
    if (res.kind === "removed") {
      outcome.removed.push({ key, label, note: res.note });
      entries.push({ key, note: res.note, telegramExtraDone: res.telegramExtraDone });
    } else if (res.kind === "manual") {
      outcome.manual.push({ key, label, reason: res.reason, url: result.url });
    } else {
      outcome.failed.push({ key, label, error: res.error });
      partial.push({ key, note: `Снять не вышло: ${res.error}`.slice(0, 300) });
    }
  }

  if (entries.length > 0 || partial.length > 0) await applyRemoval(id, entries, partial);
  if (outcome.failed.length > 0) {
    void logSystemError("api", `Свободный ролик ${id}: снятие — ${outcome.failed.map((f) => `${f.label}: ${f.error}`).join("; ")}`);
  }
  return { item: await getSocialVideo(id), outcome };
}

/** «Я убрал(а) пост вручную»: верим человеку - проверить удаление у TikTok и второго Instagram нечем. */
export async function markSocialVideoRemovedByHand(id: string, keys: string[]): Promise<SocialVideoItem> {
  const row = await loadRow(id);
  if (row.status === "PUBLISHING") throw new SocialVideoError("Ролик сейчас публикуется — отметить можно после окончания", 409);
  if (!REMOVABLE_FROM.includes(row.status as SocialVideoStatus)) throw new SocialVideoError("Ролик ещё не опубликован", 409);
  const results = parseResults(row.channelResults);
  const targets = keys.filter((k) => results[k]?.state === "PUBLISHED");
  if (targets.length === 0) throw new SocialVideoError("Эти адреса не отмечены как опубликованные", 409);
  await applyRemoval(id, targets.map((key) => ({ key, note: "убрано вручную" })), []);
  return getSocialVideo(id);
}
