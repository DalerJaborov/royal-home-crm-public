import { prisma } from "../../db.js";
import { isWithinAlarmHours } from "../workingHours.js";
import { logSystemError } from "../systemError.js";
import { describeError } from "../describeError.js";
import { createNotifications, shouldAlert } from "../notifications.js";
import { sendPushToAgents } from "../../push.js";
import {
  loadAriCredentials,
  testAriConnection,
  listEndpointsRetrying,
  type AriCredentials,
} from "./ariClient.js";
import { loadAmiCredentials, testAmiConnection, amiAction, amiDbGet, amiQueueStatus, type AmiCredentials } from "./amiClient.js";
import { stationHasContext, stationContextContains, type ContextContentStatus } from "./dialplanContext.js";
import { ROUTE_CONTEXT, ROUTE_EXTEN, WAIT_CONTEXT } from "./inboundRouting.js";
import { buildDialWithMobileFallback } from "./agentMobileFallback.js";
import { runIncomingCallsSilenceTick } from "./incomingCallsSilenceAlarm.js";
import { loadFailoverConfig, readFailoverFromStation, failoverDiffers, type FailoverConfig } from "./failoverSync.js";
import { EXTENSION_RECORDING_KEYS, EXTENSION_RECORDING_VALUE } from "./extensionPool.js";
import { collectBaselineDrift, describeDrift } from "./telephonyBaseline.js";
import { LIVE_VOICE_ARI_APP, liveVoicePauseState, liveVoiceSubscriptionState } from "./liveVoiceBridge.js";

/**
 * СВОДНАЯ ПРОВЕРКА ТЕЛЕФОНИИ (20.09.2026).
 *
 * ЗАЧЕМ. За один день 20.09.2026 вскрылись сразу три независимые поломки станции:
 * (1) участники очереди приёма были статически привязаны к мёртвым SIP-трубкам —
 * очередь молча не звонила НИ РАЗУ пять дней подряд (15-19.09); (2) транк отдавал
 * провайдеру номер звонящего клиента вместо номера агентства, и все переадресации
 * отбивались как подмена номера; (3) вебсокет событий рвался от заводского
 * таймаута записи 0,1 с. Ни одну из трёх не поймала НИ ОДНА существующая проверка —
 * о простое узнали от владельца, а не от системы. Полный разбор всех допущений
 * CRM о станции: docs/telephony-deep-station-contract-20-09.md.
 *
 * ЧТО ЭТОТ МОДУЛЬ НЕ ДЕЛАЕТ. Три узких сторожа уже существуют и знают своё дело
 * лучше: incomingCallsSilenceAlarm.ts (факт «звонков нет»/«все обрываются»),
 * agentMobileFallback.ts (мобильное плечо аппарата приёма), agentIncomingReadiness.ts
 * (состав очереди относительно списка операторов CRM). Этот модуль их не повторяет —
 * он либо зовёт их код напрямую (см. probeIncomingCallsFlowing ниже), либо
 * закрывает то, что НИ ОДИН из них не видит: жив ли AMI/ARI, загружен ли диалплан
 * РЕАЛЬНО (в памяти станции, не только в файле на диске), доступен ли хоть один
 * участник очереди ПРЯМО СЕЙЧАС (не просто «числится»), не прописана ли в очереди
 * мёртвая статическая трубка, и на месте ли права AMI-пользователя.
 *
 * ГЛАВНОЕ ПРАВИЛО МОДУЛЯ — НЕ ПОДНИМАТЬ ЛОЖНУЮ ТРЕВОГУ. Связь со станцией идёт
 * через обратный ssh-туннель и штатно рвётся на десятки секунд (сегодня, 20.09,
 * перезагрузился сервер — туннель лежал полминуты). Проверка, которая кричит от
 * каждого моргания, будет отключена директором через неделю и станет бесполезной —
 * ровно та ошибка, от которой владелец прямым текстом просил уберечь («меньше
 * пуша»). Поэтому:
 *
 *  1. Каждая проверка КЛАССИФИЦИРУЕТ свой отказ на "связь" (таймаут, ECONNREFUSED,
 *     станция не ответила/закрыла соединение — туннель моргнул, это не поломка
 *     настройки) и "конфигурация" (Permission denied, "не найдено", явный
 *     осмысленный ответ станции с неверным значением — станцию действительно
 *     сломали). См. classifyStationError().
 *  2. Тревогу поднимаем только когда отказ ПОВТОРИЛСЯ на следующем проходе подряд
 *     (см. recordFailure/CONFIRM_TICKS) — тик идёт раз в 15 минут (cron.ts), то
 *     есть моргание в 20-30 секунд никогда не наберёт двух подтверждений. Состояние
 *     живёт в памяти процесса (тот же приём, что у кэша stationHasContext) —
 *     после рестарта счётчик обнуляется, а не сохраняет ложное «уже подтверждено».
 *  3. Отказы связи (ARI/AMI недоступны) сводятся в ОДНУ тревогу, а не размножаются
 *     на шесть проверок — если станция не отвечает вовсе, отдельно говорить
 *     «сломан диалплан» и «сломана очередь» одновременно бессмысленно и пугает
 *     сильнее, чем помогает.
 *  4. Сомнение — против тревоги: не удалось однозначно классифицировать отказ
 *     (например, незнакомый текст ошибки ExtensionState) — считаем «не знаем»
 *     (`ok: null`), а не «сломано».
 */

const HOUR_MS = 60 * 60 * 1000;

/** Сколько идущих подряд 15-минутных тиков подряд должен держаться отказ, прежде
 *  чем это тревога, а не моргание туннеля (см. пункт 2 в шапке файла). */
const CONFIRM_TICKS = 2;

/** Сколько часов статическая трубка в очереди должна молчать, прежде чем это
 *  тревога, а не выключенный на обед телефон. Полтора рабочих часа — заметно
 *  больше любого разумного перерыва и заметно меньше, чем пять дней 15-19.09. */
const DEAD_MEMBER_HOURS = 2;

const ALERT_MIN_INTERVAL_MS = 24 * HOUR_MS;

export type StationCheckClass = "network" | "config";

export interface StationCheck {
  name: string;
  /** true — жив, false — подтверждённая поломка (см. CONFIRM_TICKS), null — не
   *  настроено или не удалось классифицировать однозначно. */
  ok: boolean | null;
  detail: string;
  cls: StationCheckClass;
}

/** Отказ станции — связь моргнула или её действительно сломали. Список собран по
 *  реальным текстам ошибок в этом файле: amiClient.ts/ariClient.ts (см. finish()
 *  и testAriConnection выше по репозиторию). Незнакомый текст — не паникуем,
 *  отдаём "config" только когда фраза говорит явно про права/отсутствие. */
function classifyStationError(message: string): StationCheckClass {
  const m = message.toLowerCase();
  if (
    /не удалось соединиться|станция не ответила|станция закрыла соединение|econnrefused|etimedout|econnreset|ehostunreach|enotfound/.test(
      m
    )
  ) {
    return "network";
  }
  return "config";
}

/** Подтверждено ли то, что отказ держится CONFIRM_TICKS проходов подряд — состояние
 *  в памяти процесса, ключ — имя проверки. Возврат при восстановлении (`ok: true`)
 *  всегда сбрасывает счётчик: моргнуло и прошло — говорить больше не о чем. */
const confirmState = new Map<string, number>();
function recordCheckFailure(key: string, brokenNow: boolean): boolean {
  if (!brokenNow) {
    confirmState.delete(key);
    return false;
  }
  const streak = (confirmState.get(key) ?? 0) + 1;
  confirmState.set(key, streak);
  return streak >= CONFIRM_TICKS;
}

/** Когда статический участник очереди последний раз был на связи (ARI online) —
 *  чтобы отличить "выключил телефон на обед" от "трубка мертва второй час". */
const staticMemberOfflineSince = new Map<string, number>();

/** Один участник очереди — со всеми полями, каких нет в operatorQueue.ts::readQueueMembers
 *  (там их сознательно нет: agentIncomingReadiness.ts они не нужны). Здесь нужны
 *  ОБА новых поля: `membership` ("static"/"dynamic" — станция сама помечает, кто
 *  прописан руками в queues_details.conf, а кто добавлен QueueAdd) и `paused`
 *  ("числится" ≠ "готов принять звонок прямо сейчас"). */
interface RawQueueMember {
  queue: string;
  iface: string;
  extension: string;
  membership: string;
  paused: boolean;
}

function extensionFromIface(iface: string): string | null {
  const match = /(?:^|\/)(\d{3,5})(?=[@/-]|$)/.exec(iface);
  return match?.[1] ?? null;
}

async function readRawQueueMembers(
  creds: AmiCredentials
): Promise<{ ok: true; members: RawQueueMember[] } | { ok: false; error: string }> {
  const result = await amiQueueStatus(creds);
  if (!result.ok) return { ok: false, error: result.error };
  const members: RawQueueMember[] = [];
  for (const packet of result.packets) {
    if ((packet.event ?? "").toLowerCase() !== "queuemember") continue;
    const iface = packet.location ?? packet.stateinterface ?? "";
    const extension = extensionFromIface(iface);
    if (!extension) continue;
    members.push({
      queue: packet.queue ?? "",
      iface,
      extension,
      membership: (packet.membership ?? "").toLowerCase(),
      paused: !!packet.paused && packet.paused !== "0" && packet.paused.toLowerCase() !== "false",
    });
  }
  return { ok: true, members };
}

/**
 * ARI и AMI живы — азбука: без связи со станцией судить обо всём остальном
 * нельзя вовсе (см. пункт 3 в шапке — сводим в одну строку каждая).
 */
async function probeAri(): Promise<StationCheck | null> {
  const creds = await loadAriCredentials();
  if (!creds) return null; // телефония не настроена — проверять нечего, не поломка
  const r = await testAriConnection(creds);
  return {
    name: "ARI",
    ok: r.ok,
    detail: r.ok ? `жив${r.version ? `, версия ${r.version}` : ""}` : (r.error ?? "нет ответа"),
    cls: r.ok ? "network" : classifyStationError(r.error ?? ""),
  };
}

async function probeAmi(): Promise<{ check: StationCheck | null; creds: AmiCredentials | null }> {
  const creds = await loadAmiCredentials();
  if (!creds) return { check: null, creds: null };
  const r = await testAmiConnection(creds);
  return {
    check: {
      name: "AMI",
      ok: r.ok,
      detail: r.ok ? "жив" : (r.error ?? "нет ответа"),
      cls: r.ok ? "network" : classifyStationError(r.error ?? ""),
    },
    creds: r.ok ? creds : null,
  };
}

/**
 * ТРИ КОНТЕКСТА ДИАЛПЛАНА В ФАЙЛЕ (расширение stationHasContext на все три из
 * отчёта 20.09 — раньше проверялся только royalhome-agent-route). `ext-queues-custom`
 * нигде в коде не экспортирован константой (в отличие от ROUTE_CONTEXT/WAIT_CONTEXT
 * из inboundRouting.ts) — он живёт только в диалплане станции, поэтому имя здесь
 * ровно то, что в docs/telephony-deep-station-contract-20-09.md.
 */
const EXT_QUEUES_CONTEXT = "ext-queues-custom";

async function probeDialplanContextsOnDisk(creds: AmiCredentials): Promise<StationCheck> {
  const missing: string[] = [];
  for (const ctx of [ROUTE_CONTEXT, WAIT_CONTEXT, EXT_QUEUES_CONTEXT]) {
    if (!(await stationHasContext(creds, ctx))) missing.push(ctx);
  }
  if (missing.length === 0) return { name: "Диалплан (файл)", ok: true, detail: "все контексты на месте", cls: "config" };
  return {
    name: "Диалплан (файл)",
    ok: false,
    detail: `нет секции: ${missing.join(", ")}`,
    cls: "config",
  };
}

/**
 * ВЕТКА КОНСУЛЬТАНТА В `royalhome-inbound` (28.09.2026).
 *
 * Аудит станции 25.09 (docs/telephony-audit-25-09.md, §1): на станции лежал
 * `extensions_custom.conf` старой версии — контекст `royalhome-inbound` есть, а
 * строки `Stasis(royalhome-live-voice,…)` в нём нет. CRM при этом честно клала в
 * AstDB `aimode=no_answer`, сверка AstDB писала «совпадает», а читать это значение
 * на станции было некому: владелец выбрал «консультант вместо автоответчика», а
 * трубку продолжал брать автоответчик. Ни одна проверка этого не видела —
 * `probeDialplanContextsOnDisk` спрашивает только «есть ли секция».
 *
 * Проверяется ТОЛЬКО когда консультант на входящих выбран: при выключенном
 * режиме старый диалплан ничему не мешает, и тревога была бы шумом. Тогда проверка
 * отдаёт `ok: null` («не проверяется»), чтобы на экране «Здоровье системы» не
 * висел устаревший красный снимок от прошлого включения.
 */
export const CONSULTANT_DIALPLAN_CHECK = "Диалплан: консультант на входящих";
export const INBOUND_CONTEXT = "royalhome-inbound";
export const CONSULTANT_STASIS_FRAGMENT = "Stasis(royalhome-live-voice";
export const CONSULTANT_DIALPLAN_FIX =
  "обновить диалплан станции из ops/asterisk/extensions_custom.conf, затем dialplan reload";

/** Разбор ответа станции отдельно от сети — ради теста без станции. */
export function consultantDialplanCheck(consultantWanted: boolean, status: ContextContentStatus | null): StationCheck {
  const name = CONSULTANT_DIALPLAN_CHECK;
  if (!consultantWanted || !status) {
    return { name, ok: null, detail: "консультант на входящих выключен — не проверяется", cls: "config" };
  }
  if ("unknown" in status) {
    return { name, ok: null, detail: "станция не отдала файл диалплана — проверить нельзя", cls: "network" };
  }
  if (!status.present) {
    return {
      name,
      ok: false,
      detail: `в extensions_custom.conf станции нет контекста ${INBOUND_CONTEXT}; нужно ${CONSULTANT_DIALPLAN_FIX}`,
      cls: "config",
    };
  }
  if (!status.contains) {
    return {
      name,
      ok: false,
      detail:
        `в ${INBOUND_CONTEXT} на станции нет ветки консультанта (${CONSULTANT_STASIS_FRAGMENT}…) — ` +
        `трубку по-прежнему берёт автоответчик; нужно ${CONSULTANT_DIALPLAN_FIX}`,
      cls: "config",
    };
  }
  return { name, ok: true, detail: "ветка консультанта в файле диалплана на месте", cls: "config" };
}

/**
 * ПРИЛОЖЕНИЕ РОБОТА ЗАРЕГИСТРИРОВАНО НА СТАНЦИИ (09.10.2026, аудит линии робота,
 * «Мониторинг», п.6 и п.8). Диалплан может звать `Stasis(royalhome-live-voice,…)`
 * сколько угодно — если второй сокет ARI (подписка робота) мёртв, станция
 * приложения не знает, Stasis сразу отказывает, и звонок уходит на автоответчик
 * мимо робота. У этого сокета не было ни одного сторожа. Плюс пауза робота
 * («нет звука со станции», «Gemini отказывает») — строкой на «Здоровье системы», а
 * не только записью в журнале.
 */
export const LIVE_VOICE_APP_CHECK = "Робот: приложение на станции";
export const LIVE_VOICE_PAUSE_CHECK = "Робот: пауза";

export interface LiveVoiceAppStatus {
  /** Робот включён и берёт входящие — проверять есть что. */
  wanted: boolean;
  /** Подписка робота открыта в этом процессе. */
  socketConnected: boolean;
  /** Ответ станции на GET /ari/applications/royalhome-live-voice: true — есть,
   *  false — 404, null — связи нет. */
  registered: boolean | null;
  /** Ошибка запроса к станции, если была. */
  error?: string;
}

/** Разбор отдельно от сети — ради теста без станции. */
export function liveVoiceAppCheck(status: LiveVoiceAppStatus): StationCheck {
  const name = LIVE_VOICE_APP_CHECK;
  if (!status.wanted) return { name, ok: null, detail: "робот на входящих выключен — не проверяется", cls: "config" };
  if (status.registered === null) {
    return { name, ok: null, detail: `станция не ответила (${status.error ?? "нет ответа"})`, cls: "network" };
  }
  if (!status.registered || !status.socketConnected) {
    return {
      name,
      ok: false,
      detail: !status.registered
        ? `станция не знает приложения ${LIVE_VOICE_ARI_APP} — подписка робота не установлена, звонки идут мимо робота`
        : "подписка робота в CRM закрыта, хотя станция приложение помнит — события не доходят",
      cls: "config",
    };
  }
  return { name, ok: true, detail: "приложение робота зарегистрировано, подписка открыта", cls: "config" };
}

async function probeLiveVoiceApp(creds: AriCredentials): Promise<StationCheck> {
  const settings = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { liveVoiceEnabled: true, liveVoiceInboundMode: true },
  });
  const wanted = !!settings?.liveVoiceEnabled && !!settings.liveVoiceInboundMode && settings.liveVoiceInboundMode !== "off";
  if (!wanted) return liveVoiceAppCheck({ wanted: false, socketConnected: false, registered: null });
  const auth = Buffer.from(`${creds.username}:${creds.password}`).toString("base64");
  let registered: boolean | null = null;
  let error: string | undefined;
  try {
    const res = await fetch(`${creds.url}/ari/applications/${encodeURIComponent(LIVE_VOICE_ARI_APP)}`, {
      headers: { Authorization: `Basic ${auth}` },
      signal: AbortSignal.timeout(5_000),
    });
    if (res.ok) registered = true;
    else if (res.status === 404) registered = false;
    else error = `HTTP ${res.status}`;
  } catch (err) {
    error = describeError(err);
  }
  return liveVoiceAppCheck({ wanted, socketConnected: liveVoiceSubscriptionState().connected, registered, error });
}

/** Пауза робота — видимой строкой (не тревогой: пауза снимается сама по таймеру). */
export function liveVoicePauseCheck(now: number = Date.now()): StationCheck {
  const pause = liveVoicePauseState(now);
  const until = (ms: number) =>
    new Date(ms).toLocaleTimeString("ru-RU", { timeZone: "Asia/Dushanbe", hour: "2-digit", minute: "2-digit" });
  const parts = [
    pause.audioPathDownUntil ? `нет звука со станции — до ${until(pause.audioPathDownUntil)}` : "",
    pause.geminiPausedUntil ? `Gemini отказывает подключаться — до ${until(pause.geminiPausedUntil)}` : "",
  ].filter(Boolean);
  if (parts.length === 0) return { name: LIVE_VOICE_PAUSE_CHECK, ok: true, detail: "робот берёт звонки", cls: "config" };
  return {
    name: LIVE_VOICE_PAUSE_CHECK,
    ok: false,
    detail: `робот на паузе, входящие идут на автоответчик: ${parts.join("; ")}`,
    cls: "config",
  };
}

async function probeConsultantDialplan(creds: AmiCredentials): Promise<StationCheck> {
  const settings = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { liveVoiceEnabled: true, liveVoiceInboundMode: true },
  });
  const wanted =
    !!settings?.liveVoiceEnabled && (settings.liveVoiceInboundMode === "no_answer" || settings.liveVoiceInboundMode === "always");
  if (!wanted) return consultantDialplanCheck(false, null);
  return consultantDialplanCheck(true, await stationContextContains(creds, INBOUND_CONTEXT, CONSULTANT_STASIS_FRAGMENT));
}

/**
 * САМОЕ ВАЖНОЕ ОТЛИЧИЕ ОТ УЖЕ СУЩЕСТВУЮЩЕЙ ПРОВЕРКИ (пункт 3 в трёх самых опасных
 * пунктах отчёта). `stationHasContext` читает ФАЙЛ `extensions_custom.conf` на
 * диске через GetConfig — а не то, что реально загружено в память Asterisk.
 * Правку внесли, `dialplan reload` не сделали — файл скажет «контекст есть», а
 * станция им ещё не пользуется. `ExtensionState` — единственное доступное
 * нынешним правам AMI (`ShowDialPlan` отдаёт Permission denied, см. шапку
 * dialplanContext.ts) действие, которое спрашивает РЕАЛЬНО загруженный диалплан:
 * если exten/context не существует в памяти станции прямо сейчас, оно так и
 * ответит, независимо от того, что лежит в файле.
 */
async function probeDialplanLoaded(creds: AmiCredentials): Promise<StationCheck> {
  const result = await amiAction(creds, "ExtensionState", { Exten: ROUTE_EXTEN, Context: ROUTE_CONTEXT }, { timeoutMs: 3000 });
  if (result.ok) return { name: "Диалплан (в памяти станции)", ok: true, detail: "загружен", cls: "config" };
  const msg = (result.error ?? "").toLowerCase();
  if (/not found|no such|does not exist|нет такого/.test(msg)) {
    return {
      name: "Диалплан (в памяти станции)",
      ok: false,
      detail: `${ROUTE_CONTEXT}/${ROUTE_EXTEN} не найден в загруженном диалплане: ${result.error}`,
      cls: "config",
    };
  }
  const cls = classifyStationError(result.error ?? "");
  // Сомнение — против тревоги (правило файла): не смогли однозначно понять ответ —
  // не «сломано», а «не знаем».
  return { name: "Диалплан (в памяти станции)", ok: cls === "network" ? false : null, detail: result.error ?? "нет ответа", cls };
}

/**
 * ПРАВА AMI-ПОЛЬЗОВАТЕЛЯ (`write=system,agent,call`) — БЕЗ ПОБОЧНОГО ЭФФЕКТА.
 * Тот же приём, что уже используют siteKeyProbe/checkSiteAdminResetKeyHealth в
 * integrationHealth.ts: намеренно невыполнимая цель (несуществующий канал) даёт
 * содержательный ответ станции раньше, чем действие реально что-то сделает.
 * `Redirect` требует именно класс `call` в write — той самой строки, без которой
 * 19.09 (см. отчёт, пункт про AMI) перевод известного клиента отвечал бы
 * "Permission denied" на каждый звонок. Канал с меткой `rh-health-probe-<время>`
 * гарантированно не существует, поэтому либо станция ответит "No such channel"
 * (права есть, цели нет — ничего не переключилось), либо "Permission denied"
 * (прав нет — вот она, находка).
 */
async function probeAmiWritePermission(creds: AmiCredentials): Promise<StationCheck> {
  const probeChannel = `Local/rh-health-probe-${Date.now()}@from-internal`;
  const result = await amiAction(creds, "Redirect", { Channel: probeChannel, Context: WAIT_CONTEXT, Exten: "s", Priority: 1 }, { timeoutMs: 3000 });
  if (result.ok) return { name: "Права AMI (write=call)", ok: true, detail: "приняты", cls: "config" };
  const msg = (result.error ?? "").toLowerCase();
  if (/permission denied/.test(msg)) {
    return {
      name: "Права AMI (write=call)",
      ok: false,
      detail: `станция отказала: ${result.error}`,
      cls: "config",
    };
  }
  // «channel does not exist» — ровно так отвечает Asterisk 16 на пробный Setvar
  // по несуществующему каналу (замер на живой станции 21.09.2026), и это ЕДИНСТВЕННЫЙ
  // ответ, означающий «права на месте»: действие принято, отказал только адресат.
  // Без этого образца проверка вечно висела в «неизвестно» — то есть не отвечала
  // на свой вопрос ни разу с момента появления.
  if (/no such channel|channel not found|channel does not exist|не существует/.test(msg)) {
    return { name: "Права AMI (write=call)", ok: true, detail: "приняты (пробный канал не найден, как и ожидалось)", cls: "config" };
  }
  const cls = classifyStationError(result.error ?? "");
  return { name: "Права AMI (write=call)", ok: cls === "network" ? false : null, detail: result.error ?? "нет ответа", cls };
}

/**
 * ДО УЧАСТНИКА ОЧЕРЕДИ ФИЗИЧЕСКИ ДОХОДИТ ЗВОНОК — по ЛЮБОМУ из двух плеч, а не
 * только по настольному аппарату.
 *
 * ИСПРАВЛЕНО 21.09.2026. Прежнее условие было `endpoints.get(ext) === true`, то
 * есть «SIP-трубка зарегистрирована на станции». В агентстве настольных трубок
 * НЕТ НИ У КОГО и не будет: `sip show registry` — ноль регистраций с 18.08.2026,
 * все сотрудники работают с мобильных, и звонок доходит вторым плечом
 * `Local/<девять цифр>@from-internal` в строке набора (agentMobileFallback.ts).
 * Значит проверка обязана была докладывать «ни один участник не на связи»
 * КАЖДЫЙ день и навсегда — при исправной очереди. Замер 21.09.2026: станция
 * отвечает `Status: 1, Paused: 0`, очередь приняла 4 звонка накануне, а проверка
 * писала поломку.
 *
 * Ежедневная ложная тревога на самой важной проверке хуже её отсутствия: она
 * приучает пролистывать ровно ту строку, которой однажды скажут правду. Поэтому
 * критерий теперь тот же, что у самой станции при дозвоне: участник достижим,
 * если зарегистрирован его аппарат ИЛИ в его `DEVICE/<ext>/dial` есть мобильное
 * плечо.
 *
 * Отдельной строкой — статические участники (`membership: static`), молчащие
 * дольше DEAD_MEMBER_HOURS: agentIncomingReadiness.ts сознательно не трогает
 * статические записи (queues_details.conf — руки администратора станции), но
 * молчать про мёртвую трубку в них — и есть та самая дыра из отчёта (пункт 5,
 * «что никто не проверяет»). Критерий «мёртвая» — тот же самый: нет ни одного
 * живого плеча, а не «нет регистрации».
 */

/**
 * Мобильное плечо в строке набора: `SIP/1009&Local/880001007@from-internal/n`.
 *
 * Семь цифр и больше — намеренно: внутренний номер здесь трёх-четырёхзначный
 * (`Local/1009@from-queue/n`), и принять его за выход наружу значило бы снова
 * считать достижимым того, до кого не дозвониться. Местный мобильный — девять
 * цифр без кода страны, ровно как его пишет `normalizeDialNumber` (ariClient.ts).
 */
export const MOBILE_LEG_RE = /(^|&)\s*Local\/\d{7,}@/i;

/** Есть ли у участника хоть одно плечо, по которому до него дойдёт звонок.
 *  `null` — станция не отдала строку набора: это незнание, а не «мёртв». */
export function memberHasLiveLeg(
  deskOnline: boolean | undefined,
  dial: string | null | undefined,
  dialKnown: boolean
): boolean | null {
  if (deskOnline === true) return true;
  if (!dialKnown) return null;
  return MOBILE_LEG_RE.test(dial ?? "");
}

async function probeQueueAvailability(ariCreds: AriCredentials, amiCreds: AmiCredentials, now: number): Promise<StationCheck[]> {
  const raw = await readRawQueueMembers(amiCreds);
  if (!raw.ok) {
    const cls = classifyStationError(raw.error);
    return [{ name: "Очередь приёма: доступность", ok: cls === "network" ? false : null, detail: raw.error, cls }];
  }
  if (raw.members.length === 0) {
    return [{ name: "Очередь приёма: доступность", ok: false, detail: "в очереди нет ни одного участника", cls: "config" }];
  }

  let endpoints: Map<string, boolean>;
  try {
    endpoints = new Map((await listEndpointsRetrying(ariCreds)).map((e) => [e.resource, e.state === "online"]));
  } catch (err) {
    const detail = describeError(err);
    return [{ name: "Очередь приёма: доступность", ok: false, detail, cls: classifyStationError(detail) }];
  }

  // Строки набора читаем ОДИН раз на обход и пользуемся ими дважды (доступность
  // и мёртвые статические трубки): участников единицы, а лишний круг DBGet по
  // туннелю — это секунды, украденные у остальных проверок.
  const dials = new Map<string, string | null>();
  for (const ext of new Set(raw.members.map((m) => m.extension))) {
    const got = await amiDbGet(amiCreds, "DEVICE", `${ext}/dial`);
    if (got.ok) dials.set(ext, got.value);
  }
  const liveLeg = (m: RawQueueMember): boolean | null =>
    memberHasLiveLeg(endpoints.get(m.extension), dials.get(m.extension), dials.has(m.extension));

  const results: StationCheck[] = [];
  const available = raw.members.filter((m) => !m.paused && liveLeg(m) === true);
  // «Не смогли прочитать строку набора» — это не отказ: судить о доступности по
  // молчанию станции значит выдавать заминку связи за поломку очереди (тот же
  // разбор, что у stationHasContext в dialplanContext.ts).
  const anyUnknown = raw.members.some((m) => !m.paused && liveLeg(m) === null);
  results.push({
    name: "Очередь приёма: доступность",
    ok: available.length > 0 ? true : anyUnknown ? null : false,
    detail:
      available.length > 0
        ? `доступно ${available.length} из ${raw.members.length}`
        : anyUnknown
          ? "станция не отдала строки набора участников — судить о доступности нельзя"
          : `ни один из ${raw.members.length} участников не на связи или все на паузе`,
    cls: "config",
  });

  const deadStatic: string[] = [];
  for (const m of raw.members) {
    const key = `${m.queue}:${m.extension}`;
    if (m.membership !== "static") {
      staticMemberOfflineSince.delete(key);
      continue;
    }
    const alive = liveLeg(m);
    // Неизвестно — не копим срок: иначе каждая заминка туннеля через сутки
    // превращалась бы в «мёртвая трубка», которой на самом деле не было.
    if (alive !== false) {
      if (alive === true) staticMemberOfflineSince.delete(key);
      continue;
    }
    const since = staticMemberOfflineSince.get(key) ?? now;
    staticMemberOfflineSince.set(key, since);
    if (now - since >= DEAD_MEMBER_HOURS * HOUR_MS) deadStatic.push(`${m.extension} (очередь ${m.queue})`);
  }
  if (deadStatic.length > 0) {
    results.push({
      name: "Очередь приёма: статические участники",
      ok: false,
      detail: `не на связи дольше ${DEAD_MEMBER_HOURS} ч: ${deadStatic.join(", ")}`,
      cls: "config",
    });
  }
  return results;
}

/**
 * МОБИЛЬНОЕ ПЛЕЧО У ТЕХ, КТО ПРИНИМАЕТ НЕЗНАКОМЫЕ ЗВОНКИ. agentMobileFallback.ts
 * следит только за role=AGENT и (отдельно) за аппаратом приёма из настроек —
 * оператор (`Agent.takesUnknownCalls`, решение владельца 20.09.2026) в эти два
 * случая попадает не всегда: директор или админ, назначенный оператором, не
 * получит мобильное плечо ни от одного из существующих обходов. Читаем то же
 * значение (`DEVICE/<ext>/dial`) и сверяем той же функцией
 * (`buildDialWithMobileFallback`), которой уже пользуется agentMobileFallback.ts —
 * не значит чинить: чинит соответствующая сверка по расписанию, здесь только
 * сказать правду, если у оператора нет живого запасного пути.
 */
async function probeOperatorMobileLegs(creds: AmiCredentials): Promise<StationCheck | null> {
  const operators = await prisma.agent.findMany({
    where: { takesUnknownCalls: true, isActive: true, frozenAt: null, sipExtension: { not: null } },
    select: { fullName: true, sipExtension: true, phone: true },
  });
  if (operators.length === 0) return null; // некого проверять — не поломка, см. agentIncomingReadiness.ts

  const broken: string[] = [];
  for (const op of operators) {
    const ext = op.sipExtension!;
    const current = await amiDbGet(creds, "DEVICE", `${ext}/dial`);
    if (!current.ok) {
      // Станция не ответила на конкретный DBGet — это отказ связи для этого
      // сотрудника, а не «плеча нет»; не добавляем его в список поломок.
      continue;
    }
    if (buildDialWithMobileFallback(current.value, ext, op.phone) !== null) {
      broken.push(`${op.fullName} (${ext})`);
    }
  }
  if (broken.length === 0) return { name: "Мобильное плечо операторов", ok: true, detail: `проверено ${operators.length}`, cls: "config" };
  return {
    name: "Мобильное плечо операторов",
    ok: false,
    detail: `нет рабочего мобильного плеча: ${broken.join(", ")}`,
    cls: "config",
  };
}

/**
 * ЗАПИСЬ РАЗГОВОРОВ У ВЫДАННЫХ ДОБАВОЧНЫХ (21.09.2026, разбор «у резерва 1012–1020
 * записи не пишутся» — extensionPool.ts выдаёт номера из пула «Резерв», а на станции
 * у них `AMPUSER/<ext>/recording/{in,out}/external` заведён администратором как
 * `dontcare` вместо `always`). `ensureExtensionRecording` (extensionPool.ts) ставит
 * значение СРАЗУ при выдаче номера — эта проверка ловит расхождение, если станцию
 * потом поправили руками или значение стёрло «Apply Config» в FreePBX: тот же класс
 * сверки, что у мобильного плеча и очереди приёма выше в этом файле.
 *
 * Читаем ТОЛЬКО у занятых (закреплённых за живым, не замороженным сотрудником)
 * добавочных: свободный номер пула — забота администратора станции при заведении,
 * а не этого сторожа.
 */
async function probeExtensionRecording(creds: AmiCredentials): Promise<StationCheck | null> {
  const agents = await prisma.agent.findMany({
    where: { isActive: true, frozenAt: null, sipExtension: { not: null } },
    select: { fullName: true, sipExtension: true },
  });
  if (agents.length === 0) return null; // некого проверять — не поломка

  const broken: string[] = [];
  for (const agent of agents) {
    const ext = agent.sipExtension!;
    let extBroken = false;
    for (const key of EXTENSION_RECORDING_KEYS) {
      const current = await amiDbGet(creds, "AMPUSER", `${ext}/${key}`);
      // Станция не ответила на конкретный ключ — отказ связи для этого сотрудника,
      // а не «запись выключена»; не добавляем его в список поломок.
      if (!current.ok) continue;
      // «yes» — старое значение FreePBX для «писать всегда» (так заведён 1002 до
      // нас, разбор станции 21.09.2026) — это не поломка.
      if (current.value !== EXTENSION_RECORDING_VALUE && current.value !== "yes") extBroken = true;
    }
    if (extBroken) broken.push(`${agent.fullName} (${ext})`);
  }
  if (broken.length === 0) {
    return { name: "Запись разговоров у добавочных", ok: true, detail: `проверено ${agents.length}`, cls: "config" };
  }
  return {
    name: "Запись разговоров у добавочных",
    ok: false,
    detail: `запись выключена: ${broken.join(", ")}`,
    cls: "config",
  };
}

/**
 * ЗВОНКИ ВООБЩЕ ИДУТ — ПЕРЕИСПОЛЬЗУЕМ incomingCallsSilenceAlarm.ts, А НЕ ПОВТОРЯЕМ
 * ЕГО ЛОГИКУ (прямое указание задачи «если что-то подобное уже есть — не
 * дублировать»). Тот сторож уже отличает «тихо, потому что обед» от «тихо, потому
 * что сломано» через собственную недельную базовую линию — второй раз изобретать
 * это здесь означало бы второй набор порогов, которые неизбежно разойдутся.
 * Вызов идёт из ДВУХ мест (свой почасовой тик в cron.ts + этот тик каждые 15 минут) —
 * это безопасно: `shouldAlert` внутри уже дедуплицирует тревогу раз в сутки на тег,
 * так что задваивания уведомлений не будет, а сводная проверка получает актуальный
 * статус чаще, чем раз в час.
 */
async function probeIncomingCallsFlowing(now: Date): Promise<StationCheck | null> {
  try {
    /**
     * ВНЕ ЧАСОВ АЛАРМОВ СТОРОЖ НЕ СМОТРИТ ВОВСЕ и возвращает пустой результат —
     * тот же самый, что и при «всё хорошо». Без этой проверки сводка ночью
     * рапортовала бы «звонки доходят», ничего не проверив: ложное «ок» хуже
     * честного «не знаю», потому что именно на него смотрят, когда ищут причину
     * (поймано при сборке 20.09.2026).
     */
    if (!(await isWithinAlarmHours(now))) return null;
    const { symptoms } = await runIncomingCallsSilenceTick(now);
    if (symptoms.length === 0) return { name: "Входящие звонки доходят", ok: true, detail: "тишины/сплошных обрывов не найдено", cls: "config" };
    return {
      name: "Входящие звонки доходят",
      ok: false,
      detail: `обнаружено: ${symptoms.join(", ")} (подробности — incomingCallsSilenceAlarm)`,
      cls: "config",
    };
  } catch {
    return null; // сторож сам не настроен/не сработал — не наша забота, у него своя проверка
  }
}

/**
 * ЗНАЧЕНИЯ ASTDB ЗАПАСНОГО ПУТИ СОВПАДАЮТ С ЖЕЛАЕМЫМИ — независимо от события
 * переподключения (пункт 7 отчёта). `reconcileFailoverOnReconnect` сверяет это
 * ТОЛЬКО когда открылась подписка ARI — если рассинхрон случился без разрыва
 * связи (например, кто-то руками поправил AstDB), об этом не узнают никогда.
 * Раз в сутки, а не на каждом 15-минутном тике — намеренно, тем же доводом, что
 * уже записан в failoverSync.ts («настройки меняются раз в месяц, а запросы шли
 * бы круглосуточно»): вызывается из ежедневной сводки, см. checkTelephonyDailyHealth.
 */
export async function checkFailoverAstDbHealth(): Promise<StationCheck | null> {
  const creds = await loadAmiCredentials();
  if (!creds) return null;
  const desired = await loadFailoverConfig();
  const actual = await readFailoverFromStation(creds);
  if (!actual.ok) return { name: "Запасной путь (AstDB)", ok: classifyStationError(actual.error) === "network" ? false : null, detail: actual.error, cls: classifyStationError(actual.error) };
  if (!failoverDiffers(desired, actual.config)) return { name: "Запасной путь (AstDB)", ok: true, detail: "совпадает с CRM", cls: "config" };
  return {
    name: "Запасной путь (AstDB)",
    ok: false,
    detail: `разошёлся со станцией: ${describeFailoverDiff(desired, actual.config)}`,
    cls: "config",
  };
}

/**
 * Какие именно значения разошлись — все, а не одно `action` (28.09.2026). Раньше
 * деталь называла только дневное правило: разошедшийся режим консультанта
 * (`aimode`) выглядел как «CRM хочет none, станция хранит none» — то есть как
 * бессмыслица, хотя расхождение было настоящим.
 */
export function describeFailoverDiff(desired: FailoverConfig, actual: FailoverConfig): string {
  const keys: (keyof FailoverConfig)[] = [
    "action",
    "seconds",
    "phone",
    "nightAction",
    "nightStart",
    "nightEnd",
    "target",
    "aiMode",
    "aiSeconds",
    "aiDayStart",
    "aiDayEnd",
  ];
  const show = (v: string | number) => (v === "" ? "пусто" : String(v));
  return keys
    .filter((k) => desired[k] !== actual[k])
    .map((k) => `${k}: CRM «${show(desired[k])}», станция «${show(actual[k])}»`)
    .join("; ");
}

/** Человеческая формулировка для журнала и пуша директору — что случилось, чем это
 *  грозит клиенту прямо сейчас и что делать. Стиль — по образцу
 *  incomingCallsSilenceAlarm.ts/agentMobileFallback.ts (владелец — не программист). */
function humanMessage(check: StationCheck): string {
  switch (check.name) {
    case "Диалплан (файл)":
      return (
        `На станции не хватает части настройки маршрутизации звонков (${check.detail}). Пока это не поправят, ` +
        `перевод звонка на ответственного агента может не сработать вовсе. Нужен администратор станции.`
      );
    case "Диалплан (в памяти станции)":
      return (
        `Маршрутизацию звонков на станции недавно правили, но станция ещё не перечитала настройку ` +
        `(${check.detail}). До перезагрузки диалплана на станции («dialplan reload») звонки будут идти по-старому, ` +
        `хотя настройка в файле выглядит правильной.`
      );
    case CONSULTANT_DIALPLAN_CHECK:
      return (
        `В Настройках выбран консультант вместо автоответчика, но станция его не зовёт (${check.detail}). ` +
        `Пока диалплан станции не обновят, звонки идут по-старому: оператор, потом автоответчик. ` +
        `Нужен администратор станции: ${CONSULTANT_DIALPLAN_FIX}.`
      );
    case LIVE_VOICE_APP_CHECK:
      return (
        `Робот-консультант не подключён к станции (${check.detail}). Пока это так, станция не может отдать ему ни ` +
        `одного звонка: входящие идут на автоответчик, хотя в Настройках робот включён. Обычно это чинит ` +
        `перезапуск API; если не помогло — смотрите туннель ARI.`
      );
    case LIVE_VOICE_PAUSE_CHECK:
      return (
        `Робот-консультант стоит на паузе дольше получаса (${check.detail}). Все входящие, которые должен был брать ` +
        `робот, уходят на автоответчик. Смотрите журнал ошибок живого голоса.`
      );
    case "Права AMI (write=call)":
      return (
        `У CRM отобрали право переводить звонки на станции (${check.detail}). Перевод известного клиента на ` +
        `своего агента перестанет работать — звонок останется в общей очереди. Нужно вернуть права ` +
        `пользователю AMI на станции.`
      );
    case "Очередь приёма: доступность":
      return (
        `В очереди приёма незнакомых звонков прямо сейчас некому ответить (${check.detail}). Новый клиент, ` +
        `который звонит впервые, услышит гудки и не дозвонится ни до кого. Проверьте, кто должен быть на приёме.`
      );
    case "Очередь приёма: статические участники":
      return (
        `В очереди приёма настроен номер, который не отвечает уже больше ${DEAD_MEMBER_HOURS} часов (${check.detail}). ` +
        `Если в это время он единственный на приёме, клиент дозвонится в тишину. Проверьте, подключён ли телефон.`
      );
    case "Мобильное плечо операторов":
      return (
        `У сотрудника, который принимает незнакомые звонки, нет рабочего мобильного номера для подстраховки ` +
        `(${check.detail}). Если его рабочий телефон не ответит, звонок клиента просто оборвётся. Проверьте номер ` +
        `в карточке сотрудника.`
      );
    case "Запасной путь (AstDB)":
      return (
        `Правило «если оператор не ответил» на станции отличается от того, что настроено в CRM (${check.detail}). ` +
        `Запасной путь для непринятых звонков может повести клиента не туда, куда рассчитывает владелец.`
      );
    case "Запись разговоров у добавочных":
      return (
        `У сотрудников на станции выключена запись разговоров (${check.detail}). Их звонки не попадут ни в ` +
        `хронологию клиента, ни в расшифровку — молча, без единого следа. Включите запись на станции для этих ` +
        `номеров (recording/in и /out = always).`
      );
    default:
      return `Проверка телефонии «${check.name}» не проходит: ${check.detail}.`;
  }
}

async function raiseAlert(tag: string, title: string, body: string): Promise<void> {
  if (!(await shouldAlert(tag, ALERT_MIN_INTERVAL_MS))) return;
  const directorIds = (
    await prisma.agent.findMany({ where: { role: { in: ["DIRECTOR", "ADMIN"] }, isActive: true }, select: { id: true } })
  ).map((d) => d.id);
  const payload = { kind: "oversight" as const, title, body, url: "/settings", tag, level: "CRITICAL" as const };
  for (const agentId of directorIds) {
    await createNotifications([agentId], payload).catch((err) => console.error("[telephony-health] notify:", err));
  }
  void sendPushToAgents(directorIds, payload).catch((err) => console.error("[telephony-health] push:", err));
  // В журнал — без второго пуша (директора оповещены строкой выше) и с ключом
  // вида тревоги: подробность в тексте меняется от раза к разу (E11, 02.10.2026).
  await logSystemError("telephony", body, { dedupKey: tag, silent: true }).catch((err) =>
    console.error("[telephony-health] journal:", err)
  );
}

export interface StationHealthTickResult {
  checks: StationCheck[];
  confirmedBroken: string[];
}

/**
 * ОДИН ПРОХОД — каждые 15 минут (cron.ts, рядом с остальными телефонными сверками).
 * Никогда не бросает: сбой сводной проверки не должен ронять крон и не должен
 * мешать другим тикам телефонии.
 */
export async function runStationHealthTick(now: Date = new Date()): Promise<StationHealthTickResult> {
  const checks: StationCheck[] = [];
  try {
    const ari = await probeAri();
    if (ari) checks.push(ari);
    const { check: ami, creds: amiCreds } = await probeAmi();
    if (ami) checks.push(ami);

    const ariCreds = await loadAriCredentials();

    // Дальше есть смысл спрашивать, только если сама связь жива — иначе шесть
    // проверок подряд ответят той же самой сетевой ошибкой (см. пункт 3 в шапке).
    if (amiCreds) {
      checks.push(await probeDialplanContextsOnDisk(amiCreds));
      checks.push(await probeDialplanLoaded(amiCreds));
      checks.push(await probeConsultantDialplan(amiCreds));
      checks.push(await probeAmiWritePermission(amiCreds));
      const mobile = await probeOperatorMobileLegs(amiCreds);
      if (mobile) checks.push(mobile);
      const recording = await probeExtensionRecording(amiCreds);
      if (recording) checks.push(recording);
      if (ariCreds) checks.push(...(await probeQueueAvailability(ariCreds, amiCreds, now.getTime())));
    }
    // Робот: приложение на станции и пауза (09.10.2026, аудит линии робота).
    if (ariCreds) checks.push(await probeLiveVoiceApp(ariCreds));
    checks.push(liveVoicePauseCheck(now.getTime()));

    const silence = await probeIncomingCallsFlowing(now);
    if (silence) checks.push(silence);

    /**
     * СВЕРКА С РАБОЧИМ ЭТАЛОНОМ (просьба владельца 21.09.2026: «если всё
     * работает — сделай так, чтобы никто больше не трогал эти настройки»).
     *
     * Отдельно от проверок выше и намеренно последней: те отвечают «станция
     * жива», эта — «настройка осталась той, при которой звонки доходили». С
     * 21.08 по 19.09.2026 входящие не доходили тридцать дней подряд, и всё это
     * время все проверки живости были зелёными — сломана была одна настройка.
     * Разбор эталона и почему это сторож, а не запрет: telephonyBaseline.ts.
     */
    const drift = await collectBaselineDrift(amiCreds ?? null);
    if (drift.length > 0) {
      checks.push({
        name: "Настройки телефонии: рабочий эталон",
        ok: false,
        detail: describeDrift(drift),
        cls: "config",
      });
    }
  } catch (err) {
    // Сюда попадает только сбой самого обхода (не отдельной проверки — они сами
    // ловят свои ошибки): не роняем тик, но оставляем след в журнале.
    void logSystemError("telephony", `Сводная проверка телефонии не выполнена целиком: ${describeError(err)}`, { dedupKey: "Сводная проверка телефонии не выполнена целиком: …" });
    return { checks, confirmedBroken: [] };
  }

  // Имя переменной НАМЕРЕННО отличается от функции recordCheckFailure ниже: в
  // соседнем модуле (agentIncomingReadiness.ts) ровно такое совпадение имён уже
  // однажды пришлось распутывать — здесь массив результатов и функция-счётчик
  // не должны называться одинаково.
  const brokenNames: string[] = [];
  const networkDown = checks.some((c) => c.cls === "network" && c.ok === false);
  const networkConfirmed = recordNetworkFailure(networkDown);

  for (const check of checks) {
    // Снимок — на тот же экран, что и остальные внешние доступы (IntegrationHealthSnapshot,
    // /integrations, "Здоровье системы"): один механизм на все интеграции, а не третий свой.
    await prisma.integrationHealthSnapshot
      .upsert({
        where: { name: `Телефония: ${check.name}` },
        create: { name: `Телефония: ${check.name}`, ok: check.ok, detail: check.detail },
        update: { ok: check.ok, detail: check.detail },
      })
      .catch(() => {});

    if (check.cls === "network") continue; // сеть — одна общая тревога ниже, не по строке на проверку
    if (recordCheckFailure(check.name, check.ok === false)) {
      brokenNames.push(check.name);
      await raiseAlert(`telephony-health-${check.name}`, "📵 Телефония: найдена поломка", humanMessage(check));
    }
  }

  if (networkConfirmed) {
    brokenNames.push("station-network");
    await raiseAlert(
      "telephony-health-network",
      "📵 Телефония: нет связи со станцией",
      "CRM не может связаться со станцией (ARI и/или AMI) уже как минимум полчаса подряд — это дольше обычного " +
        "моргания туннеля. Пока связи нет, ничего из телефонии (перевод звонков, очередь, запись разговоров) " +
        "проверить нельзя. Проверьте туннель и саму станцию."
    );
  }

  return { checks, confirmedBroken: brokenNames };
}

/** Второй, независимый счётчик подтверждений — специально отдельный от
 *  confirmState выше: сетевая тревога сводная (одна на ARI+AMI вместе, см. пункт 3
 *  в шапке), а не по каждой проверке отдельно, поэтому и ключ у неё свой. */
const networkConfirmState = new Map<string, number>();
function recordNetworkFailure(brokenNow: boolean): boolean {
  const key = "station-network-umbrella";
  if (!brokenNow) {
    networkConfirmState.delete(key);
    return false;
  }
  const streak = (networkConfirmState.get(key) ?? 0) + 1;
  networkConfirmState.set(key, streak);
  return streak >= CONFIRM_TICKS;
}

/**
 * ЕЖЕДНЕВНАЯ ЧАСТЬ — вызывается из lib/integrationHealth.ts::runIntegrationHealthChecks
 * (тот же суточный тик, тот же журнал, тот же экран «Здоровье системы» — без
 * третьего параллельного механизма). Только то, что незачем спрашивать каждые
 * 15 минут (см. checkFailoverAstDbHealth выше по тексту).
 */
export async function checkTelephonyDailyHealth(): Promise<{ name: string; ok: boolean | null; detail?: string }> {
  const check = await checkFailoverAstDbHealth();
  if (!check) return { name: "Телефония: запасной путь (AstDB)", ok: null, detail: "не настроена" };
  if (check.ok === false) {
    void logSystemError("telephony", humanMessage(check));
  }
  return { name: `Телефония: ${check.name}`, ok: check.ok, detail: check.detail };
}
