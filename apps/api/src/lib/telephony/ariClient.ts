import { decryptSecretSafe } from "../../crypto.js";
import { prisma } from "../../db.js";
import { logSystemError } from "../systemError.js";

/**
 * Этап 4 (телефония) — первый слой: подключение к Asterisk REST Interface (ARI).
 *
 * 07.08.2026 подключено к настоящей АТС агентства (FreePBX 15 / Asterisk 16 в офисе
 * в Душанбе), и код переписан под то, что там реально есть, — см.
 * docs/telephony-sip-numbering.md.
 *
 * Три вещи, которые важно знать, прежде чем менять этот файл:
 *
 *  1. Технология канала не зашита в код: на АТС живёт старый chan_sip (`SIP/1005`),
 *     а не chan_pjsip, поэтому она спрашивается у самой АТС через /ari/endpoints.
 *     Захардкоженный `PJSIP/` давал бы «endpoint not found» на каждом звонке.
 *  2. Никаких своих контекстов и Stasis-приложения на сервере не заводится: канал
 *     агента уходит в штатный `from-internal`, дальше FreePBX сам разбирается с
 *     маршрутом и транком. Рукописный диалплан на FreePBX стирается при «Apply Config».
 *  3. Agent.sipExtension — четырёхзначный номер (1003 и далее), выдаётся из пула,
 *     заведённого на АТС; свободные номера видны в /ari/endpoints.
 *
 * Что реализовано: проверка связи, список внутренних номеров с их состоянием,
 * звонок клиенту и звонок коллеге.
 *
 * Что ещё нет: событий звонков (StasisStart/Hangup) никто не слушает — ariEvents.ts
 * остаётся заготовкой, и Royal Score продолжает считать «дозвонился» по прежнему
 * суррогатному таймеру. Это отдельный шаг: сначала на живых звонках нужно увидеть,
 * какие события реально приходят.
 */

const CALL_TIMEOUT_MS = 5000;

/**
 * Единая точка записи отказов ARI в журнал (22.09.2026, разбор «отказ не доходит
 * до журнала» — весь модуль отвечал станцией только вызывающему коду, {ok:false}
 * или исключением, а писал ли это кто-то в ErrorLog, зависело от места вызова: не
 * писал почти никто. Связь со станцией — самое частое, что отваливается, и
 * владелец видел только «звонки не идут», без единой строки в журнале.
 *
 * Пишем здесь, а не у каждого вызывающего: тогда отказ виден независимо от того,
 * читает ли конкретный маршрут возвращённый {ok:false} или (как в части мест
 * очистки в liveVoiceBridge.ts) отбрасывает результат вовсе. Десятиминутная
 * дедупликация logSystemError сама схлопывает шторм одинаковых отказов при
 * лежащей станции — текст стабилен (без channelId/bridgeId в начале сообщения).
 */
function logAriFailure(message: string): void {
  void logSystemError("telephony", `АТС (ARI): ${message}`);
}

export interface AriCredentials {
  url: string;
  username: string;
  password: string;
}

/** Читает и расшифровывает креды ARI из Settings. null — телефония не настроена. */
export async function loadAriCredentials(): Promise<AriCredentials | null> {
  const settings = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { asteriskAriUrl: true, asteriskAriUsername: true, asteriskAriPassword: true },
  });
  const password = decryptSecretSafe(settings?.asteriskAriPassword ?? null);
  if (!settings?.asteriskAriUrl || !settings?.asteriskAriUsername || !password) return null;
  return { url: settings.asteriskAriUrl.replace(/\/+$/, ""), username: settings.asteriskAriUsername, password };
}

/** Звонить агенту на мобильный (софтфонов ещё нет) или на внутренний номер. */
export type AgentDialMode = "mobile" | "extension" | "auto";

export async function loadAgentDialMode(): Promise<AgentDialMode> {
  const settings = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { asteriskAgentDialMode: true },
  });
  const mode = settings?.asteriskAgentDialMode;
  if (mode === "extension" || mode === "auto") return mode;
  return "mobile";
}

/**
 * Куда на самом деле звонить сотруднику — с учётом режима «авто».
 *
 * ЗАЧЕМ РЕЖИМ «АВТО» (владелец 11.08.2026: «опять работает с переадресацией на
 * исходящие вызовы?»). В режиме «мобильный» звонок сотруднику уходит НАРУЖУ через
 * тот же транк, что и звонок клиенту: в журнале станции один разговор выглядит как
 * два платных вызова (`6501414 → 930001001` и `6501414 → клиент`), а сотруднику на
 * трубку приходит номер собственного агентства — то есть ровно как переадресация,
 * которой никто не заказывал. Плата при этом идёт за оба плеча.
 *
 * Если у сотрудника есть зарегистрированный аппарат (софтфон или телефон на столе),
 * правильный ответ — звонить на него: плечо внутреннее, бесплатное и мгновенное.
 * Но аппарат есть не у всех и не всегда включён, поэтому «авто» спрашивает станцию
 * о состоянии и падает на мобильный, когда аппарат не на связи. Жёсткие режимы
 * оставлены: «мобильный» — когда софтфонов нет вовсе, «внутренний» — когда владелец
 * хочет запретить платное плечо даже ценой недозвона.
 *
 * `unknown` у chan_sip означает «заведён, но ни разу не регистрировался» — то есть
 * трубки нет, и звонить туда нельзя: считаем это тем же «не на связи».
 */
export async function resolveAgentDialTarget(
  creds: AriCredentials,
  agentExtension: string,
  agentMobilePhone: string | null,
  mode: AgentDialMode
): Promise<{ agentMobile: string | null; effectiveMode: "mobile" | "extension" }> {
  if (mode === "extension") return { agentMobile: null, effectiveMode: "extension" };
  if (mode === "mobile") return { agentMobile: agentMobilePhone, effectiveMode: "mobile" };

  // Мобильного нет вовсе — выбирать не из чего, пробуем аппарат.
  if (!agentMobilePhone) return { agentMobile: null, effectiveMode: "extension" };

  try {
    const endpoints = await listEndpoints(creds);
    if (agentDeviceOnline(endpoints, agentExtension)) return { agentMobile: null, effectiveMode: "extension" };
  } catch {
    // Станция не ответила на справочный запрос — звонок из-за этого не срываем:
    // мобильный работает всегда, аппарат — не факт.
  }
  return { agentMobile: agentMobilePhone, effectiveMode: "mobile" };
}

/**
 * Есть ли у сотрудника ХОТЬ ОДНО живое устройство: софтфон на внутреннем номере
 * ИЛИ аппарат `rh-web-<номер>`, если такой ещё заведён на самой станции.
 *
 * Браузерных трубок CRM больше не выдаёт (18.08.2026, софтфон удалён), но имя
 * `rh-web-*` здесь остаётся сознательно: конфигурацию станции мы не трогаем, и
 * пока эндпоинт на ней жив и регистрируется, «устройство под рукой» — правда.
 * Убрать проверку значило бы звонить на платное мобильное плечо там, где звонок
 * дошёл бы бесплатно.
 */
export function agentDeviceOnline(endpoints: AriEndpoint[], extension: string): boolean {
  return endpoints.some(
    (e) => (e.resource === extension || e.resource === `rh-web-${extension}`) && e.state === "online"
  );
}

export interface AriConnectionResult {
  ok: boolean;
  /** Версия Asterisk из /ari/asterisk/info — доказательство, что это реально ARI, а не случайный порт. */
  version?: string;
  error?: string;
}

/** GET /ari/asterisk/info с Basic-авторизацией — самый дешёвый способ убедиться,
 *  что URL/логин/пароль верны и порт ARI открыт, не заводя ни канала, ни звонка. */
export async function testAriConnection(creds: AriCredentials): Promise<AriConnectionResult> {
  const auth = Buffer.from(`${creds.username}:${creds.password}`).toString("base64");
  try {
    const res = await fetch(`${creds.url}/ari/asterisk/info`, {
      headers: { Authorization: `Basic ${auth}` },
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
    if (res.status === 401) {
      logAriFailure("проверка связи — неверный логин или пароль ARI");
      return { ok: false, error: "Неверный логин или пароль ARI" };
    }
    if (!res.ok) {
      logAriFailure(`проверка связи — Asterisk ответил HTTP ${res.status}`);
      return { ok: false, error: `Asterisk ответил HTTP ${res.status}` };
    }
    const data = (await res.json()) as { system?: { version?: string } };
    return { ok: true, version: data.system?.version };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Таймаут/ECONNREFUSED — сервер недоступен по этому адресу или порт ARI закрыт
    // (в /etc/asterisk/http.conf нужен `enabled = yes` и `bindport`, в ari.conf —
    // включённый пользователь под `[general] enabled = yes`).
    logAriFailure(`проверка связи — не удалось соединиться: ${message}`);
    return { ok: false, error: `Не удалось соединиться: ${message}` };
  }
}

export interface OriginateCallResult {
  ok: boolean;
  /** ID канала ARI (channels[].id из ответа Originate) — пригодится позже для
   *  сопоставления событий Stasis/Hangup с этим конкретным звонком. */
  channelId?: string;
  error?: string;
}

/**
 * Контекст диалплана, куда попадает канал агента после того, как тот поднял трубку.
 * `from-internal` — штатный контекст FreePBX, тот же, в который звонит софтфон
 * сотрудника: в нём уже описаны исходящие маршруты, транки, ограничения и запись
 * CDR. Поэтому CRM не заводит собственных контекстов на АТС вообще — она передаёт
 * номер клиента так, будто агент набрал его сам.
 *
 * Экспортирован — нужен и живому голосу (liveVoiceBridge.ts) для исходящего
 * тестового звонка тем же путём, каким уже звонят агенту на мобильный.
 */
export const DIALPLAN_CONTEXT = "from-internal";

export interface AriEndpoint {
  technology: string;
  resource: string;
  /** online | offline | unknown — «unknown» у chan_sip означает, что телефон
   *  заведён, но ни разу не регистрировался (или мониторинг выключен). */
  state: string;
}

/** GET /ari/endpoints — какие внутренние номера реально существуют на АТС и в каком
 *  они состоянии. Используется и для автоопределения технологии канала, и для
 *  показа «телефон на связи / не подключён» в Настройках → Сотрудники. */
export async function listEndpoints(creds: AriCredentials): Promise<AriEndpoint[]> {
  const auth = Buffer.from(`${creds.username}:${creds.password}`).toString("base64");
  const res = await fetch(`${creds.url}/ari/endpoints`, {
    headers: { Authorization: `Basic ${auth}` },
    signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
  });
  if (!res.ok) {
    logAriFailure(`список внутренних номеров — Asterisk ответил HTTP ${res.status}`);
    throw new Error(`Asterisk ответил HTTP ${res.status}`);
  }
  return (await res.json()) as AriEndpoint[];
}

/**
 * Тот же список аппаратов, но с ОДНОЙ повторной попыткой.
 *
 * Зачем (жалоба владельца 20.09.2026: «ставлю настройки, обновляется и пропадает
 * всё, и вот такие ошибки»): один сорванный запрос к станции превращал экран
 * сотрудников в девять строк «трубка не подключена» и печатал «АТС недоступна»
 * поверх только что сохранённого номера. Связь со станцией идёт через туннель и
 * срывается поштучно, а не надолго, — вторая попытка через полсекунды почти
 * всегда отвечает.
 *
 * Только для СПРАВОЧНЫХ чтений (состав пула номеров, отметки «трубка на связи»).
 * Действия над звонками сюда не заводим: там повтор означал бы второй звонок.
 */
export async function listEndpointsRetrying(creds: AriCredentials): Promise<AriEndpoint[]> {
  try {
    return await listEndpoints(creds);
  } catch (err) {
    // Первая попытка сорвалась молча — до 22.09.2026 такие одиночные обрывы
    // туннеля были не видны никому: вторая попытка почти всегда успевает, и
    // отказ нигде не оставался. Пишем сюда же и на успешный повтор — иначе
    // директор не узнает, что связь со станцией всё-таки моргает, просто
    // не настолько, чтобы уронить экран.
    logAriFailure(
      `первая попытка получить список внутренних номеров сорвалась (повтор через ${ENDPOINTS_RETRY_DELAY_MS} мс): ${err instanceof Error ? err.message : String(err)}`
    );
    await new Promise((resolve) => setTimeout(resolve, ENDPOINTS_RETRY_DELAY_MS));
    return listEndpoints(creds);
  }
}

/** Пауза перед второй попыткой справочного чтения: меньше, чем человек замечает,
 *  и достаточно, чтобы туннель успел подняться после одиночного обрыва. */
const ENDPOINTS_RETRY_DELAY_MS = 500;

/**
 * Сколько каналов вообще имеет смысл разбирать после переподписки.
 *
 * У станции агентства в эфире единицы каналов; сотни — это либо шторм, либо чужая
 * станция. Предел стоит здесь, а не у вызывающего, чтобы ни один путь не смог
 * случайно прогнать через обработку весь ответ целиком.
 */
export const ACTIVE_CHANNELS_LIMIT = 200;

/**
 * GET /ari/channels — какие разговоры идут на станции ПРЯМО СЕЙЧАС.
 *
 * ЗАЧЕМ. События ARI не хранятся: пока подписка оборвана, станция пишет в свой лог
 * «Inactive Stasis app missed message» и выбрасывает событие навсегда. Звонок,
 * начавшийся в эти 4–15 секунд, для CRM не существовал бы вовсе — ни карточки, ни
 * перевода на ответственного. Единственный способ узнать о нём — после
 * восстановления связи спросить станцию, что у неё в эфире (см. ariEvents.ts →
 * resyncActiveChannels).
 *
 * Отказ бросается: решение «молчать или писать в журнал» принимает вызывающий.
 */
export async function listActiveChannels(
  creds: AriCredentials,
  timeoutMs: number = CALL_TIMEOUT_MS
): Promise<AriChannelSnapshot[]> {
  const auth = Buffer.from(`${creds.username}:${creds.password}`).toString("base64");
  const res = await fetch(`${creds.url}/ari/channels`, {
    headers: { Authorization: `Basic ${auth}` },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`Asterisk ответил HTTP ${res.status}`);
  const data = (await res.json()) as AriChannelSnapshot[];
  return Array.isArray(data) ? data.slice(0, ACTIVE_CHANNELS_LIMIT) : [];
}

/** Канал в том виде, в каком его отдаёт /ari/channels — та же форма, что в событиях. */
export type AriChannelSnapshot = import("./ariTypes.js").AriChannel;

/**
 * Технология канала (`SIP` у chan_sip, `PJSIP` у chan_pjsip) не задаётся руками, а
 * спрашивается у самой АТС: на сервере владельца живёт chan_sip, но при переезде на
 * chan_pjsip (FreePBX умеет конвертировать) настройка сменится сама, без правки кода
 * и без звонков, которые молча перестали проходить.
 *
 * Ответ кэшируется на время жизни процесса: технология меняется раз в несколько лет,
 * а звонок не должен ждать лишнего запроса.
 */
let cachedTech: { url: string; tech: string } | null = null;

export async function resolveChannelTech(creds: AriCredentials, extension: string): Promise<string> {
  if (cachedTech?.url === creds.url) return cachedTech.tech;
  try {
    const endpoints = await listEndpoints(creds);
    const mine = endpoints.find((e) => e.resource === extension);
    const tech = mine?.technology ?? endpoints[0]?.technology ?? "PJSIP";
    cachedTech = { url: creds.url, tech };
    return tech;
  } catch (err) {
    // Список не получен (сеть моргнула) — не срываем звонок: берём то, что стоит
    // на сервере владельца сегодня. Хуже всего здесь было бы бросить исключение и
    // оставить агента без звонка из-за необязательного справочного запроса.
    //
    // Откат на кэш (или на "SIP" вовсе без кэша) до 22.09.2026 был совсем не виден:
    // звонок всё равно проходил, и отказ станции на этом справочном запросе не
    // оставлял ни следа — а именно здесь решается, каким каналом реально звонить.
    logAriFailure(
      `технология канала не определена, откат на ${cachedTech?.tech ?? "SIP"}: ${err instanceof Error ? err.message : String(err)}`
    );
    return cachedTech?.tech ?? "SIP";
  }
}

/**
 * Номер в тот вид, который принимает транк агентства.
 *
 * Формат подтверждён журналом звонков самой АТС: успешный исходящий выглядит как
 * `6501414 → 930001001`, то есть оператор ждёт МЕСТНЫЕ ДЕВЯТЬ ЦИФР — без «+», без
 * кода страны 992 и без ведущего нуля. А в CRM номера хранятся международными
 * (`+992930001001`), как их присылают WhatsApp и сайт. Без этого преобразования
 * каждый звонок уходил бы в никуда: маршрут пропускает любой набор (шаблон «.»),
 * поэтому ошибка проявилась бы не отказом, а тишиной в трубке.
 *
 * Международные номера (не +992) остаются как есть, без кода страны их не набрать.
 */
export function normalizeDialNumber(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  // +992 XX XXX XX XX → девять цифр
  if (digits.length === 12 && digits.startsWith("992")) return digits.slice(3);
  // 0 XX XXX XX XX — местная запись с ведущим нулём
  if (digits.length === 10 && digits.startsWith("0")) return digits.slice(1);
  return digits;
}

/**
 * Можно ли вообще набрать этот номер через наш транк — те же три формы, что
 * понимает normalizeDialNumber, но здесь именно ПРОВЕРКА, а не преобразование.
 *
 * Нужна отдельно от normalizeDialNumber (20.08.2026): звонок на дополнительный
 * номер клиента (WhatsApp-номер, запасной номер) сначала должен пройти фильтр —
 * международный номер (не +992) транк не наберёт вовсе, и предлагать кнопку
 * «Позвонить» на него означало бы гарантированный отказ станции без объяснения.
 *
 * Само правило с 22.09.2026 лежит в общем пакете: сайт проверял то же самое
 * своей копией, и разойдись они — агент видит кнопку, а звонок не уходит, что
 * выглядит как поломка телефонии, а не как разная проверка номера
 * (packages/shared/src/tajikPhone.ts, правка #752).
 */
export { isDialableTajikNumber } from "@royal-home/shared";

/**
 * Звонок из карточки клиента: сначала звонит телефон агента, а когда тот берёт
 * трубку — АТС сама набирает клиента.
 *
 * Реализовано штатным для Asterisk способом «Originate в диалплан»: канал агента
 * после ответа отправляется в контекст `from-internal` с номером клиента в качестве
 * набранного. Дальше всё делает FreePBX — выбирает исходящий маршрут, транк, пишет
 * CDR. Своего контекста, Stasis-приложения и переменных диалплана не требуется:
 * раньше здесь был именно такой вариант, но он предполагал, что на сервере кто-то
 * вручную опишет контекст и подставит имя транка. На живой FreePBX это лишний
 * рукописный слой, который ломается при каждом «Apply Config».
 */
export async function originateCall(
  creds: AriCredentials,
  agentExtension: string,
  targetPhoneNumber: string,
  options?: {
    /** Кого показать на трубке агента, когда та зазвонит. Без этого агент видел бы
     *  собственный внутренний номер и не понимал, кому собирается говорить «алло». */
    callerName?: string;
    /** Мобильный агента. Задан — станция звонит на него, а не на софтфон (режим
     *  "mobile" в Настройках). Пустой — звоним на внутренний номер. */
    agentMobile?: string | null;
    /**
     * ПОДСКАЗКА АГЕНТУ ПЕРЕД НАБОРОМ КЛИЕНТА (docs/telephony-whisper.md). Задана —
     * канал агента уходит не в штатный `from-internal`, а в наш контекст: тот сперва
     * играет человеку короткую справку о клиенте, и только потом набирает номер.
     *
     * Вызывающий обязан САМ убедиться, что контекст на станции есть (stationHasContext
     * в inboundRouting.ts). Отправить звонок в несуществующий контекст значит не
     * позвонить вовсе — а исходящий звонок важнее любой подсказки.
     */
    whisper?: { fileName: string; context: string; exten: string };
  }
): Promise<OriginateCallResult> {
  const auth = Buffer.from(`${creds.username}:${creds.password}`).toString("base64");
  // На мобильный агента звоним через Local-канал в тот же штатный контекст, а не
  // через `SIP/имя-транка/номер`: имя транка тогда пришлось бы держать в настройках
  // CRM и синхронизировать с АТС вручную. Local отдаёт выбор маршрута самой FreePBX —
  // ровно как если бы номер набрали с офисного аппарата.
  // Суффикс /n обязателен. Без него Asterisk «оптимизирует» Local-канал — схлопывает
  // его, как только разговор установился, — и вызов рвётся сам собой через десяток
  // секунд после соединения. Ровно это и наблюдалось на первых живых звонках:
  // клиенту шёл гудок, а потом всё обрывалось с причиной «нормальное завершение».
  /**
   * ВНУТРЕННИЙ НОМЕР ТОЖЕ НАБИРАЕТСЯ ЧЕРЕЗ ДИАЛПЛАН, а не каналом напрямую.
   *
   * `SIP/1006` звонит ровно одному устройству — софтфону. Но у сотрудника их
   * может быть два: софтфон и трубка в браузере CRM, и список «что звонит»
   * записан у станции в устройстве сотрудника (DEVICE dial:
   * `SIP/1006&PJSIP/rh-web-1006`). Возьмёт трубку то, что реально под рукой.
   * Прямой канал в обход диалплана оставлял браузер немым — сотрудник сидит в
   * CRM, а его вызов уходит на выключенный Zoiper.
   *
   * Суффикс /n обязателен по той же причине, что и у мобильного ниже: без него
   * Asterisk «оптимизирует» Local-канал и рвёт установленный разговор.
   */
  const agentEndpoint = options?.agentMobile
    ? `Local/${normalizeDialNumber(options.agentMobile)}@${DIALPLAN_CONTEXT}/n`
    : `Local/${agentExtension}@${DIALPLAN_CONTEXT}/n`;
  const target = normalizeDialNumber(targetPhoneNumber);
  const params = new URLSearchParams({
    endpoint: agentEndpoint,
    // Куда уходит канал агента после ответа — как если бы он набрал номер сам.
    // С подсказкой — в наш контекст: он играет справку и набирает клиента сам,
    // получив номер переменной канала (см. ниже).
    context: options?.whisper?.context ?? DIALPLAN_CONTEXT,
    extension: options?.whisper ? options.whisper.exten : target,
    priority: "1",
    // Определитель для трубки агента. Наружу он не уходит: исходящий маршрут FreePBX
    // подменяет его на номер агентства (Outbound CID), поэтому клиент видит единый
    // номер компании, а не внутренний и тем более не личный мобильный агента.
    callerId: options?.callerName ? `"${options.callerName}" <${agentExtension}>` : agentExtension,
    // Сколько станция ждёт ответа сотрудника. 30 секунд — это примерно пять гудков:
    // мобильный успевает достать из кармана далеко не каждый. Столько же потом
    // отводится на дозвон клиенту самим диалпланом.
    timeout: "60",
  });
  try {
    /**
     * Переменные канала ARI принимает ТОЛЬКО телом запроса, в query их не передать.
     * Без подсказки тело не отправляем вовсе — сохраняем ровно тот запрос, который
     * работает на живой станции с 07.08.2026.
     */
    const body = options?.whisper
      ? JSON.stringify({ variables: { RH_OUT_TARGET: target, RH_WHISPER: options.whisper.fileName } })
      : undefined;
    const res = await fetch(`${creds.url}/ari/channels?${params.toString()}`, {
      method: "POST",
      headers: body
        ? { Authorization: `Basic ${auth}`, "Content-Type": "application/json" }
        : { Authorization: `Basic ${auth}` },
      body,
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
    if (res.status === 401) {
      logAriFailure("исходящий звонок — неверный логин или пароль ARI");
      return { ok: false, error: "Неверный логин или пароль ARI" };
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      logAriFailure(`исходящий звонок отклонён: HTTP ${res.status}${body ? ` — ${body}` : ""}`);
      return { ok: false, error: `Asterisk отказал в звонке: HTTP ${res.status}${body ? ` — ${body}` : ""}` };
    }
    const data = (await res.json()) as { id?: string };
    return { ok: true, channelId: data.id };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logAriFailure(`исходящий звонок — не удалось соединиться с Asterisk: ${message}`);
    return { ok: false, error: `Не удалось соединиться с Asterisk: ${message}` };
  }
}

/**
 * Originate напрямую в Stasis-приложение, минуя диалплан на выходе у канала ;1
 * (в отличие от originateCall выше, который после ответа продолжает в
 * context/extension/priority). Единственный сегодняшний потребитель — исходящий
 * тестовый звонок живого голоса (liveVoiceBridge.ts): endpoint — Local-канал в
 * `from-internal`, ровно как у звонка агенту на мобильный, поэтому реальный набор
 * номера идёт уже проверенным путём, а плечо ;1 сразу становится звонком в нашем
 * Stasis-приложении, готовым к мосту с externalMedia.
 */
export async function originateToStasisApp(
  creds: AriCredentials,
  endpoint: string,
  app: string,
  options?: { callerId?: string; timeoutSeconds?: number }
): Promise<OriginateCallResult> {
  const auth = Buffer.from(`${creds.username}:${creds.password}`).toString("base64");
  const params = new URLSearchParams({
    endpoint,
    app,
    timeout: String(options?.timeoutSeconds ?? 30),
  });
  if (options?.callerId) params.set("callerId", options.callerId);
  try {
    const res = await fetch(`${creds.url}/ari/channels?${params.toString()}`, {
      method: "POST",
      headers: { Authorization: `Basic ${auth}` },
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
    if (res.status === 401) {
      logAriFailure("звонок в Stasis-приложение — неверный логин или пароль ARI");
      return { ok: false, error: "Неверный логин или пароль ARI" };
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      logAriFailure(`звонок в Stasis-приложение отклонён: HTTP ${res.status}${body ? ` — ${body}` : ""}`);
      return { ok: false, error: `Asterisk отказал в звонке: HTTP ${res.status}${body ? ` — ${body}` : ""}` };
    }
    const data = (await res.json()) as { id?: string };
    if (!data.id) logAriFailure("звонок в Stasis-приложение — канал создан без id в ответе");
    return data.id ? { ok: true, channelId: data.id } : { ok: false, error: "Канал создан без id в ответе" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logAriFailure(`звонок в Stasis-приложение — не удалось соединиться с Asterisk: ${message}`);
    return { ok: false, error: `Не удалось соединиться с Asterisk: ${message}` };
  }
}

/**
 * Сброс вызова — «положить трубку» за агента (кнопка «Отменить» на полосе звонка).
 *
 * Нужен для случая «нажал случайно» или «передумал»: до этого прервать начатый
 * вызов из CRM было нечем, оставалось ждать, пока станция сама устанет звонить.
 *
 * 404 — УСПЕХ, а не ошибка. Канала уже нет: клиент успел ответить и положить,
 * станция сбросила по таймауту, агент нажал «Отменить» дважды. Во всех этих
 * случаях цель достигнута — звонка больше нет, и отдавать человеку «ошибка»
 * означало бы врать. Отсюда же идемпотентность повторного нажатия.
 */
export async function hangupCall(
  creds: AriCredentials,
  channelId: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const auth = Buffer.from(`${creds.username}:${creds.password}`).toString("base64");
  try {
    const res = await fetch(`${creds.url}/ari/channels/${encodeURIComponent(channelId)}`, {
      method: "DELETE",
      headers: { Authorization: `Basic ${auth}` },
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
    if (res.status === 404) return { ok: true };
    if (res.status === 401) {
      logAriFailure("сброс вызова — неверный логин или пароль ARI");
      return { ok: false, error: "Неверный логин или пароль ARI" };
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      logAriFailure(`сброс вызова не удался: HTTP ${res.status}${body ? ` — ${body}` : ""}`);
      return { ok: false, error: `Asterisk не сбросил вызов: HTTP ${res.status}${body ? ` — ${body}` : ""}` };
    }
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logAriFailure(`сброс вызова — не удалось соединиться с Asterisk: ${message}`);
    return { ok: false, error: `Не удалось соединиться с Asterisk: ${message}` };
  }
}

/**
 * Значение переменной канала (GET /ari/channels/{id}/variable).
 *
 * ЗАЧЕМ. Диалплан FreePBX кладёт в канал агента итог дозвона КЛИЕНТУ: `DIALSTATUS`
 * (ANSWER / BUSY / NOANSWER / CONGESTION) и `ANSWEREDTIME` (сколько секунд шёл
 * разговор). Это единственный источник, который знает про второе плечо звонка
 * достоверно: события Dial приходят на оба плеча и по ним ответ САМОГО АГЕНТА
 * годами засчитывался как ответ клиента (см. ariEvents.ts).
 *
 * `null` — нормальный исход, а не отказ: канал к моменту запроса мог уже исчезнуть
 * (404), а переменной могло не быть вовсе (Asterisk отвечает 404 и на это). Сетевой
 * отказ бросается — про него человек должен узнать из журнала.
 */
export async function readChannelVariable(
  creds: AriCredentials,
  channelId: string,
  variable: string
): Promise<string | null> {
  const auth = Buffer.from(`${creds.username}:${creds.password}`).toString("base64");
  const url = `${creds.url}/ari/channels/${encodeURIComponent(channelId)}/variable?variable=${encodeURIComponent(variable)}`;
  const res = await fetch(url, {
    headers: { Authorization: `Basic ${auth}` },
    signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Asterisk ответил HTTP ${res.status}`);
  const data = (await res.json()) as { value?: string };
  const value = (data.value ?? "").trim();
  return value || null;
}

/**
 * НИЖЕ — ВЫЗОВЫ ARI ДЛЯ ЖИВОГО ГОЛОСА (пункт 5 очереди ИИ, 23.08.2026).
 *
 * Ничего из уже написанного выше (originateCall, DIALPLAN_CONTEXT `from-internal`,
 * работа с обычными звонками агентства) не трогается — это отдельная группа
 * функций для отдельного, нового пути: канал, попавший в Stasis-приложение
 * `royalhome-live-voice` (см. lib/telephony/liveVoiceBridge.ts), сводится мостом с
 * externalMedia-каналом, через который течёт сырой звук к Gemini Live и обратно.
 *
 * ⚠️ НЕ ПРОВЕРЕНО ЖИВЫМ ЗВОНКОМ. Формы запросов сверены с документацией ARI
 * (docs.asterisk.org, раздел External Media and ARI) — станция агентства (Asterisk
 * 16.17, см. docs/telephony-sip-numbering.md) удовлетворяет заявленному минимуму
 * версии 16.6, но ни один из этих вызовов не отправлялся на неё ни разу.
 */

export interface AriBridgeResult {
  ok: boolean;
  bridgeId?: string;
  error?: string;
}

/** POST /bridges — мост, в который сводятся канал звонящего и externalMedia-канал.
 *  type=mixing — обычный смешивающий мост (единственный тип, которому имеет смысл
 *  входить обеим сторонам разговора одновременно). */
export async function createBridge(creds: AriCredentials): Promise<AriBridgeResult> {
  const auth = Buffer.from(`${creds.username}:${creds.password}`).toString("base64");
  try {
    const res = await fetch(`${creds.url}/ari/bridges?type=mixing`, {
      method: "POST",
      headers: { Authorization: `Basic ${auth}` },
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      logAriFailure(`мост не создан: HTTP ${res.status}${body ? ` — ${body}` : ""}`);
      return { ok: false, error: `Asterisk не создал мост: HTTP ${res.status}${body ? ` — ${body}` : ""}` };
    }
    const data = (await res.json()) as { id?: string };
    if (!data.id) logAriFailure("мост создан без id в ответе");
    return data.id ? { ok: true, bridgeId: data.id } : { ok: false, error: "Мост создан без id в ответе" };
  } catch (err) {
    logAriFailure(`мост — не удалось соединиться с Asterisk: ${err instanceof Error ? err.message : err}`);
    return { ok: false, error: `Не удалось соединиться с Asterisk: ${err instanceof Error ? err.message : err}` };
  }
}

/** Мост в том виде, в каком его отдаёт GET /ari/bridges (нужные уборщику поля). */
export interface AriBridgeSnapshot {
  id: string;
  channels: string[];
  creationtime?: string;
}

/** GET /bridges — список мостов станции (уборщик живого голоса, 02.10.2026: мост,
 *  оставшийся после сбоя отбоя, сам не исчезает). Отказ бросается — решает вызывающий. */
export async function listBridges(creds: AriCredentials, timeoutMs: number = CALL_TIMEOUT_MS): Promise<AriBridgeSnapshot[]> {
  const auth = Buffer.from(`${creds.username}:${creds.password}`).toString("base64");
  const res = await fetch(`${creds.url}/ari/bridges`, {
    headers: { Authorization: `Basic ${auth}` },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`Asterisk ответил HTTP ${res.status}`);
  const data = (await res.json()) as { id?: unknown; channels?: unknown; creationtime?: unknown }[];
  if (!Array.isArray(data)) return [];
  return data
    .filter((b) => typeof b.id === "string")
    .slice(0, ACTIVE_CHANNELS_LIMIT)
    .map((b) => ({
      id: b.id as string,
      channels: Array.isArray(b.channels) ? b.channels.filter((c): c is string => typeof c === "string") : [],
      creationtime: typeof b.creationtime === "string" ? b.creationtime : undefined,
    }));
}

/** DELETE /bridges/{id} — освобождает мост по завершении сессии. 404 — успех, мост
 *  уже развален станцией (та же идемпотентность, что у hangupCall). */
export async function deleteBridge(creds: AriCredentials, bridgeId: string): Promise<{ ok: boolean; error?: string }> {
  const auth = Buffer.from(`${creds.username}:${creds.password}`).toString("base64");
  try {
    const res = await fetch(`${creds.url}/ari/bridges/${encodeURIComponent(bridgeId)}`, {
      method: "DELETE",
      headers: { Authorization: `Basic ${auth}` },
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
    if (res.status === 404 || res.ok) return { ok: true };
    const body = await res.text().catch(() => "");
    logAriFailure(`мост не удалён: HTTP ${res.status}${body ? ` — ${body}` : ""}`);
    return { ok: false, error: `Asterisk не удалил мост: HTTP ${res.status}${body ? ` — ${body}` : ""}` };
  } catch (err) {
    logAriFailure(`удаление моста — не удалось соединиться с Asterisk: ${err instanceof Error ? err.message : err}`);
    return { ok: false, error: `Не удалось соединиться с Asterisk: ${err instanceof Error ? err.message : err}` };
  }
}

/** POST /bridges/{id}/addChannel — добавляет канал в мост (вызывается дважды: для
 *  канала звонящего и для externalMedia-канала). */
export async function addChannelToBridge(
  creds: AriCredentials,
  bridgeId: string,
  channelId: string
): Promise<{ ok: boolean; error?: string }> {
  const auth = Buffer.from(`${creds.username}:${creds.password}`).toString("base64");
  try {
    const res = await fetch(
      `${creds.url}/ari/bridges/${encodeURIComponent(bridgeId)}/addChannel?channel=${encodeURIComponent(channelId)}`,
      { method: "POST", headers: { Authorization: `Basic ${auth}` }, signal: AbortSignal.timeout(CALL_TIMEOUT_MS) }
    );
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      logAriFailure(`канал не добавлен в мост: HTTP ${res.status}${body ? ` — ${body}` : ""}`);
      return { ok: false, error: `Asterisk не добавил канал в мост: HTTP ${res.status}${body ? ` — ${body}` : ""}` };
    }
    return { ok: true };
  } catch (err) {
    logAriFailure(`добавление канала в мост — не удалось соединиться с Asterisk: ${err instanceof Error ? err.message : err}`);
    return { ok: false, error: `Не удалось соединиться с Asterisk: ${err instanceof Error ? err.message : err}` };
  }
}

export interface ExternalMediaResult {
  ok: boolean;
  channelId?: string;
  error?: string;
}

/**
 * POST /channels/externalMedia — канал, через который Asterisk шлёт сырой звук
 * разговора наружу (нам) и принимает звук обратно (RTP/UDP, без согласования
 * кодека — формат ровно тот, что указан в `format`).
 *
 * `format=slin16` — 16-битный линейный PCM на 16kHz. ЭТО РОВНО ТОТ ЖЕ ФОРМАТ,
 * который Gemini Live принимает на вход (см. ai/liveVoiceClient.ts) — значит
 * передискретизация нужна только на ОБРАТНОМ пути (ответ модели 24kHz → 16kHz
 * для канала), см. resamplePcm16 в liveVoiceBridge.ts.
 *
 * `connection_type=client` — Asterisk выступает RTP-клиентом: он сам шлёт пакеты
 * на `externalHost` (наш dgram-сокет) и ждёт пакеты в ответ на тот же адрес,
 * которым представился (см. UNICASTRTP_LOCAL_ADDRESS/PORT ниже — это уже АДРЕС
 * САМОЙ СТАНЦИИ, откуда она реально шлёт и куда реально слушает, он может
 * отличаться от того, что мы передали в `externalHost`, если между нами NAT).
 *
 * `app` — Stasis-приложение, куда попадает СОЗДАННЫЙ externalMedia-канал (не путать
 * с приложением, в которое уже попал канал звонящего) — используем то же имя
 * (`royalhome-live-voice`), чтобы оба канала были видны в одной подписке ARI.
 */
export async function createExternalMediaChannel(
  creds: AriCredentials,
  params: { app: string; externalHost: string; format?: string }
): Promise<ExternalMediaResult> {
  const auth = Buffer.from(`${creds.username}:${creds.password}`).toString("base64");
  const query = new URLSearchParams({
    app: params.app,
    external_host: params.externalHost,
    format: params.format ?? "slin16",
    encapsulation: "rtp",
    transport: "udp",
    connection_type: "client",
    direction: "both",
  });
  try {
    const res = await fetch(`${creds.url}/ari/channels/externalMedia?${query.toString()}`, {
      method: "POST",
      headers: { Authorization: `Basic ${auth}` },
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      logAriFailure(`externalMedia-канал не создан: HTTP ${res.status}${body ? ` — ${body}` : ""}`);
      return { ok: false, error: `Asterisk не создал externalMedia-канал: HTTP ${res.status}${body ? ` — ${body}` : ""}` };
    }
    const data = (await res.json()) as { id?: string };
    if (!data.id) logAriFailure("externalMedia создан без id в ответе");
    return data.id ? { ok: true, channelId: data.id } : { ok: false, error: "externalMedia создан без id в ответе" };
  } catch (err) {
    logAriFailure(`externalMedia-канал — не удалось соединиться с Asterisk: ${err instanceof Error ? err.message : err}`);
    return { ok: false, error: `Не удалось соединиться с Asterisk: ${err instanceof Error ? err.message : err}` };
  }
}

/** POST /channels/{id}/answer — на всякий случай явно отвечаем на канал звонящего
 *  перед сведением в мост. Идемпотентно молчит на 409 (уже отвечен диалпланом
 *  станции до входа в Stasis — штатный случай, не ошибка). */
export async function answerChannel(creds: AriCredentials, channelId: string): Promise<{ ok: boolean; error?: string }> {
  const auth = Buffer.from(`${creds.username}:${creds.password}`).toString("base64");
  try {
    const res = await fetch(`${creds.url}/ari/channels/${encodeURIComponent(channelId)}/answer`, {
      method: "POST",
      headers: { Authorization: `Basic ${auth}` },
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
    if (res.ok || res.status === 409) return { ok: true };
    const body = await res.text().catch(() => "");
    logAriFailure(`канал не отвечен: HTTP ${res.status}${body ? ` — ${body}` : ""}`);
    return { ok: false, error: `Asterisk не ответил на канал: HTTP ${res.status}${body ? ` — ${body}` : ""}` };
  } catch (err) {
    logAriFailure(`ответ на канал — не удалось соединиться с Asterisk: ${err instanceof Error ? err.message : err}`);
    return { ok: false, error: `Не удалось соединиться с Asterisk: ${err instanceof Error ? err.message : err}` };
  }
}

/**
 * POST /channels/{id}/moh — музыка ожидания на канал звонящего (04.09.2026, разбор
 * «не долетел до Нозы»). Найдено на живых звонках: `royalhome-inbound` отвечает на
 * канал (Answer()) СРАЗУ, а дальше идут запросы к базе CRM и, если клиент известен,
 * ещё два действия AMI (Setvar+Redirect) через туннель офис↔VPS — всё это время
 * звонящий слышит АБСОЛЮТНУЮ ТИШИНУ, не гудок и не музыку. Не каждый досиживает
 * тишину до конца и кладёт трубку раньше, чем перевод на агента успевает
 * отработать (см. redirect_failed в inboundRouting.ts — «нет такого канала» в
 * половине случаев означает именно это).
 *
 * Идемпотентно молчит на 409 (МОН уже играет — штатно при повторной попытке) и на
 * 404 (канал уже пропал — звонящий положил трубку раньше нас, сообщать нечего).
 * Останавливать явно не нужно: Asterisk сам гасит МОН в момент, когда канал
 * реально сводится с кем-то (оператором, агентом, любым Dial/Queue/Bridge) —
 * то есть ровно тогда, когда тишину должен сменить настоящий разговор.
 */
export async function startMoh(
  creds: AriCredentials,
  channelId: string,
  mohClass?: string
): Promise<{ ok: boolean; error?: string }> {
  const auth = Buffer.from(`${creds.username}:${creds.password}`).toString("base64");
  const query = mohClass ? `?mohClass=${encodeURIComponent(mohClass)}` : "";
  try {
    const res = await fetch(`${creds.url}/ari/channels/${encodeURIComponent(channelId)}/moh${query}`, {
      method: "POST",
      headers: { Authorization: `Basic ${auth}` },
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
    if (res.ok || res.status === 409 || res.status === 404) return { ok: true };
    const body = await res.text().catch(() => "");
    logAriFailure(`музыка ожидания не включена: HTTP ${res.status}${body ? ` — ${body}` : ""}`);
    return { ok: false, error: `Asterisk не включил музыку ожидания: HTTP ${res.status}${body ? ` — ${body}` : ""}` };
  } catch (err) {
    logAriFailure(`музыка ожидания — не удалось соединиться с Asterisk: ${err instanceof Error ? err.message : err}`);
    return { ok: false, error: `Не удалось соединиться с Asterisk: ${err instanceof Error ? err.message : err}` };
  }
}

/**
 * POST /channels/{id}/play — короткий системный звук на канал (12.09.2026, живой
 * голос: исходящий тестовый звонок). Не дожидается PlaybackFinished — само
 * событие приходит на websocket, которого этот вызов не открывает; сигнал нужен
 * только для проверки «канал вообще доносит звук до трубки», секундная задержка
 * до старта настоящего разговора не критична.
 */
export async function playChannelSound(
  creds: AriCredentials,
  channelId: string,
  sound: string
): Promise<{ ok: boolean; error?: string }> {
  const auth = Buffer.from(`${creds.username}:${creds.password}`).toString("base64");
  try {
    const res = await fetch(
      `${creds.url}/ari/channels/${encodeURIComponent(channelId)}/play?media=${encodeURIComponent(`sound:${sound}`)}`,
      { method: "POST", headers: { Authorization: `Basic ${auth}` }, signal: AbortSignal.timeout(CALL_TIMEOUT_MS) }
    );
    if (res.ok || res.status === 404) return { ok: true };
    const body = await res.text().catch(() => "");
    logAriFailure(`звук не проигран: HTTP ${res.status}${body ? ` — ${body}` : ""}`);
    return { ok: false, error: `Asterisk не проиграл звук: HTTP ${res.status}${body ? ` — ${body}` : ""}` };
  } catch (err) {
    logAriFailure(`проигрывание звука — не удалось соединиться с Asterisk: ${err instanceof Error ? err.message : err}`);
    return { ok: false, error: `Не удалось соединиться с Asterisk: ${err instanceof Error ? err.message : err}` };
  }
}

/**
 * POST /channels/{id}/variable — переменная канала через ARI (24.09.2026, перевод
 * звонка консультантом). Для канала в Stasis-приложении — родной путь: AMI Setvar
 * на него тоже подействовал бы, но разговор со станцией о канале, который держит
 * ARI, ведём через ARI, одним транспортом с continueInDialplan ниже.
 */
export async function setChannelVariable(
  creds: AriCredentials,
  channelId: string,
  variable: string,
  value: string
): Promise<{ ok: boolean; error?: string }> {
  const auth = Buffer.from(`${creds.username}:${creds.password}`).toString("base64");
  const query = `?variable=${encodeURIComponent(variable)}&value=${encodeURIComponent(value)}`;
  try {
    const res = await fetch(`${creds.url}/ari/channels/${encodeURIComponent(channelId)}/variable${query}`, {
      method: "POST",
      headers: { Authorization: `Basic ${auth}` },
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
    if (res.ok) return { ok: true };
    const body = await res.text().catch(() => "");
    return { ok: false, error: `HTTP ${res.status}${body ? ` — ${body}` : ""}` };
  } catch (err) {
    return { ok: false, error: `Не удалось соединиться с Asterisk: ${err instanceof Error ? err.message : err}` };
  }
}

/**
 * POST /channels/{id}/continue — вывести канал из Stasis-приложения в диалплан
 * (24.09.2026, перевод звонка консультантом агенту). Канал покидает мост живого
 * голоса сам: станция шлёт StasisEnd, и сессия голоса закрывается, НЕ кладя трубку
 * (см. transferLiveVoiceCall в liveVoiceBridge.ts). 404 — звонящий уже положил
 * трубку, это отказ: переводить некого.
 */
export async function continueInDialplan(
  creds: AriCredentials,
  channelId: string,
  /** Не передан — следующий приоритет после Stasis() в том же контексте. */
  target?: { context: string; extension: string; priority: number }
): Promise<{ ok: boolean; error?: string }> {
  const auth = Buffer.from(`${creds.username}:${creds.password}`).toString("base64");
  const query = target
    ? `?context=${encodeURIComponent(target.context)}&extension=${encodeURIComponent(target.extension)}` +
      `&priority=${target.priority}`
    : "";
  try {
    const res = await fetch(`${creds.url}/ari/channels/${encodeURIComponent(channelId)}/continue${query}`, {
      method: "POST",
      headers: { Authorization: `Basic ${auth}` },
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
    if (res.ok) return { ok: true };
    const body = await res.text().catch(() => "");
    logAriFailure(`канал не выведен в диалплан: HTTP ${res.status}${body ? ` — ${body}` : ""}`);
    return { ok: false, error: `HTTP ${res.status}${body ? ` — ${body}` : ""}` };
  } catch (err) {
    logAriFailure(`вывод канала в диалплан — не удалось соединиться с Asterisk: ${err instanceof Error ? err.message : err}`);
    return { ok: false, error: `Не удалось соединиться с Asterisk: ${err instanceof Error ? err.message : err}` };
  }
}
