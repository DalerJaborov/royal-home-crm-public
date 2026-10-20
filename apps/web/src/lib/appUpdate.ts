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
const POLL_INTERVAL_MS = 10_000;

let polling = false;

export function startAppVersionPoll(onStale: () => void): () => void {
  let stopped = false;
  let decided = false;
  let timer: number | undefined;

  function schedule() {
    if (stopped || decided) return;
    window.clearTimeout(timer);
    // Вкладка в фоне — не тикаем: браузер душит фоновые таймеры, а на возврате
    // сработает checkNow и даст более свежий ответ.
    if (typeof document !== "undefined" && document.hidden) return;
    timer = window.setTimeout(check, POLL_INTERVAL_MS);
  }

  async function check() {
    if (stopped || decided) return;
    try {
      const res = await fetch(`/version.json?t=${Date.now()}`, { cache: "no-store" });
      if (res.ok) {
        const data = (await res.json()) as { version?: string };
        if (data.version && data.version !== __APP_VERSION__) {
          decided = true; // дальше не опрашиваем — решение принято
          onStale();
          return;
        }
      }
    } catch {
      // сеть недоступна/CORS/офлайн — не считается «есть обновление», молчим
    }
    schedule();
  }

  function checkNow() {
    if (stopped || decided) return;
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
