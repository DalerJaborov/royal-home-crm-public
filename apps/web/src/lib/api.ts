import { useAuthStore } from "../store/auth";
import { getOrCreateDeviceId } from "./deviceId";
import { ApiError } from "./apiError";
import { httpStatusMessage } from "./httpStatusMessage";
import { noteServerBuild } from "./appVersion";
// Общий выход (снимает push-подписку устройства). Импорт односторонний: signOut
// намеренно ходит голым fetch и НЕ импортирует api.ts — иначе получился бы цикл.
import { signOut } from "./signOut";

const BASE_URL = "/api/v1";

/**
 * У ОБЫЧНОГО `fetch` НЕТ ПОТОЛКА ОЖИДАНИЯ — ни у одного запроса CRM. Зависший
 * ответ (мёртвый прокси, station таймаут, сервер задумался) держал экран
 * вечной полосой загрузки НАВСЕГДА: ни ошибки, ни повтора, F5 — единственный
 * выход. Это ровно тот же класс, что чинили в очередях загрузки
 * (`lib/uploadQueue.ts::withDeadline`, `lib/draftUploads.ts::withDeadline`) —
 * там уже есть честный потолок для fetch-шагов (сессия/сборка видео), здесь
 * был единственный необщий случай: САМ `api()`, вызываемый из полутысячи мест.
 *
 * Обычный JSON-ответ не должен идти дольше времени, на которое рассчитан
 * ретрай перезапуска контейнера (~30 c, см. комментарий в queryClient.ts).
 * Скачивание файла (архив фото/видео, запись звонка, экспорт) — дольше:
 * сервер честно собирает ZIP или отдаёт большое тело.
 */
const DEFAULT_TIMEOUT_MS = 30_000;
const BLOB_TIMEOUT_MS = 120_000;

/**
 * ДОЛГИЕ ПО ЗАМЫСЛУ РОУТЫ — 30 c им мало, и это не «сервер задумался».
 *
 * У самого сервера потолок одного обращения к модели 45-60 c
 * (`ai/assistant.ts::TIMEOUT_MS`, `ai/geminiClient.ts`), у сборки видео 90-120 c
 * (`ai/geminiMedia.ts`), а разбор заметки или подбор объявления успевают сходить
 * к модели дважды. Общий потолок в 30 c оборвал бы ЖИВОЙ запрос: человек увидел
 * бы «связь пропала», сервер при этом честно досчитал бы и списал деньги.
 *
 * Хуже того, текст обрыва читается как временный отказ (ниже), а `queryClient`
 * повторяет такие до четырёх раз — один вопрос ассистенту превратился бы в пять
 * оплаченных обращений к модели.
 *
 * Потолок всё равно есть: без него возвращается ровно та вечная полоса загрузки,
 * ради которой всё это и заведено.
 */
const SLOW_PATH = /^\/(ai\/|transcribe|insights\/generate|import\/)|^\/reports\/[a-z-]+\/generate|\/(translate|transcript|regenerate-caption)$/;
const SLOW_TIMEOUT_MS = 180_000;

/**
 * ЗАПРОС С ФАЙЛОМ (FormData) — 30 c ему мало по устройству: сначала всё тело
 * едет по мобильной сети, и только потом сервер начинает отвечать. 23.09.2026
 * «Загрузить готовый ролик» (PropertyVideoFixCard) обрывался ровно на 30-й
 * секунде с «Связь пропала»: ролик в сотни мегабайт плюс синхронная публикация
 * по сетям в тот же запрос. Узнаём по телу, а не по адресу — так потолок
 * получает каждая загрузка разом, и новую не надо вписывать в список.
 */
const UPLOAD_TIMEOUT_MS = 15 * 60_000;

/** Вынесено из `api()` отдельной функцией ради теста (`__tests__/apiTimeout.test.ts`):
 *  ошибка в этом выборе не падает сборкой, она тихо обрывает живые запросы. */
export function timeoutForPath(path: string, responseType: "json" | "blob" = "json", isForm = false): number {
  if (isForm) return UPLOAD_TIMEOUT_MS;
  if (SLOW_PATH.test(path.split("?")[0])) return SLOW_TIMEOUT_MS;
  return responseType === "blob" ? BLOB_TIMEOUT_MS : DEFAULT_TIMEOUT_MS;
}

/** Тот же текст и тот же смысл, что STALLED_ERROR в lib/uploadQueue.ts: не
 *  «сломано», а «попробуем ещё раз» — так его и читает isTransientFailure. */
const TIMEOUT_ERROR_MESSAGE = "Связь пропала — попробуем ещё раз";

/** Ошибка API, сохраняющая тело ответа — полезно, когда сервер возвращает
 * структурированные данные вместе с ошибкой (например, существующего клиента при 409).
 * Сам класс живёт в lib/apiError, чтобы офлайн-очередь могла им пользоваться, не
 * импортируя api.ts; здесь — реэкспорт, чтобы не переписывать место импорта у всех. */
export { ApiError } from "./apiError";

/**
 * ПАУЗА ПОСЛЕ 429 — общая на все вызовы api() во вкладке, но ПО ПУТИ.
 *
 * 22.09.2026: до этого таймера каждый GET, ушедший в паузу лимитера (общий
 * лимитер, apps/api/src/app.ts), всё равно летел на сервер и получал свой
 * собственный 429 — то есть сама пауза не разгружала уже перегруженный
 * лимитер, а лишь превращала «слишком много запросов» в «слишком много
 * запросов ещё раз». GET внутри окна отклоняется на клиенте, без сети, той
 * же ApiError, что вернул бы сервер — POST/PUT/DELETE не трогаем: они несут
 * данные, глотать их молча нельзя, пусть сходят и получат честный 429.
 *
 * 24.09.2026 (ночная проверка, находка P1): пауза была ОДНИМ таймером на весь
 * модуль — 429 с редкого /settings/branding (свой лимитер, тесен по замыслу)
 * останавливал БЕЗ СЕТИ все остальные GET вкладки, включая /clients и /deals,
 * у которых свой (общий) лимитер и своя, ещё не исчерпанная квота. Экран
 * показывал «Загружаем…» вместо данных, хотя сервер эти пути отдал бы. Теперь
 * пауза хранится по пути (без query) — 429 от одного маршрута не гасит другие.
 */
const cooldownUntilByPath = new Map<string, number>();

/** Путь без query-строки — ключ паузы. Вынесено отдельной функцией ради
 *  теста (`__tests__/apiCooldown.test.ts`), как timeoutForPath выше. */
export function cooldownPathKey(path: string): string {
  return path.split("?")[0];
}

function getCooldownUntil(path: string): number {
  return cooldownUntilByPath.get(cooldownPathKey(path)) ?? 0;
}

function setCooldownUntil(path: string, until: number): void {
  cooldownUntilByPath.set(cooldownPathKey(path), until);
}

/** Только для тестов: несколько проверок в одном файле делят один и тот же
 *  модуль, а значит и одну Map — без сброса пауза одного теста продолжается
 *  в следующем. */
export function resetApiCooldownForTests(): void {
  cooldownUntilByPath.clear();
}
/** Когда сервер не прислал ни Retry-After, ни RateLimit-Reset (не должно
 *  случаться при standardHeaders:true в apiLimiter, но заголовок могла
 *  срезать промежуточная прокси) — пауза по умолчанию. */
const DEFAULT_429_COOLDOWN_MS = 10_000;

/**
 * Текст 429 зависит от того, ЧТО не прошло (аудит 23.09.2026, №14). Чтение
 * повторяет сама CRM (queryClient), и «повторим через N с» — правда. Запись
 * (сохранить, отправить) сама не повторяется — обещание повтора там ложь, и
 * человек уходил, думая, что изменение сохранится.
 */
export function retryAfterMessage(retryAfterMs: number, method = "GET"): string {
  const secs = Math.max(1, Math.ceil(retryAfterMs / 1000));
  return method === "GET"
    ? `Слишком много запросов — повторим через ${secs} с`
    : `Слишком много запросов — не сохранилось, подождите ${secs} с и нажмите ещё раз`;
}

/**
 * Обрыв связи словами, а не «Failed to fetch»/«Load failed» браузера (аудит
 * 23.09.2026, №15): сырой английский текст TypeError уходил в уведомления.
 * Запись, которую никто не повторит, называется честно — могла не сохраниться.
 * Остаётся простым Error: queryClient читает такие как временный сбой.
 */
export function networkFailureError(err: unknown, method = "GET"): unknown {
  const isWrite = method !== "GET";
  if (err instanceof TypeError) {
    return new Error(
      isWrite
        ? "Нет связи с сервером — изменение не сохранилось, проверьте интернет и повторите"
        : "Нет связи с сервером — проверьте интернет"
    );
  }
  if (isWrite && err instanceof Error && err.message === TIMEOUT_ERROR_MESSAGE) {
    return new Error("Связь пропала — изменение могло не сохраниться, проверьте и повторите");
  }
  return err;
}

/** Retry-After — секунды или HTTP-дата (RFC 7231). RateLimit-Reset —
 *  черновик 6/7 IETF, express-rate-limit шлёт его при standardHeaders:true
 *  как число секунд до конца окна (см. apiLimiter, apps/api/src/app.ts). */
function parseRetryAfterMs(res: Response): number | undefined {
  const retryAfter = res.headers.get("Retry-After");
  if (retryAfter) {
    const secs = Number(retryAfter);
    if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
    const dateMs = Date.parse(retryAfter);
    if (!Number.isNaN(dateMs)) return Math.max(0, dateMs - Date.now());
  }
  const rateLimitReset = res.headers.get("RateLimit-Reset");
  if (rateLimitReset) {
    const secs = Number(rateLimitReset);
    if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  }
  return undefined;
}

let refreshPromise: Promise<string | null> | null = null;
/** Эпоха сессии, под которую запущен refreshPromise (см. sessionEpoch в store/auth). */
let refreshPromiseEpoch = -1;

/**
 * ПОТОЛОК ОЖИДАНИЯ REFRESH (аудит 04.10.2026, №14). Обычный fetch без signal
 * мог висеть вечно, а refreshPromise сбрасывается только в finally, то есть
 * никогда: ждали все api() после 401, ассистент, очереди загрузок, а на старте
 * ProtectedRoute держал вечный скелет. Повтор безопасен: refresh не одноразовый
 * (issueRefreshCookie перевыпускает ту же сессию). Таймер живёт до конца
 * `res.json()` — зависшее тело ответа ничем не лучше зависшего заголовка.
 */
const REFRESH_TIMEOUT_MS = 20_000;

/** Последнее обновление токена сорвалось из-за отсутствия связи, а не из-за
 *  протухшей сессии. Различать обязательно: в первом случае человека нельзя
 *  выкидывать на экран входа — он никуда не выходил, у него просто нет сети. */
let refreshFailedByNetwork = false;
export const didRefreshFailOffline = () => refreshFailedByNetwork;

/** Refresh-токен живёт в HttpOnly cookie (недоступной JS) — браузер отправляет её сам через credentials:"include".
 * Экспортируется для восстановления сессии при загрузке приложения (App.tsx). */
export async function refreshAccessToken(): Promise<string | null> {
  const { hasSession, sessionEpoch } = useAuthStore.getState();
  if (!hasSession) return null;

  // Refresh другой сессии (А вышел, вошёл Б) не переиспользуется: его ответ всё
  // равно будет отброшен ниже, а Б получил бы от общего промиса null.
  if (!refreshPromise || refreshPromiseEpoch !== sessionEpoch) {
    // ЭПОХА ЗАПОМИНАЕТСЯ ДО fetch (аудит 04.10.2026, №1). Ответ, вернувшийся после
    // выхода/входа другого аккаунта, принадлежит прежней сессии: писать его в стор
    // (токен и личность А поверх Б) или по его 401 звать signOut (разлогинил бы Б)
    // нельзя. Снимок `agent` до запроса для этого не годился: он сравнивал ответ
    // с устаревшей личностью.
    const epoch = sessionEpoch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REFRESH_TIMEOUT_MS);
    const stale = () => useAuthStore.getState().sessionEpoch !== epoch;
    const mine: Promise<string | null> = fetch(`${BASE_URL}/auth/refresh`, {
      method: "POST",
      credentials: "include",
      headers: { "X-Device-Id": getOrCreateDeviceId() },
      signal: controller.signal,
    })
      .then(async (res) => {
        if (!res.ok) {
          // 401 — сервер САМ проверил refresh-cookie и отверг её (отозвана, истекла,
          // вытеснена лимитом устройств): это такой же выход, как по кнопке, и он
          // ОБЯЗАН снять push-подписку устройства (lib/signOut). Серверу здесь уже
          // нечем нас авторизовать, но снятие подписки в самом браузере делает
          // endpoint мёртвым, и строка в базе удалится при первой же отправке (410).
          //
          // ЛЮБОЙ ДРУГОЙ код (429/500/502/503/504) — НЕ решение о сессии, а сбой
          // транспорта: 05.09.2026 нашли, что именно так читался обычный 502 в
          // секундном окне жёсткого перезапуска api-контейнера при выкате
          // (ops/deploy.sh делает stop+recreate, не rolling) — агент терял сессию
          // на ровном месте посреди рабочего дня, и это выглядело как «CRM выкинула
          // без причины». Транзитный сбой — та же ситуация, что обрыв сети ниже:
          // сессию не трогаем, следующий запрос попробует рефрешнуться заново.
          if (stale()) return null;
          if (res.status === 401) {
            void signOut();
            return null;
          }
          refreshFailedByNetwork = true;
          return null;
        }
        const data = await res.json();
        if (stale()) return null; // ответ чужой сессии: ни токен, ни личность не пишем
        refreshFailedByNetwork = false; // связь есть, метка снимается
        // Обычный случай: тот же агент, что уже показан — просто обновляем токен
        // и синхронизируем поля (preferences и т.п.) без сброса кэша запросов.
        // Если id разошёлся с тем, что запомнен в localStorage (например, в этом
        // браузере раньше логинился другой агент) — это смена личности, применяем
        // как полноценный вход, чтобы шапка и кэшированные /me-данные не остались
        // от чужой сессии.
        // ВАЖНО: «личность сменилась» — это ДРУГОЙ id, а не ОТСУТСТВУЮЩИЙ.
        // Условие `agent?.id !== data.agent.id` истинно и когда локально агента
        // нет вовсе (частично затёртый localStorage: в iOS-браузерах и в
        // установленном приложении хранилище чистится само, а снимок кэша
        // запросов ещё и упирается в квоту — см. lib/queryPersist.ts). Тогда
        // обычное продление токена посреди рабочего дня проходило через
        // setSession, а он стирает ВЕСЬ кэш запросов, кэш ответов service
        // worker и снимок на диске: у человека на ровном месте пустели экраны
        // и всё загружалось заново, хотя ни он, ни сессия никуда не делись
        // (жалоба владельца 19.09.2026 — «CRM само выбрасывает и пишет
        // загрузите данные заново»). Нет локального агента — это не чужой
        // вход, а пробел: заполняем его, ничего не стирая.
        const { agent, setAccessToken, setSession, updateAgent } = useAuthStore.getState();
        if (data.agent && agent && agent.id !== data.agent.id) {
          setSession(data.agent, data.accessToken);
        } else {
          setAccessToken(data.accessToken);
          if (data.agent) updateAgent(data.agent);
        }
        return data.accessToken as string;
      })
      .catch(() => {
        // Сеть оборвалась — это НЕ «сессия умерла». fetch при отсутствии связи
        // не возвращает ответ, а падает, и без этой ветки отказ выглядел так же,
        // как отозванный токен: агент в подвале или в лифте перезагружал страницу
        // и попадал на экран входа, будто его разлогинило. Сессию не трогаем.
        //
        // Запоминаем ИМЕННО ФАКТ сетевого отказа, а не спрашиваем navigator.onLine:
        // тот отвечает «онлайн», если есть хоть какой-то сетевой интерфейс, и врёт
        // при мёртвом Wi-Fi, captive-портале в гостинице и в эмуляции офлайна.
        // Упавший запрос — единственное честное доказательство отсутствия связи.
        if (!stale()) refreshFailedByNetwork = true;
        return null;
      })
      .finally(() => {
        clearTimeout(timer);
        // Не затираем промис уже новой сессии, если этот пережил смену аккаунта.
        if (refreshPromise === mine) refreshPromise = null;
      });
    refreshPromise = mine;
    refreshPromiseEpoch = epoch;
  }
  return refreshPromise;
}

/** Новый ключ повтора для `api(..., { idempotencyKey })`. */
export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

export async function api<T>(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    /**
     * Обычно указывать НЕ НУЖНО: FormData распознаётся сама (см. ниже).
     * Остаётся ради явного переопределения и совместимости с прежними вызовами.
     */
    isForm?: boolean;
    responseType?: "json" | "blob";
    /** true — при обрыве сети запрос сохраняется в офлайн-очередь и уйдёт сам (см. lib/offlineQueue). */
    queueOffline?: boolean;
    /** Переопределить потолок ожидания (мс). Обычно указывать не нужно — см. DEFAULT_TIMEOUT_MS/BLOB_TIMEOUT_MS. */
    timeoutMs?: number;
    /**
     * Ключ повтора (23.09.2026, apps/api/src/lib/idempotency.ts): повтор с тем же
     * ключом получает ответ первого запроса, а не создаёт вторую запись. Один
     * ключ — одно намерение: форма, которую можно нажать «Сохранить» дважды,
     * держит свой ключ до успеха (`newIdempotencyKey`). Запись с офлайн-очередью
     * получает ключ сама, если его не дали.
     */
    idempotencyKey?: string;
    /** Server revision read with the edited resource; rejects stale writes. */
    ifMatch?: string;
    /** Media may only be written to the draft that owned it when queued. */
    propertyDraftId?: string;
    /**
     * Запрос принадлежит ЭТОМУ сотруднику (офлайн-очередь, аудит 04.10.2026, №2).
     * Если за время ожидания вошёл другой, запрос не уходит чужим токеном: ни до
     * отправки, ни повтором после обновления токена. Ошибка 401 «Сессия сменилась».
     */
    expectAgentId?: string;
    /**
     * fetch с `keepalive`: запрос доживает до конца, даже если вкладку закрыли или
     * она ушла в фон (автосохранение черновика мастера на pagehide/hidden).
     * Браузер режет тело таких запросов до 64 КБ — только для коротких JSON.
     */
    keepalive?: boolean;
  } = {}
): Promise<T> {
  const initiatingSession = useAuthStore.getState();
  const initiatingActorId = initiatingSession.agent?.id;
  const initiatingEpoch = initiatingSession.sessionEpoch;
  const { method = "GET", responseType = "json", queueOffline = false } = options;
  if (queueOffline && !initiatingActorId) throw new ApiError("Нет активной сессии — данные не отправлены", 401, undefined);
  const idempotencyKey =
    options.idempotencyKey ?? (queueOffline && method === "POST" ? newIdempotencyKey() : undefined);

  // В паузе после 429 GET отклоняется без похода на сервер (см. комментарий
  // у cooldownUntilByPath выше) — записи (POST/PUT/DELETE/PATCH) всё равно
  // летят, им есть что терять. Пауза — по тому же пути, что вернул 429, а не
  // на все GET подряд.
  if (method === "GET" && getCooldownUntil(path) > Date.now()) {
    const waitMs = getCooldownUntil(path) - Date.now();
    throw new ApiError(retryAfterMessage(waitMs), 429, undefined, waitMs);
  }

  const body = options.body;
  /**
   * FORMDATA УЗНАЁТСЯ САМА, а не по флагу от вызывающего.
   *
   * Флаг `isForm` был обязательным, и забыть его ничего не стоило: ошибка не
   * выглядит ошибкой — код читается правильно, типы сходятся, отказа нет. А
   * дальше запрос уходил с `Content-Type: application/json` и телом
   * `JSON.stringify(formData)`, то есть строкой `{}`: сервер получал пустой
   * объект вместо файла и отвечал «Файл не передан».
   *
   * 16.08.2026 выяснилось, что забыли в ТРЁХ местах сразу, и все три — голосовые:
   * запись клиенту из карточки и из инбокса, а также надиктовка текста в поле
   * ввода. То есть вся работа голосом молча не работала.
   *
   * Такой флаг — ловушка по устройству: он требует помнить о нём в каждом новом
   * вызове, а расплата наступает не здесь и выглядит поломкой сервера. Поэтому
   * определяем сами; явное значение по-прежнему уважается.
   */
  const isForm = options.isForm ?? body instanceof FormData;
  const timeoutMs = options.timeoutMs ?? timeoutForPath(path, responseType, isForm);
  const assertSameAgent = () => {
    const current = useAuthStore.getState();
    if ((initiatingActorId && (current.agent?.id !== initiatingActorId || current.sessionEpoch !== initiatingEpoch))
      || (options.expectAgentId && current.agent?.id !== options.expectAgentId)) {
      throw new ApiError("Сессия сменилась — запрос не отправлен", 401, undefined);
    }
  };
  /**
   * ТАЙМЕР ДЕРЖИТСЯ ДО КОНЦА ЧТЕНИЯ ТЕЛА (аудит 04.10.2026, №15): раньше он
   * снимался сразу после заголовков, а `res.text()/json()/blob()` шли позже без
   * потолка и без signal. Вызывающий обязан позвать `done()` после всех чтений
   * (api() делает это в finally). Для blob потолок общий не годится (легальные
   * долгие скачивания) — там `restart` перезапускает его на каждый кусок данных.
   */
  const doFetch = async (token: string | null) => {
    const headers: Record<string, string> = { "X-Device-Id": getOrCreateDeviceId() };
    if (!isForm) headers["Content-Type"] = "application/json";
    if (token) headers["Authorization"] = `Bearer ${token}`;
    if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
    if (options.ifMatch) headers["If-Match"] = options.ifMatch;
    if (options.propertyDraftId) headers["X-Property-Draft-Id"] = options.propertyDraftId;

    const controller = new AbortController();
    let timer = setTimeout(() => controller.abort(), timeoutMs);
    const done = () => clearTimeout(timer);
    const restart = (ms: number) => {
      clearTimeout(timer);
      timer = setTimeout(() => controller.abort(), ms);
    };
    try {
      const res = await fetch(`${BASE_URL}${path}`, {
        method,
        headers,
        credentials: "include",
        body: body ? (isForm ? (body as FormData) : JSON.stringify(body)) : undefined,
        signal: controller.signal,
        ...(options.keepalive ? { keepalive: true } : {}),
      });
      return { res, done, restart };
    } catch (err) {
      done();
      // AbortError — это НАШ таймер, а не отказ пользователя (отмены запроса
      // здесь нет): читаем его как обрыв связи, тем же текстом, что и у
      // очередей загрузки, чтобы retry/офлайн-очередь ниже видели «сеть», а
      // не незнакомую ошибку.
      if (err instanceof DOMException && err.name === "AbortError") {
        throw new Error(TIMEOUT_ERROR_MESSAGE);
      }
      throw err;
    }
  };

  assertSameAgent();
  let token = useAuthStore.getState().accessToken;
  let attempt: Awaited<ReturnType<typeof doFetch>>;
  try {
    attempt = await doFetch(token);
  } catch (err) {
    // fetch кидает TypeError только при сетевой ошибке — тела и статуса нет.
    if (queueOffline && !isForm) {
      assertSameAgent();
      const { enqueueOffline, OfflineQueuedError } = await import("./offlineQueue");
      assertSameAgent();
      // С тем же ключом: если обрыв был по нашему таймеру, а сервер запись
      // всё-таки сделал, досылка из очереди получит тот же ответ, а не дубль.
      enqueueOffline(path, method, body, idempotencyKey, initiatingActorId);
      throw new OfflineQueuedError();
    }
    throw networkFailureError(err, method);
  }

  try {
    assertSameAgent();
    let res = attempt.res;
    if (res.status === 401 && useAuthStore.getState().hasSession) {
      assertSameAgent();
      token = await refreshAccessToken();
      assertSameAgent();
      if (token) {
        // Ответ первой попытки отбрасывается — её таймер больше никому не нужен.
        attempt.done();
        // Refresh мог пройти уже под другим аккаунтом (А вышел, вошёл Б): запись А
        // повторять токеном Б нельзя.
        assertSameAgent();
        attempt = await doFetch(token);
        res = attempt.res;
      }
    }

    // Второй сигнал «вышла новая версия» (см. UpdatePrompt): сервер шлёт свою сборку
    // заголовком на каждом ответе (app.ts), заметка сравнивает её с первой увиденной.
    // До 26.08.2026 вызова не было НИГДЕ — appVersion.ts обещал его «из api.ts на
    // каждом ответе», seenBuild навсегда оставался null, и сигнал был мёртв
    // (грабли проекта «импорт без вызова = мёртвая защита»).
    noteServerBuild(res.headers.get("X-App-Build"));

    // Учётку отключили, пока вкладка была открыта: 403 с этим признаком означает не
    // «нет права на раздел», а «работать больше нельзя». Без выхода человек продолжал
    // видеть загруженные ранее карточки клиентов и финансы.
    if (res.status === 403) {
      const clone = res.clone();
      const body = await clone
        .json()
        .then((b: { accountDisabled?: boolean; code?: string }) => b)
        .catch(() => null);
      assertSameAgent();
      if (body?.accountDisabled === true) {
        // Тот же общий выход: учётку отключили — уведомления по ней приходить
        // не должны, в том числе на уже подписанное устройство. Здесь ЖДЁМ, в
        // отличие от остальных точек: следом идёт полная перезагрузка страницы,
        // которая оборвала бы незавершённое снятие подписки. Ждать нечего дольше
        // нескольких секунд — внутри signOut на каждый шаг стоит таймаут.
        await signOut();
        window.location.href = "/login";
      }
    }

    // Подтверждение личности живёт 10 минут и истекает прямо на открытой странице
    // Настроек. Без этого сигнала «замок» не возвращался: форма показывала мелкую
    // ошибку, кнопка «Сохранить» будто не работала, и ключ молча не сохранялся.
    if (res.status === 428) {
      const precondition = await res.clone().json().catch(() => null) as { code?: string } | null;
      assertSameAgent();
      if (precondition?.code !== "UI_SHELL_VERSION_REQUIRED") window.dispatchEvent(new CustomEvent("step-up-required"));
    }

    // Обязательное окно, у которого кончились переносы, блокирует работу во всей
    // CRM (решение владельца 11.08.2026). 423 приходит вкладке, открытой ДО того,
    // как окно появилось: сама она о требовании ещё не знает и показала бы вместо
    // него невнятную ошибку сохранения. Обновляем список требований — блокирующее
    // окно поднимется само, тем же кодом, что и обычно.
    if (res.status === 423) {
      window.dispatchEvent(new CustomEvent("summary-block"));
    }

    try {
      if (!res.ok) {
        const text = await res.text();
        assertSameAgent();
        let message = "";
        let data: unknown = undefined;
        try {
          data = JSON.parse(text);
          message = (data as { error?: string }).error ?? "";
        } catch {
          // Не JSON — например, Cloudflare подменил тело 502/503/504 своей HTML-страницей.
          // Сырую разметку пользователю не показываем, только код ответа.
        }
        if (res.status === 429) {
          const retryAfterMs = parseRetryAfterMs(res) ?? DEFAULT_429_COOLDOWN_MS;
          setCooldownUntil(path, Date.now() + retryAfterMs);
          // Сервер отказал СВОИМИ словами (троттлинг повторного набора: «Подождите
          // 30 с: предыдущий вызов не дошёл до вашего телефона») — их и показываем.
          // Общая фраза только у общего лимитера: подмена его текста нашей
          // прятала от агента настоящую причину (28.09.2026, «не смогла дозвониться»).
          const ownWords = message && !message.startsWith("Слишком много запросов") ? message : null;
          throw new ApiError(ownWords ?? retryAfterMessage(retryAfterMs, method), 429, data, retryAfterMs);
        }
        throw new ApiError(message || httpStatusMessage(res.status), res.status, data);
      }

      if (res.status === 204) return undefined as T;
      if (responseType === "blob") {
        const blob = await readBlobWithIdleTimeout(res, attempt.restart, timeoutMs);
        assertSameAgent();
        return blob as T;
      }
      const result = await res.json();
      assertSameAgent();
      return result;
    } catch (err) {
      // Обрыв посреди ТЕЛА ответа: наш таймер (AbortError) и сетевой отказ читаются
      // так же, как обрыв до заголовков, а не уходят наружу сырым DOMException/TypeError.
      if (err instanceof DOMException && err.name === "AbortError") {
        throw networkFailureError(new Error(TIMEOUT_ERROR_MESSAGE), method);
      }
      throw networkFailureError(err, method);
    }
  } finally {
    attempt.done();
  }
}

/**
 * Скачивание файла с потолком ПРОСТОЯ, а не общим (аудит 04.10.2026, №15): большой
 * ZIP или запись звонка идут дольше любого общего лимита, и их обрыв рвал бы
 * легальную загрузку. Пока приходят данные, таймер перезапускается на каждый кусок;
 * тишина дольше `idleMs` обрывает запрос.
 */
async function readBlobWithIdleTimeout(
  res: Response,
  restart: (ms: number) => void,
  idleMs: number
): Promise<Blob> {
  if (!res.body) return res.blob();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    restart(idleMs);
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  return new Blob(chunks as BlobPart[], { type: res.headers.get("Content-Type") ?? "" });
}
