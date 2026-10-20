import type { NextFunction, Request, Response } from "express";
import { signMediaToken } from "../auth/jwt.js";

/**
 * Подписывает ОТНОСИТЕЛЬНЫЕ ссылки на закрытые подкаталоги `/uploads` прямо в
 * исходящем JSON (К11, аудит безопасности 11.09.2026).
 *
 * `lib/crmPublicUrl.ts::publicUploadUrl` закрывает ту же дыру для АБСОЛЮТНЫХ
 * ссылок, которые CRM сама отправляет наружу (Meta, сайт) — но `clipVideoUrl`
 * объекта уходит фронтенду СВОИМ путём: как обычное поле JSON-ответа
 * (GET объекта, список, публичная страница показа `routes/propertyShare.ts`),
 * относительным путём, без похода через `publicUploadUrl`. Мест, откуда
 * `Property.clipVideoUrl` попадает в ответ, много (карточка, список, кухня,
 * публичный показ), и охотиться за каждым — тот самый класс дыр «починил в
 * одном месте — забыл про остальные», уже стоивший репозиторию нескольких
 * находок. Поэтому здесь ОДНА точка: middleware переписывает `res.json`
 * ГЛОБАЛЬНО, до всех роутеров, и подписывает любую строку вида
 * `/uploads/video/...`, `/uploads/automontage/...`, `/uploads/handoff/...` —
 * где бы она ни оказалась в ответе.
 *
 * Фото объектов (и всё остальное под `/uploads`) не трогаем: они как были
 * открыты статикой, так и остаются — незачем подписывать то, что и так публично
 * на сайте.
 */
const SIGNED_PATH_RE = /^\/uploads\/(?:video|automontage|handoff)\/[^?]+/;

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function signMediaUrlsDeep(value: unknown, depth = 0): unknown {
  // Предохранитель на глубину: обычный ответ API — плоский объект/список в пару
  // уровней, а не дерево без дна; если он вдруг окажется глубже, дальше просто
  // не подписываем, но и не зависаем.
  if (depth > 12) return value;
  if (typeof value === "string") {
    return SIGNED_PATH_RE.test(value) ? `${value}?t=${signMediaToken(value)}` : value;
  }
  if (Array.isArray(value)) return value.map((item) => signMediaUrlsDeep(item, depth + 1));
  if (value instanceof Date) return value;
  // Спускаемся ТОЛЬКО в простые объекты. Экземпляры классов (Prisma Decimal,
  // Buffer и т.п.) отдаём как есть: у них свой toJSON, а копирование через
  // Object.entries его теряет — 11.09.2026 из-за этого commissionAmount сделки
  // уезжал фронту как {} и читался NaN. Ссылок на медиа внутри них не бывает.
  if (value && typeof value === "object" && !isPlainObject(value)) return value;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = signMediaUrlsDeep(item, depth + 1);
    }
    return out;
  }
  return value;
}

export function signMediaUrlsInResponses(_req: Request, res: Response, next: NextFunction): void {
  const originalJson = res.json.bind(res);
  res.json = ((body: unknown) => originalJson(signMediaUrlsDeep(body))) as typeof res.json;
  next();
}
