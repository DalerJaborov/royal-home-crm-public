import type { NextFunction, Request, Response } from "express";

/**
 * ПОТОЛОК ПАМЯТИ НА ЗАГРУЗКИ В ОПЕРАТИВНУЮ ПАМЯТЬ (аудит 23.09.2026, круг 3).
 *
 * Фото, аватары и голос multer держит целиком в памяти процесса
 * (`memoryStorage`, upload.ts). Лимиты multer — на ФАЙЛ (30 МБ × 30 файлов =
 * 900 МБ на один запрос), а контейнер API живёт в 768 МБ: один большой запрос
 * или несколько средних разом роняли весь API — CRM, вебхуки и бота сразу.
 *
 * Решаем ДО multer, по заголовку Content-Length, ничего не читая:
 * - запрос больше `maxRequestBytes` — 413 сразу (сайт шлёт фото пачками до
 *   ~8 МБ, одиночный файл до 30 МБ, так что 64 МБ — с запасом);
 * - без Content-Length — 411: браузер его всегда ставит, а потоковую
 *   загрузку неизвестной длины в память принимать нельзя;
 * - сумма идущих сейчас загрузок выше `maxInFlightBytes` — 503 с Retry-After:
 *   очередь загрузок сайта повторяет 5xx сама (web: lib/uploadQueue.ts), так
 *   что снимки не теряются, а просто ждут своей очереди.
 */
export function createMemoryUploadBudget(opts: { maxRequestBytes: number; maxInFlightBytes: number }) {
  let inFlight = 0;
  const middleware = (req: Request, res: Response, next: NextFunction) => {
    const header = req.headers["content-length"];
    const length = header === undefined ? NaN : Number(header);
    if (!Number.isFinite(length) || length < 0) {
      return res.status(411).json({ error: "Не указан размер загрузки" });
    }
    if (length > opts.maxRequestBytes) {
      return res.status(413).json({ error: "Слишком большая загрузка — отправьте файлы меньшими частями" });
    }
    if (inFlight > 0 && inFlight + length > opts.maxInFlightBytes) {
      res.setHeader("Retry-After", "5");
      return res.status(503).json({ error: "Сервер занят другими загрузками — повторим через несколько секунд" });
    }
    inFlight += length;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      inFlight -= length;
    };
    res.on("finish", release);
    res.on("close", release);
    next();
  };
  return Object.assign(middleware, { inFlightBytes: () => inFlight });
}

const MB = 1024 * 1024;

/** Общий на процесс: все маршруты, которые кладут файлы в память, делят один бюджет. */
export const memoryUploadBudget = createMemoryUploadBudget({ maxRequestBytes: 64 * MB, maxInFlightBytes: 192 * MB });
