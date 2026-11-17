import { prisma } from "../../db.js";
import { LIVE_VOICE_INBOUND_WAIT_SECONDS } from "@royal-home/shared";
import { logSystemError } from "../systemError.js";
import { amiDbGet, amiDbPut, loadAmiCredentials, type AmiCredentials } from "./amiClient.js";
import { configuredRtpHost } from "./liveVoiceRtpConfig.js";

/**
 * Что станция делает со звонком, которого никто не взял, — настраивается из CRM.
 *
 * ЗАЧЕМ. Очередь 1000 живёт с `joinempty=yes`, `leavewhenempty=no` и без Fail Over:
 * клиент попадает в неё, даже когда все операторы офлайн (а вечером офлайн ВСЕ), и
 * не выходит оттуда никогда — слушает музыку, пока не бросит трубку. Для агентства
 * это потерянный клиент, о котором никто не узнает. Правило висело нерешённым с
 * 11.08.2026, потому что «куда уводить» — вопрос владельца, а не программиста.
 *
 * ПОЧЕМУ ЗНАЧЕНИЯ, А НЕ КОНФИГУРАЦИЯ. CRM НЕ переписывает настройки FreePBX. На
 * станции один раз описан запасной путь, который на каждом звонке читает три
 * значения из внутренней базы Asterisk (AstDB, семейство ROYALHOME/failover), а CRM
 * эти значения кладёт. Разница принципиальная: ошибка в значении меняет номер
 * дежурного, ошибка в конфигурации кладёт телефонию агентства. К тому же правка
 * конфигурации требует `reload`, а значение действует со следующего звонка.
 *
 * ПОЧЕМУ РЕШЕНИЕ ИСПОЛНЯЕТ СТАНЦИЯ, А НЕ CRM. Запасной путь обязан работать именно
 * тогда, когда CRM недоступна: упал контейнер, оборвался туннель, идёт выкат. Если
 * бы переадресацию делала CRM, она отказала бы ровно в тот момент, ради которого
 * задумана.
 */

/** Семейство в AstDB. Меняется только вместе с диалпланом станции. */
export const FAILOVER_FAMILY = "ROYALHOME/failover";

export interface FailoverConfig {
  /** none | forward | voicemail | both — см. Settings.incomingNoAnswerAction. */
  action: string;
  seconds: number;
  /** Девять местных цифр — в этом виде станция и набирает. Пусто — номера нет. */
  phone: string;
  /** Ночной режим: вне рабочих часов очередь пропускается вовсе. */
  nightAction: string;
  nightStart: string;
  nightEnd: string;
  /**
   * Внутренний номер, которому звонок идёт ВМЕСТО очереди операторов. Пусто —
   * звонит очередь, как было. Диалплан различает режимы только по этому значению:
   * отдельного «переключателя» на станции нет намеренно, иначе появилось бы
   * состояние, в котором режим включён, а номера нет, — и звонок уходил бы в тишину.
   */
  target: string;
  /**
   * Консультант на телефоне вместо автоответчика (24.09.2026, робозвонок, правка 5):
   * "" — не берёт (прежнее поведение станции), "no_answer" — днём после оператора и
   * вне рабочих часов сразу, "always" — первым. Пусто всегда, когда живой голос
   * выключен или CRM не может его поднять (нет адреса RTP): станция, отправившая
   * звонок консультанту, которого нет, получила бы отказ и ушла бы на автоответчик,
   * но только после ожидания, — честнее не звать вовсе.
   */
  aiMode: string;
  /** Сколько секунд днём звонит оператор, прежде чем трубку возьмёт консультант. */
  aiSeconds: number;
  /** Рабочие часы ("HH:MM", Settings.workHoursStart/End): вне их консультант берёт сразу. */
  aiDayStart: string;
  aiDayEnd: string;
}

/** Режим консультанта, как его понимает станция. Отдельно — ради теста без базы. */
export function consultantStationMode(input: {
  enabled: boolean | null | undefined;
  mode: string | null | undefined;
  rtpHost: string | null | undefined;
}): string {
  if (!input.enabled || !input.rtpHost?.trim()) return "";
  return input.mode === "no_answer" || input.mode === "always" ? input.mode : "";
}

/**
 * ГОТОВНОСТЬ КОНСУЛЬТАНТА НА ВХОДЯЩИХ (28.09.2026, разбор «выбрал в Настройках
 * консультанта, а трубку берёт автоответчик»).
 *
 * `consultantStationMode` выше молча отдаёт станции пустой режим, если в окружении
 * сервера нет LIVE_VOICE_RTP_HOST: без адреса звук консультанта до станции не
 * дойдёт. Решение верное, но молчаливое — в Настройках при этом стоит «Если
 * оператор не взял», и владелец не может узнать, почему выбор не действует.
 * Этот признак отдаётся экрану (GET /settings → liveVoiceInbound) и журналу:
 * `wanted` — что выбрал владелец, `rtpHostConfigured` — может ли сервер это
 * исполнить, `stationMode` — что на самом деле уедет на станцию.
 */
export interface ConsultantInboundReadiness {
  wanted: boolean;
  rtpHostConfigured: boolean;
  stationMode: string;
}

export function consultantInboundReadiness(input: {
  enabled: boolean | null | undefined;
  mode: string | null | undefined;
  rtpHost: string | null | undefined;
}): ConsultantInboundReadiness {
  return {
    wanted: !!input.enabled && (input.mode === "no_answer" || input.mode === "always"),
    rtpHostConfigured: !!input.rtpHost?.trim(),
    stationMode: consultantStationMode(input),
  };
}

/** Ключ дедупликации журнала: одна запись на один и тот же пробел в настройке сервера,
 *  а не по записи на каждое сохранение формы и каждую сверку. */
export const CONSULTANT_NO_RTP_HOST_DEDUP = "live-voice-inbound-no-rtp-host";

/**
 * Номер дежурного в том виде, в каком его наберёт транк: девять цифр без кода
 * страны. В CRM номера хранятся международными (`+992930001001`) — ровно та же
 * причина, по которой существует normalizeDialNumber в ariClient.ts. Ошибка здесь
 * проявилась бы не отказом, а тишиной в трубке: маршрут пропускает любой набор.
 */
export function localDialDigits(raw: string | null | undefined): string {
  const digits = (raw ?? "").replace(/\D/g, "");
  if (digits.length === 12 && digits.startsWith("992")) return digits.slice(3);
  if (digits.length === 10 && digits.startsWith("0")) return digits.slice(1);
  return digits;
}

/**
 * Внутренний номер аппарата в том виде, в каком его понимает станция: только цифры.
 *
 * Всё остальное отбрасывается целиком, а не «очищается»: значение уходит прямо в
 * диалплан (`DB(DEVICE/<номер>/dial)`), и мусор в нём — это не кривой набор, а
 * подстановка чужого выражения в набор станции.
 */
export function internalExtensionDigits(raw: string | null | undefined): string {
  // Пробелы и дефисы человек набирает по привычке — их убираем. Всё остальное
  // означает, что перед нами не внутренний номер, и значение отбрасывается целиком.
  const cleaned = (raw ?? "").trim().replace(/[\s-]/g, "");
  return /^\d{2,8}$/.test(cleaned) ? cleaned : "";
}

/**
 * Настройка «если оператор не ответил» в том виде, в каком её понимает станция.
 *
 * Режим, требующий номера, без номера превращается в «ничего не делать»: диалплан,
 * которому велено звонить в никуда, оставит клиента слушать гудки вместо музыки —
 * то есть станет хуже, чем было. Сообщать об этом человеку должна форма в
 * Настройках, а не звонок в три часа ночи.
 */
export async function loadFailoverConfig(): Promise<FailoverConfig> {
  const settings = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: {
      incomingNoAnswerAction: true,
      incomingNoAnswerSeconds: true,
      incomingForwardPhone: true,
      incomingNightAction: true,
      incomingNightStart: true,
      incomingNightEnd: true,
      incomingPrimaryTarget: true,
      incomingPrimaryExtension: true,
      liveVoiceEnabled: true,
      liveVoiceInboundMode: true,
      workHoursStart: true,
      workHoursEnd: true,
    },
  });
  const phone = localDialDigits(settings?.incomingForwardPhone);
  const requested = settings?.incomingNoAnswerAction ?? "none";
  const action = (requested === "forward" || requested === "both") && !phone ? "none" : requested;
  // Тот же принцип и у ночного правила: «дежурному» без номера дежурного — это
  // «ничего», а сказать об этом человеку должна форма, не ночной звонок в никуда.
  const nightRequested = settings?.incomingNightAction ?? "none";
  const nightAction = nightRequested === "forward" && !phone ? "none" : nightRequested;
  // Режим «прямо на аппарат» без номера аппарата — это «звонить некуда». Возвращаемся
  // к очереди: молчащая трубка у клиента хуже, чем оператор, которого сняли с приёма.
  const target =
    settings?.incomingPrimaryTarget === "extension"
      ? internalExtensionDigits(settings?.incomingPrimaryExtension)
      : "";
  const consultant = consultantInboundReadiness({
    enabled: settings?.liveVoiceEnabled,
    mode: settings?.liveVoiceInboundMode,
    rtpHost: configuredRtpHost(),
  });
  // Владелец выбрал консультанта, а сервер не может его поднять: станция получит
  // пустой режим и будет вести звонки по-старому (автоответчик). Раньше это было
  // молча — теперь запись в журнале (раз в сутки по ключу) и предупреждение на экране.
  if (consultant.wanted && !consultant.rtpHostConfigured) {
    void logSystemError(
      "telephony",
      "Консультант на входящих выбран в Настройках (Бот → Живой голос), но на сервере не заданы LIVE_VOICE_RTP_HOST и LIVE_VOICE_RTP_PORT — " +
        "станция не зовёт консультанта, звонки идут по-старому на автоответчик. Нужны адрес и порт звука в .env сервера.",
      { dedupKey: CONSULTANT_NO_RTP_HOST_DEDUP, dedupWindowMs: 24 * 60 * 60 * 1000 }
    ).catch(() => {});
  }
  return {
    action,
    seconds: settings?.incomingNoAnswerSeconds ?? 20,
    phone,
    nightAction,
    nightStart: settings?.incomingNightStart ?? "21:00",
    nightEnd: settings?.incomingNightEnd ?? "09:00",
    target,
    aiMode: consultant.stationMode,
    // Константа с 01.11.2026 (packages/shared), колонка не читается.
    aiSeconds: LIVE_VOICE_INBOUND_WAIT_SECONDS,
    aiDayStart: settings?.workHoursStart ?? "09:30",
    aiDayEnd: settings?.workHoursEnd ?? "18:00",
  };
}

/**
 * Переложить настройку в станцию. Возвращает причину отказа, а не бросает: вызывается
 * и из сохранения настроек (там причину видит человек), и из фоновой сверки.
 */
export async function syncFailoverToStation(
  creds?: AmiCredentials | null
): Promise<{ ok: true; config: FailoverConfig } | { ok: false; error: string }> {
  const credentials = creds ?? (await loadAmiCredentials());
  if (!credentials) return { ok: false, error: "Управление станцией не настроено (Настройки → Каналы связи → AMI)" };

  const config = await loadFailoverConfig();
  const entries: [string, string][] = [
    ["action", config.action],
    ["seconds", String(config.seconds)],
    ["phone", config.phone],
    ["nightaction", config.nightAction],
    ["nightstart", config.nightStart],
    ["nightend", config.nightEnd],
    ["target", config.target],
    ["aimode", config.aiMode],
    ["aiseconds", String(config.aiSeconds)],
    ["aidaystart", config.aiDayStart],
    ["aidayend", config.aiDayEnd],
  ];
  for (const [key, value] of entries) {
    const result = await amiDbPut(credentials, FAILOVER_FAMILY, key, value);
    if (!result.ok) return { ok: false, error: result.error };
  }
  return { ok: true, config };
}

/**
 * Что станция считает действующим прямо сейчас — для экрана телефонии.
 *
 * Отдельный вопрос от «что сохранено в CRM», и разница между ответами и есть
 * полезный сигнал: настройка не доехала до станции (туннель лежал в момент
 * сохранения), и правило, которое владелец считает включённым, не работает.
 */
export async function readFailoverFromStation(
  creds?: AmiCredentials | null
): Promise<{ ok: true; config: FailoverConfig } | { ok: false; error: string }> {
  const credentials = creds ?? (await loadAmiCredentials());
  if (!credentials) return { ok: false, error: "Управление станцией не настроено" };

  const [action, seconds, phone] = await Promise.all([
    amiDbGet(credentials, FAILOVER_FAMILY, "action"),
    amiDbGet(credentials, FAILOVER_FAMILY, "seconds"),
    amiDbGet(credentials, FAILOVER_FAMILY, "phone"),
  ]);
  const [nightAction, nightStart, nightEnd, target] = await Promise.all([
    amiDbGet(credentials, FAILOVER_FAMILY, "nightaction"),
    amiDbGet(credentials, FAILOVER_FAMILY, "nightstart"),
    amiDbGet(credentials, FAILOVER_FAMILY, "nightend"),
    amiDbGet(credentials, FAILOVER_FAMILY, "target"),
  ]);
  const [aiMode, aiSeconds, aiDayStart, aiDayEnd] = await Promise.all([
    amiDbGet(credentials, FAILOVER_FAMILY, "aimode"),
    amiDbGet(credentials, FAILOVER_FAMILY, "aiseconds"),
    amiDbGet(credentials, FAILOVER_FAMILY, "aidaystart"),
    amiDbGet(credentials, FAILOVER_FAMILY, "aidayend"),
  ]);
  const failed = [action, seconds, phone, nightAction, nightStart, nightEnd, target, aiMode, aiSeconds, aiDayStart, aiDayEnd].find(
    (r) => !r.ok
  );
  if (failed && !failed.ok) return { ok: false, error: failed.error };

  return {
    ok: true,
    config: {
      // Пусто в базе станции = запасного пути нет. Это честное «ничего не делаем»,
      // а не отсутствие ответа: ключ появляется только после первой синхронизации.
      action: (action.ok && action.value) || "none",
      seconds: Number((seconds.ok && seconds.value) || 0) || 20,
      phone: (phone.ok && phone.value) || "",
      nightAction: (nightAction.ok && nightAction.value) || "none",
      nightStart: (nightStart.ok && nightStart.value) || "",
      nightEnd: (nightEnd.ok && nightEnd.value) || "",
      // Пусто = звонит очередь операторов. Ключа может не быть вовсе (станция
      // работала до появления этой настройки) — это то же самое «звонит очередь».
      target: (target.ok && target.value) || "",
      // Пусто = консультант не берёт; ключей нет вовсе на станции, которую
      // синхронизировали до 24.09.2026, — то же самое.
      aiMode: (aiMode.ok && aiMode.value) || "",
      aiSeconds: Number((aiSeconds.ok && aiSeconds.value) || 0) || 30,
      aiDayStart: (aiDayStart.ok && aiDayStart.value) || "",
      aiDayEnd: (aiDayEnd.ok && aiDayEnd.value) || "",
    },
  };
}

/** Расходятся ли настройки CRM и станции. Отдельной функцией — чтобы проверялась тестом без сети. */
export function failoverDiffers(a: FailoverConfig, b: FailoverConfig): boolean {
  return (
    a.action !== b.action ||
    a.seconds !== b.seconds ||
    a.phone !== b.phone ||
    a.nightAction !== b.nightAction ||
    a.nightStart !== b.nightStart ||
    a.nightEnd !== b.nightEnd ||
    a.target !== b.target ||
    a.aiMode !== b.aiMode ||
    a.aiSeconds !== b.aiSeconds ||
    a.aiDayStart !== b.aiDayStart ||
    a.aiDayEnd !== b.aiDayEnd
  );
}

/**
 * Дозапись настроек в станцию ПРИ ВОССТАНОВЛЕНИИ СВЯЗИ (вызывается из ariEvents,
 * когда открылась подписка на события).
 *
 * ЗАЧЕМ. Синхронизация раньше происходила только в момент сохранения формы. Если
 * станция в этот момент офлайн — правило оставалось в базе CRM и не применялось
 * никогда, молча: владелец уверен, что звонки уводятся, а они не уводятся.
 * Ровно это и случилось 15.08.2026, когда в офисе пропала связь.
 *
 * ПОЧЕМУ НЕ ПО РАСПИСАНИЮ. Опрашивать станцию каждые несколько минут незачем:
 * настройки меняются раз в месяц, а запросы шли бы круглосуточно (замечание
 * владельца). Восстановление связи — точный момент, когда сверка нужна и когда
 * она бесплатна: в обычной жизни этого события просто нет.
 *
 * Это же чинит перезагрузку самой АТС: её внутренняя база (AstDB) могла потерять
 * значения, а CRM об этом иначе не узнала бы вовсе.
 */
export async function reconcileFailoverOnReconnect(): Promise<void> {
  try {
    const credentials = await loadAmiCredentials();
    if (!credentials) return; // управление станцией не настроено — сверять нечего

    const desired = await loadFailoverConfig();
    const actual = await readFailoverFromStation(credentials);

    // Станция не ответила — пишем вслепую: пустая база станции выглядит так же.
    if (!actual.ok) {
      const written = await syncFailoverToStation(credentials);
      if (!written.ok) {
        console.warn(`[телефония] настройки в станцию не записались: ${written.error}`);
        // Как в syncFailoverInBackground: молчим при `none` — уводить и так
        // некуда, «не доехало» тут значит лишь то, что желаемое поведение и
        // так уже действует.
        if (desired.action !== "none" || desired.aiMode) {
          void logSystemError("telephony", `Правило «если оператор не ответил» не доехало до станции: ${written.error}`);
        }
      }
      return;
    }

    if (!failoverDiffers(desired, actual.config)) return;

    const written = await syncFailoverToStation(credentials);
    console.log(
      written.ok
        ? `[телефония] настройки станции разошлись с CRM и дописаны: ${desired.action}/${desired.seconds}с, ночь ${desired.nightAction}`
        : `[телефония] настройки станции разошлись с CRM, записать не удалось: ${written.error}`
    );
    if (!written.ok && (desired.action !== "none" || desired.aiMode)) {
      void logSystemError("telephony", `Правило «если оператор не ответил» разошлось со станцией и не дописалось: ${written.error}`);
    }
  } catch (err) {
    // Сверка не должна мешать подписке на события: связь только что появилась,
    // и уронить её из-за настройки было бы хуже самой рассинхронизации.
    console.error("[телефония] сверка настроек не удалась:", err instanceof Error ? err.message : err);
    void logSystemError("telephony", `Сверка настроек «если оператор не ответил» со станцией не удалась: ${err instanceof Error ? err.message : err}`);
  }
}

/**
 * Синхронизация «вдогонку» — из сохранения настроек. Ничего не ждёт и не ломает
 * сохранение: настройка уже в базе CRM, а до станции она доедет либо сейчас, либо
 * следующей попыткой. Отказ обязан попасть в журнал: молчаливо неприменённое
 * правило — это ровно тот случай, когда владелец уверен, что звонки уводятся, а
 * они не уводятся.
 */
export function syncFailoverInBackground(): void {
  void (async () => {
    /**
     * ЖУРНАЛ ОШИБОК — ТОЛЬКО КОГДА ЕСТЬ ЧТО ТЕРЯТЬ.
     *
     * Управление станцией настраивают не в первый день: пока логина AMI нет,
     * каждое сохранение номера дежурного писало бы директору в утреннюю сводку
     * «правило не доехало» — про правило, которого он ещё не включал. Ровно этот
     * шум уже вычищали из телефонии 12.08.2026, второй раз заводить его не нужно.
     *
     * Молчим и когда правило `none`: уводить некуда, и «не доехало» означает лишь
     * то, что станция осталась при прежнем поведении — а оно и есть желаемое.
     */
    const creds = await loadAmiCredentials();
    if (!creds) return;
    const result = await syncFailoverToStation(creds);
    if (result.ok) return;
    const config = await loadFailoverConfig();
    if (config.action === "none" && !config.aiMode) {
      console.warn(`[телефония] правило очереди не записалось (действует «ничего не делать»): ${result.error}`);
      return;
    }
    void logSystemError("telephony", `Правило «если оператор не ответил» не доехало до станции: ${result.error}`);
  })();
}
