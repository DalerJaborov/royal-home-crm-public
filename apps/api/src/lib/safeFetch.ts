import dns from "node:dns/promises";
import net from "node:net";

/**
 * Загрузка по ссылке, которую нам прислал посторонний человек.
 *
 * Обычный `fetch` здесь опасен, и не теоретически. Адрес приходит из сообщения
 * клиента или из вложения Meta, а наш сервер стоит внутри сети, где по соседству
 * живут база, АТС и служебные адреса облака. Ссылка вида `http://127.0.0.1:4000`,
 * `http://169.254.169.254/latest/meta-data/` (ключи облака) или `http://postgres:5432`
 * заставила бы CRM сходить туда за клиента и принести ответ — это называется SSRF
 * и стоит ровно столько же, сколько стоит весь сервер.
 *
 * Поэтому здесь три вещи, которых нет у голого fetch:
 *
 *  1. АДРЕС ПРОВЕРЯЕТСЯ ПО IP, А НЕ ПО ИМЕНИ. Проверять строку бессмысленно:
 *     `localtest.me` и тысячи других имён указывают на 127.0.0.1, а имя выглядит
 *     обычным. Поэтому имя резолвится, и запрет ставится на сам адрес.
 *  2. КАЖДЫЙ ПЕРЕХОД ПРОВЕРЯЕТСЯ ЗАНОВО. Публичный адрес может ответить
 *     «переезжай на 127.0.0.1», и без проверки редиректа вся защита обходится
 *     одним заголовком Location.
 *  3. ПОТОЛОК И ТАЙМАУТ ОБЯЗАТЕЛЬНЫ. Иначе один медленный сайт держит ход бота,
 *     а один большой файл съедает память контейнера.
 *
 * Оговорка честности: между проверкой имени и запросом адрес теоретически может
 * смениться (DNS rebinding). Полная защита требует своего резолвера с привязкой
 * IP к соединению; здесь взят разумный уровень — он закрывает всё, что делается
 * руками из чата, и не закрывает целенаправленную атаку с собственным DNS.
 *
 * ДВА ВХОДА, А НЕ ОДИН. `safeFetch` читает тело сам и годится там, где потолок
 * известен заранее (превью ссылки). Вложениям мессенджеров он не подходит: их
 * потолок зависит от типа файла, а тип становится известен только из заголовков
 * ответа — то есть уже внутри запроса. Для таких вызывающих есть `safeOpen`: он
 * доводит соединение до ответа с той же проверкой каждого перехода и отдаёт
 * ответ с НЕТРОНУТЫМ телом. Разделение нужно ровно для того, чтобы у второго
 * случая не завелась вторая копия цикла переходов — она разошлась бы с первой
 * при первой же правке, и половина защиты тихо осталась бы в старой версии.
 */

export interface SafeOpenOptions {
  /** Anonymous public metadata readers explicitly exclude ambient credentials. */
  credentials?: "omit";
  /** Optional original caller cancellation; no new deadline on redirects. */
  signal?: AbortSignal;
  /** Сколько ждём ответа. Ход бота не должен зависеть от чужого медленного сайта. */
  timeoutMs?: number;
  /** Сколько переходов разрешаем. Каждый проверяется отдельно. */
  maxRedirects?: number;
  headers?: Record<string, string>;
}

export interface SafeFetchOptions extends SafeOpenOptions {
  /** Потолок скачивания. Всё, что больше, обрывается на середине. */
  maxBytes?: number;
}

const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_REDIRECTS = 3;

/** Почему ссылку не открыли. Текст уходит в журнал, а не клиенту. */
export class UnsafeUrlError extends Error {}

/**
 * Внутренние диапазоны, куда ходить нельзя ни при каких условиях.
 *
 * Список нарочно перечислен полностью и с пояснениями: «приватные адреса» звучит
 * очевидно ровно до того момента, когда кто-нибудь забудет 169.254 — тот самый
 * адрес, по которому облака отдают ключи доступа без всякой авторизации.
 */
function isForbiddenAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    if (a === 0) return true; // «этот хост»
    if (a === 10) return true; // частная сеть
    if (a === 127) return true; // петля: наш же сервер
    if (a === 169 && b === 254) return true; // метаданные облака — ключи доступа
    if (a === 172 && b >= 16 && b <= 31) return true; // частная сеть, в т.ч. docker
    if (a === 192 && b === 168) return true; // домашняя/офисная сеть
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a >= 224) return true; // multicast и зарезервированное
    return false;
  }
  const v6 = ip.toLowerCase();
  if (v6 === "::1" || v6 === "::") return true;
  if (v6.startsWith("fe80")) return true; // link-local
  if (v6.startsWith("fc") || v6.startsWith("fd")) return true; // уникальные локальные

  /**
   * IPv4, завёрнутый в IPv6, — та же петля, другая запись. И записей этих ДВЕ.
   *
   * `new URL("http://[::ffff:127.0.0.1]/")` нормализует имя в `[::ffff:7f00:1]` —
   * то есть в шестнадцатеричный вид, где 7f00 = 127.0, а 0001 = 0.1. Проверка
   * только точечной записи пропускала такой адрес насквозь: тест это и поймал,
   * прежде чем поймал бы кто-то другой.
   */
  const mappedDotted = v6.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mappedDotted) return isForbiddenAddress(mappedDotted[1]);

  const mappedHex = v6.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mappedHex) {
    const high = parseInt(mappedHex[1], 16);
    const low = parseInt(mappedHex[2], 16);
    return isForbiddenAddress([high >> 8, high & 0xff, low >> 8, low & 0xff].join("."));
  }
  return false;
}

/**
 * Проверяет один адрес: схема, имя, все его IP. Бросает UnsafeUrlError.
 *
 * Проверяются ВСЕ адреса имени, а не первый: имя может отдавать и публичный, и
 * внутренний адрес одновременно, и выбор между ними от нас не зависит.
 */
export async function assertPublicUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeUrlError("не адрес");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    // file:, ftp:, gopher: — то, чем классически и вытаскивают файлы с сервера.
    throw new UnsafeUrlError(`схема ${url.protocol} запрещена`);
  }

  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host)) {
    if (isForbiddenAddress(host)) throw new UnsafeUrlError(`внутренний адрес ${host}`);
    return url;
  }

  let records: { address: string }[];
  try {
    records = await dns.lookup(host, { all: true });
  } catch {
    throw new UnsafeUrlError(`имя ${host} не разрешается`);
  }
  if (records.length === 0) throw new UnsafeUrlError(`у имени ${host} нет адресов`);
  for (const record of records) {
    if (isForbiddenAddress(record.address)) {
      throw new UnsafeUrlError(`имя ${host} указывает внутрь сети (${record.address})`);
    }
  }
  return url;
}

export interface SafeResponse {
  url: string;
  status: number;
  contentType: string;
  body: Buffer;
  /** Ответ оборвался о потолок — тело неполное. */
  truncated: boolean;
}

export interface SafeOpened {
  res: Response;
  /** Адрес, с которого пришёл ответ, — уже ПОСЛЕ всех переходов. */
  url: URL;
}

/**
 * Заголовки-пропуска, которые нельзя тащить за собой на ЧУЖОЙ хост.
 *
 * Скачивание медиа WhatsApp идёт с маркером Meta в Authorization (см.
 * whatsAppMediaSource). Пока переходами занимался сам fetch, маркер на смене
 * хоста отбрасывал он — так велит спецификация, и на это никто не смотрел. Стоит
 * переложить переходы на себя, как ответственность переходит сюда: без этого
 * отбрасывания ссылка «302 → чужой сайт» уносила бы наш рабочий маркер Meta тому,
 * кто эту ссылку прислал. Дыра ровно того же рода, что и сам SSRF, только утекает
 * не ответ изнутри сети, а ключ наружу.
 */
const CREDENTIAL_HEADERS = new Set(["authorization", "cookie", "proxy-authorization"]);

function withoutCredentials(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !CREDENTIAL_HEADERS.has(name.toLowerCase())));
}

/**
 * Доводит соединение до ответа, проверяя КАЖДЫЙ переход, и отдаёт ответ с
 * непрочитанным телом — читает его вызывающий, своим потолком.
 *
 * ПОЧЕМУ КАЖДЫЙ ПЕРЕХОД, А НЕ ТОЛЬКО ПЕРВЫЙ. Обычный `fetch` идёт по редиректам
 * сам и молча: проверенный публичный адрес отвечает «302 → http://169.254.169.254/»
 * или «302 → http://postgres:5432/», и мы сами приносим наружу то, что лежит
 * внутри сети. Проверка одного лишь первого адреса не защищает ни от чего —
 * она обходится одним заголовком Location, который пишет тот же человек, что
 * прислал ссылку.
 *
 * Отказ — это исключение, а не `null`: вызывающему нужна причина (истёкшая
 * подпись CDN, таймаут, запрещённый адрес) для журнала, и она же решает,
 * повторять ли попытку.
 */
export async function safeOpen(raw: string, options: SafeOpenOptions = {}): Promise<SafeOpened> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;

  let current = raw;
  let headers = options.headers;
  let origin: string | null = null;
  // Общий срок на ВСЮ цепочку переходов, а не на каждый: три редиректа по восемь
  // секунд — это двадцать четыре секунды тишины в переписке.
  const deadline = Date.now() + timeoutMs;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    options.signal?.throwIfAborted();
    const url = await assertPublicUrl(current);
    options.signal?.throwIfAborted();
    if (origin !== null && url.origin !== origin && headers) headers = withoutCredentials(headers);
    origin = url.origin;

    const left = deadline - Date.now();
    if (left <= 0) throw new Error(`таймаут ${timeoutMs} мс`);

    const res = await fetch(url, {
      // Ключевая строка всего модуля: переходы разбираем сами, иначе следующий
      // адрес никем не проверяется.
      redirect: "manual",
      ...(options.credentials ? { credentials: options.credentials } : {}),
      headers,
      signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(left)]) : AbortSignal.timeout(left),
    });

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      await res.body?.cancel();
      if (!location) throw new Error(`HTTP ${res.status} без Location`);
      // Относительный переход разрешаем от текущего адреса — так же, как браузер.
      current = new URL(location, url).toString();
      continue;
    }

    if (!res.ok) {
      await res.body?.cancel();
      throw new Error(`HTTP ${res.status}`);
    }
    return { res, url };
  }
  throw new Error(`больше ${maxRedirects} перенаправлений подряд`);
}

/**
 * Скачивает по ссылке с проверкой каждого перехода и потолком размера.
 * Возвращает null, если ссылка не наша забота (отказ, таймаут, слишком большой
 * файл); причина уходит вызывающему исключением только при явно опасном адресе.
 */
export async function safeFetch(raw: string, options: SafeFetchOptions = {}): Promise<SafeResponse | null> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

  let opened: SafeOpened;
  try {
    opened = await safeOpen(raw, options);
  } catch (err) {
    // Запрещённый адрес — не «не получилось», а сработавшая защита, и вызывающий
    // (lib/linkPreview.ts) пишет про него отдельную строку в журнал. Всё остальное
    // — обычный отказ чужого сайта, о котором ему знать нечего.
    if (err instanceof UnsafeUrlError) throw err;
    return null;
  }

  const { res, url } = opened;
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > maxBytes) {
    await res.body?.cancel();
    return null;
  }

  const { body, truncated } = await readCapped(res, maxBytes);
  return {
    url: url.toString(),
    status: res.status,
    contentType: res.headers.get("content-type") ?? "",
    body,
    truncated,
  };
}

/**
 * Читает тело кусками и обрывает на потолке.
 *
 * Именно кусками, а не `arrayBuffer()`: тот честно прочитает и гигабайт, если
 * сервер соврал в Content-Length или не прислал его вовсе — а память у контейнера
 * общая с базой.
 *
 * Экспортируется, потому что ровно та же беда есть у вложений из мессенджеров
 * (messengers/attachments.ts): там свой потолок, свой у каждого вида файла, но
 * обрываться чтение должно одним и тем же кодом — вторая копия этой функции
 * разошлась бы с первой при первой же правке.
 */
export async function readCapped(res: Response, maxBytes: number): Promise<{ body: Buffer; truncated: boolean }> {
  /**
   * ОТВЕТ БЕЗ ПОТОКА — не всегда пустой ответ.
   *
   * У настоящего `fetch` тело потоком есть всегда, но подменённый в тестах ответ
   * (и некоторые полифиллы) отдают только `arrayBuffer()`. Возвращать в этом случае
   * пустой буфер значит молча терять содержимое: живой пример 21.08.2026 —
   * автоответчик перестал расшифровывать сообщения клиентов ровно потому, что
   * загрузчик перешёл на чтение по кускам, а заглушка ответа потока не имела.
   *
   * Читаем целиком и проверяем размер после — защита от переполнения памяти здесь
   * слабее, но этот путь и не встречается там, где приходят чужие файлы.
   */
  if (!res.body) {
    const whole = Buffer.from(await res.arrayBuffer());
    return whole.byteLength > maxBytes
      ? { body: whole.subarray(0, maxBytes), truncated: true }
      : { body: whole, truncated: false };
  }
  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      truncated = true;
      await reader.cancel().catch(() => {});
      break;
    }
    chunks.push(Buffer.from(value));
  }
  return { body: Buffer.concat(chunks), truncated };
}
