import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { prisma } from "../db.js";
import { uploadsDir } from "../upload.js";
import { describeError } from "./describeError.js";
import { logSystemError } from "./systemError.js";
import { fetchInstagramProfile } from "../messengers/meta.js";
import { getUserProfilePhotoUrl } from "../telegram/api.js";
import { safeOpen, type SafeOpened } from "./safeFetch.js";

/**
 * АВАТАР КЛИЕНТА В КАРТОЧКЕ И ПУШ-УВЕДОМЛЕНИЯХ — «крутая фича» по просьбе владельца
 * 19.08.2026: агент должен ориентироваться по клиентам с одного взгляда на шторку
 * уведомлений, не открывая карточку.
 *
 * Забираем только ОДИН раз на клиента, лениво — первым сообщением, на котором у нас
 * впервые есть и клиент, и его идентификатор в канале. Оба условия проверяет вызывающий
 * (см. lib/clientMessageAlert.ts): если avatarUrl уже стоит, сюда даже не заходим.
 *
 * Instagram и Facebook отдают `profile_pic` временной подписанной ссылкой на CDN Meta —
 * она протухает за часы, поэтому хранить её как есть в базе нельзя (клиент открыл бы
 * карточку через неделю и увидел битую картинку). Telegram отдаёт адрес с маркером бота
 * прямо в URL — тем более нельзя. Поэтому в обоих случаях файл СКАЧИВАЕТСЯ РАЗ и кладётся
 * в uploads/avatars как локальная копия — тот же приём, что и messagePhoto.ts для фото
 * объектов, и agents.ts/me.ts для аватаров сотрудников: /uploads отдаётся статикой
 * (app.ts), значит ссылка не протухнет и не привяжется к маркеру.
 *
 * WhatsApp Cloud API аватар не отдаёт вовсе — Meta закрывает его политикой приватности
 * на уровне Cloud API (в отличие от Instagram/Messenger, где `profile_pic` есть). Поэтому
 * канал WHATSAPP здесь даже не пытается — это не пропуск по лени, а факт API.
 *
 * Никогда не бросает: отказ — это просто «аватара не будет», а не повод уронить приём
 * сообщения или доставку пуша.
 *
 * ПРО ПРОКСИ (22.08.2026). Запросы к Graph API идут через Cloudflare Worker, потому что
 * с нашего VPS домены Meta недоступны напрямую (см. instagramProxyBase в
 * messengers/meta.ts). САМА КАРТИНКА лежит на другом хосте — CDN (`scontent-*.
 * cdninstagram.com`), и его наш Worker сегодня не проксирует вовсе: он знает только
 * префикс `/gemini` и путь graph.instagram.com. Подставлять сюда адрес прокси наугад
 * значит менять таймаут на 404 — поэтому CDN пока зовём напрямую, но с урезанным
 * бюджетом попыток (см. ниже). Чтобы закрыть причину, а не симптом, Worker'у нужен
 * маршрут для CDN-хостов Meta — это правка вне репозитория, см. отчёт 22.08.
 */

const avatarsDir = path.join(uploadsDir, "avatars");
fs.mkdirSync(avatarsDir, { recursive: true });
const MAX_SIDE_PX = 300;

/** Потолок скачиваемого файла: аватар крупнее не бывает, а буфер целиком ложится в
 *  память процесса перед sharp (26.08.2026 — единственный путь загрузки без лимита,
 *  все multer-пути в upload.ts лимиты имеют). */
const MAX_AVATAR_BYTES = 10 * 1024 * 1024;

/**
 * СВОЙ БЮДЖЕТ НА ПОПЫТКИ, А НЕ ОБЩИЙ (22.08.2026).
 *
 * До этого дня здесь был голый `fetch` с одной попыткой и сроком 15 секунд — при том,
 * что ВСЕ остальные обращения к Meta в проекте идут через `fetchWithRetry`
 * (messengers/meta.ts, три повтора 1с→2с→4с, добавлено 18.08.2026 ровно из-за таких
 * потерь). Утро 22.08 дало минимум четыре записи вида «Аватар клиента <id> (INSTAGRAM):
 * fetch failed (UND_ERR_CONNECT_TIMEOUT ... scontent-arn2-1.cdninstagram.com:443)».
 *
 * Но общий бюджет Meta сюда не годится в обе стороны. Ноль повторов — это потеря
 * аватара от секундного сбоя сети; три повтора по 15 секунд — это 45 секунд на
 * КАРТИНКУ, которая всего лишь украшает пуш. Поэтому здесь свой, урезанный набор:
 * две попытки по 6 секунд с одной секундой паузы — худший случай ≈13 секунд, меньше
 * прежних 15, а разовый обрыв уже лечится.
 */
const AVATAR_TIMEOUT_MS = 6_000;
const AVATAR_RETRY_DELAYS_MS = [1_000];

/**
 * Повтор скачивания при СЕТЕВОМ отказе — точная калька `fetchWithRetry` из
 * messengers/meta.ts (тот же довод: `fetch` бросает исключение только на сетевом
 * уровне, а HTTP-ответ CDN — пусть даже 404 — это осмысленный ответ, и повторять
 * его бессмысленно). Свежий `AbortSignal` на каждую попытку: один сигнал на весь
 * цикл истекал бы во время пауз, и повторы были бы фикцией — грабля, разобранная
 * на ленте Instagram 20.08.2026.
 *
 * СВОЯ КОПИЯ, А НЕ ИМПОРТ ИЗ meta.ts: бюджет попыток здесь намеренно другой (см.
 * выше), а аватар обязан работать одинаково для Meta и для Telegram.
 *
 * К8 (аудит безопасности 11.09.2026): раньше здесь стоял голый `fetch` мимо
 * общего рубежа SSRF-защиты (lib/safeFetch.ts) — единственное место в проекте,
 * где адрес из внешнего API (Graph/Telegram) уходил в запрос без проверки IP и
 * без проверки переходов. Сам адрес сегодня не вводит человек напрямую, но это
 * ссылка, которую нам ПРИСЛАЛ чужой сервис, — тот же полудоверенный источник,
 * что и вложения мессенджеров, для которых safeFetch/safeOpen и заведены.
 * Теперь скачивание идёт через `safeOpen`: та же проверка каждого перехода, тот
 * же запрет на внутренние адреса, а тело по-прежнему читает и лимитирует сама
 * downloadAndStoreAvatar — у неё свой потолок в байтах, safeOpen лишь доводит
 * соединение до ответа.
 */
async function fetchAvatarWithRetry(url: string): Promise<SafeOpened> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= AVATAR_RETRY_DELAYS_MS.length; attempt++) {
    try {
      return await safeOpen(url, { timeoutMs: AVATAR_TIMEOUT_MS });
    } catch (err) {
      lastErr = err;
      if (attempt < AVATAR_RETRY_DELAYS_MS.length) {
        await new Promise((resolve) => setTimeout(resolve, AVATAR_RETRY_DELAYS_MS[attempt]));
      }
    }
  }
  throw lastErr;
}

/**
 * Удаляет локальный файл аватара клиента — при «удалить навсегда» (G10,
 * 02.10.2026). Папка uploads/avatars раздаётся без входа, и без этого фото
 * удалённого клиента открывалось по старой ссылке у любого. Только наш формат
 * `/uploads/avatars/<имя>`; всё остальное (внешний адрес, чужой путь) не трогаем.
 * Best-effort: отказ диска не должен отменять уже совершённое удаление.
 */
export async function removeClientAvatarFile(avatarUrl: string | null): Promise<void> {
  if (!avatarUrl?.startsWith("/uploads/avatars/")) return;
  const name = path.basename(avatarUrl);
  if (!/^[0-9a-f-]{36}\.webp$/i.test(name)) return;
  await fs.promises.rm(path.join(avatarsDir, name), { force: true }).catch((err) =>
    console.error(`[avatar] файл аватара ${name} не удалён:`, err instanceof Error ? err.message : err)
  );
}

/** Скачивает картинку по адресу и сохраняет локальную WebP-копию в uploads/avatars.
 *  Возвращает публичный путь (`/uploads/avatars/...`) или null, если скачать/обработать
 *  не вышло. */
async function downloadAndStoreAvatar(remoteUrl: string): Promise<string | null> {
  const { res } = await fetchAvatarWithRetry(remoteUrl);
  // safeOpen уже бросил исключение на не-2xx ответе и на любом непубличном адресе
  // из цепочки переходов — сюда доходит только успешный, проверенный ответ.
  // Потолок объёма: URL полудоверенный (ответ Graph/Telegram), а весь файл ляжет в
  // память процесса перед sharp. Аватар больше 10 МБ не бывает; заявленный размер
  // проверяем до чтения, фактический — после (Content-Length может отсутствовать).
  const declared = Number(res.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_AVATAR_BYTES) {
    throw new Error(`аватар слишком большой: заявлено ${declared} байт`);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.byteLength > MAX_AVATAR_BYTES) {
    throw new Error(`аватар слишком большой: ${buffer.byteLength} байт`);
  }

  const filename = `${randomUUID()}.webp`;
  await sharp(buffer)
    .resize(MAX_SIDE_PX, MAX_SIDE_PX, { fit: "cover" })
    .webp({ quality: 85 })
    .toFile(path.join(avatarsDir, filename));
  return `/uploads/avatars/${filename}`;
}

/**
 * Забирает и сохраняет аватар клиента, если его ещё нет. Best-effort: канал не
 * поддерживается, идентификатор неизвестен, сеть подвела — молча ничего не делаем.
 *
 * `channel`/`subscriberId` — те же значения, что несёт BotConversation
 * (psid/igsid у Meta, chatId у Telegram): тот идентификатор, по которому уже сегодня
 * ведётся переписка, отдельно узнавать ничего не нужно.
 */
/** Возвращает свежесохранённый локальный путь к аватару, если удалось его забрать —
 *  так вызывающему не нужно перечитывать клиента из базы, чтобы отдать аватар в ЭТОТ
 *  же пуш, а не только в следующий. null — не вышло (и это нормально, не ошибка). */
export async function fetchAndStoreClientAvatarIfMissing(
  clientId: string,
  channel: string,
  subscriberId: string | undefined | null
): Promise<string | null> {
  if (!subscriberId) return null;
  try {
    const client = await prisma.client.findUnique({ where: { id: clientId }, select: { avatarUrl: true } });
    if (!client || client.avatarUrl) return client?.avatarUrl ?? null; // уже есть или клиента больше нет

    let remoteUrl: string | null = null;
    if (channel === "INSTAGRAM" || channel === "FACEBOOK") {
      const profile = await fetchInstagramProfile(subscriberId);
      remoteUrl = profile.profilePic ?? null;
    } else if (channel === "TELEGRAM") {
      remoteUrl = await getUserProfilePhotoUrl(subscriberId);
    } else {
      // WHATSAPP и всё остальное — Cloud API аватар не отдаёт, см. комментарий выше.
      return null;
    }
    if (!remoteUrl) return null;

    const localUrl = await downloadAndStoreAvatar(remoteUrl);
    if (!localUrl) return null;

    // updateMany, а не update: клиента могли удалить/переместить в Корзину между
    // запросом профиля и записью результата — отметка не имеет права упасть из-за этого.
    await prisma.client.updateMany({ where: { id: clientId, avatarUrl: null }, data: { avatarUrl: localUrl } });
    return localUrl;
  } catch (err) {
    const message = describeError(err);
    console.error("[avatar] клиент", clientId, message);
    // Сетевые отказы CDN Meta — хронический шум, а не событие: с нашего VPS хосты
    // Meta блокируются (см. шапку про прокси), и до маршрута CDN в Worker'е таймауты
    // здесь неизбежны. Аватар — украшение пуша с готовым запасным вариантом
    // (clientAvatarFallback), будить директора записью в журнале из-за него нельзя
    // (прод 25-26.08: десяток «Аватар клиента … timeout» в утренней сводке).
    // Неожиданные сбои (sharp, диск, HTTP-ошибка) — по-прежнему в журнал.
    const networkNoise = /timeout|timed out|fetch failed|ECONNRESET|ENOTFOUND|ECONNREFUSED|UND_ERR/i.test(message);
    if (!networkNoise) {
      void logSystemError("api", `Аватар клиента ${clientId} (${channel}): ${message}`);
    }
    return null;
  }
}
