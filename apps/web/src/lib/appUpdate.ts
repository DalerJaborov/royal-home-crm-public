/**
 * Третий (и самый независимый) сигнал «вышла новая версия» — рядом с service
 * worker и X-App-Build (appVersion.ts). Опрашивает `/version.json`, который
 * кладёт vite.config.ts при сборке (см. `versionJsonPlugin`), и сравнивает
 * поле `version` (GIT_SHA выката) с тем, что вклеено в текущую вкладку через
 * `__APP_VERSION__`. В отличие от X-App-Build (обновляется только когда человек
 * делает хоть один запрос к API) этот сигнал не ждёт действия — сам ходит за
 * файлом, который CDN/Caddy обязаны отдавать без кэша (то же правило, что у
 * index.html, см. apps/web/nginx.conf). И это единственный из трёх, который
 * вообще ходит в сеть без входа — работает и на /login.
 *
 * ЧТО ИЗМЕНИЛОСЬ 10.09.2026 (владелец: «обновление должно происходить само и
 * моментально»):
 *
 *  - интервал 30 с → 10 с. Файл весит десятки байт и отдаётся статикой; шесть
 *    запросов в минуту на вкладку дешевле, чем полминуты работы на старой
 *    сборке;
 *  - возврат во вкладку (`visibilitychange`) и восстановление сети (`online`)
 *    проверяют немедленно, не дожидаясь очередного тика. Установленное на
 *    телефоне приложение почти всегда возвращается из фона, а не открывается
 *    заново — без этого оно узнавало о новой сборке последним;
 *  - пока вкладка в фоне, опрос не тикает вовсе: браузер всё равно душит там
 *    таймеры, а проверка на возврате даёт более свежий ответ, чем разбуженный
 *    таймер.
 */
import { acknowledgeServerBuild, onServerBuildStale } from "./appVersion";

const POLL_INTERVAL_MS = 10_000;

let polling = false;

function tabVersion(): string {
  return typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : "";
}

/**
 * ОТВЕТЫ version.json ПРИМЕНЯЮТСЯ ТОЛЬКО ПО ПОРЯДКУ (21.11.2026, ревью #380). На несколько
 * перезапусков API подряд и на опрос уходят несколько запросов; ответ на ранний может прийти
 * позже ответа на поздний и откатить цель v3 → v2. Номер запроса общий на оба канала: ответ
 * старше уже применённого отбрасывается.
 */
let issuedSeq = 0;
let appliedSeq = 0;

/** Только для тестов: обнулить счёт запросов. */
export function resetSiteVersionOrderForTests(): void {
  issuedSeq = 0;
  appliedSeq = 0;
}

/** Спросить версию сайта и отдать её, только если более свежий ответ ещё не применён. */
async function latestSiteVersion(fetchVersion: () => Promise<string | null>): Promise<string | null> {
  const seq = ++issuedSeq;
  const version = await fetchVersion();
  if (seq < appliedSeq) return null; // устаревший ответ: позже отправленный уже пришёл
  if (version) appliedSeq = seq;
  return version;
}

/** Версия сайта на сервере из `/version.json`; null — не узнали (сеть, ошибка ответа). */
export async function fetchSiteVersion(fetchImpl: typeof fetch = fetch): Promise<string | null> {
  try {
    const res = await fetchImpl(`/version.json?t=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) return null;
    const data = (await res.json()) as { version?: string };
    return data.version || null;
  } catch {
    return null;
  }
}

/**
 * КАНАЛ X-App-Build — ТОЛЬКО ПОВОД СПРОСИТЬ version.json (21.11.2026, ревью #380).
 *
 * Заголовок — время запуска процесса API (apps/api/src/app.ts), а не версия сайта.
 * Выкат одного сервера (ops/auto-deploy.sh пересобирает только api/worker, если сайт
 * не тронут) раньше сразу ставил «вышла новая версия»: вкладка тратила попытку
 * лестницы на перезагрузку в ту же сборку, а после трёх таких выкатов подряд
 * (14–15.11 их было по пять) глохла насовсем и не обновлялась уже никогда. Теперь
 * сигнал только запускает сверку с version.json; версия сайта та же — заголовок
 * принимается новой точкой отсчёта, попытка не тратится.
 */
export function startServerBuildWatch(
  onStale: (siteVersion: string) => void,
  deps: { fetchVersion?: () => Promise<string | null>; currentVersion?: string } = {},
): () => void {
  const fetchVersion = deps.fetchVersion ?? (() => fetchSiteVersion());
  const current = deps.currentVersion ?? tabVersion();
  let stopped = false;
  const off = onServerBuildStale(() => {
    acknowledgeServerBuild();
    void latestSiteVersion(fetchVersion).then((siteVersion) => {
      if (!stopped && siteVersion && siteVersion !== current) onStale(siteVersion);
    });
  });
  return () => {
    stopped = true;
    off();
  };
}

/**
 * Опрос version.json. С 21.11.2026 не останавливается после первого расхождения:
 * вкладка, у которой лестница обновления сдалась, должна узнать о СЛЕДУЮЩЕЙ версии
 * сайта и попробовать снова (appUpdateReload.ts, isUpdateLoopSuppressed). Повторы одной и
 * той же версии гасит стор (store/appUpdate.ts, noteSiteVersion).
 */
export function startAppVersionPoll(
  onStale: (siteVersion: string) => void,
  deps: { fetchVersion?: () => Promise<string | null> } = {},
): () => void {
  const fetchVersion = deps.fetchVersion ?? (() => fetchSiteVersion());
  let stopped = false;
  let timer: number | undefined;

  function schedule() {
    if (stopped) return;
    window.clearTimeout(timer);
    // Вкладка в фоне — не тикаем: браузер душит фоновые таймеры, а на возврате
    // сработает checkNow и даст более свежий ответ.
    if (typeof document !== "undefined" && document.hidden) return;
    timer = window.setTimeout(check, POLL_INTERVAL_MS);
  }

  async function check() {
    if (stopped) return;
    // сеть недоступна/CORS/офлайн — null, не считается «есть обновление»
    const siteVersion = await latestSiteVersion(fetchVersion);
    if (!stopped && siteVersion && siteVersion !== tabVersion()) onStale(siteVersion);
    schedule();
  }

  function checkNow() {
    if (stopped) return;
    window.clearTimeout(timer);
    void check();
  }

  function onVisibility() {
    if (!document.hidden) checkNow();
  }

  // Второй раз в той же вкладке опрос не заводим (StrictMode монтирует эффекты
  // дважды), но подписки всё равно снимаем корректно — отсюда общий return.
  const owns = !polling;
  if (owns) {
    polling = true;
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("online", checkNow);
    void check();
  }

  return () => {
    stopped = true;
    if (!owns) return;
    polling = false;
    window.clearTimeout(timer);
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("online", checkNow);
  };
}
