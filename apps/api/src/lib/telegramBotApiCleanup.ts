import fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";
import { TELEGRAM_LOCAL_FILES_DIR } from "../messengers/attachments.js";
import { maskTelegramFilePath } from "../telegram/api.js";
import { logSystemError } from "./systemError.js";

/**
 * УБОРКА ТОМА СВОЕГО BOT API-СЕРВЕРА (24.09.2026, разбор потери ролика монтажёра).
 *
 * Свой сервер Telegram Bot API (`--local`, см. docker-compose.telegram.yml) кладёт
 * каждый скачанный и каждый отправленный файл на диск в `telegram_bot_api_data` и
 * НИКОГДА не чистит его сам — это наша забота, не Telegram. До этой правки том рос
 * без счёта: каждый ролик монтажёра (~80 МБ), каждое фото и голосовое клиента,
 * каждый файл, что бот когда-либо отправлял или получал, — и диск VPS уже был
 * забит на 96% (docs/journal, «чистка анонимных docker-томов»).
 *
 * Основную часть — исходники, скопированные в `uploads/handoff` — удаляет сам
 * `telegram/bot.ts` сразу после успешной копии (см. `isInsideTelegramFilesDir` там
 * же). Этот крон — подстраховка на всё остальное: файлы, что бот скачал/отправил и
 * НЕ копировались никуда (фото клиента, голосовые, отправленные документы), плюс
 * любой исходник ролика, который не удалился сразу (сбой между копией и удалением).
 *
 * ВОЗРАСТ, А НЕ ВЕСЬ ТОМ. Telegram может повторно попросить файл по тому же
 * `file_id` (getFile не перекачивает заново, если файл уже на диске) — снести всё
 * подчистую значило бы заставлять сервер перекачивать заново на каждый чих. Два
 * дня — тот же порядок, что и `RESEND_WINDOW_MS` (lib/videoHandoff.ts, 3 часа) и
 * `STALE_AFTER_MS` (lib/webhookDedupe.ts, 10 минут) с большим запасом: дольше, чем
 * реально нужно кому-либо, чтобы попросить файл повторно.
 */
const MAX_AGE_MS = 2 * 24 * 60 * 60 * 1000;

export interface TelegramBotApiCleanupResult {
  removed: number;
  failed: number;
}

async function walk(dir: string, cutoff: number, result: TelegramBotApiCleanupResult): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    result.failed++;
    console.error(
      `[telegram] уборка тома Bot API: каталог не прочитан (${maskTelegramFilePath(dir)}):`,
      err instanceof Error ? err.message : err
    );
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(full, cutoff, result);
      continue;
    }
    if (!entry.isFile()) continue;
    try {
      const stat = await fs.stat(full);
      if (stat.mtimeMs < cutoff) {
        await fs.rm(full, { force: true });
        result.removed++;
      }
    } catch (err) {
      result.failed++;
      console.error(
        `[telegram] уборка тома Bot API: файл не удалён (${maskTelegramFilePath(full)}):`,
        err instanceof Error ? err.message : err
      );
    }
  }
}

/** Своего сервера нет (`TELEGRAM_LOCAL_FILES_DIR` пусто — облако Telegram) —
 *  чистить нечего, том нам не принадлежит вовсе. Одна строка в журнал на прогон:
 *  сколько удалено, без перечисления путей (путь без маски мог бы содержать токен). */
export async function cleanupTelegramBotApiVolume(): Promise<TelegramBotApiCleanupResult> {
  const result: TelegramBotApiCleanupResult = { removed: 0, failed: 0 };
  if (!TELEGRAM_LOCAL_FILES_DIR) return result;
  const cutoff = Date.now() - MAX_AGE_MS;
  await walk(TELEGRAM_LOCAL_FILES_DIR, cutoff, result);
  if (result.failed > 0) {
    void logSystemError("telegram", `Уборка тома Bot API: ${result.failed} файлов не удалось проверить/удалить`).catch(
      () => {}
    );
  }
  return result;
}
