import { Prisma } from "../generated/prisma/client.js";

/**
 * ПОСЛЕДНЯЯ РЕПЛИКА ПЕРЕПИСКИ В SQL — ОДНИМ ЧТЕНИЕМ ПОЛЯ (27.11.2026, «чаты грузятся по 5 секунд»).
 *
 * Переписка лежит одним jsonb-полем `messages` (в среднем 1,8 КБ сжатыми на проде, до 10 КБ), и
 * Postgres хранит его отдельно (TOAST): КАЖДОЕ упоминание поля в выражении заново достаёт и
 * распаковывает его. Прежняя запись `CASE WHEN jsonb_typeof(c.messages) = 'array' THEN c.messages -> -1
 * ELSE NULL END` упоминает поле дважды, а рядом стояла такая же пара для длины — четыре распаковки
 * на строку. Замер на проде (3 157 переписок, JIT выключен): 376 мс на проход против 94 мс у этого
 * выражения; список «Чатов» делал два таких прохода на каждое открытие.
 *
 * Смысл тот же, что у прежнего CASE: у массива — последний элемент, у пустого массива, объекта,
 * строки, числа и NULL — NULL (режим `strict` и `silent = true`: несовпадение типа не ошибка).
 * Обычный `-> -1` так не умеет: у строки он вернул бы саму строку. Сверка всех случаев —
 * `tests/last-message-sql.test.ts`.
 */
export function lastMessageSql(messages: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`jsonb_path_query_first(${messages}, 'strict $[last]', '{}'::jsonb, true)`;
}

/** Число реплик (0 у не-массива) — для строк ОДНОЙ страницы, не для всей выборки: тоже распаковка. */
export function messagesCountSql(messages: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`(CASE WHEN jsonb_typeof(${messages}) = 'array' THEN jsonb_array_length(${messages}) ELSE 0 END)`;
}
