import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { prisma } from "../db.js";
import { describeError } from "./describeError.js";
import { logSystemError } from "./systemError.js";
import { privateDirRoot } from "./privateFiles.js";
import { safeOpen } from "./safeFetch.js";
import { chatAttachmentLinks } from "./chatAttachmentLinks.js";
import { fetchInstagramProfile, fetchMessengerProfilePic } from "../messengers/meta.js";
import { accountTokenById } from "../messengers/accounts.js";
import { getUserProfilePhotoUrl } from "../telegram/api.js";

/**
 * МИНИАТЮРА СОБЕСЕДНИКА В СПИСКЕ ЧАТОВ (владелец 26.11.2026): фото из профиля канала там, где канал его
 * отдаёт (Instagram, Messenger, Telegram); у остальных (WhatsApp Cloud API фото не отдаёт) остаётся кружок
 * с буквой. Лиц не выдумываем: нет фото, значит нет фото.
 *
 * ОДИН РАЗ. Забираем на первом входящем, где у нас есть досье, и больше не ходим: успех пишет `avatarKey`,
 * любая попытка пишет `avatarFetchedAt` (повтор после отказа не раньше чем через неделю). Отметка занимается
 * ДО скачивания условным `updateMany`, поэтому два одновременных входящих не качают фото дважды.
 *
 * ЛИЧНЫЕ ДАННЫЕ. Фото клиента персональное: лежит в закрытом хранилище (`<uploads-private>/avatars`, вне
 * `/uploads`; уборка вложений подкаталоги не трогает), наружу отдаётся только по подписанной ссылке тому, кто
 * видит переписку (routes/attachments.ts, `v=a`). Миниатюра 96 px webp: оригинал не хранится.
 *
 * Скачивание идёт через `safeOpen` (проверка каждого перехода, запрет внутренних адресов), с потолком байтов
 * и пикселей и таймаутом. Функция никогда не бросает: отказ канала или ключа даёт тихое «аватара не будет»
 * (тревога о ключе уже есть у самих каналов), неожиданное (диск, sharp) попадает одной строкой в журнал.
 */
export const AVATAR_PX = 96;
/** Повтор после отказа канала не раньше, чтобы закрытый профиль не дёргали на каждое сообщение. */
export const AVATAR_RETRY_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
/** Человек сменил фото в канале: обновляем миниатюру не чаще раза в 90 дней и только когда он снова пишет. */
export const AVATAR_REFRESH_AFTER_MS = 90 * 24 * 60 * 60 * 1000;
/** Файл без записи в базе стирается ночной уборкой не раньше чем через сутки: он мог только что лечь, запись ещё едет. */
const ORPHAN_GRACE_MS = 24 * 60 * 60 * 1000;
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_INPUT_PIXELS = 24_000_000;
const TIMEOUT_MS = 6_000;

const AVATAR_NAME_RE = /^[0-9a-f-]{36}\.webp$/i;

function avatarsDir(): string {
  const dir = path.join(privateDirRoot(), "avatars");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Путь к файлу миниатюры по ключу; null: имя не наше (защита от выхода из папки) или файла нет. */
export function contactAvatarPath(key: string): string | null {
  if (!AVATAR_NAME_RE.test(key)) return null;
  const full = path.join(avatarsDir(), key);
  return fs.existsSync(full) ? full : null;
}

/** Каналы, у которых фото вообще можно взять. WhatsApp сюда не входит: Cloud API фото не отдаёт. */
export function channelHasAvatar(channel: string): boolean {
  return channel === "INSTAGRAM" || channel === "FACEBOOK" || channel === "TELEGRAM";
}

/** Подписанная ссылка на миниатюру для этого сотрудника (null: секрет не настроен или ключа нет). */
export function contactAvatarLink(key: string | null | undefined, agentId: string, nowMs: number = Date.now()): string | null {
  if (!key || !AVATAR_NAME_RE.test(key)) return null;
  const links = chatAttachmentLinks(key, "image", "image/webp", agentId, nowMs);
  return links ? `${links.src}&v=a` : null;
}

async function remoteUrlFor(channel: string, subscriberId: string, token?: string): Promise<string | null> {
  if (channel === "INSTAGRAM") return (await fetchInstagramProfile(subscriberId, token)).profilePic ?? null;
  if (channel === "FACEBOOK") return (await fetchMessengerProfilePic(subscriberId, token)) ?? null;
  if (channel === "TELEGRAM") return getUserProfilePhotoUrl(subscriberId);
  return null;
}

async function downloadThumb(remoteUrl: string): Promise<string> {
  const { res } = await safeOpen(remoteUrl, { timeoutMs: TIMEOUT_MS });
  const declared = Number(res.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_BYTES) throw new Error(`фото слишком большое: ${declared} байт`);
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.byteLength > MAX_BYTES) throw new Error(`фото слишком большое: ${buffer.byteLength} байт`);
  const name = `${randomUUID()}.webp`;
  await sharp(buffer, { limitInputPixels: MAX_INPUT_PIXELS })
    .rotate()
    .resize(AVATAR_PX, AVATAR_PX, { fit: "cover" })
    .webp({ quality: 80 })
    .toFile(path.join(avatarsDir(), name));
  return name;
}

export type EnsureAvatarResult = "stored" | "skipped" | "none" | "failed";

/**
 * Запуск из горячего пути входящего сообщения («в отрыве»). Под Vitest молчит: фоновый запрос к каналу и запись
 * в досье иначе гоняются с подменой сети и уборкой базы в ЧУЖИХ тестах бота (ship #469: 7 машин красные,
 * «vi.fn() вызван 9 раз»). Сам `ensureContactAvatar` тесты зовут напрямую. Тот же приём, что lib/sms::isDryRun.
 */
export function scheduleContactAvatar(input: Parameters<typeof ensureContactAvatar>[0]): void {
  if (process.env.VITEST && process.env.CONTACT_AVATAR_IN_TESTS !== "1") return;
  void ensureContactAvatar(input).catch(() => undefined);
}

/**
 * Забрать миниатюру собеседника, если её ещё не пробовали брать. Зовётся «в отрыве» (`void`) из входящего
 * сообщения: ответ клиенту от неё не зависит.
 */
export async function ensureContactAvatar(input: {
  profileId: string | null | undefined;
  channel: string;
  subscriberId: string | null | undefined;
  /**
   * НАШ аккаунт, в который написали (несколько Instagram или Страниц). Фото спрашивается ключом ЭТОГО аккаунта:
   * общим ключом из Настроек чужого человека не видно («объект не существует»), и отказ закрыл бы попытку на неделю
   * (и на сутки спрятал бы профиль для разбора имени). Аккаунт выключен или ключа нет: не пробуем и попытку не занимаем.
   */
  accountId?: string | null;
  now?: Date;
}): Promise<EnsureAvatarResult> {
  const { profileId, channel, subscriberId } = input;
  if (!profileId || !subscriberId || !channelHasAvatar(channel)) return "skipped";
  const now = input.now ?? new Date();
  try {
    let token: string | undefined;
    if (input.accountId && (channel === "INSTAGRAM" || channel === "FACEBOOK")) {
      const account = await accountTokenById(input.accountId, channel);
      if (account.disabled || !account.token) return "skipped";
      token = account.token;
    }
    // Занимаем попытку условно: выиграл один из одновременных входящих, остальные пропускают.
    const previous = await prisma.contactProfile.findUnique({ where: { id: profileId }, select: { avatarKey: true } });
    if (!previous) return "skipped";
    const claim = await prisma.contactProfile.updateMany({
      where: {
        id: profileId,
        avatarKey: previous.avatarKey,
        // Нет фото: первая попытка или повтор после отказа через неделю; есть фото: обновление раз в 90 дней.
        OR: previous.avatarKey
          ? [{ avatarFetchedAt: { lt: new Date(now.getTime() - AVATAR_REFRESH_AFTER_MS) } }]
          : [{ avatarFetchedAt: null }, { avatarFetchedAt: { lt: new Date(now.getTime() - AVATAR_RETRY_AFTER_MS) } }],
      },
      data: { avatarFetchedAt: now },
    });
    if (claim.count !== 1) return "skipped";

    const remote = await remoteUrlFor(channel, subscriberId, token);
    if (!remote) return "none";
    const name = await downloadThumb(remote);
    const saved = await prisma.contactProfile.updateMany({ where: { id: profileId, avatarKey: previous.avatarKey }, data: { avatarKey: name } });
    if (saved.count !== 1) {
      // Профиль успели слить или фото уже записали: лишний файл не оставляем.
      await fs.promises.rm(path.join(avatarsDir(), name), { force: true }).catch(() => undefined);
      return "skipped";
    }
    // Обновление: прежнюю миниатюру этого человека не храним (персональные данные).
    if (previous.avatarKey) await fs.promises.rm(path.join(avatarsDir(), previous.avatarKey), { force: true }).catch(() => undefined);
    return "stored";
  } catch (err) {
    const message = describeError(err);
    // Сеть и отказ канала шум (кружок с буквой остаётся); неожиданное (sharp, диск) идёт в журнал.
    if (!/timeout|timed out|таймаут|fetch failed|ECONNRESET|ENOTFOUND|ECONNREFUSED|UND_ERR|HTTP \d{3}/i.test(message)) {
      void logSystemError("api", `Фото собеседника ${profileId} (${channel}): ${message}`, {
        dedupKey: "contact-avatar",
        dedupWindowMs: 6 * 60 * 60_000,
        silent: true,
        quietPult: true,
      });
    }
    return "failed";
  }
}

/**
 * НОЧНАЯ УБОРКА МИНИАТЮР БЕЗ ХОЗЯИНА (ПДн): досье удалили или слили, и файл остался. Стирает файлы папки `avatars`,
 * на которые не ссылается ни одно досье и которым больше суток. Чужие имена (не наш формат) не трогает.
 */
export async function cleanupOrphanContactAvatars(now: Date = new Date()): Promise<{ deleted: number; kept: number }> {
  const dir = avatarsDir();
  const old: string[] = [];
  for (const name of await fs.promises.readdir(dir)) {
    if (!AVATAR_NAME_RE.test(name)) continue;
    const stat = await fs.promises.stat(path.join(dir, name)).catch(() => null);
    if (stat && now.getTime() - stat.mtimeMs > ORPHAN_GRACE_MS) old.push(name);
  }
  const used = new Set<string>();
  for (let i = 0; i < old.length; i += 500) {
    const rows = await prisma.contactProfile.findMany({ where: { avatarKey: { in: old.slice(i, i + 500) } }, select: { avatarKey: true } });
    for (const row of rows) if (row.avatarKey) used.add(row.avatarKey);
  }
  let deleted = 0;
  for (const name of old) {
    if (used.has(name)) continue;
    await fs.promises.rm(path.join(dir, name), { force: true }).then(() => { deleted += 1; }).catch(() => undefined);
  }
  return { deleted, kept: old.length - deleted };
}
