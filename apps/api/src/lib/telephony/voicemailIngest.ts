import { prisma } from "../../db.js";
import { scheduleSellerFactsRefresh } from "../sellerFacts.js";
import { transcribeAudio } from "../../ai/transcribe.js";
import { translateTranscript } from "../../ai/translateTranscript.js";
import { findClientByPhoneDigits } from "../whatsappPhone.js";
import { findPhoneOwners } from "../clientPhones.js";
import { logSystemError } from "../systemError.js";
import { logTimeline } from "../timeline.js";
import { describeError } from "../describeError.js";
import { readCapped } from "../safeFetch.js";
import { toCrmPhone } from "./incomingCalls.js";
import { maskClientPhone } from "../clientPhone.js";
import { loadIncomingSettings } from "./incomingSettings.js";
import { sendPushToAgent } from "../../push.js";
import { recordingFetchConfig, type RecordingFetchConfig } from "./callRecordings.js";
import { scrubMentionedPhones, type KnownClientPhones } from "./callPhoneMasking.js";
import { autoLeadFromIncomingCall } from "./autoLeadFromCall.js";
import { enqueueDirectorAlert } from "../directorAlertQueue.js";
import { findStaffPhone, staffPhoneError } from "../staffPhoneGuard.js";
import { claimAutoTaskSlot } from "../autoTasks.js";

/**
 * АВТООТВЕТЧИК: сообщения, наговоренные клиентами, становятся лидами.
 *
 * Клиент позвонил, никто не взял трубку, он услышал просьбу рассказать, что ему
 * нужно, и наговорил сообщение. Станция записала его в свой каталог с ГОВОРЯЩИМ
 * именем — `vm-20260814-013000-930001001.wav` (время и номер звонившего), — а этот
 * модуль раз в две минуты забирает новые файлы и доводит сообщение до того же
 * места, куда попадает состоявшийся разговор.
 *
 * Без этого «оставьте сообщение» — вежливый способ потерять клиента: сообщение
 * лежало бы на станции, куда никто не заглядывает.
 *
 * ЧТО ИЗМЕНИЛОСЬ 18.08.2026 (новая схема приёма звонков). Раньше модуль доводил
 * сообщение до хронологии клиента и будил ОПЕРАТОРА входящих — тот слушал и решал,
 * что с человеком делать. Роли оператора больше нет, и владелец сформулировал
 * прямо: «чтобы был автоответчик, где чётко сказано, чтобы клиент полностью
 * продиктовал своё сообщение, и потом уже из этого всего расшифровывается, и также
 * попадает в очередь по распределению». То есть сообщение обязано пройти весь путь
 * само: расшифровка → разбор ИИ → карточка → агент по KPI.
 *
 * ВТОРОГО ПУТИ К ЭТИМ ДАННЫМ НЕТ, И ЭТО ГЛАВНОЕ РЕШЕНИЕ ЗДЕСЬ. Разбор и раздача
 * живут в `autoLeadFromCall.ts` → `qualifyIncomingCall`, где уже решены дедупликация
 * по номеру, отказ раздавать «Другое» агентам, однократное назначение через
 * `pickAgentForLead` и пуши. Поэтому сообщение не разбирается здесь, а ПРИВЯЗЫВАЕТСЯ
 * К ЗВОНКУ (`IncomingCall.voicemailFile`) и отдаётся той же автоматике: она уже не
 * различает, откуда взялась расшифровка — из разговора или из автоответчика.
 *
 * КЛИЕНТ, У КОТОРОГО ЕСТЬ СВОЙ АГЕНТ, В РАЗДАЧУ НЕ УХОДИТ. Он остаётся за своим
 * агентом, тот получает задачу перезвонить и расшифровку в хронологии. Забрать
 * чужого клиента в общую очередь нельзя ни при каких обстоятельствах — это чужая
 * работа. Решение принимает та же автоматика (исход `known_client`), задачу ставит
 * запись в хронологии здесь.
 *
 * ИДЕМПОТЕНТНОСТЬ — ПО ИМЕНИ ФАЙЛА, И ЗАМОК ЗАНИМАЕТСЯ ДО ЛЮБОЙ ПЛАТНОЙ РАБОТЫ.
 * Имя уникально (секунда + номер), обработанные помнит таблица VoicemailMessage с
 * уникальным `file`. CRM не может удалить файл со станции (доступ только на чтение —
 * и это правильно), поэтому «не обработать дважды» — задача CRM. Тот же приём, что
 * у `autoLeadAt` в autoLeadFromCall.ts: строка-замок создаётся ПЕРЕД расшифровкой,
 * а не после, иначе два наложившихся прохода крона (или перезапуск процесса посреди
 * работы) оплатили бы расшифровку и разбор дважды и завели бы вторую карточку.
 */

/**
 * Сколько знаков расшифровки нужно, чтобы завести под сообщение карточку клиента.
 * Меньше — это «алло, вы меня слышите» и щелчок отбоя: разбирать нечего, а карточка
 * с одним номером вместо имени остаётся в базе навсегда (см. processOne). Порог тот
 * же, что у разбора входящего звонка (ai/incomingCallLead.ts: MIN_TRANSCRIPT_CHARS).
 */
const MIN_TRANSCRIPT_FOR_CLIENT = 80;

const VOICEMAIL_DIR = "royalhome-voicemail";
/**
 * Имя файла: время и номер звонившего. Номер — ЛЮБОЙ хвост (03.10.2026): раньше
 * шаблон требовал 5-15 цифр, и сообщения со скрытого номера (`anonymous`, пусто)
 * и с номером в виде `+992…` молча не видел никто — ни проход, ни журнал.
 */
const FILE_PATTERN = /^vm-(\d{8})-(\d{6})-([^/\\]*)\.wav$/;

/** Меньше цифр — номер не настоящий (скрытый, служебный): сообщение без карточки. */
const MIN_CALLER_DIGITS = 7;

/**
 * Насколько раньше сообщения мог начаться звонок, который к нему привёл. Станция
 * сначала звонит агентам (двадцать пять секунд), потом играет приветствие, и только
 * потом человек говорит — плюс сам разговор с автоответчиком. Десять минут с
 * запасом покрывают всё это, но не дотягиваются до предыдущего звонка того же
 * человека часом раньше.
 */
const CALL_MATCH_WINDOW_MS = 10 * 60_000;

/**
 * Сколько сообщений разбираем за один проход. Каждое — платная расшифровка и платный
 * разбор, а проход идёт раз в две минуты: без предела первый же запуск после суток
 * простоя (или после того, как станция вернула каталог целиком) оплатил бы всё
 * разом и занял бы Gemini, пока рядом ждут расшифровки живых разговоров. Остальные
 * подождут следующего прохода — файлы со станции никуда не денутся.
 */
const INGEST_BATCH = 10;

/**
 * Потолок на список имён, которыми спрашиваем базу «что уже разобрано». Каталог
 * сообщений станция чистит сама, но запрос с `IN` на тысячу значений — это уже не
 * проверка, а сканирование, и предел здесь дешевле, чем надежда на чужую ротацию.
 */
const LISTING_LIMIT = 200;

/**
 * ПОТОЛОК НА РАЗМЕР ОДНОГО СООБЩЕНИЯ (21.08.2026).
 *
 * Источник свой — наша же АТС по туннелю, — поэтому речь не о злом умысле, а о той
 * же дыре, что и у чужих вложений (messengers/attachments.ts): `arrayBuffer()`
 * честно прочитает в память хоть гигабайт, если станция отдаст сбойный файл
 * (зависший MixMonitor, недописанный wav), а память у контейнера общая с базой.
 *
 * Двадцать мегабайт — с большим запасом: телефонный wav это ≈16 КБ в секунду, то
 * есть больше двадцати минут наговоренного сообщения. Столько на автоответчик не
 * наговаривают; всё, что крупнее, — сбой станции, а не клиент.
 */
const VOICEMAIL_MAX_BYTES = 20 * 1024 * 1024;

/**
 * СКОЛЬКО ЖДЁМ, ПРЕЖДЕ ЧЕМ СЧИТАТЬ ЗАМОК БРОШЕННЫМ.
 *
 * Строка `VoicemailMessage` встаёт ДО расшифровки — как замок, чтобы соседний
 * проход не оплатил ту же минуту второй раз. Но отметки о КОНЦЕ работы у неё не
 * было, и любой обрыв посреди прохода терял сообщение навсегда: имя файла в базе
 * есть, значит следующий проход его не тронет, а карточки, задачи «перезвонить»
 * и раздачи так и не случилось — и ни одной строки в журнале, потому что процесс
 * умер, не дойдя до `catch`. Перезапуск здесь не редкость: контейнеры
 * перезапускаются на каждый мерж в main.
 *
 * Десять минут — с запасом больше самого долгого честного прохода (скачивание,
 * расшифровка, перевод, разбор — это минуты), так что живую работу мы не
 * перебьём.
 */
const STALE_CLAIM_MS = 10 * 60_000;

/**
 * Потолок повторов на одно сообщение. Без него сломанный файл крутился бы в
 * платной расшифровке каждые две минуты до скончания века — та же причина, по
 * которой слишком большой файл не качают заново.
 */
const MAX_CLAIM_ATTEMPTS = 3;

/**
 * Файл больше потолка. Отдельный тип ошибки нужен, чтобы отличить его от моргнувшей
 * сети: сеть чинится следующим проходом, а файл не похудеет никогда — повторять его
 * значит скачивать одно и то же каждые две минуты вечно.
 */
class VoicemailTooLargeError extends Error {}

interface VoicemailFile {
  name: string;
  phone: string;
  recordedAt: Date;
}

function parseVoicemailName(name: string): VoicemailFile | null {
  const m = FILE_PATTERN.exec(name);
  if (!m) return null;
  const [, d, t, caller] = m;
  const digits = caller.replace(/\D/g, "");
  // Имя пишет станция в местном времени Душанбе (UTC+5) — переводим честно, а не
  // через часовой пояс контейнера (он в UTC). Тот же приём, что в dateDir()
  // из callRecordings.ts; своего разбора времени здесь не изобретаем.
  const iso = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T${t.slice(0, 2)}:${t.slice(2, 4)}:${t.slice(4, 6)}+05:00`;
  const recordedAt = new Date(iso);
  if (Number.isNaN(recordedAt.getTime())) return null;
  // Пустой phone — номер скрыт: сообщение живёт без карточки (см. processVoicemail).
  return { name, phone: digits.length >= MIN_CALLER_DIGITS ? toCrmPhone(digits) : "", recordedAt };
}

async function listVoicemailFiles(config: RecordingFetchConfig): Promise<string[]> {
  const res = await fetch(`${config.baseUrl}/${VOICEMAIL_DIR}/`, {
    headers: config.token ? { "X-Recordings-Token": config.token } : {},
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`станция ответила HTTP ${res.status}`);
  const html = await res.text();
  return [...html.matchAll(/href="([^"]+\.wav)"/g)].map((m) => decodeURIComponent(m[1]));
}

async function fetchVoicemail(config: RecordingFetchConfig, name: string): Promise<Buffer> {
  const res = await fetch(`${config.baseUrl}/${VOICEMAIL_DIR}/${encodeURIComponent(name)}`, {
    headers: config.token ? { "X-Recordings-Token": config.token } : {},
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`файл ${name}: HTTP ${res.status}`);
  const limitMb = Math.round(VOICEMAIL_MAX_BYTES / 1024 / 1024);
  // Заведомо огромный файл отсекаем ДО чтения тела: буферизовать сотню мегабайт
  // только ради того, чтобы измерить её, — это и есть та беда, от которой потолок.
  const declared = Number(res.headers?.get("content-length") ?? 0);
  if (declared > VOICEMAIL_MAX_BYTES) {
    await res.body?.cancel().catch(() => {});
    throw new VoicemailTooLargeError(
      `файл ${name}: станция заявила ${Math.round(declared / 1024 / 1024)} МБ при потолке ${limitMb} МБ`
    );
  }
  if (res.body) {
    // Тело читаем потоком с обрывом на потолке — той же функцией, что стережёт
    // вложения из мессенджеров (lib/safeFetch.ts): своей второй копии этой логики
    // здесь заводить незачем, а Content-Length станция может и не прислать.
    const { body, truncated } = await readCapped(res, VOICEMAIL_MAX_BYTES);
    if (truncated) throw new VoicemailTooLargeError(`файл ${name}: тело больше потолка ${limitMb} МБ`);
    return body;
  }
  // Ответ без потока (пустое тело; в тестах — подменённый fetch): читаем как есть,
  // но потолок всё равно проверяем.
  const body = Buffer.from(await res.arrayBuffer());
  if (body.byteLength > VOICEMAIL_MAX_BYTES) {
    throw new VoicemailTooLargeError(
      `файл ${name}: ${Math.round(body.byteLength / 1024 / 1024)} МБ при потолке ${limitMb} МБ`
    );
  }
  return body;
}

/**
 * Один проход: забрать новые сообщения, обработать, отметить.
 * Возвращает число обработанных — крону и тестам.
 */
export async function ingestVoicemails(): Promise<number> {
  const config = recordingFetchConfig();
  if (!config) return 0;

  let names: string[];
  try {
    names = await listVoicemailFiles(config);
  } catch (err) {
    // Обрыв туннеля — штатная погода, а не тревога: следующий проход доберёт.
    // В консоли след остаётся, в журнале ошибок — нет (см. правило шумных тревог).
    console.warn(`[автоответчик] каталог не прочитан: ${describeError(err)}`);
    return 0;
  }

  // По возрастанию времени: сообщения разбираются в том порядке, в каком их
  // оставляли, — при упёршемся в предел проходе первым обслуживается тот, кто ждёт
  // дольше всех.
  const parsed = names
    .map((name) => {
      const vm = parseVoicemailName(name);
      // Каждый пропущенный файл — в журнал (03.10.2026): молча отброшенное
      // сообщение клиента не найдёт никто. Ключ постоянный (сторож system-error-stable-keys-02-10):
      // иначе каждый файл будил бы директоров пушем «новая проблема».
      if (!vm) {
        void logSystemError("telephony", `Файл автоответчика ${name} не разобран по имени — сообщение не обработано, послушайте его на станции.`, {
          dedupKey: "voicemail-unparsed",
        });
      }
      return vm;
    })
    .filter((v): v is VoicemailFile => v !== null)
    .sort((a, b) => a.recordedAt.getTime() - b.recordedAt.getTime())
    .slice(-LISTING_LIMIT);
  if (parsed.length === 0) return 0;

  // Предварительный отсев обработанных — чтобы не дёргать станцию за файлы, которые
  // уже разобраны. Настоящий замок ниже: эта выборка только экономит запросы.
  //
  // «Обработано» — это ТОЛЬКО доведённое до конца (`processedAt`), взятое прямо
  // сейчас соседним проходом или исчерпавшее повторы. Брошенный замок (процесс
  // умер посреди работы) сюда не попадает, иначе сообщение терялось бы навсегда.
  const staleBefore = new Date(Date.now() - STALE_CLAIM_MS);
  const known = await prisma.voicemailMessage.findMany({
    where: {
      file: { in: parsed.map((p) => p.name) },
      OR: [
        { processedAt: { not: null } },
        { attempts: { gte: MAX_CLAIM_ATTEMPTS } },
        { claimedAt: { gte: staleBefore } },
      ],
    },
    select: { file: true },
  });
  const knownSet = new Set(known.map((k) => k.file));
  const fresh = parsed.filter((p) => !knownSet.has(p.name)).slice(0, INGEST_BATCH);

  let processed = 0;
  // Последовательно, а не Promise.all: каждое сообщение — платная расшифровка и
  // платный разбор, а очередь расшифровок разговоров рядом и так занимает Gemini.
  for (const vm of fresh) {
    try {
      if (await processVoicemail(config, vm)) processed += 1;
    } catch (err) {
      // Одно сломанное сообщение не должно останавливать остальные; в журнал —
      // обязательно: потерянное сообщение клиента дороже любой другой ошибки здесь.
      void logSystemError("telephony", `Сообщение автоответчика ${vm.name} не обработано: ${describeError(err)}`, { dedupKey: "Сообщение автоответчика … не обработано: …" });
    }
  }
  return processed;
}

/**
 * Карточка под расшифрованное сообщение. Отказ записи (номер заняли между
 * поиском и созданием) не должен ронять обработку: расшифровка уже оплачена, и
 * сообщение обязано дойти до звонка в «Без разбора» (23.09.2026, пункт 22).
 */
async function createVoicemailClient(
  vm: VoicemailFile,
  defaultKind: string
): Promise<{ id: string; shortId: number; fullName: string; assignedAgentId: string | null } | null> {
  try {
    return await prisma.client.create({
      data: {
        // МАСКА, А НЕ НОМЕР ЦЕЛИКОМ — то же правило, что у карточки по живому
        // звонку (lib/telephony/incomingCalls.ts, владелец 20.08.2026: номер не
        // должен выходить агенту мимо права `clients.viewPhone`, а имя карточки
        // это право не проверяет). Настоящий номер лежит в поле `phone`.
        fullName: `Входящий ${maskClientPhone(vm.phone)}`,
        phone: vm.phone,
        source: "PHONE_CALL",
        kind: defaultKind === "BUYER" || defaultKind === "SELLER" ? defaultKind : "OTHER",
        status: "NEW",
        currency: "TJS",
      },
      select: { id: true, shortId: true, fullName: true, assignedAgentId: true },
    });
  } catch (err) {
    void logSystemError(
      "telephony",
      `Сообщение автоответчика ${vm.name} (${maskClientPhone(vm.phone)}): карточка не заведена — ${describeError(err)}. ` +
        `Звонок остался в «Без разбора».`, { dedupKey: "Сообщение автоответчика … (…): карточка не заведена — …. Звонок остался в «Без разбора»." }
    );
    return null;
  }
}

/**
 * ЗАНЯТЬ СООБЩЕНИЕ. `null` — за него уже взялся кто-то другой либо повторы
 * исчерпаны.
 *
 * Обычный путь — создать строку: уникальный `file` делает попытку однократной,
 * проигравший получает P2002 и уходит молча.
 *
 * Второй путь — ПЕРЕХВАТ БРОШЕННОГО ЗАМКА. Строка есть, работа не доведена
 * (`processedAt` пуст), а взялись за неё давно — значит тот проход умер (рестарт
 * на выкате, падение посреди расшифровки). Перехват делается условным
 * `updateMany` в одном запросе, как и первичный захват: кто изменил строку, тот
 * и работает, второй увидит `count: 0`. Попытки считаются, чтобы сломанный файл
 * не крутился в платной расшифровке вечно.
 */
async function claimVoicemail(vm: VoicemailFile): Promise<string | null> {
  try {
    const claim = await prisma.voicemailMessage.create({
      data: { file: vm.name, phone: vm.phone, recordedAt: vm.recordedAt },
      select: { id: true },
    });
    return claim.id;
  } catch {
    // Ожидаемая причина одна — имя файла уже в базе. Любая другая ошибка базы
    // всплывёт следующим запросом и попадёт в журнал там.
  }

  const taken = await prisma.voicemailMessage.updateMany({
    where: {
      file: vm.name,
      processedAt: null,
      attempts: { lt: MAX_CLAIM_ATTEMPTS },
      claimedAt: { lt: new Date(Date.now() - STALE_CLAIM_MS) },
    },
    data: { attempts: { increment: 1 }, claimedAt: new Date() },
  });
  if (taken.count === 0) return null;

  const row = await prisma.voicemailMessage.findUnique({
    where: { file: vm.name },
    select: { id: true, attempts: true },
  });
  if (!row) return null;
  const last = row.attempts >= MAX_CLAIM_ATTEMPTS;
  void logSystemError(
    "telephony",
    `Сообщение автоответчика ${vm.name} осталось неразобранным с прошлого раза (обрыв или перезапуск) — ` +
      `берусь заново, попытка ${row.attempts} из ${MAX_CLAIM_ATTEMPTS}.` +
      (last ? " Это последняя: если снова не выйдет, послушайте запись вручную." : ""),
    // Ключ — вид события, а не файл (E11, 02.10.2026): имя файла в ключе давало
    // пуш «Новая проблема» директорам на каждое сообщение.
    { dedupKey: "voicemail-stale" }
  );
  return row.id;
}

/** Работа доведена до конца — больше за это сообщение не берёмся. */
async function markVoicemailDone(claimId: string): Promise<void> {
  await prisma.voicemailMessage
    .update({ where: { id: claimId }, data: { processedAt: new Date() } })
    .catch(() => {});
}

/**
 * Обработка одного сообщения. `false` — сообщение уже было занято другим проходом.
 */
async function processVoicemail(config: RecordingFetchConfig, vm: VoicemailFile): Promise<boolean> {
  /**
   * ЗАМОК — ПЕРВЫМ ДЕЙСТВИЕМ, ДО СКАЧИВАНИЯ И ДО ИИ.
   *
   * Проход крона длится дольше своего интервала (расшифровка минутного сообщения —
   * десятки секунд), и второй проход видит тот же файл ещё необработанным. Уникальный
   * `file` делает попытку однократной: проигравший получает P2002 и уходит молча.
   */
  const claimId = await claimVoicemail(vm);
  if (!claimId) return false;

  let audio: Buffer;
  try {
    audio = await fetchVoicemail(config, vm.name);
  } catch (err) {
    /**
     * ФАЙЛ БОЛЬШЕ ПОТОЛКА — ЗАМОК ОСТАВЛЯЕМ ЗАНЯТЫМ, и это единственное исключение
     * из правила ниже. Такой файл не похудеет: сняв замок, мы бы качали его заново
     * каждые две минуты и писали ту же строку в журнал до скончания века. Одна
     * запись в журнал — и сообщение больше не трогаем; человек при этом не потерян,
     * пропущенным звонком занимается notifyMissed.
     */
    if (err instanceof VoicemailTooLargeError) {
      void logSystemError(
        "telephony",
        `Сообщение автоответчика ${vm.name} не обработано: ${describeError(err)}. ` +
          `Похоже на сбой записи на станции — файл нужно послушать вручную.`, { dedupKey: "Сообщение автоответчика … не обработано: …. Похоже на сбой записи на станции — файл нужно послушать вручную." }
      );
      // Замок остаётся занятым НАВСЕГДА, значит это тоже конец работы: без отметки
      // проход счёл бы его брошенным и качал бы файл заново каждые десять минут.
      await markVoicemailDone(claimId);
      return false;
    }
    /**
     * Файл не скачался — снимаем замок, чтобы следующий проход попробовал снова.
     * Оставить его занятым значит потерять сообщение навсегда из-за одной моргнувшей
     * сети, а платного здесь ещё ничего не произошло — повтор бесплатен.
     */
    await prisma.voicemailMessage.delete({ where: { id: claimId } }).catch(() => {});
    console.warn(`[автоответчик] ${vm.name} не скачано: ${describeError(err)}`);
    return false;
  }

  /**
   * КЛИЕНТ БРОСИЛ ТРУБКУ НА ПРИВЕТСТВИИ — сообщения нет, файл почти пустой.
   * Секунда телефонного wav ≈ 16 КБ; всё, что короче половины секунды, — это
   * щелчок отбоя, а не речь. Помечаем обработанным БЕЗ карточки и пуша: будить
   * агентов «сообщением», в котором тишина, значит приучить их не открывать
   * настоящие. Сам пропущенный звонок при этом никуда не делся — им занимается
   * notifyMissed: задача перезвонить и пуш ответственному агенту.
   */
  if (audio.length < 8_000) {
    console.log(`[автоответчик] ${vm.name}: пустая запись (${audio.length} байт), пропущено`);
    await markVoicemailDone(claimId);
    return true;
  }

  const settings = await loadIncomingSettings();

  // Карточка: существующая по номеру или новая — ровно как у входящего звонка,
  // которого никто не разобрал. Автосоздание уважает тот же выключатель.
  const anonymous = !vm.phone;
  let existing = anonymous ? null : await findClientByPhoneDigits(vm.phone);
  /**
   * НОМЕР ИЗ КОРЗИНЫ: СНАЧАЛА ИЩЕМ ЖИВУЮ КАРТОЧКУ (23.09.2026, разбор раздачи,
   * пункт 22). Точное совпадение по главному номеру находит карточку в Корзине
   * раньше, чем живую, у которой этот номер запасной, — так выглядит дубль после
   * объединения: номер дубля переехал к основной карточке (пункт 17). Сообщение
   * должно лечь к живой.
   */
  if (existing?.deletedAt) {
    const [live] = await findPhoneOwners([vm.phone], { limit: 1 });
    if (live) existing = { id: live.id, phone: live.phone, whatsappPhone: live.whatsappPhone, deletedAt: null };
  }
  /**
   * findClientByPhoneDigits НАМЕРЕННО видит и Корзину (includeDeleted:true,
   * lib/whatsappPhone.ts) — решение оставлено вызывающему. Соседний путь
   * входящего звонка это решение уже принимает (incomingCalls.ts:496:
   * `const known = match && !match.deletedAt ? match : null`); здесь его не
   * было (27.08.2026), и сообщение с автоответчика ложилось в удалённую
   * карточку — задача «Перезвонить» пропадала из всех списков (list dел,
   * календарь, вечерняя сводка — все фильтруют по TASK_WHERE, а оно требует
   * живого клиента).
   */
  const known = existing && !existing.deletedAt ? existing : null;
  let client: { id: string; shortId: number; fullName: string; assignedAgentId: string | null } | null = known
    ? await prisma.client.findUnique({
        where: { id: known.id },
        select: { id: true, shortId: true, fullName: true, assignedAgentId: true },
      })
    : null;
  let created = false;

  // Расшифровка — тем же конвейером, что голосовые и разговоры. Отказ не роняет
  // обработку: сообщение ценно и без текста, человек его послушает в карточке.
  // Перевод здесь ОСТАЁТСЯ автоматическим (в отличие от полных звонков, см.
  // callRecordings.ts, 19.08.2026): голосовое на автоответчике короткое (пара
  // предложений, не получасовой разговор), а transcriptRu — не просто удобство
  // чтения, а сам текст уведомления агенту (push/заметка) ниже.
  let transcript: string | null = null;
  let transcriptRu: string | null = null;
  try {
    transcript = await transcribeAudio(audio, vm.name, "audio/wav");
    if (transcript) transcriptRu = await translateTranscript(transcript);
  } catch (err) {
    // Отказ поставщика уже записан в журнал внутри transcribeAudio — второй
    // одинаковой записи не делаем, чтобы не превращать журнал в шум.
    console.warn(`[автоответчик] ${vm.name} не расшифровано: ${describeError(err)}`);
  }

  /**
   * ЗАПАСНОЙ НОМЕР, ПРОДИКТОВАННЫЙ НА АВТООТВЕТЧИКЕ, МАСКИРУЕТСЯ ТАК ЖЕ, КАК В
   * ОБЫЧНОМ ЗВОНКЕ (24.09.2026, тот же приём, что callRecordings.ts:1130-1159 —
   * lib/telephony/callPhoneMasking.ts). До этой правки расшифровка автоответчика
   * уходила в Interaction.transcript/transcriptRu и в текст пуша открытым текстом:
   * человек мог продиктовать запасную симку прямо в сообщении, и она оседала в БД
   * мимо контролируемого поля Client.extraPhones — тот самый обход CRM, который
   * для полного звонка уже закрыт. Маскируем ДО того, как текст ляжет в карточку
   * или push, а не после: окно между записью и маскировкой — это окно, где сырой
   * номер уже лежит открытым.
   *
   * ОСНОВНОЙ номер (vm.phone, из которого и заведётся/уже заведена карточка) не
   * трогаем — он и так открыт через саму карточку, маскировать его в расшифровке
   * бессмысленно. Запасные номера уже существующей карточки (extraPhones) тоже не
   * маскируем — их читает то же лицо, что и Client.extraPhones в самой карточке.
   */
  const knownForMasking: KnownClientPhones = {
    phone: vm.phone,
    whatsappPhone: known?.whatsappPhone ?? null,
    extraPhones: known
      ? (await prisma.client.findUnique({ where: { id: known.id }, select: { extraPhones: true } }))?.extraPhones ?? []
      : [],
  };
  const mentionedPhonesEncrypted: string[] = [];
  const scrubForVoicemail = (text: string | null): string | null => {
    if (!text) return text;
    try {
      const scrubbed = scrubMentionedPhones(text, knownForMasking);
      mentionedPhonesEncrypted.push(...scrubbed.mentionedPhonesEncrypted);
      return scrubbed.text;
    } catch (err) {
      void logSystemError(
        "telephony",
        `Маскировка запасных номеров в сообщении автоответчика ${vm.name} не выполнена: ${describeError(err)}`, { dedupKey: "Маскировка запасных номеров в сообщении автоответчика … не выполнена: …" }
      );
      return text;
    }
  };
  transcript = scrubForVoicemail(transcript);
  transcriptRu = scrubForVoicemail(transcriptRu);

  /**
   * КАРТОЧКА — ТОЛЬКО ПОД РАСШИФРОВАННОЕ СООБЩЕНИЕ (30.08.2026).
   *
   * Раньше карточка заводилась ДО расшифровки, и в базе оседали пустышки «Входящий
   * +992…» по сообщениям на 13-26 секунд, в которых не разобрано ни слова: ни имени,
   * ни запроса, ни даже текста, который можно прочитать. Разобрать их не может ни
   * автоматика (ей нечего читать), ни человек (в списке клиентов он видит только
   * номер) — это мусор, который живёт в базе вечно и мешает искать настоящих людей.
   *
   * Само СООБЩЕНИЕ при этом не теряется: файл привязывается к звонку в журнале
   * входящих (linkIncomingCall ниже), звонок остаётся на странице «Звонки» без
   * разбора, запись можно послушать, а пуш руководству отправляет notify(needsHuman).
   * Пропущенным звонком отдельно занимается notifyMissed.
   *
   * Имя здесь ещё неоткуда взять: его достаёт разбор расшифровки
   * (autoLeadFromIncomingCall ниже), то есть «есть расшифровка» и есть то самое
   * условие «расшифровка либо имя».
   */
  const staffMatch = !client && !anonymous ? await findStaffPhone([vm.phone]) : null;
  if (anonymous) {
    // Скрытый номер — карточку заводить не на что: сообщение остаётся на звонке в
    // «Без разбора», руководство получает пуш «не разобрано» (notify ниже).
    void logSystemError(
      "telephony",
      `Сообщение автоответчика ${vm.name} со скрытого номера — карточка не заведена, звонок в «Без разбора»: послушайте запись.`,
      { dedupKey: "voicemail-anonymous" }
    );
  } else if (staffMatch) {
    // Номер сотрудника — карточку под сообщение автоответчика не заводим (см.
    // lib/staffPhoneGuard.ts). Запись звонка не теряется: linkIncomingCall
    // ниже привязывает её без client.id, как и у нерасшифрованных сообщений.
    void logSystemError("telephony", `Сообщение автоответчика ${vm.name}: ${staffPhoneError(staffMatch)}`, { dedupKey: "Сообщение автоответчика …: …" });
  } else if (!client && existing?.deletedAt) {
    /**
     * КАРТОЧКА ЭТОГО НОМЕРА В КОРЗИНЕ — НОВУЮ НЕ ЗАВОДИМ (23.09.2026, пункт 22).
     * Раньше здесь шло создание карточки с тем же номером: уникальный индекс
     * ронял всю обработку уже ПОСЛЕ оплаченной расшифровки, замок оставался
     * занятым, и сообщение терялось навсегда — ни звонка в «Без разбора», ни
     * пуша. Оживлять удалённую карточку автоматике не нам решать (то же правило,
     * что у разбора звонка, qualifyIncoming.ts::createClientForCall): сообщение
     * остаётся на звонке, руководство получает пуш «не разобрано» и решает само.
     */
    void logSystemError(
      "telephony",
      `Сообщение автоответчика ${vm.name} (${maskClientPhone(vm.phone)}): карточка этого номера в Корзине — ` +
        `новую не заводим. Звонок остался в «Без разбора»: послушайте запись и решите, восстанавливать ли карточку.`, { dedupKey: "Сообщение автоответчика … (…): карточка этого номера в Корзине — новую не заводим. Звонок остался в «Без разбо…" }
    );
  } else if (!client && settings.autoCreateClient) {
    if (transcript && transcript.trim().length >= MIN_TRANSCRIPT_FOR_CLIENT) {
      client = await createVoicemailClient(vm, settings.defaultKind);
      created = client != null;
    } else {
      void logSystemError(
        "telephony",
        `Сообщение автоответчика ${vm.name} (${maskClientPhone(vm.phone)}) без расшифровки — карточка не заведена. ` +
          `Звонок остался в списке «Без разбора»: послушайте запись.`, { dedupKey: "Сообщение автоответчика … (…) без расшифровки — карточка не заведена. Звонок остался в списке «Без разбора»: п…" }
      );
    }
  }

  const call = await linkIncomingCall(vm, client?.id ?? null);

  /**
   * Задача «перезвонить» в этой CRM — это nextAction на записи хронологии (та же
   * механика, что у недозвона, см. noAnswerStreak): запись попадает в «задачи на
   * сегодня», и её видно в карточке. Отдельной сущности задач здесь нет намеренно.
   *
   * ЗАПИСЬ ОДНА НА ЗВОНОК. У пропущенного звонка запись уже завёл finishIncomingCall
   * («до оператора не дозвонился»), и вторая строка про тот же звонок читалась бы
   * как два разных обращения. Поэтому существующую ДОПОЛНЯЕМ расшифровкой, а новую
   * заводим только если звонка в журнале не нашлось.
   */
  const notes = transcriptRu
    ? `Сообщение на автоответчике: ${transcriptRu.slice(0, 500)}`
    : "Сообщение на автоответчике (расшифровка недоступна — послушайте запись)";
  const nextAction = "Перезвонить: клиент оставил сообщение на автоответчике";
  const nextActionDate = new Date();

  let interactionId: string | null = null;
  // Запись в хронологию упала: расшифровка и перевод в карточку не легли (CHANNEL-NEW-34).
  let persistFailed = false;
  if (client) {
    try {
      // Дедуп (21.09.2026, lib/autoTasks.ts): если у клиента уже открыта задача
      // «перезвонить» (любого из видов «перезвонить», в т.ч. с прошлого
      // автоответчика), эту запись звонка/сообщения дополняем расшифровкой, но
      // БЕЗ второй задачи — claimAutoTaskSlot продлит существующую.
      const slot = await claimAutoTaskSlot(client.id, "voicemail_callback", nextAction, nextActionDate);
      const taskFields = slot.assignToNewRecord
        ? { nextAction, nextActionDate, autoTaskKind: "voicemail_callback" as const }
        : {};
      // Один зашифрованный номер на уникальный хвост — тот же приём, что в
      // scrubMentionedPhones (transcript и transcriptRu могут назвать один и тот
      // же запасной номер дважды, шифровать его дважды незачем).
      const dedupedMentionedPhones = [...new Set(mentionedPhonesEncrypted)];
      // Запись звонка, который брал консультант, — его разговор (расшифровка, запись
      // в R2): сообщение автоответчика ложится РЯДОМ отдельной записью, а не поверх.
      if (call?.interactionId && !call.answeredByConsultant) {
        await prisma.interaction.update({
          where: { id: call.interactionId },
          data: {
            notes,
            transcript,
            transcriptRu,
            recordingUrl: `${VOICEMAIL_DIR}/${vm.name}`,
            ...(dedupedMentionedPhones.length ? { mentionedPhonesEncrypted: dedupedMentionedPhones } : {}),
            ...taskFields,
          },
        });
        interactionId = call.interactionId;
      } else if (
        (interactionId =
          (
            await prisma.interaction.findFirst({
              where: { clientId: client.id, recordingUrl: `${VOICEMAIL_DIR}/${vm.name}` },
              select: { id: true },
            })
          )?.id ?? null)
      ) {
        // ПРОШЛЫЙ ПРОХОД УМЕР ПОСЛЕ ЗАПИСИ В ХРОНОЛОГИЮ (перехват замка, 03.10.2026):
        // запись этого сообщения уже есть — вторую не заводим.
      } else {
        // SYSTEM всегда — сообщение никто не поднимал (П-10, 17.09.2026);
        // задача «перезвонить» попадает в список дел ответственного агента
        // через subjectAgentId, владение карточкой не значит, что именно он
        // слушал автоответчик.
        const interaction = await logTimeline({
          clientId: client.id,
          actor: {
            kind: "system",
            source: "voicemail",
            subjectAgentId: client.assignedAgentId ?? null,
            // Без агента — задача руководства, общая по замыслу (см. incomingCalls.ts).
            ...(client.assignedAgentId ? {} : { sharedTask: true as const }),
          },
          type: "CALL",
          notes,
          transcript,
          transcriptRu,
          mentionedPhonesEncrypted: dedupedMentionedPhones,
          recordingUrl: `${VOICEMAIL_DIR}/${vm.name}`,
          createdAt: vm.recordedAt,
          ...taskFields,
        });
        interactionId = interaction.id;
      }
    } catch (err) {
      persistFailed = true;
      void logSystemError("telephony", `Сообщение автоответчика не попало в хронологию: ${describeError(err)}`, { dedupKey: "Сообщение автоответчика не попало в хронологию: …" });
    }
    // Голосовое продавца на автоответчике — такой же источник фактов объекта, как звонок.
    if (interactionId && transcript) scheduleSellerFactsRefresh(client.id);
  }

  // Сообщение «разобрано» только если доехало до хронологии: иначе отметка ниже
  // навсегда исключила бы его из повторов (выборка исключает processedAt), а платная
  // расшифровка и перевод пропали бы. Бросаем: замок остаётся брошенным и подхватится
  // проходом через STALE_CLAIM_MS, не более MAX_CLAIM_ATTEMPTS раз (processVoicemail
  // вызывается в try цикла ingestVoicemails, отказ уже пишется в журнал).
  if (persistFailed) throw new Error("запись сообщения в хронологию не удалась — повторим на следующем проходе");

  /**
   * Связи — одной транзакцией: звонок без ссылки на запись хронологии автоматика
   * разберёт «по пустому месту» (расшифровку она читает именно через неё), а
   * сообщение без ссылки на карточку невозможно найти из карточки. Порознь эти две
   * записи означают тихую потерю атомарности ровно в том месте, где цена ошибки —
   * неразобранный лид.
   */
  await prisma.$transaction([
    prisma.voicemailMessage.update({
      where: { id: claimId },
      // `processedAt` — отметка о КОНЦЕ работы, а не о её начале: по ней проход
      // отличает разобранное сообщение от брошенного замка (см. claimVoicemail).
      data: { clientId: client?.id ?? null, interactionId, processedAt: new Date() },
    }),
    ...(call && interactionId && !call.interactionId
      ? [prisma.incomingCall.update({ where: { id: call.id }, data: { interactionId } })]
      : []),
  ]);

  /**
   * РАЗБОР И РАЗДАЧА — ОБЩИЕ С ОТВЕЧЕННЫМ ЗВОНКОМ. Здесь решается всё: кем оказался
   * позвонивший, заводить ли лида, кому он достанется. Клиент со своим агентом
   * получит исход `known_client` и в раздачу не уйдёт; нераспознанное сообщение —
   * `no_data`, и звонок останется в «Только без разбора» на странице «Звонки»,
   * где человек послушает запись сам.
   */
  // Скрытый номер в раздачу не уходит: карточку для лида завести не на что.
  const outcome = call && !anonymous ? await autoLeadFromIncomingCall(call.id) : null;

  await notify({
    vm,
    client,
    transcriptRu,
    // Пуш ответственному — только когда клиент действительно за кем-то закреплён:
    // остальным занимается раздача внутри qualifyIncomingCall, и второй пуш об
    // одном и том же обращении агент читает как два разных.
    assignedAgentId: outcome?.status === "known_client" ? (client?.assignedAgentId ?? null) : null,
    needsHuman: outcome?.status === "no_data" || anonymous,
  });

  console.log(
    `[автоответчик] ${vm.name}: карточка ${client ? (created ? "создана" : "найдена") : "не заведена"}, ` +
      `расшифровка ${transcript ? "есть" : "нет"}, исход ${outcome?.status ?? "звонка нет в журнале"}`
  );
  return true;
}

/**
 * Звонок в журнале, к которому относится это сообщение.
 *
 * СНАЧАЛА ИЩЕМ УЖЕ ЗАПИСАННЫЙ: сообщение оставляют после того, как станция позвонила
 * агентам и никто не взял, — такой звонок CRM уже видела через ARI и завела ему
 * строку. Привязаться к ней, а не завести свою, важно ради счётчиков: иначе один
 * непринятый звонок считался бы дважды.
 *
 * НЕ НАШЛИ — ЗАВОДИМ. Туннель до станции мог лежать в момент звонка, ARI мог
 * промолчать, CRM могла перезапускаться. Сообщение при этом существует, значит
 * звонок был; потерять из-за этого лида нельзя. `channelId` собирается из имени
 * файла и уникален — повторный проход второй строки не создаст.
 */
async function linkIncomingCall(
  vm: VoicemailFile,
  clientId: string | null
): Promise<{ id: string; interactionId: string | null; answeredByConsultant: boolean } | null> {
  /**
   * УЖЕ ПРИВЯЗАН ПРОШЛЫМ ПРОХОДОМ (03.10.2026). Проход, умерший после привязки, но
   * до отметки о конце, оставлял звонок с voicemailFile — и перехват замка его не
   * находил (условие voicemailFile: null) и заводил второй звонок `voicemail:…`.
   */
  const already = await prisma.incomingCall.findFirst({
    where: { voicemailFile: vm.name },
    select: { id: true, interactionId: true, answeredByConsultant: true },
  });
  if (already) {
    if (clientId) await prisma.incomingCall.update({ where: { id: already.id }, data: { clientId } });
    return already;
  }

  // Скрытый номер не сводим ни с чьим звонком: сверять не по чему.
  const found = !vm.phone ? null : await prisma.incomingCall.findFirst({
    where: {
      phone: vm.phone,
      /**
       * ЗВОНОК, КОТОРЫЙ ВЗЯЛ РОБОТ И ОТДАЛ АВТООТВЕТЧИКУ (03.10.2026), — тоже
       * «тот самый»: консультант снял трубку, разговор не сложился (сбой, тишина,
       * линия занята на возврате от агента), станция увела человека на
       * автоответчик. С одним answered:false такое сообщение заводило ВТОРОЙ
       * звонок — двойные лиды, задачи и пуши об одном обращении.
       */
      OR: [{ answered: false }, { answeredByConsultant: true }],
      voicemailFile: null,
      startedAt: { gte: new Date(vm.recordedAt.getTime() - CALL_MATCH_WINDOW_MS), lte: vm.recordedAt },
    },
    orderBy: { startedAt: "desc" },
    select: { id: true, interactionId: true, answeredByConsultant: true },
  });

  if (found) {
    await prisma.incomingCall.update({
      where: { id: found.id },
      data: { voicemailFile: vm.name, ...(clientId ? { clientId } : {}) },
    });
    return found;
  }

  try {
    const created = await prisma.incomingCall.create({
      data: {
        channelId: `voicemail:${vm.name}`,
        phone: vm.phone,
        startedAt: vm.recordedAt,
        endedAt: vm.recordedAt,
        answered: false,
        clientId,
        autoCreatedClient: !!clientId,
        voicemailFile: vm.name,
      },
      select: { id: true, interactionId: true, answeredByConsultant: true },
    });
    return created;
  } catch (err) {
    void logSystemError("telephony", `Звонок под сообщение автоответчика не заведён: ${describeError(err)}`, { dedupKey: "Звонок под сообщение автоответчика не заведён: …" });
    return null;
  }
}

/**
 * СОБСТВЕННОГО ЧЕЛОВЕКА-АВТОРА У СООБЩЕНИЯ НА АВТООТВЕТЧИКЕ НЕТ (П-10, 17.09.2026,
 * docs/audit/lead-ownership-17-09.md §2). Сообщение никто не поднимал — ни
 * ответственный агент (владение карточкой — не то же самое, что «услышал
 * сообщение»), ни `incomingOperatorIds()` (первая линия приёма — получатель
 * уведомлений, а не тот, кто физически что-то сделал — до этой правки оба использовались как agent-автор, что и
 * есть тот самый директорский/операторский фолбэк, который П-10 запрещает).
 * Запись пишется как SYSTEM всегда (вызывающий код), держатель карточки —
 * через subjectAgentId.
 */

/**
 * Кого будить. Сообщение на автоответчике по смыслу и есть пропущенный звонок,
 * только с объяснением, чего человек хотел, — без уведомления оно повисело бы
 * в хронологии никем не читанное до утра.
 *
 * ДВА АДРЕСАТА, И ОНИ НЕ ПЕРЕСЕКАЮТСЯ. Клиента, которого ведёт агент, будим агента:
 * это его работа, и в общую раздачу такой клиент не уходит. Нераспознанное сообщение
 * — руководству: его никто не разобрал, и без пуша оно ждало бы, пока кто-нибудь
 * заглянет в «Без разбора». Разобранное сообщение незнакомого человека не будит
 * никого: пуш «примите заявку» уже отправила раздача, и второй об одном и том же
 * обращении агент читает как два разных.
 */
async function notify(input: {
  vm: VoicemailFile;
  client: { id: string; shortId: number; fullName: string } | null;
  transcriptRu: string | null;
  assignedAgentId: string | null;
  needsHuman: boolean;
}): Promise<void> {
  const { vm, client, transcriptRu } = input;
  const who = vm.phone || "Скрытый номер";
  const body = transcriptRu
    ? `${who}: ${transcriptRu.slice(0, 120)}`
    : `${who} оставил сообщение — послушайте в карточке`;
  const url = client ? `/clients/${client.shortId}` : "/calls";

  try {
    if (input.assignedAgentId) {
      await sendPushToAgent(input.assignedAgentId, {
        title: "💬 Ваш клиент оставил сообщение",
        body,
        url,
        tag: `voicemail-${vm.name}`,
      });
      return;
    }
    if (input.needsHuman) {
      // Часы алармов (владелец 07.09.2026): сообщение уже сохранено и лежит в
      // «Без разбора» — откладывается только пуш о нём.
      await enqueueDirectorAlert({
        title: "💬 Сообщение на автоответчике не разобрано",
        body,
        url: "/calls",
        tag: `voicemail-${vm.name}`,
        recipientPermission: "calls.transcripts",
      });
    }
  } catch (err) {
    // Уведомление — не условие обработки: сообщение уже в карточке и в разборе.
    console.warn(`[автоответчик] уведомление по ${vm.name} не ушло: ${describeError(err)}`);
  }
}
