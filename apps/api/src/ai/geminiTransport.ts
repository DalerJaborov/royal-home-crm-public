/**
 * Как мы вообще дозваниваемся до Gemini: адрес, прокси и заголовки.
 *
 * Отдельным модулем, потому что это уже жило двумя копиями — в geminiClient.ts и в
 * transcribe.ts, — и с появлением третьего потребителя (разбор видео, geminiMedia.ts)
 * копии неизбежно разошлись бы. Разойтись им нельзя: если прокси настроен, через
 * него обязаны идти ВСЕ запросы, иначе часть функций молча упрётся в геоблок,
 * а часть будет работать — и причину будут искать в логике, а не в маршруте.
 *
 * ГЕОБЛОК. Регион VPS не поддерживается Gemini API напрямую (ответ: "User location
 * is not supported for the API use", проверено логами 21 июля) — та же история, что
 * была с graph.instagram.com. Если заданы GEMINI_PROXY_URL/GEMINI_PROXY_KEY (тот же
 * Cloudflare Worker, что уже проксирует Instagram, с маршрутом /gemini/*), запросы
 * идут через прокси; без них — напрямую, и на боевом сервере это откажет.
 *
 * ВАЖНО про прокси и загрузку файлов: маршрут /gemini/* обязан пропускать не только
 * /v1beta/*, но и /upload/v1beta/* (File API). Если Worker сузили до генерации,
 * видео перестанет разбираться, а текст продолжит работать — расхождение,
 * которое снаружи выглядит как «видео не читается».
 */

const GEMINI_HOST = "https://generativelanguage.googleapis.com";

/**
 * Модель для всех продуктовых вызовов Gemini. Одна на репозиторий: пока имя жило
 * копиями, обновление модели требовало помнить про каждый файл.
 *
 * 02.08.2026 менялась с `gemini-2.5-flash` — Google её закрыл, и КАЖДЫЙ вызов
 * возвращал 404 «no longer available to new users»: диалоги, расшифровка голосовых,
 * разбор видео, скоринг. Снаружи это не выглядело поломкой, потому что перекрёстный
 * фолбэк молча вытягивал каждый ход на Claude — до дня, когда у Claude кончились
 * деньги, и тогда бот замолчал совсем. Урок: «модель отвалилась» обязано быть
 * заметно СРАЗУ, а не через месяц счетов за резервного поставщика.
 *
 * Имя взято из документации (ai.google.dev/gemini-api/docs/models/gemini-3.6-flash,
 * «Код модели: gemini-3.6-flash», стабильная версия), а не придумано: 3.6 Flash
 * принимает текст, изображения, видео, аудио и PDF — весь набор, который нам нужен.
 *
 * ИМЯ БЕРЁТСЯ ИЗ ОКРУЖЕНИЯ (16.08.2026). Flash — младшая ступень линейки: она быстрая
 * и дешёвая, но хуже держит длинный промт с десятками запретов, а у нас их там
 * больше тридцати. Платный ключ на это не влияет вовсе: оплата снимает бесплатные
 * квоты, а насколько модель умна, решает ИМЯ модели, которое мы просим. Чтобы
 * перейти на старшую ступень, не нужен выкат кода — достаточно GEMINI_MODEL в .env.
 *
 * ИМЯ НЕ ВЫДУМЫВАТЬ. 02.08.2026 закрытая модель давала 404 на КАЖДЫЙ вызов, и
 * снаружи это выглядело не поломкой, а тишиной. Перед сменой сверить действующий
 * список на ai.google.dev/gemini-api/docs/models.
 */
export const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.6-flash";

/**
 * Резервные модели Gemini — пробуем по очереди, когда предыдущая в цепочке исчерпала
 * все повторы (503/429 — перегружена или превышена квота). Остаётся тем же
 * поставщиком (Google), просто другая модель: владелец решил 02.08.2026 держать
 * одного поставщика и не прятать простой за молчаливым переходом на Claude (см.
 * комментарий у GEMINI_MODEL).
 *
 * СПИСОК, А НЕ ОДНА МОДЕЛЬ (17.08.2026). Раньше было ровно одно резервное имя — если
 * и оно перегружено, спасать было больше нечем. Формат — через запятую в той же
 * переменной: GEMINI_FALLBACK_MODEL=gemini-3.6-flash,gemini-3.5-flash — пробуем слева
 * направо, первая ответившая и обслуживает ход.
 *
 * БЕЗ ЗНАЧЕНИЯ ПО УМОЛЧАНИЮ НАРОЧНО. Придуманное имя модели — верный способ поймать
 * 404 на каждый вызов (та же история, что была 02.08 с gemini-2.5-flash — она с того
 * дня закрыта Google насовсем, добавлять её обратно в цепочку бессмысленно), и тогда
 * резерв будет не спасать, а тихо есть деньги без результата. Указывать явно в .env,
 * сверившись с действующим списком моделей на ai.google.dev/gemini-api/docs/models —
 * иначе резерв просто не используется.
 */
export const GEMINI_FALLBACK_MODELS = (process.env.GEMINI_FALLBACK_MODEL || "")
  .split(",")
  .map((m) => m.trim())
  .filter(Boolean);

/**
 * ДОРОГИЕ МОДЕЛИ РАСШИФРОВКИ ГОЛОСОВЫХ — по очереди, слева направо.
 *
 * Голос требует модели умнее диалоговой: Flash не разобрал продиктованный клиентом
 * номер телефона, и карточки не объединились (решение владельца 19.08.2026). Дешёвая
 * модель остаётся последним рубежом, чтобы голосовое не потерялось совсем, — но
 * первой не ставится никогда.
 *
 * Дефолт здесь ОДИН, потому что доступная pro-модель с приёмом звука сейчас ровно
 * одна: gemini-2.5-pro закрыта Google 22.08.2026 (HTTP 404 «no longer available to
 * new users», он же сам называет замену). Вторая появится в списке, как только
 * откроют следующую.
 */
export const GEMINI_TRANSCRIBE_MODELS = (
  process.env.GEMINI_TRANSCRIBE_MODELS || "gemini-3.1-pro-preview"
)
  .split(",")
  .map((m) => m.trim())
  .filter(Boolean);

/**
 * МОДЕЛЬ РИСОВАНИЯ — обложки статей блога.
 *
 * Проверена живым вызовом 22.08.2026: вернула JPEG на 1 МБ. Рисующие модели
 * доступны ТОЛЬКО на платном проекте: на бесплатном тире Google отвечает 429 с
 * `quotaId: GenerateRequestsPerDayPerProjectPerModel-FreeTier` — суточная квота у
 * них ровно ноль. Текстовые при этом работают, поэтому «ключ рабочий, а картинки
 * не идут» означает не сломанный ключ, а проект без привязанного биллинга.
 */
export const GEMINI_IMAGE_MODEL = process.env.GEMINI_IMAGE_MODEL || "gemini-3-pro-image";

/**
 * МОДЕЛЬ ЭМБЕДДИНГОВ — семантический подбор объектов (23.08.2026, пункт 3 очереди
 * ИИ, ai/embeddings.ts). Отдельный эндпоинт (:embedContent, см. geminiEmbedUrlFor
 * ниже), а не :generateContent, которым пользуется весь остальной файл, — векторы,
 * а не текст ответа.
 *
 * Имя сверено на ai.google.dev/gemini-api/docs/embeddings 23.08.2026: у Google на
 * этот день две модели эмбеддингов — `gemini-embedding-2` (мультимодальная, новее,
 * НЕ принимает REST-параметр task_type вовсе — тип задачи задаётся инструкцией
 * внутри текста промта) и `gemini-embedding-001` (только текст, обычный REST-
 * параметр task_type: RETRIEVAL_DOCUMENT для индексации объекта, RETRIEVAL_QUERY
 * для запроса клиента — асимметричный поиск, стандартная практика эмбеддингов).
 * Выбрана -001: явный параметр надёжнее промт-инструкции и ближе к остальному
 * стилю проекта (структурные REST-поля, не текстовые соглашения), а разница в
 * качестве для каталога в сотни-тысячи объектов не критична.
 *
 * ИМЯ НЕ ВЫДУМЫВАТЬ (см. комментарий у GEMINI_MODEL выше) — сверить действующий
 * список на ai.google.dev/gemini-api/docs/embeddings перед сменой.
 */
export const GEMINI_EMBEDDING_MODEL = process.env.GEMINI_EMBEDDING_MODEL || "gemini-embedding-001";

/**
 * Размерность вектора — параметр outputDimensionality (Matryoshka Representation
 * Learning: усечённый вектор остаётся осмысленным для сравнения). По умолчанию
 * Google отдаёт 3072; 768 — одно из рекомендованных документацией меньших значений,
 * втрое дешевле хранить и сравнивать, чего достаточно для каталога в сотни-тысячи
 * объектов (не миллионы, где точность на меньшей размерности была бы заметнее).
 *
 * gemini-embedding-001 требует РУЧНОЙ нормализации усечённого вектора для точного
 * косинуса (в отличие от -2, который нормализует сам) — но cosineSimilarity в
 * ai/embeddings.ts делит на норму обоих векторов сама, поэтому предварительная
 * нормализация здесь не нужна: результат корректен и без неё.
 */
export const GEMINI_EMBEDDING_DIMENSIONS = 768;

/** Адрес :embedContent для векторов — отдельный от :generateContent (geminiGenerateUrlFor). */
export function geminiEmbedUrlFor(model: string): string {
  return geminiUrl(`/v1beta/models/${model}:embedContent`);
}

/**
 * Полный адрес запроса к Gemini.
 * @param path путь от корня API, начиная со слэша: "/v1beta/models/...:generateContent".
 */
export function geminiUrl(path: string): string {
  const proxyUrl = process.env.GEMINI_PROXY_URL;
  // `||`, а не `??`: пустая строка в .env — это «не настроено», а не адрес прокси.
  return proxyUrl ? `${proxyUrl.replace(/\/+$/, "")}/gemini${path}` : `${GEMINI_HOST}${path}`;
}

/** Заголовок доступа к прокси. Пустой объект, когда прокси не настроен. */
export function geminiProxyHeaders(): Record<string, string> {
  const proxyKey = process.env.GEMINI_PROXY_KEY;
  return proxyKey ? { "x-proxy-key": proxyKey } : {};
}

/** Адрес генерации для произвольной модели — нужен, чтобы позвать резервную. */
export function geminiGenerateUrlFor(model: string): string {
  return geminiUrl(`/v1beta/models/${model}:generateContent`);
}

/** Адрес генерации для модели по умолчанию — самый частый случай из всех. */
export function geminiGenerateUrl(): string {
  return geminiGenerateUrlFor(GEMINI_MODEL);
}

/**
 * 503 (перегружен), 429 (лимит/квота) и 500 (внутренняя ошибка на стороне Google —
 * видна в журнале как «Internal error», обычно проходит после паузы) стоит
 * переждать и повторить; остальные коды (400/401/404...) от паузы не изменятся —
 * общее для всех точек входа Gemini.
 *
 * 502/504/408 И 524 ДОБАВЛЕНЫ 24.09.2026 — ТА ЖЕ ПРИРОДА, ЧТО У AbortError.
 *
 * Запросы к Gemini идут через прокси (Cloudflare Worker, geminiUrl выше): регион
 * VPS сам Google блокирует, прокси обязателен. У прокси свой предел ожидания
 * ответа от апстрима (~100 с) — если Gemini не успел, прокси не молчит и не висит,
 * а честно отвечает 524 (Cloudflare: «a connection was established… but the origin
 * did not respond before the … timeout») или 502/504 (сеть/шлюз между прокси и
 * Google оборвалась). 408 — то же самое от обычного HTTP-сервера («Request Timeout»).
 *
 * Это НЕ отказ модели — апстрим просто не ответил вовремя, ровно та же беда, что
 * AbortError у клиентского таймера (transcribe.ts, EXPENSIVE_TIMEOUT_BASE_MS): та
 * запись уже повторяется следующей попыткой/моделью, а эти статусы раньше
 * останавливали перебор мгновенно (isRetryableGeminiStatus возвращала false), хотя
 * причина ничем не отличалась от таймаута. Живой замер 24.09: pro на mp3 1486 КБ
 * (692 с речи) получал именно 524 через 125 с — и без этой правки шёл сразу в
 * `fail()`, вместо повтора следующей попыткой/моделью.
 *
 * Бесконечных повторов это не создаёт: количество попыток на модель ограничено
 * ЧИСЛОМ (не статусом) — ATTEMPTS_PER_MODEL в geminiClient.ts и
 * `GEMINI_RETRY_DELAYS_MS.length + 1` в transcribe.ts, — а сверху всё ещё стоит
 * общий бюджет времени на вызов (TOTAL_BUDGET_MS / TRANSCRIBE_TOTAL_BUDGET_MS).
 * Добавление статусов в этот список не трогает ни то, ни другое — оно лишь решает,
 * не бросить ли попытку раньше положенного числа повторов.
 */
export function isRetryableGeminiStatus(status: number): boolean {
  return (
    status === 503 ||
    status === 429 ||
    status === 500 ||
    status === 502 ||
    status === 504 ||
    status === 524 ||
    status === 408
  );
}

/**
 * ИМЕНА МОДЕЛЕЙ, ПРОВЕРЕННЫЕ ЖИВЫМ ЗАПРОСОМ — чтобы опечатка или закрытая Google
 * модель была видна СРАЗУ, а не растворялась в общем потоке отказов (30.08.2026).
 *
 * ЗАЧЕМ. Дважды за август имя модели становилось мёртвым (gemini-2.5-flash 02.08,
 * gemini-2.5-pro 22.08) и давало HTTP 404 на КАЖДЫЙ вызов, а перекрёстный резерв
 * молча вытягивал каждый ход — первый случай прожил два месяца, второй трое суток.
 * Опечатка в поле Настроек ведёт себя ровно так же: снаружи «работает».
 *
 * ЭТО ПОДСКАЗКА, А НЕ ЗАПРЕТ. Список неизбежно устаревает: Google выпускает модели
 * чаще, чем мы выкатываем код. Поэтому неизвестное имя НИЧЕГО не блокирует — оно
 * лишь поднимает запись в «Здоровье системы» с прямым текстом «либо опечатка, либо
 * список в коде устарел». Блокировать значило бы однажды не пустить владельца на
 * новую модель без выката — ровно то, ради чего имя и переехало в Настройки.
 *
 * Проверено живым запросом через прокси 30.08.2026: отвечают gemini-3.6-flash и
 * gemini-3.5-flash; gemini-3.7-flash существует, но в этот день отдавал 503;
 * 404 отдают gemini-3.6-flash-lite, gemini-3.6-pro, gemini-3.7-flash-lite и
 * gemini-2.5-flash («no longer available to new users»).
 */
export const GEMINI_KNOWN_MODELS = [
  // Диалоги и разбор текста.
  "gemini-3.7-flash",
  "gemini-3.6-flash",
  "gemini-3.5-flash",
  "gemini-3-flash-preview",
  "gemini-3.1-pro-preview",
  // Дешёвая ступень (geminiLiteModel): проверена живым структурным вызовом
  // 30.08.2026 — верно извлекла район/комнаты/бюджет из таджикско-русского
  // текста, принимает thinkingLevel: minimal. ~2.4x дешевле обычных flash.
  "gemini-3.1-flash-lite",
  // Отдельные линейки — рисование, эмбеддинги, живой голос: у них свои эндпоинты,
  // но имя проверяется тем же списком.
  "gemini-3-pro-image",
  "gemini-embedding-2",
  "gemini-embedding-001",
  // Живой голос: основная модель (GEMINI_LIVE_MODEL по умолчанию) и запасная.
  "gemini-3.8-live",
  "gemini-3.1-flash-live-preview",
];

/**
 * Имена, про которые ТОЧНО известно, что Google их закрыл: их появление в Настройках
 * или .env — не «возможно, список устарел», а гарантированные 404 на каждый вызов.
 * Дата закрытия в комментарии, чтобы через полгода не гадать, откуда строка.
 */
export const GEMINI_RETIRED_MODELS: Record<string, string> = {
  "gemini-2.5-flash": "закрыта Google 02.08.2026 («no longer available to new users»)",
  "gemini-2.5-pro": "закрыта Google 22.08.2026 («no longer available to new users»)",
  "gemini-3.6-flash-lite": "проверена 30.08.2026 — HTTP 404, такой модели нет",
  "gemini-3.6-pro": "проверена 30.08.2026 — HTTP 404, такой модели нет",
  "gemini-3.7-flash-lite": "проверена 30.08.2026 — HTTP 404, такой модели нет",
};

/** Имя встречалось в живой проверке и на тот день отвечало. */
export function isKnownGeminiModel(model: string): boolean {
  return GEMINI_KNOWN_MODELS.includes(model.trim());
}

/** Почему это имя заведомо мёртвое, или null — если про него ничего плохого не известно. */
export function retiredGeminiModelReason(model: string): string | null {
  return GEMINI_RETIRED_MODELS[model.trim()] ?? null;
}

/**
 * Семейство модели — линейка 2.x и линейка 3.x принимают РАЗНУЮ форму параметра
 * «глушить размышление» (см. geminiThinkingConfig ниже). По имени различить легко:
 * все модели линейки 2 называются `gemini-2.*`, остальное (3.x и новее) — `gemini-3.*`.
 *
 * ЗАЧЕМ ОТДЕЛЬНОЙ ФУНКЦИЕЙ (16.08.2026). Резервная модель (в проде — из линейки 2.5)
 * получила запрос с параметром линейки 3.x (`thinkingLevel`), Google ответил 400
 * «Thinking level MINIMAL is not supported for this model», и это ОДНИМ отказом
 * навсегда выключало thinkingConfig для ВСЕХ моделей в процессе, включая основную
 * 3.x — хотя её отказ никак не касался. Расход на «мысли» рос без необходимости, а
 * короткие бюджеты ответа (400–500 токенов) снова рисковали выжигаться раньше
 * самого ответа (см. комментарий в geminiClient.ts, «ЗАПАС ПОД МЫСЛИ»).
 */
export function geminiModelFamily(model: string): "2.x" | "3.x" {
  return /^gemini-2\./.test(model) ? "2.x" : "3.x";
}

/**
 * Модели линейки 3.x, которые НЕ принимают самый нижний уровень размышления.
 * У них минимально допустимый — "low", а на "minimal" приходит 400 «Thinking level
 * MINIMAL is not supported for this model».
 *
 * ЗАЧЕМ СПИСКОМ (18.08.2026). Весь день 17–18.08 основная модель `gemini-3.7-flash`
 * отвечала 400 на первый запрос из-за `thinkingLevel: "minimal"`, после чего перебор
 * уводил ход на резервную `gemini-3.6-flash` и писал в журнал «основная недоступна».
 * Модель была доступна всё это время (проверено на проде: без thinkingConfig и с
 * `low` — HTTP 200, только `minimal` — 400): каждый такой ход стоил ДВУХ запросов
 * и отвечала не та модель, которую выбрал владелец.
 *
 * Проверено на боевом ключе 18.08.2026: `minimal` принимают 3-flash-preview, 3.1,
 * 3.5 и 3.6; не принимает только 3.7. Поэтому список, а не «всё, что новее 3.6»:
 * выдумывать правило про ещё не вышедшие модели — тот же способ поймать 400 на
 * каждый вызов. Новая модель, которой `minimal` не подойдёт, доедет сюда строкой,
 * а до тех пор её подстрахует разовое снятие thinkingConfig в geminiClient.ts.
 *
 * gemini-3.1-pro-preview добавлена 24.09.2026 (модель расшифровки голосовых, см.
 * ai/transcribe.ts): живая проба боевым ключом — на `minimal` HTTP 400 «Thinking
 * level MINIMAL is not supported for this model», на `low` — 200 и 0 токенов
 * размышлений. «3.1» в списке выше — это flash-lite, не pro.
 */
const MINIMAL_THINKING_UNSUPPORTED = [/^gemini-3\.7-/, /^gemini-3\.1-pro/];

/** Форма параметра «не размышляй», подходящая модели: 2.x понимает только
 *  `thinkingBudget: 0`, 3.x — `thinkingLevel`, причём нижний уровень у части моделей
 *  не "minimal", а "low" (см. MINIMAL_THINKING_UNSUPPORTED). Отправка не той формы
 *  не молчит, а даёт 400 на КАЖДЫЙ вызов этой моделью. */
export function geminiThinkingConfig(model: string): Record<string, unknown> {
  if (geminiModelFamily(model) === "2.x") return { thinkingBudget: 0 };
  const level = MINIMAL_THINKING_UNSUPPORTED.some((re) => re.test(model)) ? "low" : "minimal";
  return { thinkingLevel: level };
}

/** Пауза перед повтором: 1с → 2с → 4с. Без неё повтор бьёт в тот же перегруженный
 *  сервер немедленно и почти наверняка получает тот же 503. */
export const GEMINI_RETRY_DELAYS_MS = [1000, 2000, 4000];

/**
 * МОДЕЛЬ ЖИВОГО ГОЛОСА (Gemini Live API, WebSocket BidiGenerateContent) — пункт 5
 * очереди ИИ, 23.08.2026. ОТДЕЛЬНАЯ от GEMINI_MODEL: это другое семейство
 * (аудио-нативные модели линейки `*-live-*`), обычный `generateContent` её не
 * примет, и наоборот — Live API принимает только модели этой линейки.
 *
 * Имя проверено живой документацией 23.08.2026 (ai.google.dev/api/live,
 * ai.google.dev/gemini-api/docs/live): в примерах setup-сообщения используется
 * `models/gemini-3.1-flash-live-preview`. Как и у GEMINI_MODEL, имя может смениться
 * без выката кода — через переменную окружения.
 *
 * ⚠️ НЕ ПРОВЕРЕНО ЖИВЫМ ЗВОНКОМ. Ни это имя, ни сам протокол WebSocket ни разу не
 * были опробованы на реальном соединении — только сверены с документацией. См.
 * докстринг ai/liveVoiceClient.ts и lib/telephony/liveVoiceBridge.ts.
 */
export const GEMINI_LIVE_MODEL = process.env.GEMINI_LIVE_MODEL || "gemini-3.8-live";

/**
 * ПРЕЖНЯЯ МОДЕЛЬ ЖИВОГО ГОЛОСА — ЗАПАСНАЯ (24.09.2026, робозвонок-консультант).
 *
 * 15.09.2026 Google выпустил `gemini-3.8-live` (ai.google.dev/gemini-api/docs/models:
 * «Legacy Live API preview model. We recommend updating to Gemini 3.8 Live» — о
 * `gemini-3.1-flash-live-preview`). Цена та же, а главное отличие для телефона —
 * вызов функции больше не замораживает разговор: у 3.1 «function calling is
 * sequential only», и на время поиска квартиры в трубке стояла тишина.
 *
 * Имя новой модели прочитано из документации через пересказ (прямой запрос к
 * ai.google.dev из облачной сессии закрыт), живым звонком ещё не проверено. Поэтому
 * прежняя модель остаётся запасной: если Google отклонит setup новой, клиент
 * (ai/liveVoiceClient.ts) сам откроет сессию на этой, и звонок не сорвётся.
 */
export const GEMINI_LIVE_LEGACY_MODEL = "gemini-3.1-flash-live-preview";

/** Порядок попыток открыть Live-сессию: явно заданная модель (или основная),
 *  затем запасная. Повторы убираются — если в окружении прописана прежняя модель,
 *  попытка одна. */
export function liveVoiceModelChain(preferred: string = GEMINI_LIVE_MODEL): string[] {
  return [...new Set([preferred, GEMINI_LIVE_LEGACY_MODEL])];
}

/** Модель умеет асинхронные функции (NON_BLOCKING по умолчанию, поле scheduling в
 *  ответе) — линейка 3.8 и новее. У 3.1 вызов функции блокирует разговор, и поле
 *  scheduling ей не отправляем. */
export function liveModelSupportsAsyncTools(model: string): boolean {
  const m = /^gemini-(\d+)\.(\d+)/.exec(model);
  if (!m) return false;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  return major > 3 || (major === 3 && minor >= 8);
}

/**
 * ЦЕПОЧКИ TTS-МОДЕЛЕЙ — вынесены сюда из ai/tts.ts и lib/telephony/whisperAudio.ts
 * (пачка 7, 11.09.2026), рядом с остальными именами моделей репозитория, по той же
 * причине, что и GEMINI_MODEL выше: имя должно жить в одном месте, а не копией в
 * каждом потребителе.
 *
 * ФОРМАТ — СПИСОК ЧЕРЕЗ ЗАПЯТУЮ, СТАБИЛЬНАЯ ПЕРВОЙ (как и GEMINI_FALLBACK_MODEL
 * выше): synthesizeSpeech (ai/tts.ts) идёт по списку слева направо и переключается
 * на следующую модель ТОЛЬКО на HTTP 404 — «этой модели больше нет» — а не на любую
 * ошибку, чтобы не прятать реальные сбои (квота, сеть) переходом на другую модель.
 *
 * СЕГОДНЯ В ЦЕПОЧКЕ РОВНО ОДНО ИМЯ, И ОНО PREVIEW (обе TTS-линейки Gemini на день
 * написания существуют только в статусе preview — стабильной TTS-модели Google пока
 * не выпустил, сверено на ai.google.dev/gemini-api/docs/models). Чем дальше preview
 * закроют, файл узнает об этом через logSystemError с понятным текстом (см.
 * synthesizeSpeech), а не тишиной. Как только Google выпустит стабильную версию,
 * добавить её ПЕРВОЙ строкой через запятую в GEMINI_TTS_MODELS / GEMINI_WHISPER_TTS_MODELS
 * (.env) — имя сверить живым запросом, не выдумывать (см. предупреждение у GEMINI_MODEL).
 */
export const GEMINI_TTS_MODELS = (process.env.GEMINI_TTS_MODELS || process.env.GEMINI_TTS_MODEL || "gemini-2.5-flash-preview-tts")
  .split(",")
  .map((m) => m.trim())
  .filter(Boolean);

/**
 * Модель озвучки телефонной подсказки — своя цепочка (см. WHISPER_TTS_MODEL было в
 * lib/telephony/whisperAudio.ts): таджикский текст на `gemini-2.5-flash-preview-tts`
 * молчит без ошибки (проверено 20.08.2026), нужна отдельная модель.
 */
export const GEMINI_WHISPER_TTS_MODELS = (
  process.env.GEMINI_WHISPER_TTS_MODELS || process.env.GEMINI_WHISPER_TTS_MODEL || "gemini-3.1-flash-tts-preview"
)
  .split(",")
  .map((m) => m.trim())
  .filter(Boolean);

/**
 * ОДНА ЗАПИСЬ В ЖУРНАЛ В ЧАС НА ПЕРЕХОД МЕЖДУ МОДЕЛЯМИ, А НЕ НА КАЖДЫЙ ВЫЗОВ
 * (пачка 7, 11.09.2026). Переключение на резервную модель при 404 происходит на
 * КАЖДОМ вызове synthesizeSpeech, пока основную модель не вернут/не поправят в
 * .env, — без ограничения это тот же журнал-спам, что был у 429 до 21.08.2026
 * (см. QUOTA_PAUSE_STEPS_MS в ai/tts.ts). Ключ — своя строка на каждую точку
 * перехода (например "tts:gemini-2.5-flash-preview-tts"), чтобы переход одной
 * модели не глушил запись про переход другой.
 */
const modelFallbackLoggedAt = new Map<string, number>();
const MODEL_FALLBACK_LOG_INTERVAL_MS = 60 * 60 * 1000;
export function shouldLogGeminiModelFallback(key: string): boolean {
  const last = modelFallbackLoggedAt.get(key);
  if (last !== undefined && Date.now() - last < MODEL_FALLBACK_LOG_INTERVAL_MS) return false;
  modelFallbackLoggedAt.set(key, Date.now());
  return true;
}
/** Только для тестов — см. resetTtsQuotaPause в ai/tts.ts, тот же приём. */
export function resetGeminiModelFallbackLog(): void {
  modelFallbackLoggedAt.clear();
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
