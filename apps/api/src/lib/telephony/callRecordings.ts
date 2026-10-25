import { captureExplicitClientPhone } from "../clientPhoneCapture.js";
import { runClientAutopilotInBackground } from "../clientAutopilot.js";
import { prisma } from "../../db.js";
import { scheduleSellerFactsRefresh } from "../sellerFacts.js";
import { transcribeAudioResult } from "../../ai/transcribe.js";
import { splitAudioForTranscription, type AudioParts } from "../../ai/audioChunks.js";
import { logSystemError } from "../systemError.js";
import { logTimeline } from "../timeline.js";
import { describeError } from "../describeError.js";
import { buildSuggestionFromCall } from "../cardSuggestions.js";
import { analyzeCall } from "../../ai/callAnalysis.js";
import { autoLeadFromInteraction } from "./autoLeadFromCall.js";
import { r2Download } from "../r2Client.js";
import { mapWithConcurrency } from "../concurrency.js";
import { findAgentsWithPermission } from "../recipients.js";
import { enqueueBackgroundJob } from "../../jobs/enqueue.js";
import { sendPushToAgents } from "../../push.js";
import { shouldAlert } from "../notifications.js";
import { scrubMentionedPhones } from "./callPhoneMasking.js";
import { dushanbeWallClock } from "../dushanbeTime.js";
import type { CallTranscriptionStage } from "@royal-home/shared";

/**
 * Запись телефонных разговоров: расшифровать и привязать к карточке клиента.
 *
 * ЗАЧЕМ. В хронологии клиента до сих пор оставалась только строчка «поговорили 1:12»
 * (callTracker.ts). О чём был разговор — знал один агент, и при его уходе это знание
 * уходило вместе с ним. Запись + расшифровка делают разговор частью карточки клиента:
 * руководитель может проверить обещания агента, а бот и Royal Score — опереться на
 * текст, а не на отметку «дозвонился».
 *
 * ГДЕ ЛЕЖАТ САМИ ФАЙЛЫ. На станции, там же, где их пишет Asterisk, — решение владельца
 * 07.08.2026. Сначала записи складывались в Cloudflare R2, но там бесплатных 10 ГБ, а
 * на диске станции свободно 68 ГБ: год архива после сжатия в MP3 занимает около 24 ГБ
 * и обходится бесплатно. CRM хранит у записи в хронологии только путь и по требованию
 * отдаёт файл (routes/interactions.ts), скачивая его с АТС тем же способом, что и для
 * расшифровки. Ротацией и сжатием занимается сама станция
 * (/usr/local/bin/royalhome-recordings-maintenance.sh, год хранения).
 *
 * Плата за это — единственный экземпляр: копии записей нигде больше нет, и смерть
 * диска станции означает потерю архива. Владелец предупреждён и выбрал этот вариант.
 *
 * ВАЖНО ПРО СЖАТИЕ. Тот же скрипт станции через ПЯТЬ МИНУТ после разговора
 * превращает `.wav` в `.mp3` и удаляет исходник. Путь, записанный в карточку в
 * момент звонка, после этого указывает в пустоту — станция отвечает 404. Именно так
 * 11.08.2026 выяснилось, что не проигрывалась НИ ОДНА запись старше пяти минут, а
 * расшифровка при этом была на месте (она делается сразу, пока WAV ещё жив), — из-за
 * чего сбой выглядел необъяснимо: «текст есть, звук исчез». Поэтому fetchRecording
 * спрашивает соседние расширения, а найденный путь записывается обратно в карточку
 * (см. siblingPaths ниже и routes/interactions.ts).
 *
 * ПОЧЕМУ HTTP, А НЕ SCP. Первое, что напрашивается, — забрать файл по SSH: доступ
 * `ssh rh-pbx` у сопровождающего уже есть. Но забирает файл не сопровождающий, а
 * контейнер CRM на VPS, и для SCP в него пришлось бы положить приватный ключ от
 * станции — то есть ключ от телефонии агентства в образе Docker и в резервных копиях.
 * Угнанная АТС означает звонки на платные направления за счёт агентства (см.
 * docs/telephony-sip-numbering.md), поэтому цена такой ошибки несоразмерна удобству.
 * Плюс в образе нет ни ssh-клиента, ни библиотеки ssh2 — появилась бы ещё и
 * зависимость ради одной операции.
 *
 * Вместо этого файл забирается обычным GET по тому же туннелю, по которому CRM уже
 * ходит в ARI: станция сама подключается к VPS и пробрасывает порт на docker-мосты
 * (наружу ничего не открывается). На стороне АТС отдаёт каталог записей маленький
 * статический сервер, закрытый общим токеном. Настройка станции — в
 * docs/telephony-sip-numbering.md, раздел «Запись разговоров».
 *
 * ПОЧЕМУ ИМЯ ФАЙЛА ПРИХОДИТ ИЗВНЕ. Угадывать путь по дате и номеру нельзя: FreePBX
 * собирает имя из внутреннего uniqueid канала, и совпадение по секунде подсунуло бы
 * в карточку чужой разговор. Настоящее имя Asterisk сообщает сам — переменной
 * MIXMONITOR_FILENAME в событии ChannelVarset; её и запоминает rememberRecordingPath().
 */

/** Корень записей FreePBX. Всё, что приходит от станции, обязано лежать внутри него —
 *  иначе это не запись разговора, а попытка вычитать посторонний файл. */
const MONITOR_ROOT = "/var/spool/asterisk/monitor/";

/** Час разговора — около 55 МБ в WAV. Потолок с запасом на длинный разговор, но не
 *  настолько, чтобы одна аномальная запись съела память процесса. */
const MAX_RECORDING_BYTES = 150 * 1024 * 1024;

/**
 * Нижний порог «в файле реально есть звук» (18.08.2026, после случая на проде:
 * MixMonitor записал два разговора в 44 байта — это ровно пустой заголовок WAV,
 * ни секунды звука). Даже одна секунда 8kHz/16-bit моно — это ~16 КБ, поэтому
 * 2 КБ уже с большим запасом отсекает только настоящую пустышку, а не короткое
 * «алло» на секунду. Ниже порога — не расшифровываем (нечего) и не показываем
 * плеер как рабочий: агент должен сразу увидеть «записи нет», а не тишину под
 * видом настоящей записи.
 */
const MIN_RECORDING_BYTES = 2_000;

/** Начало текста записи о ВХОДЯЩЕМ звонке — его пишет lib/telephony/incomingCalls.ts
 *  и только он. По нему догоняющий поиск понимает, что добавочного агента в имени
 *  файла не будет (разговор пишет очередь, а не оператор). */
const INCOMING_CALL_NOTE_PREFIX = "Входящий звонок клиента";

/** Gemini принимает аудио телом запроса в base64; крупные файлы он отвергает целиком.
 *  Дешевле не отправлять их вовсе, чем ждать таймаут и писать отказ в журнал. */
const TRANSCRIBE_MAX_BYTES = 15 * 1024 * 1024;

/**
 * Файл тянется по локальному туннелю, но с диска станции и целиком в память.
 *
 * ЭТО ПОТОЛОК НА ВЕСЬ ПОИСК ФАЙЛА, А НЕ НА ОДИН ЗАПРОС. fetchRecording спрашивает
 * до четырёх расширений подряд (станция могла успеть сжать wav в mp3), и пока
 * таймаут был на каждый запрос свой, зависший туннель держал маршрут
 * `/interactions/:id/recording` до восьми минут: браузер и обратный прокси к тому
 * времени давно отваливались, а сокет на сервере всё ещё ждал. Общий бюджет делает
 * худший случай равным лучшему — две минуты, ровно столько, сколько может честно
 * качаться часовой разговор.
 */
const FETCH_BUDGET_MS = 120_000;

export interface RecordingFetchConfig {
  baseUrl: string;
  token: string | null;
}

/** Адрес каталога записей на АТС. Живёт в .env, а не в Настройках: это часть обвязки
 *  сервера (как адрес туннеля), а не то, что директор меняет из интерфейса. */
/** Тег и частота напоминания руководству о пустых записях (см. ingestCallRecording). */
const RECORDING_EMPTY_TAG = "recording-empty";
const RECORDING_EMPTY_REALERT_MS = 6 * 3_600_000;

export function recordingFetchConfig(): RecordingFetchConfig | null {
  const baseUrl = process.env.PBX_RECORDINGS_URL?.replace(/\/+$/, "");
  if (!baseUrl) return null;
  return { baseUrl, token: process.env.PBX_RECORDINGS_TOKEN || null };
}

/**
 * Поиск записи в каталоге станции.
 *
 * Сначала предполагалось, что путь сообщит сама АТС переменной MIXMONITOR_FILENAME.
 * На живых событиях этого не случилось: FreePBX шлёт только `TOUCH_MONITOR` с
 * внутренним uniqueid, а имя файла собирает сама и наружу не отдаёт. Поэтому запись
 * ищется по каталогу дня.
 *
 * Совпадение не «примерно по времени», а по признакам сразу. У ИСХОДЯЩЕГО их три —
 * номер клиента, внутренний номер агента и минута начала; имя файла у FreePBX
 * выглядит так:
 *   out-<номер клиента>-<внутренний агента>-<ГГГГММДД>-<ЧЧММСС>-<uniqueid>.mp3
 * Совпасть всем трём у чужого разговора невозможно — для этого тот же агент должен
 * в ту же минуту звонить тому же клиенту.
 *
 * У ВХОДЯЩЕГО внутреннего номера в имени нет: разговор пишет очередь, а не оператор
 * (`q-<очередь>-<номер звонящего>-<ГГГГММДД>-<ЧЧММСС>-<uniqueid>`). Признаков два —
 * номер звонящего и минута; номер при этом приходит с кодом страны, поэтому
 * сравнивается по девятизначному хвосту (см. nameHasClientNumber).
 */
export interface RecordingSearch {
  /** Когда звонок начался — по нему берётся каталог дня и окно поиска. */
  startedAt: Date;
  /**
   * Внутренний номер агента (1004) — ТОЛЬКО У ИСХОДЯЩИХ.
   *
   * У входящего его в имени файла нет: очередь пишет разговор от своего имени, а не
   * от имени снявшего трубку оператора. Поэтому поле необязательное — но если оно
   * передано, требование остаётся строгим (для исходящих поведение не изменилось).
   */
  agentExtension?: string;
  /** Телефон клиента в любом виде: сравниваются только цифры набора. */
  clientPhone: string;
  /**
   * Момент ответа оператора — у входящих запись начинается с него, а не с гудка:
   * человек может простоять в очереди несколько минут, и окно вокруг начала звонка
   * до файла бы не дотянулось.
   */
  answeredAt?: Date;
  /**
   * КУДА ШЁЛ ЗВОНОК — ОБЯЗАТЕЛЬНОЕ ПОЛЕ (21.09.2026, разбор прод-жалобы «входящему
   * подшилась чужая запись»: три входящих 1010 (14:01, 16:19, 16:18:39) получили
   * файлы соседних ИСХОДЯЩИХ (13:57, 16:22) того же клиента — поиск совпадал по
   * номеру клиента и минуте, префикс имени файла не проверялся вовсе, а окно ±5
   * минут (SEARCH_WINDOW_MS) у частого клиента накрывает сразу оба звонка.
   * `reconcileCallAuthor` эту подмену не ловит: добавочный в имени `out-…` совпадает
   * с тем, что реально звонил, — привязан не тот РАЗГОВОР, а не не тот АГЕНТ.
   *
   * Без direction различить эти два случая по имени файла нельзя — префикс
   * (`out-` у исходящего, `in-`/`external-`/`q-` у входящего, см. findRecording) и
   * есть единственный надёжный признак направления, а agentExtension для этого не
   * годится: он необязателен и у входящего отсутствует по другой причине (его нет
   * в имени файла), а не потому что направление неизвестно.
   */
  direction: "incoming" | "outgoing";
}

/** Окно, в котором имя файла считается «тем самым». Пять минут с запасом на то,
 *  что запись начинается не в ту же секунду, что и команда звонка. */
const SEARCH_WINDOW_MS = 5 * 60_000;

/**
 * Префиксы имени файла по направлению (21.09.2026). ИСХОДЯЩИЙ пишет сам канал
 * агента — `out-`. ВХОДЯЩИЙ пишет очередь или транк, а не оператор — на практике
 * встречаются все три варианта в зависимости от того, что именно на станции ведёт
 * запись (см. extensionFromRecordingName): `q-<очередь>-…`, `in-…`, `external-…`.
 * Файл с любым другим префиксом (в первую очередь `out-`) для входящего не
 * годится НИКОГДА, даже если номер клиента и минута совпали, — иначе это и есть
 * та самая подмена, из-за которой входящему подшивалась чужая исходящая запись.
 */
const INCOMING_RECORDING_PREFIXES = ["q-", "in-", "external-"];
const OUTGOING_RECORDING_PREFIXES = ["out-"];

function dateDir(at: Date): string {
  // Каталоги станция раскладывает по местному времени Душанбе (UTC+5), а сервер CRM
  // живёт в UTC — без сдвига запись за 02:00 по Душанбе искалась бы во вчерашнем дне.
  const local = new Date(at.getTime() + 5 * 60 * 60_000);
  const y = local.getUTCFullYear();
  const m = String(local.getUTCMonth() + 1).padStart(2, "0");
  const d = String(local.getUTCDate()).padStart(2, "0");
  return `${y}/${m}/${d}`;
}

/** Время из имени файла (…-ГГГГММДД-ЧЧММСС-…) в миллисекунды UTC. */
function timeFromName(name: string): number | null {
  const m = name.match(/-(\d{8})-(\d{6})-/);
  if (!m) return null;
  const [, date, time] = m;
  const iso = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4, 6)}+05:00`;
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Есть ли в имени файла номер клиента.
 *
 * Сравниваем ПО ХВОСТУ в девять цифр, потому что один и тот же человек приходит в
 * имя файла по-разному: у исходящего станция кладёт то, что набрала (`880001007`),
 * у входящего — то, что сообщил транк, с кодом страны (`992880001007`). Прежняя
 * проверка `name.includes("-880001007-")` второй случай не находила НИКОГДА — то
 * есть запись входящего разговора не находилась вовсе.
 *
 * Имя режется на цифровые сегменты, а не ищется подстрокой: `-` в имени встречается
 * и внутри uniqueid, и в дате. Ограничение длины сегмента 9–12 цифр отсеивает дату
 * (`20260807`) и «секунды» (`181630`), но НЕ uniqueid (у Asterisk это epoch, тех же
 * десяти цифр) — от чужого разговора защищают хвост номера и окно времени, а не
 * длина сегмента.
 */
function nameHasClientNumber(name: string, tail: string): boolean {
  return name
    .split(/\D+/)
    .some((segment) => segment.length >= 9 && segment.length <= 12 && segment.endsWith(tail));
}

/** Листинг одного каталога дня. Нет каталога (404) — это не ошибка, а «в тот день
 *  записей не было»: у смежных суток так бывает всегда. */
async function listRecordingDir(dir: string, config: RecordingFetchConfig): Promise<string[]> {
  const res = await fetch(`${config.baseUrl}/${dir}/`, {
    headers: config.token ? { "X-Recordings-Token": config.token } : {},
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 404) return [];
  if (!res.ok) {
    // Прочие отказы (403 — X-Recordings-Token перестал подходить, 5xx — станция
    // лежит) до 26.08.2026 выглядели как пустой каталог: записи «не находились»,
    // разговоры молча оставались без расшифровки, и в журнале было пусто — сбой
    // доступа к станции был невидим до жалобы владельца.
    void logSystemError("telephony", `Каталог записей АТС не прочитан (${dir}): HTTP ${res.status}`, { dedupKey: "Каталог записей АТС не прочитан (…): HTTP …" });
    return [];
  }
  const html = await res.text();
  return [...html.matchAll(/href="([^"]+\.(?:wav|mp3|ogg|gsm))"/g)].map((m) => decodeURIComponent(m[1]));
}

/**
 * Ищет файл записи для конкретного звонка. Возвращает путь относительно каталога
 * записей или null, если подходящего нет (запись выключена, недозвон, ротация).
 *
 * Для ИСХОДЯЩИХ признаков три: номер клиента, внутренний номер агента и минута —
 * совпасть всем трём у чужого разговора невозможно. Для ВХОДЯЩИХ внутреннего номера
 * в имени нет (пишет очередь, а не оператор), поэтому признаков два: номер звонящего
 * и минута.
 *
 * КАТАЛОГИ СМЕЖНЫХ СУТОК. Станция раскладывает записи по местному времени Душанбе, и
 * разговор, начатый в 23:58, лежит уже в файле следующего дня — а искали его только
 * во вчерашнем каталоге и не находили. Спрашиваем три каталога вокруг звонка;
 * обычно это один и тот же, и лишних запросов не возникает.
 */
export async function findRecording(search: RecordingSearch, config: RecordingFetchConfig): Promise<string | null> {
  // Якорь — момент ответа, если он известен: у входящего запись начинается с него,
  // а не с гудка (человек мог простоять в очереди дольше окна поиска).
  const anchor = search.answeredAt ?? search.startedAt;
  const dirs = [...new Set([
    dateDir(new Date(anchor.getTime() - SEARCH_WINDOW_MS)),
    dateDir(anchor),
    dateDir(new Date(anchor.getTime() + SEARCH_WINDOW_MS)),
  ])];

  const digits = search.clientPhone.replace(/\D/g, "");
  const tail = digits.slice(-9);
  const anchors = [search.startedAt.getTime(), ...(search.answeredAt ? [search.answeredAt.getTime()] : [])];

  const allowedPrefixes = search.direction === "incoming" ? INCOMING_RECORDING_PREFIXES : OUTGOING_RECORDING_PREFIXES;

  let best: { path: string; distance: number } | null = null;
  for (const dir of dirs) {
    const names = await listRecordingDir(dir, config);
    for (const name of names) {
      // Направление — первый и самый жёсткий фильтр: файл чужого направления не
      // подходит никогда, сколько бы других признаков ни совпало (см. комментарий
      // у INCOMING_RECORDING_PREFIXES).
      if (!allowedPrefixes.some((prefix) => name.startsWith(prefix))) continue;
      if (!nameHasClientNumber(name, tail)) continue;
      // Внутренний номер спрашиваем, только если он у нас есть: см. agentExtension.
      if (search.agentExtension && !name.includes(`-${search.agentExtension}-`)) continue;
      const at = timeFromName(name);
      if (at === null) continue;
      const distance = Math.min(...anchors.map((a) => Math.abs(at - a)));
      if (distance > SEARCH_WINDOW_MS) continue;
      if (!best || distance < best.distance) best = { path: `${dir}/${name}`, distance };
    }
  }
  return best?.path ?? null;
}

/** channelId → абсолютный путь записи на АТС, если станция его всё-таки сообщила.
 *  Основной путь теперь — поиск по каталогу (findRecording), но обработчик события
 *  оставлен: на других сборках Asterisk переменная приходит, и тогда это точнее. */
const pendingPaths = new Map<string, string>();

/** Asterisk сообщил, куда пишет разговор (ChannelVarset, MIXMONITOR_FILENAME). */
export function rememberRecordingPath(channelId: string, absolutePath: string): void {
  if (!channelId || !absolutePath) return;
  pendingPaths.set(channelId, absolutePath);
}

export function forgetRecordingPath(channelId: string): void {
  pendingPaths.delete(channelId);
}

/**
 * Внутренний номер агента из имени файла записи (17.09.2026).
 *
 * Только у ИСХОДЯЩЕГО он в имени есть: `out-<номер клиента>-<внутренний>-<дата>-
 * <время>-<uniqueid>`. У входящего (какой бы префикс станция ни использовала — в
 * коде это `q-<очередь>-…`, на практике встречается и `in-…`) добавочного в имени
 * нет: пишет очередь, а не оператор, поэтому для любого файла не с `out-` в начале
 * возвращаем null — это не «не нашли», а «у такого файла его и не бывает».
 */
export function extensionFromRecordingName(name: string): string | null {
  const base = name.split("/").pop() ?? name;
  const match = base.match(/^out-\d+-(\d+)-\d{8}-\d{6}-/);
  return match ? match[1] : null;
}

/** Минимум, что нужно знать о разговоре, чтобы сверить автора с добавочным. */
export interface CallAuthorInteraction {
  id: string;
  clientId: string;
  agentId: string | null;
}

/** Минимум об агенте, за которым сейчас числится разговор. */
export interface CallAuthorAgent {
  id: string;
  fullName: string;
  sipExtension: string | null;
}

export type ReconcileCallAuthorOutcome =
  | { action: "unchanged" }
  | { action: "reassigned"; to: { id: string; fullName: string } }
  | { action: "orphan-extension"; extension: string }
  | { action: "rejected"; extension: string; belongsTo: { id: string; fullName: string } };

/**
 * Сверяет автора разговора с добавочным, которым реально была набрана запись
 * (17.09.2026, разбор прод-жалобы «в карточке не тот, кто говорил»: ПК-000236,
 * ПК-000228, ПК-000135 за 30 дней — 3 из 273 исходящих).
 *
 * ПОЧЕМУ НУЖНО. При наборе из CRM Interaction.agentId проставляется тем, кого CRM
 * попросила звонить, а не тем, кто физически поднял трубку. Обычно это одно и то
 * же, но имя файла записи — это то, что реально ответило станции, и когда они
 * расходятся, до этой сверки ничего в конвейере не замечало разницу.
 *
 * ДВА РЕЖИМА. `options.weakMatch` не задан (обычный исходящий, файл найден по
 * ТРЁМ признакам — клиент+добавочный+минута, см. findRecording): совпадение уже
 * подтверждено, поэтому при расхождении переподписываем автора — запись точно
 * этого разговора, ошибся только с тем, кто в карточке. `options.weakMatch: true`
 * (файл найден БЕЗ добавочного в критериях — checkStuckCallStubs при пустом
 * sipExtension, входящий путь): совпадение по клиенту и минуте не исключает, что
 * это вообще ЧУЖОЙ разговор с тем же клиентом в то же окно, поэтому вместо
 * переподписи запись отклоняется — подшить не тому ещё хуже, чем не подшить
 * никому.
 */
export async function reconcileCallAuthor(
  interaction: CallAuthorInteraction,
  agent: CallAuthorAgent,
  recordingName: string,
  options: { weakMatch?: boolean } = {}
): Promise<ReconcileCallAuthorOutcome> {
  const fileExtension = extensionFromRecordingName(recordingName);
  if (!fileExtension || fileExtension === agent.sipExtension) return { action: "unchanged" };

  const owner = await prisma.agent.findFirst({
    where: { sipExtension: fileExtension, isActive: true },
    select: { id: true, fullName: true },
  });

  if (!owner) {
    // Дожидаемся записи в журнал (в отличие от большинства мест этого файла,
    // здесь нет уже идущего фонового конвейера, которому нельзя мешать
    // блокирующим ожиданием, — вызывающий код сам ждёт reconcileCallAuthor
    // целиком, поэтому awaited logSystemError не добавляет задержки конвейеру,
    // зато гарантирует, что строка уже лежит в базе к моменту, когда вызывающий
    // код проверяет результат (утренний отчёт, тесты).
    await logSystemError(
      "telephony",
      `Запись разговора набрана с добавочного ${fileExtension} — он не привязан ни к одному активному агенту (карточка ${interaction.id} осталась за ${agent.fullName}, файл ${recordingName})`,
      { dedupKey: `call-author-orphan-ext-${fileExtension}` }
    );
    return { action: "orphan-extension", extension: fileExtension };
  }

  if (owner.id === interaction.agentId) return { action: "unchanged" };

  if (options.weakMatch) {
    await logSystemError(
      "telephony",
      `Найденная запись похожа на чужую: искали без добавочного, файл набран с ${fileExtension} (${owner.fullName}) — к разговору ${interaction.id} (числится за ${agent.fullName}) не подшита`,
      // Ключ — вид поломки, а не разговор (E11, 02.10.2026): id в ключе делал
      // каждый случай «новой проблемой» с пушем директорам.
      { dedupKey: "call-author-foreign-weak" }
    );
    return { action: "rejected", extension: fileExtension, belongsTo: owner };
  }

  await prisma.$transaction(async (tx) => {
    await tx.interaction.update({ where: { id: interaction.id }, data: { agentId: owner.id } });
    // Актор этой заметки — SYSTEM (сверка обнаружила и исправила расхождение
    // сама, П-10, 17.09.2026), а не новый агент owner — он к переподписи не
    // причастен, просто оказался прав насчёт того, кто звонил.
    await logTimeline({
      clientId: interaction.clientId,
      actor: { kind: "system", source: "call-author-reconcile", subjectAgentId: owner.id },
      type: "SYSTEM",
      notes: `Звонок переподписан: набирал добавочный ${fileExtension} (${owner.fullName}), а не ${agent.fullName}`,
      tx,
    });
  });
  await logSystemError(
    "telephony",
    `Звонок переподписан по добавочному в файле записи: было ${agent.fullName} (${interaction.agentId}), стало ${owner.fullName} (${owner.id}), файл ${recordingName}`,
    { dedupKey: "call-author-reassigned" }
  );
  return { action: "reassigned", to: owner };
}

/**
 * Абсолютный путь на АТС → относительный путь внутри каталога записей.
 *
 * Отдельная функция, потому что это граница доверия: путь приходит со станции, а
 * подставляется в URL. `..` и выход за MONITOR_ROOT отбрасываются — иначе достаточно
 * было бы одной подделанной переменной канала, чтобы CRM выкачала со станции
 * `/etc/asterisk/sip.conf` вместе с паролями SIP.
 */
export function relativeRecordingPath(absolutePath: string): string | null {
  const normalized = absolutePath.trim().replace(/\\/g, "/");
  if (!normalized.startsWith(MONITOR_ROOT)) return null;
  const rest = normalized.slice(MONITOR_ROOT.length);
  if (!rest || rest.includes("..") || rest.startsWith("/")) return null;
  return rest;
}

/** Тип содержимого по расширению. FreePBX по умолчанию пишет WAV, но на станции
 *  обычно включают постобработку в MP3 (в семь раз меньше места — см. документацию),
 *  а на старых установках встречается gsm. */
export function contentTypeFor(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase();
  if (ext === "mp3") return "audio/mpeg";
  if (ext === "ogg") return "audio/ogg";
  if (ext === "gsm") return "audio/gsm";
  if (ext === "wav49") return "audio/wav";
  return "audio/wav";
}

/**
 * Куда ещё посмотреть, если файла по записанному пути уже нет.
 *
 * ПОЧЕМУ ЭТО ВООБЩЕ НУЖНО. Станция сжимает записи: скрипт обслуживания
 * (/usr/local/bin/royalhome-recordings-maintenance.sh) через ПЯТЬ МИНУТ после
 * разговора превращает `.wav` в `.mp3` и удаляет исходник — иначе год архива в
 * WAV на диск не влезает. А CRM записывает в хронологию путь, который знала в
 * момент звонка, то есть `.wav`.
 *
 * Последствие обнаружено на проде 11.08.2026: НИ ОДНА запись не проигрывалась
 * спустя пять минут после разговора — станция отвечала 404, CRM превращала это в
 * 502, и агент видел голый номер кода. Расшифровка при этом была на месте, потому
 * что она делается сразу, пока WAV ещё существует, — из-за чего сбой и выглядел
 * необъяснимо: «текст есть, звук исчез».
 *
 * Чинить это на станции нельзя (хранить WAV — значит отказаться от архива), а
 * догонять базу пост-фактум неоткуда: станция о CRM ничего не знает. Поэтому CRM
 * спрашивает соседнее расширение сама, а найденный путь запоминает
 * (см. routes/interactions.ts), чтобы второй раз не искать.
 */
function siblingPaths(relativePath: string): string[] {
  const dot = relativePath.lastIndexOf(".");
  if (dot <= 0) return [];
  const base = relativePath.slice(0, dot);
  const ext = relativePath.slice(dot + 1).toLowerCase();
  // mp3 первым: сжатие — то, что происходит с записью почти всегда.
  return ["mp3", "wav", "ogg", "gsm"].filter((e) => e !== ext).map((e) => `${base}.${e}`);
}

export interface FetchedRecording {
  buffer: Buffer;
  /** Путь, по которому файл РЕАЛЬНО нашёлся — может отличаться расширением. */
  path: string;
}

/**
 * Отказ станции по HTTP — со статусом, а не только текстом.
 *
 * Нужен, чтобы вызывающий отличил бытовое «файла нет» от поломки настройки: по
 * тексту `АТС отдала HTTP 401 на 2026/08/…` это различимо только разбором строки,
 * а решение «будить директора или нет» принимается именно здесь
 * (см. isRecordingSetupFailure и routes/interactions.ts).
 */
export class RecordingHttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
    this.name = "RecordingHttpError";
  }
}

/**
 * Означает ли отказ поломку доступа/настройки, а не пропажу одного файла.
 *
 * ЧТО РАЗЛИЧИМО ПО КОДУ. 401/403/407 — сервер записей на станции нас не пускает:
 * PBX_RECORDINGS_TOKEN разошёлся с тем, что настроен на АТС (или туннель уткнулся
 * в чужой прокси). 5xx — сам каталог записей отвечает отказом, то есть хранилище
 * недоступно как таковое. И то, и другое человек обязан увидеть: пока это так, не
 * проиграется НИ ОДНА запись.
 *
 * Всё остальное — 404 (ротация или сжатие в mp3), таймаут туннеля, обрыв сети,
 * пустой файл — это про один разговор и лечится само; агент видит причину на
 * экране, а журнал директора о таком молчит.
 */
export function isRecordingSetupFailure(err: unknown): err is RecordingHttpError {
  if (!(err instanceof RecordingHttpError)) return false;
  return err.status === 401 || err.status === 403 || err.status === 407 || err.status >= 500;
}

/** Один запрос к станции. null — файла по этому пути нет (404), это не отказ.
 *  `timeoutMs` — остаток общего бюджета, а не отдельный таймаут (см. FETCH_BUDGET_MS). */
async function tryFetch(
  relativePath: string,
  config: RecordingFetchConfig,
  timeoutMs: number
): Promise<Buffer | null> {
  const url = `${config.baseUrl}/${relativePath.split("/").map(encodeURIComponent).join("/")}`;
  const res = await fetch(url, {
    headers: config.token ? { "X-Recordings-Token": config.token } : {},
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new RecordingHttpError(res.status, `АТС отдала HTTP ${res.status} на ${relativePath}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length === 0) throw new Error(`пустой файл записи ${relativePath}`);
  if (buffer.length > MAX_RECORDING_BYTES) {
    throw new Error(`запись ${relativePath} больше допустимого (${buffer.length} байт)`);
  }
  return buffer;
}

/**
 * Записи прежней эпохи — те, что успели уехать в Cloudflare R2 до отказа от него
 * 07.08.2026. В карточке у них лежит не путь на станции, а ключ бакета вида
 * `call-recordings/2026/08/<uuid>.wav`, и на АТС такого файла нет и не было.
 *
 * Проверено на проде 11.08.2026: файлы в R2 живы. Ключи от бакета в окружении
 * остались (там же лежит сырое видео объектов), так что достать их ничего не
 * стоит, — а «запись недоступна» на разговоре, который на самом деле цел, это
 * потеря на ровном месте.
 */
const LEGACY_R2_PREFIX = "call-recordings/";

/** Запись прежней эпохи: в карточке лежит ключ бакета, а не путь на станции. */
export function isLegacyRecording(path: string): boolean {
  return path.startsWith(LEGACY_R2_PREFIX);
}

async function fetchFromLegacyR2(key: string): Promise<Buffer | null> {
  const found = await r2Download(key);
  if (!found) return null;
  const chunks: Uint8Array[] = [];
  const reader = found.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  const buffer = Buffer.concat(chunks);
  return buffer.length > 0 ? buffer : null;
}

export async function fetchRecording(
  relativePath: string,
  config: RecordingFetchConfig,
  budgetMs: number = FETCH_BUDGET_MS
): Promise<FetchedRecording> {
  if (relativePath.startsWith(LEGACY_R2_PREFIX)) {
    const legacy = await fetchFromLegacyR2(relativePath);
    if (legacy) return { buffer: legacy, path: relativePath };
    throw new Error(`записи ${relativePath} нет ни в R2, ни на АТС`);
  }

  // Общий срок на все попытки: перебор расширений не должен множить таймаут
  // (см. FETCH_BUDGET_MS).
  const deadline = Date.now() + budgetMs;
  const remaining = () => deadline - Date.now();

  const direct = await tryFetch(relativePath, config, Math.max(1, remaining()));
  if (direct) return { buffer: direct, path: relativePath };

  for (const candidate of siblingPaths(relativePath)) {
    if (remaining() <= 0) {
      throw new Error(`станция не ответила про ${relativePath} за отведённое время`);
    }
    const buffer = await tryFetch(candidate, config, remaining());
    if (buffer) return { buffer, path: candidate };
  }
  throw new Error(`на АТС нет файла ${relativePath} ни в одном из форматов`);
}

/**
 * Очередь расшифровок — строго последовательная цепочка промисов.
 *
 * Почему очередь, а не просто await на месте: расшифровка часового разговора идёт
 * десятки секунд, а завершение звонка обрабатывается в обработчике событий АТС,
 * который в это время не должен стоять. Почему последовательная: у Gemini общий
 * ключ на всё агентство (бот, голосовые клиентов, разбор видео), и пачка звонков,
 * закончившихся одновременно, выбирала бы лимит на всех сразу.
 */
let transcriptionQueue: Promise<void> = Promise.resolve();

/**
 * КАК ЧАСТО НАПОМИНАТЬ, ЧТО ЗАПИСИ ПИШУТСЯ НЕ ТУДА, ГДЕ CRM ИХ ИЩЕТ (12.08.2026).
 *
 * «Запись разговора вне каталога записей АТС» — это не происшествие одного
 * разговора, а расхождение настроек: станция сообщила путь вне MONITOR_ROOT, и
 * пока это так, строка повторяется на КАЖДОМ разговоре, где станция вообще
 * сообщает имя файла. Десятиминутная дедупликация logSystemError её не склеивает:
 * имя файла у каждого разговора своё, а сравнение идёт по полному тексту.
 *
 * ПОЧЕМУ СУТКИ, А НЕ «ОДИН РАЗ ДО УСТРАНЕНИЯ». «До устранения» звучит честнее, но
 * CRM не может узнать, что настройку починили: пока путей вообще не приходит,
 * молчание неотличимо от исправности, и запись месячной давности в журнале уже
 * ничего не означает. Сутки — это «напоминай, пока не починили, но не чаще, чем
 * человек читает сводку». Отсчёт при этом сбрасывается, как только приходит
 * КОРРЕКТНЫЙ путь: настройку поправили — о следующей поломке узнаем сразу, а не
 * через остаток суток.
 */
const OUTSIDE_ROOT_LOG_INTERVAL_MS = 24 * 60 * 60 * 1000;
let outsideRootLoggedAt: number | null = null;

/**
 * ЖИВОЙ СТАТУС КОНВЕЙЕРА (владелец 15.08.2026): «человек не должен просто сидеть и
 * ждать секунды, пока это всё расшифровывается» — не про то, чтобы конвейер стал
 * мгновенным (он и так работает столько, сколько отвечает Gemini и станция), а про
 * то, что происходящее должно быть ВИДНО. Стадии живут в @royal-home/shared
 * (CALL_TRANSCRIPTION_STAGES) — интерфейс подписывает их по-русски и снимает
 * поллингом.
 *
 * ПЕРЕХОДЫ МЕЖДУ СТАДИЯМИ — ЖДЁМ ЗАПИСЬ, ПРОГРЕСС ВНУТРИ СТАДИИ — НЕТ. Смена стадии
 * (SEARCHING → QUEUED → TRANSCRIBING → ...) — редкое событие раз на весь разговор, и
 * awaiting здесь ничего не стоит, зато гарантирует порядок: без него не awaited-запись
 * могла бы уйти по другому соединению пула и обогнать предыдущую, и человек увидел бы
 * стадию, которая уже позади. Процент готовых кусков внутри TRANSCRIBING — совсем
 * другое дело: обновляется на каждом куске длинного разговора, и ждать там нечего —
 * ошибка в записи процента ничего не портит, кроме одной лишней секунды на экране.
 */
async function setStage(interactionId: string, stage: CallTranscriptionStage | null): Promise<void> {
  await prisma.interaction
    .update({ where: { id: interactionId }, data: { transcriptionStage: stage, transcriptionProgress: null } })
    .catch((err) => {
      // Статус — витрина, а не условие расшифровки: если запись не пройдёт (обрыв
      // базы в неудачный момент), человек увидит прежний текст на секунду дольше,
      // а сама расшифровка идёт дальше как ни в чём не бывало.
      //
      // НО МОЛЧА ЭТО ГЛОТАТЬ БОЛЬШЕ НЕЛЬЗЯ (21.09.2026). Проглоченный отказ
      // СНЯТИЯ стадии — это «Ищем запись на станции» на экране навсегда: снять
      // её больше некому, второй попытки у этой строки нет. В журнал ошибок не
      // пишем (стадия правда не стоит отдельной тревоги), но в консоль
      // контейнера — обязательно, иначе причина вечной плашки неотличима от
      // рестарта. Подстраховка на случай, если и эта строка потеряется, —
      // recoverInterruptedTranscriptionStages() на старте процесса.
      console.warn(
        `[запись] стадия ${stage ?? "снята"} у разговора ${interactionId} не записалась: ${describeError(err)}`
      );
    });
}

function bumpProgress(interactionId: string, percent: number): void {
  void prisma.interaction
    .update({ where: { id: interactionId }, data: { transcriptionProgress: Math.max(0, Math.min(100, percent)) } })
    .catch(() => {});
}

/**
 * Сколько кусков одного разговора расшифровываем одновременно.
 *
 * Не единица (было раньше — строго по очереди) и не «сколько кусков, столько и
 * запросов сразу»: у Gemini общий ключ на всё агентство (бот, голосовые клиентов,
 * разбор видео), и вся эта функция и так уже стоит в общей очереди звонков
 * (transcriptionQueue ниже) — то есть звонки друг друга не толкают. Здесь речь
 * только о КУСКАХ ОДНОГО часового разговора: без параллельности их четыре, и
 * человек ждал бы всю расшифровку целиком, хотя каждый кусок независим от других.
 * Двух одновременных запросов достаточно, чтобы сократить время примерно вдвое,
 * не рискуя лимитом на минуту.
 */
const CHUNK_CONCURRENCY = 2;

function enqueueTranscription(job: () => Promise<void>): void {
  transcriptionQueue = transcriptionQueue.then(job).catch((err) => {
    void logSystemError("ai", `Расшифровка разговора не удалась: ${describeError(err)}`, { dedupKey: "Расшифровка разговора не удалась: …" });
  });
}

/**
 * Дождаться, пока очередь опустеет. Нужно тестам и корректной остановке процесса.
 *
 * Ждём, пока сама ссылка на очередь не перестанет меняться — а не фиксированное
 * число раз: пока ждём текущую цепочку, в неё могла добавиться следующая задача
 * (например, повтор после сбоя), и один лишний await не покрывал такой случай —
 * тест иногда снимал `transcript` в промежуточном виде до того, как очередь
 * действительно опустела.
 */
export async function waitForTranscriptions(): Promise<void> {
  let before: Promise<void>;
  do {
    before = transcriptionQueue;
    await before;
  } while (before !== transcriptionQueue);
}

export interface IngestRecordingParams {
  /** Канал ARI — по нему берётся запомненный путь, если станция его сообщила. */
  channelId?: string;
  /** Запись в хронологии клиента, к которой привязывается разговор. */
  interactionId: string;
  /** Путь на АТС. Обычно не передаётся: ищется по каталогу (см. search). */
  recordingPath?: string;
  /** По чему искать запись в каталоге станции — основной путь. */
  search?: RecordingSearch;
  /** Длительность разговора в секундах (callTracker.talkSeconds). */
  durationSec?: number;
  /**
   * Клиент ТОЧНО брал трубку — это подтвердила сама станция (DIALSTATUS=ANSWER у
   * исходящего, соединённый мост у входящего), а не наша догадка по событиям.
   *
   * Нужно ровно для одного решения: поднимать ли тревогу из-за пустого файла. У
   * недозвона пустой файл (44 байта от MixMonitor) — норма, а не поломка.
   */
  clientAnswered?: boolean;
}

export interface IngestRecordingResult {
  ok: boolean;
  /** Путь записи внутри каталога станции — он же сохраняется в Interaction. */
  recordingPath?: string;
  /** Почему не вышло — для журнала и тестов, наружу агенту не показывается. */
  reason?: string;
  /**
   * Исход окончательный: переспрашивать станцию об этом разговоре больше незачем
   * (файл найден и отвергнут как чужой, либо в нём нет звука). Нужен с 21.09.2026,
   * когда догоняющий поиск стал заводиться ДО поиска, а не после: страховку,
   * которая уже не нужна, снимает cancelRecordingSearchRetry по этому признаку.
   * Отсутствие признака означает «можно попробовать ещё раз» — например обрыв
   * туннеля посреди скачивания файла.
   */
  terminal?: boolean;
}

/**
 * Полный проход по одному разговору: забрать → положить в R2 → привязать к записи в
 * хронологии → поставить расшифровку в очередь.
 *
 * Не бросает никогда. Запись разговора — приятное дополнение к звонку, а не его
 * условие: отказ хранилища или недоступная станция не должны ронять обработчик
 * событий АТС и тем более мешать следующему звонку. Всё, что пошло не так, уходит в
 * журнал CRM (logSystemError), а не в тишину.
 */
export async function ingestCallRecording(params: IngestRecordingParams): Promise<IngestRecordingResult> {
  const { channelId, interactionId, durationSec } = params;
  const absolutePath = params.recordingPath ?? (channelId ? pendingPaths.get(channelId) : undefined);
  if (channelId) forgetRecordingPath(channelId);

  const config = recordingFetchConfig();
  if (!config) return { ok: false, reason: "PBX_RECORDINGS_URL не задан" };

  /**
   * ДОГОНЯЮЩИЙ ПОИСК ЗАВОДИТСЯ ДО ОКНА, КОТОРОЕ ОН СТРАХУЕТ (21.09.2026).
   *
   * Раньше он ставился НИЖЕ — в ветке «файла нет», то есть уже ПОСЛЕ 23 секунд
   * поиска в памяти процесса. Страховка, которая заводится после опасного
   * участка, от него и не страхует: автовыкат перезапускает контейнер по
   * каждому мержу в main (ops/deploy.sh, `docker compose up -d`), и рестарт
   * ВНУТРИ этих 23 секунд не оставлял ни записи, ни задания на повтор, ни
   * строки в журнале — разговор просто оставался без записи навсегда. Живой
   * случай: звонок 21.09 в 13:02, выкат правки #633 пришёлся ровно на поиск.
   *
   * Теперь строка в BackgroundJob ложится ПЕРЕД поиском и переживает рестарт
   * сама. Лишней работы это не создаёт: первая ступень лесенки — через минуту,
   * а поиск укладывается в 23 секунды, и к её сроку задание либо уже снято
   * (cancelRecordingSearchRetry ниже), либо выходит на первой же проверке
   * recordingUrl (runRecordingSearchRetryAttempt идемпотентен).
   *
   * Условие прежнее и ни на йоту не шире: ТОЛЬКО когда клиент точно отвечал
   * (подтверждено станцией) и путь не пришёл от самой станции, а ищется по
   * каталогу. Для недозвона поведение не меняется — задания нет, тишина в
   * журнале остаётся штатной.
   */
  if (params.search && params.clientAnswered) {
    await scheduleRecordingSearchRetry(interactionId, params.search, durationSec);
  }

  // Первая видимая стадия конвейера: до этого момента карточка молчала до 23 секунд
  // (2с + 6с + 15с ретраев поиска ниже), не давая ни намёка, что вообще происходит.
  await setStage(interactionId, "SEARCHING");

  let relative: string | null = null;
  if (absolutePath) {
    relative = relativeRecordingPath(absolutePath);
    if (!relative) {
      const now = Date.now();
      const due = outsideRootLoggedAt === null || now - outsideRootLoggedAt >= OUTSIDE_ROOT_LOG_INTERVAL_MS;
      if (due) {
        outsideRootLoggedAt = now;
        void logSystemError("telephony", `Запись разговора вне каталога записей АТС: ${absolutePath}`, { dedupKey: "Запись разговора вне каталога записей АТС: …" });
      } else {
        // Повтор той же поломки настройки. В журнал он не идёт, но пропасть не
        // имеет права: по консоли контейнера видно и время, и конкретный путь.
        console.warn(
          `[запись] ${new Date().toISOString()} путь вне каталога записей АТС: ${absolutePath} (о поломке уже записано в журнал)`
        );
      }
      return { ok: false, reason: "путь вне каталога записей" };
    }
    // Путь снова разбирается — настройка в порядке, следующая поломка будет новостью.
    outsideRootLoggedAt = null;
  } else if (params.search) {
    // Основной путь: станция имя файла не сообщает, поэтому ищем его сами.
    // Запись появляется в каталоге не мгновенно — файл дописывается и, если на
    // станции включено сжатие, ещё и переименовывается в .mp3. Поэтому пробуем
    // несколько раз с паузой, а не один раз сразу после отбоя.
    for (const waitMs of [2_000, 6_000, 15_000]) {
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      try {
        relative = await findRecording(params.search, config);
      } catch {
        relative = null;
      }
      if (relative) break;
    }
  }

  // Записи нет: недозвон, запись выключена или разговор не попал в каталог. Это
  // штатный исход, а не отказ — в журнал он не пишется, иначе шум был бы на каждом
  // недозвоне. Стадию снимаем: искать больше нечего, конвейер этим звонком не занят.
  if (!relative) {
    await setStage(interactionId, null);
    /**
     * ОТВЕЧЕННЫЙ РАЗГОВОР БЕЗ ФАЙЛА — НЕ НОРМА, А ОБРЫВ ТУННЕЛЯ (20.09.2026).
     *
     * Обратный ssh-туннель до станции регулярно ложится на десятки секунд (в день
     * разбора — около 30с при перезагрузке VPS), а весь поиск файла выше — это
     * 2+6+15=23 секунды. Если обрыв пришёлся ровно на них, «файла нет» раньше
     * означало «забыли навсегда»: в отличие от расшифровки (scheduleTranscriptionRetry
     * чуть ниже), у поиска файла не было ни одного повторного шанса, а этот путь
     * (недозвон/запись выключена) молчал специально, чтобы не шуметь на каждом
     * недозвоне — и та же тишина накрывала СОСТОЯВШИЙСЯ разговор.
     *
     * Само задание теперь заведено ВЫШЕ, до поиска (21.09.2026) — здесь остаётся
     * только штатный выход: для отвеченного разговора страховка уже лежит в
     * очереди, для недозвона её нет и не должно быть.
     */
    /**
     * СОСТОЯВШИЙСЯ РАЗГОВОР БЕЗ ФАЙЛА — ЗАМЕТКА В ХРОНОЛОГИЮ (24.09.2026), по
     * образцу ветки «запись пустая» ниже в finalizeFoundRecording. Недозвон
     * по-прежнему молчит (см. докстринг выше) — приписка только когда клиент
     * точно отвечал (`clientAnswered`, подтверждено станцией) или разговор шёл
     * хоть сколько-то секунд (`durationSec`, callTracker.talkSeconds): агент видит
     * в хронологии «Звонок через CRM, разговор N:NN» и должен понимать, почему
     * кнопки «Послушать и прочитать разговор» нет, а не считать это поломкой CRM.
     * Тот же поиск ещё может найти файл позже (задание уже заведено выше) —
     * приписка не окончательный приговор, а объяснение на СЕЙЧАС.
     */
    if (params.clientAnswered || (typeof durationSec === "number" && durationSec > 0)) {
      const interaction = await prisma.interaction.findUnique({
        where: { id: interactionId },
        select: { notes: true },
      });
      if (interaction?.notes?.startsWith("Звонок через CRM, разговор")) {
        await prisma.interaction.update({
          where: { id: interactionId },
          data: { notes: `${interaction.notes} — запись не найдена на станции` },
        });
      }
    }
    return { ok: false, reason: "нет файла записи" };
  }

  const found = await finalizeFoundRecording(
    interactionId,
    relative,
    durationSec,
    !absolutePath && !params.search?.agentExtension,
    params.clientAnswered
  );
  // Файл найден и разобран — страховка своё отслужила. Снимаем её на успехе и на
  // ОКОНЧАТЕЛЬНОМ отказе (запись чужая, в записи нет звука): повторный поиск нашёл
  // бы ровно тот же файл, отверг бы его ровно так же и закончился бы ложной
  // строкой в журнале «запись так и не нашлась». Неокончательный отказ (обрыв
  // туннеля посреди скачивания) страховку сохраняет — она для него и заведена.
  if (found.ok || found.terminal) await cancelRecordingSearchRetry(interactionId);
  return found;
}

/**
 * Хвост ingestCallRecording после того, как относительный путь файла уже известен:
 * скачать → сверить автора → проверить, что там реально звук → сохранить → поставить
 * расшифровку в очередь. Вынесено отдельно, чтобы догоняющий поиск (см. ниже,
 * scheduleRecordingSearchRetry) не повторял эту логику своей половиной — ровно та же
 * причина, по которой transcribeAndEnrich вынесена отдельно от первичного пути
 * расшифровки (см. докстринг там).
 *
 * weakMatch=true — путь найден БЕЗ добавочного агента в критериях поиска (входящий,
 * либо исходящий без sipExtension): совпадение по клиенту и минуте не исключает
 * чужой разговор, поэтому reconcileCallAuthor при расхождении отклоняет подшивку,
 * а не переподписывает автора.
 */
async function finalizeFoundRecording(
  interactionId: string,
  foundRelative: string,
  durationSec: number | undefined,
  weakMatch: boolean,
  clientAnswered: boolean | undefined
): Promise<IngestRecordingResult> {
  const config = recordingFetchConfig();
  if (!config) return { ok: false, reason: "PBX_RECORDINGS_URL не задан" };
  let relative = foundRelative;

  try {
    const { buffer, path: found } = await fetchRecording(relative, config);
    // Запоминаем путь, по которому файл РЕАЛЬНО нашёлся: станция могла успеть
    // сжать запись в mp3 ещё до того, как мы за ней пришли.
    relative = found;

    // СВЕРКА АВТОРА С ДОБАВОЧНЫМ В ИМЕНИ ФАЙЛА (17.09.2026, см. reconcileCallAuthor).
    // `weakMatch` — искали ли БЕЗ добавочного в критериях (absolutePath от станции
    // не в счёт: это не поиск, а её собственное сообщение о канале). Если запись
    // похожа на чужую и совпадение было слабым — не подшиваем вовсе и снимаем стадию,
    // как при «нет файла записи»; переподписывать автора при слабом совпадении нельзя,
    // мы не знаем, что это вообще запись ЭТОГО разговора.
    const authorInteraction = await prisma.interaction.findUnique({
      where: { id: interactionId },
      select: { id: true, clientId: true, agentId: true, agent: { select: { id: true, fullName: true, sipExtension: true } } },
    });
    if (authorInteraction && authorInteraction.agent) {
      const outcome = await reconcileCallAuthor(authorInteraction, authorInteraction.agent, relative, { weakMatch }).catch(
        (err) => {
          void logSystemError("telephony", `Сверка автора звонка с добавочным в файле записи не выполнена: ${describeError(err)}`, { dedupKey: "Сверка автора звонка с добавочным в файле записи не выполнена: …" });
          return { action: "unchanged" as const };
        }
      );
      if (outcome.action === "rejected") {
        await setStage(interactionId, null);
        return {
          ok: false,
          terminal: true,
          reason: "найденная запись похожа на чужую — добавочный принадлежит другому агенту",
        };
      }
    }

    // Станция отдала файл, но в нём нет звука (см. MIN_RECORDING_BYTES) — MixMonitor
    // не записал разговор. Показывать такую «запись» агенту нельзя: плеер молчал бы
    // 0:00/0:00 без единого объяснения, а расшифровывать нечего. recordingUrl НЕ
    // сохраняем — карточка честно скажет «записи нет» вместо мёртвого плеера;
    // recordingDurationSec (реальное время разговора) остаётся, его пишет finishCall
    // отдельно. О самом факте — сразу руководству, а не молчком в журнал: это
    // поломка станции, а не звонка, и без сигнала она повторится на следующем.
    if (buffer.length < MIN_RECORDING_BYTES) {
      await setStage(interactionId, null);

      /**
       * ПУСТОЙ ФАЙЛ ПРИ НЕДОЗВОНЕ — НОРМА, А НЕ ПОЛОМКА (18.08.2026).
       *
       * Сюда же попадала прежняя диагностика «станция сообщила „ответил“, но запись
       * пуста: похоже на сбой линии». Никакого сбоя линии не было: CRM засчитывала
       * разговором ответ САМОГО АГЕНТА на первом плече (см. ariEvents.ts), клиент при
       * этом был BUSY или не брал трубку, и MixMonitor честно оставлял файл в 44
       * байта. То есть неверным был не файл, а наш вывод о разговоре — а карточка
       * получала выдуманную причину, руководство — push, журнал — ошибку.
       *
       * Теперь тревога и приписка в карточке остаются ТОЛЬКО для случая, когда клиент
       * точно снял трубку (`clientAnswered`, подтверждено станцией): вот там пустая
       * запись действительно означает, что MixMonitor не пишет звук.
       */
      if (!clientAnswered) {
        return { ok: false, terminal: true, reason: "запись пустая — клиент не отвечал, звука и не было" };
      }

      const interaction = await prisma.interaction.findUnique({
        where: { id: interactionId },
        select: { notes: true },
      });
      if (interaction?.notes?.startsWith("Звонок через CRM, разговор")) {
        await prisma.interaction.update({
          where: { id: interactionId },
          data: {
            notes: `${interaction.notes} — записи разговора нет: станция не сохранила звук`,
          },
        });
      }

      /**
       * DEDUPKEY ПО ДНЮ, А НЕ СТАБИЛЬНЫЙ НАВСЕГДА (24.09.2026). Без него
       * `everSeen` (systemError.ts) становится true один раз за всю жизнь
       * процесса — и если MixMonitor отвалится через месяц после первого такого
       * разговора, директор про это уже не услышит пушем: тревога всё ещё
       * пишется в журнал, но `!everSeen` больше никогда не сработает. Путь
       * (`relative`) и размер файла в сам ключ не идут — они у каждого разговора
       * свои, а дедуп должен ловить именно ПОВТОР поломки станции, а не считать
       * каждый пустой файл новым видом ошибки (как у соседних тревог этого
       * файла, например call-author-orphan-ext-*).
       */
      void logSystemError(
        "telephony",
        `Станция записала разговор без звука (${buffer.length} байт) — MixMonitor не пишет аудио: ${relative}`,
        { dedupKey: `recording-empty-${dushanbeWallClock().toISOString().slice(0, 10)}` }
      );
      /**
       * РУКОВОДСТВУ — ОДНО УВЕДОМЛЕНИЕ НА ПОЛОМКУ, А НЕ НА КАЖДЫЙ РАЗГОВОР (E11
       * глубокой проверки 02.10.2026). Тег был свой у каждого звонка: сломался
       * MixMonitor — 60 разговоров за день дали 60 пушей каждому. Поломка
       * станции одна, напоминание о ней — не чаще RECORDING_EMPTY_REALERT_MS.
       */
      void shouldAlert(RECORDING_EMPTY_TAG, RECORDING_EMPTY_REALERT_MS)
        .then(async (due) => {
          if (!due) return;
          const supervisors = await findAgentsWithPermission("calls.transcripts");
          await sendPushToAgents(supervisors, {
            title: "⚠️ Записи разговоров пустые",
            body: `Станция не записывает звук (последний: ${relative}) — проверьте MixMonitor на АТС`,
            url: "/settings",
            tag: RECORDING_EMPTY_TAG,
          });
        })
        .catch((err) => console.error("[push] пустая запись:", err));
      return { ok: false, terminal: true, reason: "запись пустая — станция не пишет звук" };
    }

    // Путь на станции сохраняется ДО расшифровки: запись уже доступна из карточки,
    // даже если Gemini сегодня молчит.
    await prisma.interaction.update({
      where: { id: interactionId },
      data: {
        recordingUrl: relative,
        recordingDurationSec: typeof durationSec === "number" ? Math.max(0, Math.round(durationSec)) : null,
      },
    });

    /**
     * ДЛИННЫЙ РАЗГОВОР РАСШИФРОВЫВАЕТСЯ ПО ЧАСТЯМ (12.08.2026).
     *
     * Раньше запись крупнее предела поставщика не расшифровывалась ВООБЩЕ — в
     * журнал уходила строка «больше предела Gemini», и всё. Час разговора в WAV с
     * АТС — около 55 МБ, то есть всё, что длиннее пятнадцати минут, пропадало:
     * ни текста, ни разбора, ни подсказки в окне итога. А это самые ценные
     * разговоры: короткое «алло, перезвоню» разбиралось прекрасно, живая беседа с
     * клиентом — нет.
     */
    const mediaType = contentTypeFor(relative);
    // durationSec (реальная длительность разговора) передаётся резчику: он метит
    // куски не только байтовым пределом Gemini, но и целью в секундах речи — см.
    // ai/audioChunks.ts, TARGET_CHUNK_SECONDS.
    const rawParts = splitAudioForTranscription(buffer, mediaType, TRANSCRIBE_MAX_BYTES, durationSec);
    /**
     * ФОРМАТ НЕ УМЕЕТ РЕЗАТЬСЯ, НО ФАЙЛ И ТАК ПОМЕЩАЕТСЯ ЦЕЛИКОМ (24.09.2026).
     *
     * splitAudioForTranscription сегодня сама возвращает [buffer] для любого формата,
     * если он не больше предела (первая строка функции) — так что эта ветка сейчас
     * не должна срабатывать. Оставлена на стороне вызывающего нарочно, а не как
     * вера в чужой контракт: резчик — отдельный модуль, который может измениться
     * (например, разделить формат данных и предел байт), и без этой страховки
     * такое изменение тихо утопило бы КОРОТКУЮ запись незнакомого формата (не только
     * длинную) — от «резать нечем» до «нечего вообще передать в Gemini».
     */
    const parts: AudioParts = rawParts.length === 0 && buffer.length <= TRANSCRIBE_MAX_BYTES ? [buffer] : rawParts;
    if (parts.length > 0) {
      const path = relative;
      // QUEUED, а не сразу TRANSCRIBING: если сейчас расшифровывается другой
      // звонок (общая очередь ниже), этот будет ждать своей секунды, и человек
      // должен видеть именно это, а не молчание, неотличимое от «забыли».
      // transcribeAndEnrich перепишет стадию на TRANSCRIBING сам, как только
      // очередь до него дойдёт.
      await setStage(interactionId, "QUEUED");
      enqueueTranscription(async () => {
        const result = await transcribeAndEnrich({
          interactionId,
          parts,
          mediaType,
          path,
          durationSec,
        });
        // Поставщик отказал на всех кусках — разговор записан, а текста нет.
        // Ставим в очередь повтора: без неё такой разговор оставался немым
        // навсегда, потому что второй раз его никто не забирал.
        if (result.retryable) scheduleTranscriptionRetry(interactionId);
      });
    } else {
      /**
       * ЗАПИСЬ КРУПНЕЕ ПРЕДЕЛА, А ФОРМАТ НЕ РЕЖЕТСЯ — ПОВТОР, А НЕ НАВСЕГДА НЕМОЙ
       * РАЗГОВОР (24.09.2026).
       *
       * ЧТО БЫЛО НЕ ТАК. Раньше эта ветка писала строку в журнал и на этом
       * заканчивалась: запись сохранена (recordingUrl уже записан выше), а текста
       * не будет никогда — второй попытки не назначалось, хотя причина вполне
       * может быть временной. WAV с побитым заголовком (readWavLayout вернула null)
       * — частый случай именно ПОВРЕЖДЁННОЙ при скачивании копии: канал до станции
       * идёт через туннель (см. докстринг файла), который рвётся посреди передачи;
       * повторная попытка качает файл заново и может получить исправную копию.
       *
       * ЧТО ДЕЛАЕМ. То же самое, что уже есть для «поставщик отказал на всех
       * кусках» чуть выше: scheduleTranscriptionRetry. Формат, который в принципе
       * не режется (не wav/mp3/gsm), тоже встанет в очередь повтора и в итоге
       * исчерпает лимит попыток (TRANSCRIPTION_RETRY_MAX_ATTEMPTS) — это не хуже
       * прежнего «навсегда немой», а лишь на несколько попыток дороже.
       */
      await setStage(interactionId, null);
      void logSystemError(
        "ai",
        `Разговор ${relative} не расшифрован: ${Math.round(buffer.length / 1024 / 1024)} МБ, формат ${mediaType} не режется на части — назначен повтор`, { dedupKey: "Разговор … не расшифрован: … МБ, формат … не режется на части — назначен повтор" }
      );
      scheduleTranscriptionRetry(interactionId);
    }

    return { ok: true, recordingPath: relative };
  } catch (err) {
    const reason = describeError(err);
    await setStage(interactionId, null);
    void logSystemError("telephony", `Запись разговора ${relative} не сохранена: ${reason}`, { dedupKey: "Запись разговора … не сохранена: …" });
    return { ok: false, reason };
  }
}

/**
 * Один разговор от аудио до карточки: расшифровка → перевод → разбор → предложение
 * по карточке.
 *
 * Вынесено из ingestCallRecording, чтобы догоняющий повтор (ниже) делал ровно то же
 * самое, а не свою половину: второй путь к тем же данным неизбежно забыл бы то
 * перевод, то разбор — и разговоры расходились бы по наполнению в зависимости от
 * того, с первой попытки они расшифровались или со второй.
 */
async function transcribeAndEnrich(params: {
  interactionId: string;
  parts: Buffer[];
  mediaType: string;
  path: string;
  durationSec?: number;
  /** Зовётся, когда новый текст УЖЕ получен и вот-вот ляжет в карточку, — ручная
   *  пере-расшифровка снимает здесь старый разбор (retranscribeInteraction). */
  beforeSave?: () => Promise<void>;
}): Promise<{ ok: boolean; retryable: boolean }> {
  const { interactionId, parts, mediaType, path, durationSec, beforeSave } = params;
  await setStage(interactionId, "TRANSCRIBING");

  /**
   * КОНТЕКСТ ДЛЯ РАСШИФРОВКИ — ОДНИМ ЗАПРОСОМ, ДО КУСКОВ (24.09.2026).
   *
   * transcribeAudioResult теперь принимает 4-м параметром "кто с кем говорит":
   * kind:"call" (чтобы писать репликами, см. ai/transcribe.ts), известный номер
   * клиента (для сверки цифр, не для подстановки) и имя агента. Запрос один на
   * весь разговор, а не на каждый кусок — у часового разговора их четыре, и
   * КАЖДЫЙ должен получить ОДИНАКОВЫЙ контекст: разъехавшиеся между кусками имя
   * или номер (если бы читались по одному на кусок) превратили бы один разговор
   * в лоскутное одеяло разных вводных.
   *
   * Тот же запрос заодно закрывает нужды маскировки запасных номеров ниже
   * (scrubMentionedPhones) — она раньше делала СВОЙ отдельный такой же запрос
   * ПОСЛЕ расшифровки; два одинаковых запроса за один вызов были бы именно тем
   * дублированием, которого просит избегать CLAUDE.md.
   */
  const context = await prisma.interaction.findUnique({
    where: { id: interactionId },
    select: {
      clientId: true, createdAt: true, investigationOnly: true,
      client: { select: { phone: true, whatsappPhone: true, extraPhones: true } },
      agent: { select: { fullName: true, sipExtension: true } },
    },
  });
  const transcribeOptions = {
    kind: "call" as const,
    callerPhone: context?.client?.phone || null,
    agentName: context?.agent?.fullName || null,
    agentExtension: context?.agent?.sipExtension || null,
  };

  /**
   * КУСКИ ОДНОГО РАЗГОВОРА — ПАРАЛЛЕЛЬНО, А НЕ ПО ОЧЕРЕДИ (15.08.2026).
   *
   * Раньше это был `for` с `await` внутри: у часового разговора четыре куска, и
   * третий начинал расшифровываться только после того, как первые два полностью
   * отвечали — реальное время расшифровки складывалось из ЧЕТЫРЁХ последовательных
   * ответов Gemini, хотя куски друг от друга не зависят. `mapWithConcurrency`
   * держит на связи CHUNK_CONCURRENCY кусков одновременно и складывает результаты
   * в исходном порядке (склеивать текст нужно по порядку разговора, а не по тому,
   * какой кусок ответил первым).
   */
  let completed = 0;
  const outcomes = await mapWithConcurrency(parts, CHUNK_CONCURRENCY, async (part, index) => {
    const name = path.split("/").pop() || "call.wav";
    const outcome = await transcribeAudioResult(
      part,
      parts.length > 1 ? `${name} (${index + 1}/${parts.length})` : name,
      mediaType,
      transcribeOptions
    );
    completed += 1;
    // Только у многочастного разговора: у однокускового прогресс — либо 0, либо
    // сразу «готово» через смену стадии, отдельная цифра ему не нужна.
    if (parts.length > 1) bumpProgress(interactionId, Math.round((completed / parts.length) * 100));
    return outcome;
  });

  const pieces: string[] = [];
  // «Все куски отказали» и «в записи нечего разбирать» — разные вещи: первое надо
  // повторить, второе повторять бессмысленно (см. ai/transcribe.ts).
  let failures = 0;
  for (const outcome of outcomes) {
    // Отказ на куске — не повод терять остальные: у часового разговора четыре
    // части, и три расшифрованные лучше, чем ни одной. Сам отказ уже записан в
    // журнал внутри transcribeAudioResult.
    if (outcome.text) pieces.push(outcome.text);
    else if (outcome.failed) failures += 1;
  }

  // ПЕРЕВОД СТРОКИ МЕЖДУ КУСКАМИ, А НЕ ПРОБЕЛ (24.09.2026). Каждый кусок теперь
  // пишется РЕПЛИКАМИ («Агент:»/«Клиент:», см. ai/transcribe.ts) — склейка пробелом
  // приклеивала бы последнюю реплику одного куска к префиксу первой реплики
  // следующего на одной строке, и разбор (ai/callAnalysis.ts) читал бы это как
  // одну слитную реплику вместо двух. "\n" гарантирует, что следующий кусок
  // начинается с чистой строки, даже если его первая реплика идёт от той же
  // стороны, что и последняя реплика предыдущего куска.
  const text = pieces.join("\n").trim();
  if (!text) {
    await setStage(interactionId, null);
    return { ok: false, retryable: failures > 0 };
  }

  /**
   * ЗАПАСНОЙ НОМЕР КЛИЕНТА — МАСКИРУЕМ ДО ТОГО, КАК ТЕКСТ ЛЯЖЕТ В КАРТОЧКУ
   * (03.09.2026, требование владельца — см. lib/telephony/callPhoneMasking.ts).
   *
   * Номера клиента читаются ДО сохранения расшифровки, а не после: маскировать
   * нужно строку, которая ещё не покинула эту функцию, иначе окно между записью
   * и маскировкой — это окно, где сырой номер уже лежит в БД открытым текстом.
   * Если карточка не находится (клиент удалён параллельно) — считаем, что
   * известных номеров нет: тогда ЛЮБОЙ найденный номер трактуется как «новый» и
   * маскируется, это безопасное направление ошибки (перебдеть, а не потерять).
   *
   * `context` уже поднят выше (для transcribeOptions) — второй одинаковый запрос
   * здесь не нужен.
   */
  if (context?.clientId && !context.investigationOnly) {
    await captureExplicitClientPhone({ kind: "CALL", id: interactionId, clientId: context.clientId, at: context.createdAt, text })
      .catch(error => { void logSystemError("telephony", "Сохранение подтверждённого номера из звонка: " + (error instanceof Error ? error.name : "UnknownError")); });
  }
  let scrubbed: { text: string; mentionedPhonesEncrypted: string[] };
  try {
    scrubbed = scrubMentionedPhones(
      text,
      context?.client ?? { phone: "", whatsappPhone: null, extraPhones: [] }
    );
  } catch (err) {
    void logSystemError("telephony", `Маскировка запасных номеров в расшифровке звонка не выполнена: ${describeError(err)}`, { dedupKey: "Маскировка запасных номеров в расшифровке звонка не выполнена: …" });
    scrubbed = { text, mentionedPhonesEncrypted: [] };
  }

  // Был ли у разговора текст ДО этой расшифровки: от этого зависит, можно ли заново
  // разобрать входящий звонок, на который крон уже записал «нет расшифровки»
  // (autoLeadFromInteraction, lateTranscript). Читаем до beforeSave и до записи.
  const hadTextBefore = await prisma.interaction
    .findUnique({ where: { id: interactionId }, select: { transcript: true, transcriptRu: true } })
    .then((row) => !!(row?.transcriptRu || row?.transcript || "").trim())
    // Не прочиталось — считаем, что текст был: ложный «нет текста» дал бы лишний платный разбор.
    .catch(() => true);

  if (beforeSave) await beforeSave();

  // Оригинал (уже с замаскированными запасными номерами) сохраняем сразу: перевод —
  // приятное дополнение, а не условие того, чтобы разговор вообще попал в CRM.
  const saved = await prisma.interaction.update({
    where: { id: interactionId },
    data: { transcript: scrubbed.text, mentionedPhonesEncrypted: scrubbed.mentionedPhonesEncrypted },
    select: { clientId: true, agentId: true },
  });
  // Разговор с продавцом — самый подробный источник фактов об объекте (lib/sellerFacts.ts).
  scheduleSellerFactsRefresh(saved.clientId);

  // Перевод на русский БОЛЬШЕ НЕ ГОНИТСЯ АВТОМАТИЧЕСКИ (19.08.2026, экономия
  // токенов: полный перевод получасового разговора — отдельный платный вызов,
  // а читают его далеко не на каждом звонке). ИИ-разбору (analyzeCall ниже)
  // перевод не нужен — он и так понимает таджикский текст, читает оригинал.
  // Перевод остаётся доступен ПО КЛИКУ (POST /interactions/:id/translate) —
  // тому, кому по-русски читать удобнее.
  /**
   * РАЗБОР РАЗГОВОРА — ПЕРВЫМ, И ЭТО ИЗМЕНИЛОСЬ 12.08.2026.
   *
   * Раньше первым шло предложение по карточке: «карточка нужна агенту прямо
   * сейчас, разбор подождёт лишние секунды». С тех пор из разбора берётся ЧЕРНОВИК
   * ОКНА «Как прошёл звонок» (suggestedOutcome/suggestedNextAction), а окно висит у
   * агента перед глазами с самого отбоя и блокирует CRM. Теперь «прямо сейчас»
   * нужен именно разбор: пока он не готов, человек сидит перед пустой формой.
   * Предложение по карточке ждёт своей очереди секунды — его окно откроется следом
   * и никого не держит.
   */
  await setStage(interactionId, "ANALYZING");
  const analysis = await analyzeCall(interactionId);
  // Расшифровка уже сохранена, а разбор упал временным сбоем (БД, поставщик): повтор
  // расшифровки по пустому transcript его не подхватит, а ночные сводки и лид читают
  // разбор (CHANNEL-NEW-39, 04.10.2026). Ставим то же задание повтора — оно доведёт разбор.
  if (!analysis.ok && ANALYSIS_RETRYABLE_REASONS.has(analysis.reason ?? "")) scheduleTranscriptionRetry(interactionId);
  // Поля карточки из того же разговора: агент подтвердит или поправит.
  if (saved.agentId) {
    await buildSuggestionFromCall({
      clientId: saved.clientId,
      agentId: saved.agentId,
      interactionId,
      talkSeconds: typeof durationSec === "number" ? durationSec : 0,
    });
  }
  /**
   * ВХОДЯЩИЙ ЗВОНОК ПРЕВРАЩАЕТСЯ В ЛИДА ЗДЕСЬ (18.08.2026).
   *
   * Расшифровка и разбор уже готовы — это единственный момент, когда о позвонившем
   * известно всё, что вообще можно узнать. Раньше дальше шёл человек: оператор
   * открывал окно и выбирал «Покупатель/Продавец». Теперь по новой схеме приёма
   * оператор в CRM не заходит вовсе, и разбор делает сама CRM.
   *
   * Звонка агента это не касается: `autoLeadFromInteraction` сам проверяет, что
   * запись хронологии принадлежит входящему, и на чужой молча возвращает null.
   * Отказ автоматики не должен ломать конвейер записи — она не бросает наружу.
   */
  await autoLeadFromInteraction(interactionId, { lateTranscript: !hadTextBefore });

  // Сводка ИИ на карточке (29.09.2026: «чтобы все шаги с клиентом там каждый раз
  // обновлялись») — пересобирается по уже записанному итогу разговора, в самом
  // конце конвейера, когда разбор и предложение по карточке уже лежат в базе.
  // Раньше причина call_result_logged была объявлена, но не звалась нигде, и
  // звонок попадал в сводку только со следующим сообщением клиента или ночью.
  if (saved.clientId) runClientAutopilotInBackground(saved.clientId, "call_result_logged");

  // Готово — конвейер этим разговором больше не занят. Дальше карточку читают по
  // transcript/transcriptRu/callAnalysis, а не по стадии.
  await setStage(interactionId, null);
  return { ok: true, retryable: false };
}

/* ─────────────────── ДОГОНЯЮЩАЯ РАСШИФРОВКА (15.08.2026) ────────────────────
 *
 * ЗАЧЕМ. Расшифровка делается ОДИН раз — сразу после разговора. Если в эту минуту
 * Gemini отвечает отказом (лимит ключа, обрыв прокси, таймаут на длинной записи —
 * а такое в журнале ошибок бывает пачками), разговор остаётся немым НАВСЕГДА:
 * запись на станции есть, текста нет, разбора нет, черновик окна «Как прошёл
 * звонок» пустой, и повторить некому. Именно это агент видит строкой «Разговор не
 * расшифрован» в карточке.
 *
 * ЧТО ДЕЛАЕМ. Разговор, где отказали ВСЕ куски, встаёт в очередь повтора: запись
 * скачивается со станции заново (файл там живёт год) и проходит тот же путь.
 *
 * С 27.08.2026 очередь ПЕРСИСТЕНТНАЯ (BackgroundJob, чертёж Б3): первая версия
 * жила в памяти процесса и потребовала костыль «досева» после каждого рестарта
 * (reseedTranscriptionRetries в точке входа) — единственная in-memory очередь,
 * которой это понадобилось, то есть боль была доказана в проде. Задание
 * переживает перезапуск само, досев удалён вместе с окном-двухчасовкой и её
 * оговорками про неотличимость «ждал повтора» от «тишины».
 *
 * ПОЧЕМУ НЕ ПОВТОРЯЕМ ТИШИНУ. Пустой ответ модели («в записи нечего разбирать» —
 * гудки, молчание) отказом не считается и в очередь не попадает: повторять его
 * значит платить за один и тот же пустой файл каждые несколько минут.
 */
/**
 * Отступ перед попыткой: первая через 5 минут после отказа, дальше 20 минут,
 * час, 2 часа, 3 и 3 — всего ~9,5 часа от первой неудачи.
 *
 * ПОЧЕМУ ТАК ДОЛГО (21.09.2026). Было три ступени, ~85 минут. В тот день у
 * Gemini кончился баланс (402) примерно на полтора часа — и два звонка
 * (12:35 и 12:36 UTC) сдались в 14:03 и 14:08, за пару минут до того, как
 * поставщик ожил: разговоры остались немыми навсегда, без разбора и красных
 * флажков. Соседний повтор ответов бота (jobs/aiReplyRetryPolicy.ts, ~13 часов)
 * тот же простой пережил без единой потери. Ждать дольше почти бесплатно:
 * отказ поставщика токенов не стоит, платим только за удачную попытку.
 */
export const TRANSCRIPTION_RETRY_DELAYS_MS = [
  5 * 60_000,
  20 * 60_000,
  60 * 60_000,
  2 * 60 * 60_000,
  3 * 60 * 60_000,
  3 * 60 * 60_000,
];
/** Попыток ровно столько, сколько ступеней: [0] — отступ постановки, [N] — после
 *  N-й неудачи (backoff в jobs/transcriptionRetry.ts), последняя ступень ведёт к
 *  последней попытке. Выведено из массива, чтобы они не разъехались. */
export const TRANSCRIPTION_RETRY_MAX_ATTEMPTS = TRANSCRIPTION_RETRY_DELAYS_MS.length;

/** Причины отказа analyzeCall, при которых разбор стоит повторить (остальные окончательны:
 *  «нет расшифровки», «разговор слишком короткий», «разбор уже есть» и т.п.). */
const ANALYSIS_RETRYABLE_REASONS = new Set(["ошибка разбора", "модель не ответила"]);

export function scheduleTranscriptionRetry(interactionId: string): void {
  void enqueueBackgroundJob({
    type: "transcription-retry",
    payload: { interactionId },
    // Один живой повтор на разговор; после DONE новый отказ заведёт задание заново.
    dedupeKey: transcriptionRetryKey(interactionId),
    maxAttempts: TRANSCRIPTION_RETRY_MAX_ATTEMPTS,
    runAt: new Date(Date.now() + TRANSCRIPTION_RETRY_DELAYS_MS[0]),
  });
}

/**
 * Одна попытка догнать расшифровку — тело задания transcription-retry
 * (jobs/transcriptionRetry.ts). Тихо завершается, когда повторять НЕЧЕГО (не
 * потому что не получилось, а потому что вопрос уже закрыт иначе): разговор уже
 * расшифрован другим путём, удалён вместе с карточкой, или в записи тишина
 * (пустой ответ модели — штатный исход, а не отказ, см. ai/transcribe.ts).
 * Бросает — когда есть за что зацепиться следующей попыткой: поставщик снова
 * отказал, станция не отдала файл, ИЛИ формат не режется на части (24.09.2026,
 * было тихим завершением — см. докстринг у той же ветки в finalizeFoundRecording:
 * решили, что «не режется» чаще значит «файл побит при скачивании через
 * нестабильный туннель», а не «формат навсегда не поддерживается», и следующая
 * попытка вправе получить исправную копию). Исключение возвращает задание
 * очереди на следующую ступень лесенки.
 *
 * Идемпотентно: повторный вызов по расшифрованному разговору выходит на первой
 * же проверке transcript.
 */
/**
 * Тело «скачать со станции → сверить автора → нарезать → расшифровать» — то, что
 * ДЕЛАЕТ и автоматический повтор ниже (когда поставщик отказал), и ручная
 * пере-расшифровка по кнопке (retranscribeInteraction, вызывается из POST
 * /interactions/:id/retranscribe). Вынесено отдельно ровно по той же причине, по
 * которой сама transcribeAndEnrich вынесена из ingestCallRecording (см. её
 * докстринг): второй путь к тем же действиям рано или поздно забыл бы сверку
 * автора или страховку «формат не режется», и два вызывающих места разошлись бы
 * в поведении.
 *
 * Не ловит исключения сама — их обрабатывает каждый вызывающий по-своему
 * (retry бросает дальше, чтобы задание встало на следующую ступень лесенки;
 * ручная расшифровка ловит и пишет в logSystemError, не имея своей лесенки).
 */
async function fetchAndTranscribe(
  interactionId: string,
  recordingUrl: string,
  durationSec: number | null | undefined,
  config: RecordingFetchConfig,
  beforeSave?: () => Promise<void>
): Promise<{ ok: boolean; retryable: boolean }> {
  const { buffer, path: found } = await fetchRecording(recordingUrl, config);
  if (found !== recordingUrl) {
    // Станция успела сжать wav в mp3 — запоминаем найденный путь, как это
    // делает прослушивание записи (routes/interactions.ts).
    await prisma.interaction
      .update({ where: { id: interactionId }, data: { recordingUrl: found } })
      .catch(() => {});
  }

  // Повторная сверка автора (17.09.2026, см. reconcileCallAuthor у первой записи
  // в finalizeFoundRecording): путь здесь уже подтверждён первым проходом, поэтому
  // режим уверенный (без weakMatch) — если добавочный агента с тех пор поменяли
  // или расхождение как-то проскочило мимо первой проверки, второй шанс поймать
  // его — здесь.
  const authorInteractionRetry = await prisma.interaction.findUnique({
    where: { id: interactionId },
    select: { id: true, clientId: true, agentId: true, agent: { select: { id: true, fullName: true, sipExtension: true } } },
  });
  if (authorInteractionRetry && authorInteractionRetry.agent) {
    await reconcileCallAuthor(authorInteractionRetry, authorInteractionRetry.agent, found).catch((err) => {
      void logSystemError("telephony", `Сверка автора звонка с добавочным в файле записи не выполнена: ${describeError(err)}`, { dedupKey: "Сверка автора звонка с добавочным в файле записи не выполнена: …" });
    });
  }

  const mediaType = contentTypeFor(found);
  const rawParts = splitAudioForTranscription(buffer, mediaType, TRANSCRIBE_MAX_BYTES, durationSec ?? undefined);
  // Та же страховка, что в finalizeFoundRecording (см. её докстринг): формат без
  // поддержки резки, но укладывающийся в предел целиком, расшифровывается одним
  // вызовом, а не считается «не режется».
  const parts: AudioParts = rawParts.length === 0 && buffer.length <= TRANSCRIBE_MAX_BYTES ? [buffer] : rawParts;
  if (parts.length === 0) {
    // Формат крупнее предела и не режется — бросаем, а не завершаемся тихо (см.
    // докстринг runTranscriptionRetryAttempt): следующая попытка получит свежую
    // копию файла со станции, и если дело было в повреждении при скачивании, она
    // распознается. Если формат действительно не поддерживается — лесенка
    // автоповтора исчерпает попытки и остановится сама (у ручной пере-расшифровки
    // лесенки нет — вызывающий просто вернёт отказ).
    void logSystemError(
      "ai",
      `Разговор ${found} не расшифрован повтором: ${Math.round(buffer.length / 1024 / 1024)} МБ, формат ${mediaType} не режется на части`, { dedupKey: "Разговор … не расшифрован повтором: … МБ, формат … не режется на части" }
    );
    throw new Error(`формат записи (${mediaType}) не режется на части`);
  }

  return transcribeAndEnrich({ interactionId, parts, mediaType, path: found, durationSec: durationSec ?? undefined, beforeSave });
}

export async function runTranscriptionRetryAttempt(interactionId: string): Promise<void> {
  // Расшифровка уже есть, а разбора нет (его отказ ставит это же задание): записи на
  // станции не нужны, догоняем только разбор. «Разбор уже есть» и прочие окончательные
  // отказы — завершение; временный отказ бросает, и очередь ретраит по лесенке.
  const transcribed = await prisma.interaction.findUnique({ where: { id: interactionId }, select: { transcript: true } });
  if (transcribed?.transcript) {
    const analysis = await analyzeCall(interactionId);
    if (!analysis.ok && ANALYSIS_RETRYABLE_REASONS.has(analysis.reason ?? "")) {
      throw new Error(`разбор звонка снова не вышел: ${analysis.reason}`);
    }
    return;
  }
  const config = recordingFetchConfig();
  // Телефония не настроена — записи взять неоткуда; это завершение, не ошибка.
  if (!config) return;

  const interaction = await prisma.interaction.findUnique({
    where: { id: interactionId },
    select: { id: true, recordingUrl: true, transcript: true, recordingDurationSec: true },
  });
  // Запись успели расшифровать другим путём, разговор удалили вместе с
  // карточкой, путь потерялся — повторять нечего.
  if (!interaction?.recordingUrl || interaction.transcript) return;

  try {
    await setStage(interactionId, "SEARCHING");
    const result = await fetchAndTranscribe(interactionId, interaction.recordingUrl, interaction.recordingDurationSec, config);
    if (result.ok) {
      console.log(`[расшифровка] разговор ${interactionId} расшифрован с повтора`);
      return;
    }
    // В записи нечего разбирать — это не отказ, повторять нет смысла.
    if (!result.retryable) return;
    throw new Error("поставщик снова отказал");
  } catch (err) {
    // Стадию снимаем на ЛЮБОМ отказе — в том числе когда станция отказала ДО
    // transcribeAndEnrich (та сама снимает стадию на своих путях отказа) —
    // иначе «Ищем запись на станции» висело бы на экране до следующей попытки.
    await setStage(interactionId, null);
    throw err;
  }
}

/**
 * ПЕРЕ-РАСШИФРОВКА ПО КНОПКЕ (24.09.2026) — POST /interactions/:id/retranscribe
 * (routes/interactions.ts). В отличие от runTranscriptionRetryAttempt выше, эта
 * функция не ждёт, пока поставщик откажет: агент слышит запись и видит, что
 * текущий текст разошёлся с тем, что сказано (шумная запись, плохое распознавание
 * — не отказ Gemini), и просит разобрать заново.
 *
 * СТАРЫЙ РАЗБОР УДАЛЯЕТСЯ, КОГДА НОВЫЙ ТЕКСТ УЖЕ ПОЛУЧЕН (03.10.2026). Раньше —
 * до скачивания: станция не отдала файл или поставщик отказал, и разговор
 * оставался вовсе без текста и без разбора, хотя старые были. Теперь снятие идёт
 * крючком beforeSave — между ответом поставщика и записью нового текста.
 *
 * ЗАПИСЬ КОНСУЛЬТАНТА (ИИ) НЕ ПЕРЕ-РАСШИФРОВЫВАЕТСЯ: её текст — живая расшифровка
 * самого разговора, другой нет, а файл лежит в R2, не на станции.
 *
 * Почему разбор вообще снимается: analyzeCall (зовётся изнутри
 * transcribeAndEnrich) сам отказывается разбирать разговор, у которого уже есть
 * CallAnalysis (уникальность interactionId, см. её докстринг «разбор уже есть») —
 * без удаления новый текст получил бы старый разбор, будто ничего не изменилось.
 *
 * transcriptRu СБРАСЫВАЕТСЯ В NULL, А НЕ ПЕРЕСЧИТЫВАЕТСЯ ЗДЕСЬ ЖЕ: перевод — по
 * клику (POST /:id/translate, экономия токенов, см. её докстринг в
 * ai/translateTranscript.ts), а старый перевод СТАРОГО текста после новой
 * расшифровки — источник вранья, а не экономии.
 *
 * NOTES: снимается только ХВОСТ, дописанный предыдущим разбором (` — <резюме>`,
 * см. analyzeCall) — собственные пометки агента в notes трогать нельзя, а
 * снятие всего поля стёрло бы и их.
 */
/** Запись консультанта на телефоне (liveVoiceBridge.ts::liveVoiceRecordingKey) —
 *  ключ R2, а не файл станции. */
export const LIVE_VOICE_RECORDING_PREFIX = "call-recordings/live-voice/";
export function isLiveVoiceRecording(recordingUrl: string): boolean {
  return recordingUrl.startsWith(LIVE_VOICE_RECORDING_PREFIX);
}

export async function retranscribeInteraction(interactionId: string): Promise<{ ok: boolean; reason?: string }> {
  const config = recordingFetchConfig();
  if (!config) return { ok: false, reason: "PBX_RECORDINGS_URL не задан" };

  const interaction = await prisma.interaction.findUnique({
    where: { id: interactionId },
    select: { id: true, recordingUrl: true, recordingDurationSec: true, notes: true },
  });
  if (!interaction?.recordingUrl) return { ok: false, reason: "записи нет" };
  if (isLiveVoiceRecording(interaction.recordingUrl)) {
    return { ok: false, reason: "разговор с консультантом (ИИ) — его расшифровка единственная, повтор не нужен" };
  }

  const oldAnalysis = await prisma.callAnalysis.findUnique({
    where: { interactionId },
    select: { summary: true },
  });
  const oldSuffix = oldAnalysis?.summary ? ` — ${oldAnalysis.summary}` : null;
  const strippedNotes =
    oldSuffix && interaction.notes?.endsWith(oldSuffix)
      ? interaction.notes.slice(0, -oldSuffix.length)
      : interaction.notes;

  const clearOld = async () => {
    await prisma.$transaction([
      prisma.callAnalysis.deleteMany({ where: { interactionId } }),
      prisma.interaction.update({
        where: { id: interactionId },
        data: { transcript: null, transcriptRu: null, notes: strippedNotes },
      }),
    ]);
  };

  try {
    await setStage(interactionId, "SEARCHING");
    const result = await fetchAndTranscribe(interactionId, interaction.recordingUrl, interaction.recordingDurationSec, config, clearOld);
    if (!result.ok) {
      await setStage(interactionId, null);
      void logSystemError(
        "ai",
        `Повторная расшифровка по запросу не удалась: разговор ${interactionId}, запись ${interaction.recordingUrl}`, { dedupKey: "Повторная расшифровка по запросу не удалась: разговор …, запись …" }
      );
      return { ok: false, reason: "поставщик не ответил" };
    }
    return { ok: true };
  } catch (err) {
    await setStage(interactionId, null);
    void logSystemError("ai", `Повторная расшифровка по запросу упала: ${describeError(err)}`, { dedupKey: "Повторная расшифровка по запросу упала: …" });
    return { ok: false, reason: describeError(err) };
  }
}

/* ─────────────── ДОГОНЯЮЩИЙ ПОИСК ФАЙЛА ЗАПИСИ (20.09.2026) ─────────────────
 *
 * ЗАЧЕМ. «Нет файла записи» выше — штатный исход для недозвона, но для
 * ОТВЕЧЕННОГО разговора это означает лишь то, что окно поиска (2+6+15=23с)
 * короче обрыва обратного туннеля до станции: 20.09.2026 при перезагрузке VPS
 * туннель лежал около 30 секунд. Файл, который на станции реально появится
 * через минуту, до сих пор терялся НАВСЕГДА — повторного шанса не было ни
 * одного, в отличие от расшифровки выше (scheduleTranscriptionRetry, с
 * 15.08.2026).
 *
 * ПОЧЕМУ ОТДЕЛЬНОЕ ЗАДАНИЕ, А НЕ scheduleTranscriptionRetry. Тот повтор требует
 * уже сохранённого interaction.recordingUrl (`if (!interaction?.recordingUrl
 * ...) return` в runTranscriptionRetryAttempt) — а здесь файл ещё не найден
 * вовсе, сохранять нечего. Это более ранняя стадия того же конвейера.
 */
export const RECORDING_SEARCH_RETRY_MAX_ATTEMPTS = 3;
/** Минута — пережить сам обрыв тоннеля, 5 и 15 минут — на случай, если станция
 *  была перегружена дольше одного разрыва. Короче лесенки расшифровки: здесь
 *  ищем файл, который либо уже лежит на диске станции, либо не появится вовсе
 *  (ждать час, как для Gemini, смысла нет). */
export const RECORDING_SEARCH_RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000];

/**
 * JSON-совместимый снимок RecordingSearch — Date не проходит через payload задания.
 *
 * Именно `type`, а не `interface`: payload уходит в Prisma.InputJsonValue, а тот
 * требует индексную сигнатуру. У псевдонима типа она выводится неявно, у
 * интерфейса — нет, и сборка падает на несовместимости (поймано 20.09.2026).
 */
type RecordingSearchRetryPayload = {
  interactionId: string;
  search: {
    startedAt: string;
    agentExtension: string | null;
    clientPhone: string;
    answeredAt: string | null;
    direction: "incoming" | "outgoing";
  };
  durationSec: number | null;
};

/**
 * Ключи страховочных заданий по разговору — одной формулировкой на весь модуль.
 *
 * Постановка, снятие и досмотр зависших стадий читают один и тот же ключ; пока
 * строка собиралась на месте в трёх разных функциях, разъехаться они могли молча
 * и без единой ошибки сборки — снятие просто переставало что-либо находить.
 */
function recordingSearchRetryKey(interactionId: string): string {
  return `recording-search-retry:${interactionId}`;
}

function transcriptionRetryKey(interactionId: string): string {
  return `transcription-retry:${interactionId}`;
}

/**
 * Снять страховочный поиск, который больше не нужен: файл найден и разобран, либо
 * отвергнут окончательно. Трогаем только ЖДУЩЕЕ задание (PENDING): исполняющееся
 * сейчас отменять нельзя — оно само выйдет на первой проверке recordingUrl, а
 * удалённая из-под бегущего обработчика строка обернулась бы ошибкой записи итога.
 */
async function cancelRecordingSearchRetry(interactionId: string): Promise<void> {
  await prisma.backgroundJob
    .deleteMany({ where: { dedupeKey: recordingSearchRetryKey(interactionId), status: "PENDING" } })
    .catch((err) => {
      // Не снялось — не беда: задание идемпотентно и выйдет само, увидев
      // recordingUrl. Молчать всё равно не надо, иначе лишний проход по станции
      // выглядит как необъяснимый.
      console.warn(`[запись] страховка ${interactionId} не снята: ${describeError(err)}`);
    });
}

async function scheduleRecordingSearchRetry(
  interactionId: string,
  search: RecordingSearch,
  durationSec: number | undefined
): Promise<void> {
  const payload: RecordingSearchRetryPayload = {
    interactionId,
    search: {
      startedAt: search.startedAt.toISOString(),
      agentExtension: search.agentExtension ?? null,
      clientPhone: search.clientPhone,
      answeredAt: search.answeredAt ? search.answeredAt.toISOString() : null,
      direction: search.direction,
    },
    durationSec: typeof durationSec === "number" ? durationSec : null,
  };
  // ЖДЁМ постановку, а не `void`: с 21.09.2026 задание заводится ПЕРЕД поиском
  // именно затем, чтобы пережить рестарт внутри него. Не дождаться записи в БД
  // значит снова оставить окно без страховки — ровно то, что чиним. Цена — один
  // INSERT перед паузой в 23 секунды; сама постановка best-effort и наверх не
  // бросает (см. enqueueBackgroundJob).
  await enqueueBackgroundJob({
    type: "recording-search-retry",
    payload,
    // Один живой повтор на разговор: обычный путь мог найти файл сам, пока
    // задание ждало свою ступень лесенки — дублировать поиск не нужно.
    dedupeKey: recordingSearchRetryKey(interactionId),
    maxAttempts: RECORDING_SEARCH_RETRY_MAX_ATTEMPTS,
    runAt: new Date(Date.now() + RECORDING_SEARCH_RETRY_DELAYS_MS[0]),
  });
}

/**
 * Одна попытка догнать поиск файла — тело задания recording-search-retry
 * (jobs/recordingSearchRetry.ts). Идемпотентна: если запись уже нашлась другим
 * путём (сам ingestCallRecording успел раньше, либо postfactum-восстановление
 * checkStuckCallStubs), recordingUrl уже сохранён — выходим сразу, второй
 * выгрузки файла и второй записи в хронологии клиента не будет.
 *
 * Бросает, если файла всё ещё нет, — задание вернётся на следующую ступень
 * лесенки (jobs/recordingSearchRetry.ts); финальный отказ обрабатывает onGiveUp
 * того же задания — это и есть требуемая видимая ошибка для ОТВЕЧЕННОГО
 * разговора без записи.
 */
export async function runRecordingSearchRetryAttempt(payload: RecordingSearchRetryPayload): Promise<void> {
  const { interactionId } = payload;
  const config = recordingFetchConfig();
  // Телефония не настроена — искать негде; это завершение, не ошибка.
  if (!config) return;

  const interaction = await prisma.interaction.findUnique({
    where: { id: interactionId },
    select: { recordingUrl: true },
  });
  // Запись уже нашлась сама (обычный путь или postfactum-восстановление) —
  // повторный поиск не нужен и не должен ничего перезаписывать.
  if (!interaction || interaction.recordingUrl) return;

  const search: RecordingSearch = {
    startedAt: new Date(payload.search.startedAt),
    agentExtension: payload.search.agentExtension ?? undefined,
    clientPhone: payload.search.clientPhone,
    answeredAt: payload.search.answeredAt ? new Date(payload.search.answeredAt) : undefined,
    direction: payload.search.direction,
  };

  const relative = await findRecording(search, config);
  if (!relative) {
    throw new Error("файл записи всё ещё не найден на станции");
  }

  // Сюда попадают только отвеченные разговоры (см. вызов scheduleRecordingSearchRetry
  // в ingestCallRecording — планируется исключительно при params.clientAnswered).
  const result = await finalizeFoundRecording(
    interactionId,
    relative,
    payload.durationSec ?? undefined,
    !search.agentExtension,
    true
  );
  // Окончательный отказ finalizeFoundRecording (запись похожа на чужую, пустой файл)
  // уже залогирован и запушен внутри неё самой — переспрашивать станцию незачем.
  if (!result.ok) {
    console.warn(`[запись] ${interactionId}: догоняющий поиск нашёл файл, но ${result.reason}`);
    // А вот отказ БЕЗ признака terminal — сеть, туннель, база при скачивании или записи
    // (catch в finalizeFoundRecording): задание завершилось бы «успешно», лесенка
    // повторов отменилась бы, и запись терялась навсегда (CHANNEL-NEW-40, 04.10.2026).
    // Бросаем: очередь вернёт задание на следующую ступень.
    if (!result.terminal) throw new Error(`запись найдена, но не сохранена: ${result.reason ?? "причина не названа"}`);
  }
}

/* ──────── ЗАВИСШАЯ СТАДИЯ ПОСЛЕ РЕСТАРТА ПРОЦЕССА (21.09.2026) ────────────
 *
 * ЖИВОЙ СЛУЧАЙ. Звонок 21.09 в 13:02: `ingestCallRecording` записал стадию
 * SEARCHING и ушёл искать файл (2+6+15 секунд), а в 13:01 в main влилась правка
 * #633 — автовыкат на сервере поднял контейнеры заново ровно в это окно. Стадию
 * снимает ТОТ ЖЕ процесс в конце работы, снять её больше некому, и в карточке
 * клиента пять часов подряд висело «Ищем запись на станции» — притом что никто
 * ничего уже не искал. Владелец прочитал это как «расшифровки сломались».
 *
 * ПОЧЕМУ НЕ ПО ВОЗРАСТУ. Хотелось бы сторожевой обход «стадия висит дольше N
 * минут», но у Interaction нет `updatedAt`, а `createdAt` — это начало звонка, и
 * по нему живая расшифровка часового разговора неотличима от зависшей. Возраст
 * пришлось бы заводить отдельной колонкой с миграцией, а выкат миграции здесь
 * ручной (ops/deploy.sh только печатает `migrate status`).
 *
 * ПОЭТОМУ ПО ФАКТУ РАБОТЫ, А НЕ ПО ВРЕМЕНИ. Стадия означает ровно одно: «прямо
 * сейчас кто-то этим разговором занят». Занятость бывает двух видов — конвейер в
 * памяти ЭТОГО процесса (его рестарт уносит целиком) и задание в очереди (оно
 * рестарт переживает и видно в БД). Значит на старте процесса достоверно
 * зависшая стадия — это стадия БЕЗ живого задания, и никакого порога не нужно.
 *
 * ЗАПУСКАЕТСЯ ТАМ ЖЕ, ГДЕ ЖИВЁТ КОНВЕЙЕР, — в index.ts рядом с подписками на АТС
 * (ровно по той же причине, по которой там живёт live-calls-sweep): это память
 * HTTP-процесса, и чистит её тот, кто её потерял. В worker вызывать нельзя — его
 * рестарт чужую стадию не отменяет.
 *
 * И НЕ ПРОСТО СНИМАЕТ ПЛАШКУ. Оборванный поиск не оставил после себя ни записи,
 * ни задания (до этой же правки страховка заводилась ПОСЛЕ поиска), поэтому
 * состоявшемуся разговору без записи заново заводится догоняющий поиск: иначе
 * «починка» свелась бы к тому, что лживая строка просто исчезает, а запись
 * разговора остаётся потерянной навсегда.
 */
export async function recoverInterruptedTranscriptionStages(): Promise<{ cleared: number; requeued: number }> {
  const hung = await prisma.interaction.findMany({
    where: { transcriptionStage: { not: null } },
    select: {
      id: true,
      type: true,
      notes: true,
      createdAt: true,
      callAttempt: true,
      recordingUrl: true,
      recordingDurationSec: true,
      transcript: true,
      client: { select: { phone: true } },
      agent: { select: { sipExtension: true } },
    },
    // Потолок на всякий случай: зависших стадий штуки, а не тысячи. Если их
    // вдруг тысячи — это отдельная поломка, и разгребать её пачкой по 500 за
    // старт всё равно правильнее, чем тянуть всю таблицу в память.
    take: 500,
  });
  if (hung.length === 0) return { cleared: 0, requeued: 0 };

  const keys = hung.flatMap((call) => [recordingSearchRetryKey(call.id), transcriptionRetryKey(call.id)]);
  const jobs = await prisma.backgroundJob.findMany({
    where: { dedupeKey: { in: keys }, status: { in: ["PENDING", "RUNNING", "GIVEN_UP"] } },
    select: { dedupeKey: true, status: true },
  });
  // Живое задание — разговором занимаются, стадия честная, не трогаем.
  const busy = new Set(jobs.filter((j) => j.status !== "GIVEN_UP").map((j) => j.dedupeKey));
  // Исчерпанное задание — станцию об этом разговоре уже спрашивали трижды и
  // сдались. Плашку снять надо, а гонять поиск по четвёртому кругу незачем.
  const spent = new Set(jobs.filter((j) => j.status === "GIVEN_UP").map((j) => j.dedupeKey));

  let cleared = 0;
  let requeued = 0;
  for (const call of hung) {
    if (busy.has(recordingSearchRetryKey(call.id)) || busy.has(transcriptionRetryKey(call.id))) continue;
    await setStage(call.id, null);
    cleared++;

    if (call.type !== "CALL") continue;

    /**
     * ЗАПИСЬ ЕСТЬ, А ТЕКСТА НЕТ — ПОТЕРЯНА РАСШИФРОВКА, А НЕ ПОИСК ФАЙЛА.
     *
     * Очередь расшифровок (transcriptionQueue выше) — цепочка промисов в памяти
     * процесса, и рестарт уносит её целиком: файл на станции цел, recordingUrl
     * записан, а стадия так и осталась QUEUED или TRANSCRIBING, и текста у
     * разговора не будет никогда. Повторить это умеет уже существующее задание
     * transcription-retry — оно как раз и требует сохранённого recordingUrl при
     * пустом transcript, то есть ровно этот случай.
     */
    if (call.recordingUrl) {
      if (!call.transcript) {
        scheduleTranscriptionRetry(call.id);
        requeued++;
      }
      continue;
    }

    // Догоняющий поиск — только состоявшемуся разговору без записи, тем же
    // условием, что и на основном пути: "TALKED" ставит сама станция (см.
    // callTracker.ts и incomingCalls.ts), догадок по тексту заметки здесь нет.
    if (call.callAttempt !== "TALKED" || !call.client.phone) continue;
    if (spent.has(recordingSearchRetryKey(call.id))) continue;

    /**
     * ВХОДЯЩЕМУ ДОБАВОЧНЫЙ НЕ ПЕРЕДАЁМ. В имени файла очереди его нет вовсе
     * (разговор пишет очередь, а не оператор — см. шапку findRecording), и
     * строгое требование добавочного отбросило бы ЕДИНСТВЕННЫЙ верный файл.
     * Направление читаем по тексту записи: её пишет incomingCalls.ts и только он.
     */
    const incoming = call.notes.startsWith(INCOMING_CALL_NOTE_PREFIX);
    await scheduleRecordingSearchRetry(
      call.id,
      {
        // Начало разговора: у исходящего это момент заведения заготовки, у
        // входящего — момент записи итога, то есть конец разговора. И то и
        // другое ложится в пятиминутное окно поиска (SEARCH_WINDOW_MS) для
        // любого разговора вменяемой длины; у совсем длинного входящего файл
        // может не найтись, и это честно закончится строкой в журнале.
        startedAt: call.createdAt,
        clientPhone: call.client.phone,
        agentExtension: incoming ? undefined : (call.agent?.sipExtension ?? undefined),
        // Направление обязательно с #651: без него догоняющий поиск подшил бы
        // входящему соседнюю ИСХОДЯЩУЮ запись того же клиента — та же подмена,
        // ради которой поле и заведено. Признак тот же, что у agentExtension
        // выше: текст записи пишет incomingCalls.ts только для входящих.
        direction: incoming ? "incoming" : "outgoing",
      },
      call.recordingDurationSec ?? undefined
    );
    requeued++;
  }

  return { cleared, requeued };
}

/** Только для тестов: очистить запомненные пути, очередь повторов и дождаться
 *  пустой очереди расшифровок. */
export async function resetCallRecordings(): Promise<void> {
  pendingPaths.clear();
  outsideRootLoggedAt = null;
  await prisma.backgroundJob.deleteMany({ where: { type: "transcription-retry" } }).catch(() => {});
  await prisma.backgroundJob.deleteMany({ where: { type: "recording-search-retry" } }).catch(() => {});
  await waitForTranscriptions();
}
