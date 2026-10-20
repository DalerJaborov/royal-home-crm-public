import path from "node:path";
import type { Response } from "express";
import { privateFilePath, privateMimeType } from "./privateFiles.js";

/**
 * ОТДАТЬ ФАЙЛ ИЗ ЗАКРЫТОГО ХРАНИЛИЩА — те же заголовки и та же защита пути, что
 * у вложений переписки (routes/attachments.ts) и голосовых заметок
 * (routes/me.ts GET /voice-notes/:name). Право и владение проверяет вызывающий —
 * здесь только безопасная отдача.
 *
 *  - Имя — только наше uuid.ext: privateFilePath отсекает «../» и всё чужое
 *    (там же второй рубеж — сверка каталога после resolve).
 *  - Content-Type — по нашему справочнику расширений, плюс nosniff: браузер не
 *    «угадает» тип и не выполнит файл как разметку.
 *  - private, no-store: файл персональный, общий кэш перед CRM не должен отдать
 *    его тому, кому только что ответили 403.
 *  - root + basename, а не абсолютный путь: send проверяет на «скрытый файл»
 *    каждый сегмент пути, и каталог с точкой в имени дал бы 403 на ровном месте.
 *
 * false — файла нет или имя не наше: вызывающий отвечает 404 сам.
 */
export function sendPrivateFile(res: Response, name: string, logTag: string): boolean {
  const fullPath = privateFilePath(name);
  if (!fullPath) return false;
  res.setHeader("Content-Type", privateMimeType(name));
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Disposition", "inline");
  res.setHeader("Cache-Control", "private, no-store, max-age=0");
  res.sendFile(path.basename(fullPath), { root: path.dirname(fullPath), cacheControl: false, dotfiles: "deny" }, (err) => {
    if (!err) return;
    // Ошибка после начала отдачи — статус менять поздно: закрываем и пишем в
    // журнал, чтобы обрыв не выглядел успехом.
    console.error(`[${logTag}] не удалось отдать файл:`, err instanceof Error ? err.message : err);
    if (res.headersSent) res.end();
    else res.status(500).json({ error: "Не удалось прочитать файл" });
  });
  return true;
}
