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
  const tuned = withSessionSettings(connectionString);
  return new PrismaPg({
    connectionString: tuned,
    ...poolTuning(tuned),
  });
}

/**
 * JIT POSTGRES ВЫКЛЮЧЕН НА КАЖДОМ СОЕДИНЕНИИ ПРИЛОЖЕНИЯ (27.11.2026, «скорость барахлит везде»).
 *
 * Замер на проде (EXPLAIN ANALYZE двух запросов списка «Чатов», 3 157 переписок): исполнение
 * 0,25 + 0,46 с, а JIT-компиляция поверх — 3,6 + 4,1 с (Optimization 2,0–2,2 с, Emission 1,4–1,7 с).
 * Итого 8,4 с на одно открытие «Чатов» вместо 0,76 с. Postgres включает JIT по ОЦЕНКЕ стоимости
 * (jit_above_cost 100 000, оптимизация с 500 000), а оценку раздувают коррелированные подзапросы
 * на строку (EXISTS правил архива и «ждёт человека») — при том что сами таблицы маленькие. JIT
 * окупается на аналитике по миллионам строк; у CRM таких запросов нет, а платили все тяжёлые
 * экраны (пульт, агенты, подбор). Поэтому это класс, и закрыт он в ОДНОЙ двери — здесь, где
 * создаётся каждое соединение (сервер, воркер, сиды, тесты).
 *
 * Как: параметр соединения `options=-c jit=off` (так же, как уже едет `statement_timeout` из
 * docker-compose.prod.yml) — Postgres применяет его при установке соединения, на каждое
 * соединение пула. Свой `-c jit=…` в адресе не перебивается. Вернуть JIT без выката кода:
 * `PG_JIT=on` в окружении (рубильник, по умолчанию выключено).
 */
export function withSessionSettings(connectionString: string, env: NodeJS.ProcessEnv = process.env): string {
  if (!connectionString || env.PG_JIT === "on") return connectionString;
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    return connectionString; // неразбираемый адрес — пусть с внятной ошибкой падает сам драйвер
  }
  const options = url.searchParams.get("options") ?? "";
  if (/(^|\s)-c\s*jit\s*=/.test(options)) return connectionString;
  url.searchParams.set("options", `${options} -c jit=off`.trim());
  return url.toString();
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
