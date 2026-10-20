import {
  SOCIAL_VIDEO_MIN_SCHEDULE_LEAD_MINUTES,
  type SocialVideoChannel,
  type SocialVideoChannelLive,
  type SocialVideoFacts,
  type SocialVideoItem,
  type SocialVideoStatus,
} from "@royal-home/shared";

/**
 * Общие мелочи экрана «Ролики в соцсети»: список, композитор и карточка ролика
 * считают одно и то же одинаково, поэтому здесь, а не копией в каждом файле.
 */

/** Факты о файле из ответа сервера (ffprobe). Всё, что сервер не измерил, — null. */
export function factsFromItem(item: SocialVideoItem): SocialVideoFacts {
  return {
    durationSec: item.durationSec,
    sizeBytes: item.sizeBytes,
    width: item.width,
    height: item.height,
    videoCodec: item.videoCodec,
    hasAudio: item.hasAudio,
  };
}

/**
 * Сводит факты сервера и браузера: сервер точнее (знает кодек и звук), но если
 * ffprobe чего-то не измерил, берём то, что успел прочитать браузер.
 */
export function mergeFacts(server: SocialVideoFacts | null, browser: SocialVideoFacts | null): SocialVideoFacts | null {
  if (!server) return browser;
  if (!browser) return server;
  return {
    durationSec: server.durationSec ?? browser.durationSec,
    sizeBytes: server.sizeBytes,
    width: server.width ?? browser.width,
    height: server.height ?? browser.height,
    videoCodec: server.videoCodec ?? browser.videoCodec,
    hasAudio: server.hasAudio ?? browser.hasAudio,
  };
}

/**
 * Адрес файла из `/uploads` для `<video>`/`<img>`. Сервер отдаёт путь уже
 * пригодным для просмотра (подписанным); без ведущего слеша добавляем его, чтобы
 * относительный путь не склеился с адресом текущей страницы.
 */
export function mediaSrc(path: string): string {
  if (/^(https?:)?\/\//.test(path) || path.startsWith("/") || path.startsWith("blob:")) return stableSigned(path);
  return stableSigned(`/${path}`);
}

/**
 * Сервер подписывает путь файла заново в КАЖДОМ ответе (`?t=<новая подпись>`), а экран опрашивает
 * ролик раз в 3 секунды, пока идёт публикация. Новый адрес = плеер перезагружает видео и мигает.
 * Поэтому для одного и того же файла держим первую выданную ссылку, пока она заведомо живая
 * (подпись действует сутки — обновляем раз в 6 часов).
 */
const SIGNED_KEEP_MS = 6 * 60 * 60_000;
const signedSeen = new Map<string, { url: string; at: number }>();

function stableSigned(url: string): string {
  const queryAt = url.indexOf("?t=");
  if (queryAt < 0) return url;
  const clean = url.slice(0, queryAt);
  const known = signedSeen.get(clean);
  if (known && Date.now() - known.at < SIGNED_KEEP_MS) return known.url;
  signedSeen.set(clean, { url, at: Date.now() });
  return url;
}

/** Название по умолчанию из имени файла: «promo_ramazon-2026.mp4» → «promo ramazon 2026». */
export function titleFromFileName(name: string): string {
  const base = name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim();
  return (base || "Новый ролик").slice(0, 120);
}

/** Цвет чипа статуса ролика (`.chip` из темы). Смысл всегда дублирует подпись. */
export const SOCIAL_VIDEO_STATUS_CHIP: Record<SocialVideoStatus, string> = {
  DRAFT: "chip mute",
  SCHEDULED: "chip sky",
  PUBLISHING: "chip warn",
  DONE: "chip ok",
  PARTIAL: "chip warn",
  FAILED: "chip crit",
  REMOVED: "chip mute",
};

/** Ролик можно править: черновик, ждущий своего часа или не вышедший. */
export function isEditable(status: SocialVideoStatus): boolean {
  return status === "DRAFT" || status === "SCHEDULED" || status === "FAILED" || status === "PARTIAL";
}

/**
 * Ролик можно (пере)отправлять на публикацию: повтор упавших адресов, добавление сетей.
 * Снятый из соцсетей ролик не публикуется — для нового выхода делают копию черновиком.
 */
export function canPublishAgain(status: SocialVideoStatus): boolean {
  return status !== "REMOVED";
}

/** «Снять из соцсетей» доступно вышедшему (целиком, частично или с ошибками) ролику хотя бы с одним вышедшим адресом. */
export function canRemoveFromSocials(item: Pick<SocialVideoItem, "status" | "results">): boolean {
  if (item.status !== "DONE" && item.status !== "PARTIAL" && item.status !== "FAILED") return false;
  return Object.values(item.results).some((r) => r.state === "PUBLISHED");
}

/** Живые данные списком → словарь по каналу (так их ждёт ChannelPicker). */
export function liveByChannel(list: SocialVideoChannelLive[] | undefined): Partial<Record<SocialVideoChannel, SocialVideoChannelLive>> {
  const map: Partial<Record<SocialVideoChannel, SocialVideoChannelLive>> = {};
  for (const entry of list ?? []) map[entry.channel] = entry;
  return map;
}

/** Самое раннее допустимое время публикации по расписанию (UTC, мс). */
export function earliestScheduleMs(now = Date.now()): number {
  return now + SOCIAL_VIDEO_MIN_SCHEDULE_LEAD_MINUTES * 60_000;
}

/** Ошибка из ответа API — текстом сервера; запасная фраза, если текста нет. */
export function errorText(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}
