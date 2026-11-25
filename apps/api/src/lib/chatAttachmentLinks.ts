import { createHmac, timingSafeEqual } from "node:crypto";
import type { Request } from "express";

/**
 * ПОДПИСАННЫЕ ССЫЛКИ НА ВЛОЖЕНИЯ ПЕРЕПИСКИ (25.11.2026, жалоба владельца «фото и
 * видео приходят, но не открываются в CRM»).
 *
 * Было: браузер качал КАЖДОЕ вложение целиком через fetch с заголовком
 * Authorization и показывал его через blob-ссылку — потому что `<img>`/`<video>`
 * заголовков не шлют. Цена: при открытии диалога качались сразу все файлы во всю
 * величину (четыре видео рум-тура = 64 МБ, `preload="none"` у плеера ничего не
 * экономил — файл уже скачан), видео нельзя было смотреть, пока оно не скачалось
 * до конца, перемотки по сети (Range) не было вовсе, и на медленном мобильном
 * интернете агент видел серую заглушку минутами.
 *
 * Стало: сервер, отдавая переписку тому, кто ИМЕЕТ право открыть вложение,
 * кладёт в него короткоживущую подписанную ссылку. `<img src>`, `<video src>` и
 * `<audio src>` грузят файл напрямую — с Range, ленивой загрузкой и кэшем
 * браузера. Право и владелец проверяются в МОМЕНТ ВЫДАЧИ подписи — тем же
 * правилом, что у старого маршрута `/attachments/:name` (`canOpenChatAttachments`
 * ниже — одна дверь на оба пути).
 *
 * ПОЧЕМУ ПОДПИСЬ В АДРЕСЕ, А НЕ COOKIE. Вход в CRM — по токену в заголовке
 * (тот же токен пригоден мобильному приложению), cookie-сессии нет вовсе. Завести
 * её ради картинок значило бы добавить второй способ входа со своими CSRF,
 * SameSite и выходом из учётной записи. Подпись в адресе ничего не открывает
 * сверх ОДНОГО файла на несколько часов, к сессии не привязана и потому не
 * даёт ни войти, ни прочитать что-то ещё. Утечка через Referer закрыта
 * заголовком `Referrer-Policy: no-referrer` на ответе маршрута.
 *
 * ПОЧЕМУ СРОК «ОКНАМИ». Переписка опрашивается каждые несколько секунд; если бы
 * срок считался от «сейчас», адрес картинки менялся бы на каждом опросе, и
 * браузер перекачивал бы все фото диалога заново. Срок — конец СЛЕДУЮЩЕГО
 * шестичасового окна: адрес неизменен шесть часов, а действует от шести до
 * двенадцати.
 */

/** Окно 2 часа: адрес неизменен 2 ч, действует от 2 до 4 ч (ревью #428: подпись — пропуск без входа, короче лучше). */
const WINDOW_SEC = 2 * 60 * 60;
/** Длина подписи в символах base64url: 22 символа = 132 бита, перебором не подобрать. */
const SIG_CHARS = 22;
const DOMAIN = "chat-attachment-link-v2";

export const SIGNED_ATTACHMENT_PREFIX = "/api/v1/attachments/s/";

function secret(): string | null {
  const s = process.env.JWT_ACCESS_SECRET;
  return s && s.length >= 16 ? s : null;
}

function signature(name: string, agentId: string, exp: number, key: string): string {
  return createHmac("sha256", key).update(JSON.stringify([DOMAIN, name, agentId, exp])).digest("base64url").slice(0, SIG_CHARS);
}

/** Срок действия ссылки, выданной в момент `nowMs` (секунды эпохи). */
export function attachmentLinkExpiry(nowMs: number = Date.now()): number {
  return (Math.floor(nowMs / 1000 / WINDOW_SEC) + 2) * WINDOW_SEC;
}

export interface ChatAttachmentLinks {
  /** Сам файл (оригинал). */
  src: string;
  /** Уменьшенная копия — только у фото. */
  thumb?: string;
  /** Версия, которую играет любой браузер (m4a/mp4), — у голосовых и видео. */
  play?: string;
}

/**
 * Ссылки на файл закрытого хранилища. null — секрет не настроен: тогда интерфейс
 * идёт прежним путём (скачать с заголовком Authorization), а не рисует битую
 * картинку.
 */
export function chatAttachmentLinks(
  name: string,
  kind: "image" | "audio" | "video" | "file",
  mime: string,
  /** Кому выдана ссылка: на отдаче проверяется, что учётка ещё активна. */
  agentId: string,
  nowMs: number = Date.now()
): ChatAttachmentLinks | null {
  const key = secret();
  if (!key || !agentId) return null;
  const exp = attachmentLinkExpiry(nowMs);
  const base = `${SIGNED_ATTACHMENT_PREFIX}${encodeURIComponent(name)}?a=${encodeURIComponent(agentId)}&e=${exp}&k=${signature(name, agentId, exp, key)}`;
  const links: ChatAttachmentLinks = { src: base };
  if (kind === "image") links.thumb = `${base}&v=t`;
  // Вид (a/v) — подсказка для перекодировки: webm бывает и голосом, и видео.
  if (kind === "video") links.play = `${base}&v=p&m=v`;
  else if (kind === "audio" && needsAudioTranscode(mime)) links.play = `${base}&v=p&m=a`;
  return links;
}

/** Голос в mp3/aac/m4a/wav играет любой браузер; ogg и webm — не каждый (Safari до iOS 18.4). */
export function needsAudioTranscode(mime: string): boolean {
  const base = mime.split(";")[0].trim().toLowerCase();
  return !["audio/mpeg", "audio/mp4", "audio/x-m4a", "audio/aac", "audio/wav"].includes(base);
}

/** Подпись верна и не просрочена. Сравнение — за постоянное время. */
export function verifyAttachmentLink(name: string, agentId: string, exp: number, sig: string, nowMs: number = Date.now()): boolean {
  const key = secret();
  if (!key || !agentId) return false;
  if (!Number.isInteger(exp) || exp * 1000 <= nowMs) return false;
  // Срок дальше двух окон вперёд не выдаётся никогда — значит, подделан.
  if (exp > attachmentLinkExpiry(nowMs)) return false;
  const expected = Buffer.from(signature(name, agentId, exp, key));
  const given = Buffer.from(sig);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/**
 * МОЖНО ЛИ ЭТОМУ СОТРУДНИКУ ОТКРЫТЬ ВЛОЖЕНИЯ ПЕРЕПИСКИ ЭТОГО КЛИЕНТА — одна дверь
 * на оба пути отдачи: старый `/attachments/:name` (проверка по имени файла) и
 * выдачу подписанной ссылки вместе с перепиской. Правило то же, что было у
 * старого маршрута (К7, 11.09.2026): право `messages.viewAttachments` И
 * (`clients.viewAll` ИЛИ клиент закреплён за ним). Диалог без клиента —
 * открыт только `clients.viewAll`: неизвестное не значит «моё».
 *
 * `clientAssignedAgentId === undefined` — клиента у диалога нет вовсе.
 */
export function canOpenChatAttachments(
  req: Pick<Request, "agent">,
  clientAssignedAgentId: string | null | undefined
): boolean {
  const perms = req.agent?.permissions;
  if (!perms?.has("messages.viewAttachments")) return false;
  if (perms.has("clients.viewAll")) return true;
  return !!clientAssignedAgentId && clientAssignedAgentId === req.agent?.id;
}

/**
 * Кому выдавать подписанные ссылки на вложения этого клиента: id сотрудника или
 * null. Одна дверь для всех мест, где переписка уходит наружу (presentMessages).
 */
export function attachmentLinkSigner(
  req: Pick<Request, "agent">,
  clientAssignedAgentId: string | null | undefined
): string | null {
  return canOpenChatAttachments(req, clientAssignedAgentId) ? req.agent?.id ?? null : null;
}
