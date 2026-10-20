/**
 * Применение обновления вкладки — и защита от вечной петли «Обновляю Royal Home…».
 *
 * ПОЧЕМУ ЭТО ОТДЕЛЬНЫЙ МОДУЛЬ (09.09.2026, жалоба владельца: «открываю CRM —
 * экран обновления, процент быстро доходит до 100 и всё начинается заново»).
 *
 * Сигнал «вышла новая версия» приходит из трёх мест (см. UpdatePrompt.tsx), но
 * применялся он одинаково: `window.location.reload()`. Для сигнала /version.json
 * это неверно, когда страницей управляет service worker: `NavigationRoute` в
 * sw.ts отдаёт ПРЕКЕШИРОВАННЫЙ index.html старой сборки, то есть перезагрузка
 * возвращает ту же самую версию. Дальше цикл замыкается сам:
 *
 *   загрузка старой сборки → опрос /version.json (сразу, без задержки) → версия
 *   не совпала → оверлей → 100 % за секунду (файлы новой сборки уже в кэше
 *   браузера, их прогрел прошлый проход) → reload → старый index.html из
 *   прекеша → …
 *
 * Причём каждый такой круг ещё и УБИВАЕТ единственный выход: новый воркер
 * успевает начать установку (а она качает весь прекеш — десятки файлов), но
 * перезагрузка через ~2 секунды сбрасывает её, `needRefresh` не наступает
 * никогда, и «правильная» ветка (SKIP_WAITING → controllerchange) не включается.
 *
 * ЧТО ДЕЛАЕМ. Три ступени, каждая следующая — только если предыдущая не
 * сработала (счётчик живёт в sessionStorage и переживает перезагрузку, но не
 * вкладку):
 *
 *   1) дать воркеру шанс: `registration.update()` и ожидание ждущего воркера до
 *      WAIT_FOR_WORKER_MS — если он появился, обновляемся штатным путём;
 *   2) жёсткий выход: снять регистрацию воркера, вычистить кэши сборки и уйти
 *      на тот же путь с новым параметром `?rh-update=<время>` — мимо и воркера,
 *      и HTTP-кэша, и bfcache (см. buildFreshUrl);
 *   3) сдаться тихо: после MAX_ATTEMPTS кругов оверлей для этой версии больше не
 *      показываем — пусть человек работает на старой сборке, чем смотрит на
 *      бесконечную заставку. Факт уходит в журнал ошибок (errorReporter слушает
 *      window "error").
 */
const ATTEMPTS_KEY = "rh:update-attempts";
const MAX_ATTEMPTS = 3;
const WAIT_FOR_WORKER_MS = 8_000;
const WORKER_POLL_MS = 300;

/** Кэш загруженных пользователем файлов — единственный, который не трогаем при
 *  жёстком выходе: он не относится к сборке, а весит десятки мегабайт. */
const KEEP_CACHE = "uploads-cache";

interface AttemptRecord {
  /** Версия сборки, из которой пытались обновиться. */
  from: string;
  /** Сколько раз уже пытались уйти именно с неё. */
  count: number;
}

function readAttempts(): AttemptRecord | null {
  try {
    const raw = sessionStorage.getItem(ATTEMPTS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<AttemptRecord>;
    if (typeof parsed?.from !== "string" || typeof parsed?.count !== "number") return null;
    return { from: parsed.from, count: parsed.count };
  } catch {
    // приватный режим/переполненное хранилище — считаем, что попыток не было
    return null;
  }
}

function writeAttempts(record: AttemptRecord): void {
  try {
    sessionStorage.setItem(ATTEMPTS_KEY, JSON.stringify(record));
  } catch {
    // не смогли запомнить — защита от петли выключается, но работа продолжается
  }
}

export function clearUpdateAttempts(): void {
  try {
    sessionStorage.removeItem(ATTEMPTS_KEY);
  } catch {
    /* см. writeAttempts */
  }
}

/**
 * Вызывается при старте вкладки: если версия сборки изменилась — обновление
 * применилось, счётчик попыток больше не про нас.
 */
export function resetAttemptsIfUpdated(currentVersion: string): void {
  const record = readAttempts();
  if (record && record.from !== currentVersion) clearUpdateAttempts();
}

/** Номер текущей попытки (1 — первая) для данной версии сборки. */
export function noteUpdateAttempt(currentVersion: string): number {
  const record = readAttempts();
  const count = record && record.from === currentVersion ? record.count + 1 : 1;
  writeAttempts({ from: currentVersion, count });
  return count;
}

/**
 * Перезагрузка уже не помогала MAX_ATTEMPTS раз подряд — оверлей для этой версии
 * не показываем совсем.
 */
export function isUpdateLoopSuppressed(currentVersion: string): boolean {
  const record = readAttempts();
  return !!record && record.from === currentVersion && record.count >= MAX_ATTEMPTS;
}

/**
 * Ждущий воркер — тот, кого можно активировать сообщением SKIP_WAITING.
 * Экспортируется: тем же ожиданием пользуется lazyWithReload.ts (там
 * `registration.update()` без ожидания заставал воркера ещё в installing, и
 * SKIP_WAITING уходил в пустоту — перезагрузка возвращала ту же оболочку).
 */
export async function waitForWaitingWorker(timeoutMs = WAIT_FOR_WORKER_MS): Promise<boolean> {
  if (!("serviceWorker" in navigator)) return false;
  let registration: ServiceWorkerRegistration | undefined;
  try {
    registration = await navigator.serviceWorker.getRegistration();
  } catch {
    return false;
  }
  if (!registration) return false;
  if (registration.waiting) return true;
  try {
    await registration.update();
  } catch {
    // сеть/CORS — дальше просто ждём: воркер мог начать установку и раньше
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (registration.waiting) return true;
    await new Promise((resolve) => setTimeout(resolve, WORKER_POLL_MS));
  }
  return false;
}

/**
 * Снять воркер и кэши сборки. После этого страница остаётся без офлайн-режима
 * ровно до следующей загрузки: registerSW регистрирует воркер заново сам.
 */
export async function dropServiceWorkerAndCaches(): Promise<void> {
  try {
    if ("serviceWorker" in navigator) {
      const registrations = await navigator.serviceWorker.getRegistrations();
      await Promise.all(registrations.map((r) => r.unregister().catch(() => false)));
    }
  } catch {
    /* воркера могло и не быть — не мешает перезагрузке */
  }
  try {
    if ("caches" in window) {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== KEEP_CACHE).map((k) => caches.delete(k).catch(() => false)));
    }
  } catch {
    /* см. выше */
  }
}

/**
 * ТЕЛЕМЕТРИЯ СДАЧИ (13.09.2026).
 *
 * Две записи в журнале 11.09 («2 попыток подряд остались на сборке 6c4e5a31» и
 * то же на c8c90ed0) разобрать было НЕЧЕМ: в сообщении не было ни одного факта
 * об устройстве, кроме версии сборки. Пришлось доказывать по датам коммитов, что
 * это вообще не сдача, а вторая ступень лестницы, доложенная старым кодом.
 * Чтобы следующая запись приходила с диагнозом, собираем дешёвый снимок среды.
 *
 * Всё под таймаутом и без единого throw: диагностика не имеет права помешать
 * самому обновлению. Уходит в поле `stack` события (errorReporter читает
 * `e.error.stack`), а НЕ в message: message — ключ дедупликации на 200 символов,
 * и переменные заголовки в нём ломали бы защиту от потока одинаковых репортов.
 */
const DIAGNOSTICS_TIMEOUT_MS = 3_000;

async function collectUpdateDiagnostics(currentVersion: string): Promise<string> {
  const facts: string[] = [`сборка вкладки=${currentVersion}`];

  const safe = <T>(label: string, read: () => T): void => {
    try {
      facts.push(`${label}=${String(read())}`);
    } catch {
      facts.push(`${label}=?`);
    }
  };

  // Установленное приложение на телефоне ведёт себя иначе, чем вкладка: у него
  // свой HTTP-кэш и своя история — первое, что нужно знать о сдавшемся клиенте.
  safe("standalone", () =>
    typeof matchMedia === "function" ? matchMedia("(display-mode: standalone)").matches : "нет matchMedia"
  );
  safe("controller", () => !!navigator.serviceWorker?.controller);
  safe("online", () => navigator.onLine);
  safe("путь", () => window.location.pathname);

  try {
    const registrations = (await navigator.serviceWorker?.getRegistrations()) ?? [];
    facts.push(
      `воркеры=${registrations
        .map((r) => `[активен:${!!r.active} ждёт:${!!r.waiting} ставится:${!!r.installing}]`)
        .join(",") || "нет"}`
    );
  } catch {
    facts.push("воркеры=?");
  }

  try {
    facts.push(`кэши=${"caches" in window ? (await caches.keys()).join(",") || "нет" : "нет API"}`);
  } catch {
    facts.push("кэши=?");
  }

  // Главный вопрос сдачи: а сервер-то отдаёт новую сборку — и не из кэша ли
  // Cloudflare? `cf-cache-status`/`age` отвечают на это одной строкой.
  try {
    const res = await Promise.race([
      fetch(`/version.json?t=${Date.now()}`, { cache: "no-store" }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("таймаут")), DIAGNOSTICS_TIMEOUT_MS)
      ),
    ]);
    const body = (await res.json().catch(() => ({}))) as { version?: string };
    facts.push(
      `version.json: сборка сервера=${body.version ?? "?"}`,
      `cf-cache-status=${res.headers.get("cf-cache-status") ?? "нет"}`,
      `age=${res.headers.get("age") ?? "нет"}`,
      `cache-control=${res.headers.get("cache-control") ?? "нет"}`
    );
  } catch (error) {
    facts.push(`version.json=недоступен (${error instanceof Error ? error.message : "ошибка"})`);
  }

  return facts.join("\n");
}

/**
 * Вторая ступень лестницы — жёсткий сброс. Он ЛЕЧИТ ситуацию и почти всегда
 * срабатывает, поэтому в журнал ошибок не уходит (11.09.2026: иначе «Здоровье
 * системы» и утреннее уведомление директору каждый день несли «поймано N
 * ошибок» на штатной работе механизма). Остаётся в консоли вкладки.
 *
 * ТЕКСТ НАРОЧНО ОТЛИЧАЕТСЯ ОТ ТЕКСТА СДАЧИ (13.09.2026). Раньше обе ступени
 * писали одну и ту же фразу «N попыток подряд остались на сборке», и запись из
 * журнала невозможно было отличить от записи из консоли: разбор 13.09 начался с
 * предположения, что «2 попыток» — это сдача, хотя сдача наступает только на
 * четвёртой. Разные слова стоят ноль и экономят час.
 */
function reportHardReset(currentVersion: string, attempt: number): void {
  console.error(
    `[update] Жёсткий сброс воркера и кэшей (ступень 2, попытка ${attempt}) на сборке ${currentVersion}`
  );
}

/** Лестница кончилась, обновление так и не применилось — это настоящая поломка. */
function reportGiveUp(currentVersion: string, attempt: number): void {
  // attempt - 1: сама сдача попыткой не была, она лишь подвела итог сделанным.
  const message = `[update] Сдача: обновление не применилось за ${attempt - 1} попытки подряд, вкладка осталась на сборке ${currentVersion}`;
  console.error(message);
  // errorReporter слушает window "error" — факт попадёт в «Здоровье системы»,
  // а не только в консоль вкладки, до которой никто не доберётся.
  if (typeof ErrorEvent === "undefined") return;
  void collectUpdateDiagnostics(currentVersion)
    .catch(() => "диагностика не собралась")
    .then((details) => {
      const carrier = new Error(details);
      window.dispatchEvent(new ErrorEvent("error", { message, error: carrier }));
    });
}

export interface ApplyUpdateOptions {
  /** Есть ждущий воркер по данным useRegisterSW (сигнал service worker). */
  needRefresh: boolean;
  /** updateServiceWorker(true) из useRegisterSW: SKIP_WAITING + перезагрузка. */
  updateServiceWorker: (reloadPage?: boolean) => Promise<void>;
  currentVersion: string;
  /** Подменяется в тестах — в браузере это window.location.reload. */
  reload?: () => void;
  /** Уход после жёсткого сброса. Подменяется в тестах, см. hardNavigate. */
  navigateFresh?: (url: string) => void;
}

/**
 * УХОД ПОСЛЕ ЖЁСТКОГО СБРОСА — НЕ reload(), А ПЕРЕХОД НА НОВЫЙ АДРЕС
 * (13.09.2026).
 *
 * `location.reload()` — это перезагрузка ТОГО ЖЕ адреса, и у неё остаётся два
 * пути вернуть старую оболочку даже после того, как воркер снят, а кэши сборки
 * вычищены: HTTP-кэш браузера (index.html приходит с `no-cache`, то есть
 * храниться ему можно — нельзя лишь отдавать без перепроверки, а перепроверка
 * требует сети, которой на телефоне в этот момент может и не быть) и снятая с
 * паузы страница из bfcache. Адрес с новым параметром не совпадает ни с одной
 * записью кэша, поэтому ответ приходит только из сети.
 *
 * `replace`, а не `assign`: лишняя запись в истории заставила бы «назад»
 * возвращать человека в старую сборку.
 */
const CACHE_BUST_PARAM = "rh-update";

export function buildFreshUrl(location: { pathname: string; search: string; hash: string }): string {
  const params = new URLSearchParams(location.search);
  params.set(CACHE_BUST_PARAM, String(Date.now()));
  return `${location.pathname}?${params.toString()}${location.hash}`;
}

function hardNavigate(url: string): void {
  window.location.replace(url);
}

/**
 * Метка обхода кэша своё дело сделала в момент запроса — в адресной строке ей
 * делать нечего: человек копирует ссылку на раздел и отдаёт её коллеге. Чистим
 * через replaceState, чтобы не заводить ещё одну запись в истории.
 */
export function stripFreshMarker(): void {
  try {
    const params = new URLSearchParams(window.location.search);
    if (!params.has(CACHE_BUST_PARAM)) return;
    params.delete(CACHE_BUST_PARAM);
    const query = params.toString();
    window.history.replaceState(
      window.history.state,
      "",
      `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`
    );
  } catch {
    // приватный режим/старый браузер — лишний параметр в адресе не мешает работе
  }
}

/**
 * СВОЯ ГАРАНТИЯ ПЕРЕЗАГРУЗКИ ПОВЕРХ ПЛАГИНА (10.09.2026, поймано замером).
 *
 * `updateServiceWorker(true)` из vite-plugin-pwa перезагружает страницу по
 * событию workbox-window `controlling` — но ТОЛЬКО если у события выставлен
 * `isUpdate`, а он выставляется по наличию управляющего воркера в момент
 * первой регистрации. У вкладки, которая зарегистрировала воркер сама (первое
 * в жизни открытие CRM в этом браузере, чистый профиль, после очистки данных
 * сайта), контроллера тогда ещё не было — и подмена доходила до смены воркера,
 * но страница не перезагружалась НИКОГДА: сборка новая, оболочка старая. На
 * стенде это выглядело как «обновление просто не применяется».
 *
 * Поэтому перезагрузку держим сами, двумя независимыми стежками:
 *   - воркер сменился (`controllerchange`) — перезагружаемся немедленно;
 *   - воркер не сменился за SWAP_TIMEOUT_MS — перезагружаемся всё равно.
 * Оба стежка идемпотентны: страница, которая уже уходит, второй перезагрузки
 * не заметит, а лестница попыток выше по-прежнему не даёт зациклиться.
 */
const SWAP_TIMEOUT_MS = 3_000;

export async function swapViaServiceWorker(
  updateServiceWorker: (reloadPage?: boolean) => Promise<void>,
  reload: () => void
): Promise<void> {
  try {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.addEventListener("controllerchange", () => reload(), { once: true });
    }
  } catch {
    // без воркера остаётся сторож ниже
  }
  const guard = setTimeout(reload, SWAP_TIMEOUT_MS);
  try {
    await updateServiceWorker(true);
  } catch {
    // плагин не справился — сторож всё равно перезагрузит
    clearTimeout(guard);
    reload();
  }
}

/**
 * Единственная точка применения обновления. Возвращает выбранную ветку — это
 * же значение проверяют тесты (в браузере результат не используется: страница
 * к этому моменту уже перезагружается).
 */
export async function applyAppUpdate({
  needRefresh,
  updateServiceWorker,
  currentVersion,
  reload = () => window.location.reload(),
  navigateFresh = hardNavigate,
}: ApplyUpdateOptions): Promise<"service-worker" | "reload" | "hard-reset" | "gave-up"> {
  const attempt = noteUpdateAttempt(currentVersion);

  if (attempt > MAX_ATTEMPTS) {
    reportGiveUp(currentVersion, attempt);
    return "gave-up";
  }

  // Ждущий воркер есть — штатный путь: SKIP_WAITING и перезагрузка по
  // controllerchange (см. sw.ts и комментарий в UpdatePrompt.tsx).
  if (needRefresh) {
    await swapViaServiceWorker(updateServiceWorker, reload);
    return "service-worker";
  }

  // Вторая и последующие попытки: голая перезагрузка уже показала, что
  // возвращает ту же сборку — уходим жёстко, без воркера и кэшей.
  if (attempt >= 2) {
    reportHardReset(currentVersion, attempt);
    await dropServiceWorkerAndCaches();
    navigateFresh(buildFreshUrl(window.location));
    return "hard-reset";
  }

  // Первая попытка: сначала даём воркеру шанс встать в waiting — тогда
  // обновление применится правильно, а не перезагрузкой в старый прекеш.
  if (await waitForWaitingWorker()) {
    await swapViaServiceWorker(updateServiceWorker, reload);
    return "service-worker";
  }

  reload();
  return "reload";
}
