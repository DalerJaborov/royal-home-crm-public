import type { NextFunction, Request, Response } from "express";
import { requestPultSnapshot } from "./pultCacheHook.js";

/**
 * ЛЮБОЕ ДЕЙСТВИЕ СОТРУДНИКА ОБНОВЛЯЕТ ПУЛЬТ (23.10.2026).
 *
 * Пульт директора решает дела на месте: «разобрать ошибки», «скрыть
 * комментарий», «повторить ролик», «принято» и ещё два десятка кнопок, и у
 * каждой свой роут. Найдено на стенде: «Разобрать все» вернуло `resolved: 3`,
 * а строка «3 ошибки» вернулась через секунду — зона пульта лежала в кэше
 * 60 с, а роут ошибок о кэше не знает. Звать сброс из каждого роута — тот же
 * класс забытого места при следующей кнопке, поэтому сброс один на все записи.
 *
 * После успешной записи (не GET, ответ 2xx) вошедшего сотрудника — сброс кэша
 * секций и троттлированный `pult.snapshot` (не чаще раза в 5 с на процесс,
 * lib/livePublish.ts): открытые пульты других директоров тоже обновятся.
 * Служебные записи, которые идут фоном сами по себе, не в счёт.
 */
const IGNORED_PREFIXES = ["/api/v1/_seen", "/api/v1/events", "/api/v1/auth", "/api/v1/properties/drafts"];

export function isPultRelevantWrite(method: string, path: string, status: number, signedIn: boolean): boolean {
  if (!signedIn || status < 200 || status >= 300) return false;
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return false;
  return !IGNORED_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

export function pultWriteRefresh(req: Request, res: Response, next: NextFunction): void {
  res.on("finish", () => {
    if (isPultRelevantWrite(req.method, req.originalUrl.split("?")[0] ?? "", res.statusCode, !!req.agent)) requestPultSnapshot();
  });
  next();
}
