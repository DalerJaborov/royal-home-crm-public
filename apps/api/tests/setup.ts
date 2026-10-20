import "../src/loadEnv.js";
import { pinTestEnv } from "./testEnvPin.js";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, vi } from "vitest";
import { currentWorkerIndex, isParallelDbEnabled, workerDatabaseUrl } from "./dbPerWorker.js";

/**
 * ПРОЦЕСС ПЕРЕКЛЮЧАЕТСЯ НА СВОЮ БАЗУ ДО ПЕРВОГО ИМПОРТА ПРИКЛАДНОГО КОДА.
 *
 * `src/db.ts` создаёт `new PrismaClient()` прямо в теле модуля, а тот читает
 * `DATABASE_URL` один раз, в момент создания. С переходом на Prisma 7 и
 * драйверный адаптер это не изменилось: адрес снимает `new Pool({
 * connectionString })` внутри `PrismaPg`, и ровно в тот же момент.
 *
 * Значит подменить адрес позже — в `beforeAll`, в самом файле теста — уже
 * поздно: клиент будет смотреть в общую базу, и вся затея с изоляцией
 * останется на бумаге, молча.
 *
 * Здесь это самое раннее место, где такая подмена вообще возможна: файл
 * подготовки vitest выполняет ДО файла теста, импорты этого файла (`dotenv`,
 * `vitest`, соседний модуль без побочных действий) до базы не доходят, а
 * прикладной код ниже импортируется только динамически, внутри хуков.
 *
 * СРАБАТЫВАЕТ ТОЛЬКО ПРИ ЗАДАННОМ `VITEST_DB_INDEX`, и это сделано намеренно.
 * Номер процессу выдаёт `runParallel.ts`, он же заранее создаёт базы. Прямой
 * `npx vitest run <файлы>` — тот, которым пользуются `precheck` и человек за
 * клавиатурой, — номера не получает и работает с базой из `DATABASE_URL`, ровно
 * как до всей этой затеи. Копия базы требует, чтобы к шаблону никто не был
 * подключён, и навязывать это требование каждому точечному прогону значило бы
 * ломать его всякий раз, когда рядом поднят свой dev-сервер API.
 *
 * Зачем всё это и как выключить целиком — в `dbPerWorker.ts`.
 */
// Эталон окружения CI: переменные сайта и публичного адреса из локального .env снимаются до
// любого прикладного импорта — иначе четыре теста красят ship при зелёном коде (09.10.2026,
// tests/testEnvPin.ts). Выключить для прогона против своего стенда: TEST_ENV_PIN=0.
pinTestEnv(process.env);
// resetModules can import prismaAdapter -> loadEnv again. The initial load above
// already preserved DB/JWT/encryption; keep later imports from restoring external
// credentials. doMock is registered after that load and survives resetModules.
if (process.env.TEST_ENV_PIN !== "0") vi.doMock("../src/loadEnv.js", () => ({}));

if (isParallelDbEnabled() && process.env.VITEST_DB_INDEX && process.env.DATABASE_URL) {
  /**
   * Исходный адрес запоминается в самом окружении, а не выводится из текущего.
   *
   * Этот файл выполняется ЗАНОВО для каждого файла тестов (изоляция модулей),
   * а `process.env` один на процесс. Подмена «взять текущий и дописать суффикс»
   * на втором файле дала бы `..._w1_w1`, на третьем `..._w1_w1_w1` — и процесс
   * ушёл бы в несуществующую базу. Поэтому суффикс всегда навешивается на
   * ЗАПОМНЕННЫЙ исходный адрес, сколько бы раз сюда ни зашли.
   */
  process.env.VITEST_DB_BASE_URL ??= process.env.DATABASE_URL;
  process.env.DATABASE_URL = workerDatabaseUrl(process.env.VITEST_DB_BASE_URL, currentWorkerIndex());
}

/**
 * СВОЙ КАТАЛОГ ВРЕМЕННЫХ ВИДЕО НА ПРОЦЕСС — ТА ЖЕ ПРИЧИНА, ЧТО У СВОЕЙ БАЗЫ.
 *
 * `src/upload.ts` кладёт принятый ролик в один каталог на всю машину, а
 * `video-handoff.test.ts` проверяет, что после обработки временных файлов не
 * прибавилось, считая файлы во ВСЁМ каталоге. Пока прогон шёл одним процессом,
 * это работало; с переходом на несколько процессов (`runParallel.ts`) соседний
 * шард, загружающий свой ролик в ту же секунду, роняет проверку — и роняет
 * случайно, то есть выглядит как «плавающий тест». Поймано 19.09.2026 полным
 * прогоном: файл красный в пачке и зелёный поодиночке.
 *
 * Задаётся ДО первого импорта прикладного кода — `videoTmpDir` вычисляется в
 * теле модуля, ровно как адрес базы в `src/db.ts`. Номер процесса берётся тот
 * же, что у базы; при точечном прогоне без номера годится pid — он всё равно
 * разведёт тесты и поднятый рядом dev-сервер.
 */
process.env.VIDEO_TMP_DIR ??= path.join(
  os.tmpdir(),
  `royal-home-video-uploads-test-${process.env.VITEST_DB_INDEX ?? process.pid}`
);

/**
 * НАСТРОЙКИ ВОЗВРАЩАЮТСЯ К УМОЛЧАНИЯМ ОДИН РАЗ ЗА ПРОГОН.
 *
 * `Settings` — одна строка на всю базу (`id: "singleton"`), и десятки файлов
 * временно правят её под свой сценарий: лимит активных объектов, лимит лидов,
 * пороги Royal Score, задержки бота. Каждый честно возвращает прежнее значение
 * в `afterEach`/`finally` — пока прогон доходит до этого места.
 *
 * 13.08.2026 не дошёл: прогон оборвался на `Worker exited unexpectedly` ровно
 * тогда, когда `property-active-limit` держал `propertyActiveLimit: 1`.
 * Восстановление не выполнилось, испорченная строка ПЕРЕЖИЛА прогон, и в
 * СЛЕДУЮЩЕМ упал совсем другой файл — создание объекта в
 * `property-moderate-permission` ответило 409 «лимит исчерпан». Третий прогон
 * был чистым: тот же `afterEach` по дороге вернул ноль. Отсюда и «мигание»,
 * из-за которого причину искали в тесте, который ни при чём.
 *
 * Чинится порча МЕЖДУ прогонами — значит и сбрасывать достаточно один раз, в
 * самом начале. Сброс перед каждым файлом был первой попыткой и оказался хуже
 * болезни: он поднимал соединение с базой даже в файлах, которые до неё не
 * доходят, все 190 пулов копились в одном процессе (см. ниже про
 * `max_connections`) и прогон умирал на середине тем же «Worker exited
 * unexpectedly». Защиту между файлами и так держат сами файлы своими
 * `afterEach`.
 *
 * Флаг живёт на `globalThis`, а не в модуле: при `isolate: true` этот файл
 * подготовки выполняется заново для каждого файла тестов, а `globalThis` один
 * на процесс — и `singleFork` даёт ровно один процесс на прогон.
 *
 * Строка удаляется и создаётся заново вместо перечисления полей: их 137, и
 * список разъехался бы со схемой при первой же новой настройке. Сид делает
 * ровно это же (`create: { id: "singleton" }` без единого значения), поэтому
 * «сброшено» и «как после сида» здесь одно и то же. Связей у модели нет —
 * удалять безопасно.
 */
const SETTINGS_RESET_FLAG = "__royalHomeSettingsReset";

beforeAll(async () => {
  const flags = globalThis as Record<string, unknown>;
  if (flags[SETTINGS_RESET_FLAG]) return;

  const { prisma } = await import("../src/db.js");
  // Часть файлов подменяет `../src/db.js` целиком (`vi.mock`) и оставляет в
  // подделке только то, что зовёт сама, — `settings` там нет. Такому файлу и
  // сбрасывать нечего: до настоящей базы он не доходит. Флаг при этом НЕ
  // ставим, иначе сброс потерялся бы совсем, окажись такой файл первым в
  // прогоне. Проверяем наличие, а не ловим исключение: молчаливый `catch`
  // скрыл бы и настоящий отказ базы.
  if (typeof prisma?.settings?.deleteMany !== "function") return;

  await prisma.settings.deleteMany({ where: { id: "singleton" } });
  /**
   * Запись создаётся заново СРАЗУ, со значениями схемы по умолчанию: тесты правят
   * настройки через `settings.update` по id "singleton", и без строки они падают на
   * «запись не найдена» (проверено 14.09.2026 — showing-auto-book.test.ts).
   *
   * Раньше здесь же взводился mandatorySummaryWindowsEnabled: true — чтобы тесты
   * продолжали проверять механизм обязательных окон, пока он стоял на паузе
   * рубильником. Механизм удалён 14.09.2026 (решение владельца), взводить нечего.
   */
  await prisma.settings.create({ data: { id: "singleton" } });
  flags[SETTINGS_RESET_FLAG] = true;
});

/**
 * КРЮЧКИ ТЕЛЕФОНИИ РЕГИСТРИРУЮТСЯ ЗАНОВО НА КАЖДЫЙ ФАЙЛ (аудит циклов
 * 03.09.2026, разрыв telephony/* ↔ services/leads/*).
 *
 * qualifyIncoming.ts/callTracker.ts берут pickAgentForLead/assignAgentForLead+
 * recordAssignReason/rewardFirstCallIfOnTime/liveIncomingByRecordId через крючок
 * (см. lib/telephony/*Hook.ts), а не прямым импортом — иначе цикл. В проде крючок
 * заводят src/index.ts и src/worker.ts один раз при старте; тесты их не поднимают
 * вовсе. Без регистрации здесь крючок молча не делает ничего (заглушка на случай
 * именно теста), и тесты, ожидавшие реального назначения агента через
 * qualifyIncomingCall, ловили null — то же самое случилось повторно 11.09.2026,
 * когда qualifyIncoming.ts перевели с pickAgentForLead на assignAgentForLead, а
 * регистрацию нового крючка в setup.ts забыли добавить.
 *
 * `isolate: true` (vitest.config.ts) даёт каждому файлу свой граф модулей —
 * поэтому регистрация именно в `beforeAll`, не один раз через globalThis-флаг
 * как настройки выше: модуль крючка тоже пересоздаётся на каждый файл, и
 * прошлая регистрация до него не доживает.
 *
 * Файлы, которые подменяют db.js/selection.js/incomingCalls.js/firstCall.js
 * целиком (`vi.mock`), получат СВОИ моки вместо настоящих функций — обычное
 * поведение vi.mock, регистрация лишь передаёт то, что резолвится импортом.
 *
 * ЧАСТИЧНЫЙ МОК incomingCalls.js (ari-alarm.test.ts, ari-events-resilience.test.ts)
 * — Vitest даёт строгому `vi.mock` объект, который бросает исключение на ЧТЕНИИ
 * любого свойства не из явного списка (защита «забыл замокать») — даже
 * `typeof x === "function"` падает, не только деструктуризация. try/catch тут
 * не обход дисциплины «не глотать ошибки молча» (см. сброс настроек выше), а
 * единственный способ отличить «файл не мокал эту функцию» от прочих сбоев,
 * раз сам Vitest не даёт проверить наличие иначе.
 */
async function registerHookIfAvailable<T>(
  loadHookSetter: () => Promise<(fn: T) => void>,
  loadRealFn: () => Promise<T>
): Promise<void> {
  try {
    const [setHook, realFn] = await Promise.all([loadHookSetter(), loadRealFn()]);
    if (typeof realFn === "function") setHook(realFn);
  } catch {
    // Строгий частичный мок этого файла не определяет нужный экспорт —
    // у файла свой мок крючка (или он ему вовсе не нужен), не наша забота.
  }
}

beforeAll(async () => {
  await registerHookIfAvailable(
    async () => (await import("../src/lib/telephony/pickAgentForLeadHook.js")).setPickAgentForLeadHook,
    async () => (await import("../src/services/leads/selection.js")).pickAgentForLead
  );
  await registerHookIfAvailable(
    async () => (await import("../src/lib/telephony/assignAgentForLeadHook.js")).setAssignAgentForLeadHook,
    async () => (await import("../src/services/leads/assignment.js")).assignAgentForLead
  );
  await registerHookIfAvailable(
    async () => (await import("../src/lib/telephony/assignAgentForLeadHook.js")).setRecordAssignReasonHook,
    async () => (await import("../src/services/leads/assignment.js")).recordAssignReason
  );
  await registerHookIfAvailable(
    async () => (await import("../src/lib/telephony/rewardFirstCallHook.js")).setRewardFirstCallHook,
    async () => (await import("../src/services/leads/firstCall.js")).rewardFirstCallIfOnTime
  );
  await registerHookIfAvailable(
    async () => (await import("../src/lib/telephony/liveIncomingLookupHook.js")).setLiveIncomingLookup,
    async () => (await import("../src/lib/telephony/incomingCalls.js")).liveIncomingByRecordId
  );
});

/**
 * Снимок окружения на момент старта файла — чтобы файл не утаскивал соседей.
 *
 * Часть файлов правит `process.env` прямо в теле модуля (например, подставляет
 * заведомо ненастоящие ключи VAPID, раз сам `web-push` замокан). Пока каждый
 * файл жил в отдельном процессе, это никого не задевало. Теперь процесс один на
 * весь прогон, а `process.env` в нём — общий: ненастоящий ключ доживал до
 * следующего файла, и `src/push.ts` при загрузке падал на проверке ключа,
 * унося файл целиком ещё до первого теста.
 *
 * Файл вправе менять окружение как угодно; граница действия правки — сам файл.
 */
/**
 * Тихие часы пушей (21:00–08:00 по Душанбе) выключены на время тестов: иначе
 * ночной прогон откладывает пуш в очередь, и 59 файлов, ждущих немедленной
 * отправки, краснеют по часам, а не по коду (CI на main 13.09 в 21:00).
 * tests/push-quiet-hours.test.ts включает правило обратно у себя.
 */
process.env.PUSH_QUIET_HOURS ??= "off";
const envAtFileStart = { ...process.env };

afterAll(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in envAtFileStart)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(envAtFileStart)) {
    if (process.env[key] !== value) process.env[key] = value;
  }
});

/**
 * Соединения с базой закрываются после КАЖДОГО файла.
 *
 * Раньше это держалось на дисциплине: свой `afterAll` с `$disconnect` был лишь
 * в 81 файле из 178. Пока каждый файл жил в отдельном процессе, забытый вызов
 * ничего не стоил — соединения умирали вместе с процессом. Теперь все файлы
 * делят один процесс, и каждый файл поднимает СВОЙ экземпляр `PrismaClient`
 * (`src/db.ts` пересобирается на каждый файл из-за изоляции модулей). Без явного
 * закрытия их пулы копились бы в одном процессе и упёрлись бы в `max_connections`
 * базы (сейчас 100).
 *
 * Импорт динамический и внутри хука: файлам, которые до базы не доходят, клиент
 * не поднимается вовсе. Повторный `$disconnect` в файлах, где он уже есть,
 * безвреден — Prisma допускает его многократно.
 */
afterAll(async () => {
  const { prisma } = await import("../src/db.js");
  await prisma.$disconnect();
});
