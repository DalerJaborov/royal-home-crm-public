import type { RequestHandler } from "express";
import type { ParamsFlatDictionary } from "express-serve-static-core";

/**
 * СНЯТЬ С ЧУЖОГО MIDDLEWARE ПРИВЯЗКУ К ФОРМЕ `req.params` (Express 5).
 *
 * В `@types/express` 5 `ParamsDictionary` стал `string | string[]`: значение
 * шаблона-звёздочки (`/*splat`) приезжает массивом сегментов. Наши роуты
 * звёздочку не используют нигде, кроме `routes/mediaProxy.ts`, где массив
 * разбирается руками, — но TypeScript выводит форму `req.params` СРАЗУ ДЛЯ ВСЕЙ
 * цепочки обработчиков. Стоит поставить перед роутом чужое middleware,
 * типизированное жёстким `RequestHandler` (multer `upload.single(...)`,
 * `express-rate-limit`), — и вывод по строке пути («/:id» → `{ id: string }`)
 * проигрывает ему: `req.params.id` во ВСЁМ роуте становится `string | string[]`,
 * и дальше не годится ни в Prisma, ни в собственные функции.
 *
 * Свои middleware от этого избавлены иначе — они объявлены обобщёнными по `P`
 * (`requireAuth<P>`, `requirePermission`, `requireElevation` и соседи), и тогда
 * `P` выводится из строки пути, как и должно. Для чужих остаётся эта обёртка:
 * она ничего не делает во время выполнения и только перестаёт навязывать `P`.
 */
export function anyParams<P = ParamsFlatDictionary>(handler: RequestHandler): RequestHandler<P> {
  return handler as unknown as RequestHandler<P>;
}
