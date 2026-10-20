/**
 * `.env` ЗАГРУЖАЕТСЯ ЗДЕСЬ, ПОТОМУ ЧТО PRISMA 7 ЭТОГО БОЛЬШЕ НЕ ДЕЛАЕТ.
 *
 * До семёрки клиент читал `.env` сам, и на это молча опирались точки входа без
 * своего `dotenv`: оба сида (`prisma/seed.ts`, `prisma/seed-prod.ts`) и все
 * разовые скрипты из `apps/api/scripts`, которые тянут `src/db.ts`. Сервер и
 * фоновый процесс грузят `.env` первой строкой сами, и повторный импорт им
 * ничего не портит: `dotenv` не перекрывает уже заданные переменные — по той же
 * причине не ломается и подмена `DATABASE_URL` в `tests/setup.ts`.
 *
 * Через `./loadEnv.js`, а не `dotenv/config`: с dotenv 17 у опции `quiet`
 * умолчание сменилось на `false`, и прямой импорт печатал бы «injecting env…»
 * при каждом старте. Единая точка входа для dotenv в apps/api — один модуль.
 */
import "../loadEnv.js";
import { PrismaPg } from "@prisma/adapter-pg";

/**
 * ОДНА ТОЧКА СОЗДАНИЯ ДРАЙВЕРНОГО АДАПТЕРА (переход на Prisma 7, 14.09.2026).
 *
 * В Prisma 7 встроенный движок с собственным пулом убран: клиент ходит в базу
 * через `pg`, и пул теперь настраивается не строкой подключения, а объектом.
 * Мест создания клиента у нас четыре (сервер, два сида, подготовка баз для
 * тестов), и разъехавшиеся настройки пула — это ровно тот класс поломок,
 * который замечают только на проде в час пик.
 *
 * ЧТО ЗДЕСЬ ВОССТАНАВЛИВАЕТСЯ РУКАМИ И ПОЧЕМУ.
 *
 * 1. `connection_limit` в адресе базы. До 7 его читал движок Prisma; `pg` про
 *    такой параметр не знает и молча взял бы свой предел в 10 соединений.
 *    В `docker-compose.prod.yml` стоит `connection_limit=15` (аудит №4, 27.08:
 *    `src/db.ts` брал ВТОРОЕ соединение на чтение «до» при правке статуса, и
 *    при узком пуле это путь к взаимной блокировке; с 24.09.2026 внутри
 *    транзакции чтение идёт её же соединением, №78), а `tests/dbPerWorker.ts`
 *    ставит 10 на процесс, чтобы четыре процесса не выбрали `max_connections`
 *    целиком. Обе настройки осмысленные, и обе нужно перенести в пул `pg`.
 *
 * 2. Таймауты. Умолчания `pg` отличаются от прежних умолчаний Prisma:
 *    ожидание нового соединения 0 (без предела) против 5 секунд и простой
 *    10 секунд против 300. Оба изменения меняют поведение под нагрузкой, а
 *    задача обновления — не менять поведение, поэтому прежние значения заданы
 *    явно. `pool_timeout=20` из боевого адреса — это ожидание соединения ИЗ
 *    пула, у `pg` за это отвечает тот же `connectionTimeoutMillis`.
 */
export function makePrismaAdapter(connectionString: string): PrismaPg {
  return new PrismaPg({
    connectionString,
    ...poolTuning(connectionString),
  });
}

/** `connection_limit`/`pool_timeout` из адреса — в понятия пула `pg`. */
function poolTuning(connectionString: string): { max?: number; connectionTimeoutMillis: number; idleTimeoutMillis: number } {
  let max: number | undefined;
  let connectSeconds = 5;
  try {
    const params = new URL(connectionString).searchParams;
    const limit = Number(params.get("connection_limit"));
    if (Number.isInteger(limit) && limit > 0) max = limit;
    const poolTimeout = Number(params.get("pool_timeout"));
    if (Number.isFinite(poolTimeout) && poolTimeout > 0) connectSeconds = poolTimeout;
  } catch {
    /* неразбираемый адрес — пусть падает сам драйвер, с внятным сообщением */
  }
  return { max, connectionTimeoutMillis: connectSeconds * 1000, idleTimeoutMillis: 300_000 };
}
