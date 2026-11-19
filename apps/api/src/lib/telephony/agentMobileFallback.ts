import { prisma } from "../../db.js";
import { logSystemError } from "../systemError.js";
import { amiDbGet, amiDbPut, loadAmiCredentials, type AmiCredentials } from "./amiClient.js";
import { normalizeDialNumber, isDialableTajikNumber, listEndpointsRetrying, loadAriCredentials, type AriEndpoint } from "./ariClient.js";
import { internalExtensionDigits } from "./failoverSync.js";
import { createNotifications, shouldAlert } from "../notifications.js";
import { sendPushToAgents } from "../../push.js";
import { SALES_AGENT_ROLES } from "@royal-home/shared";

/**
 * МОБИЛЬНЫЙ КАК ВТОРОЕ ПЛЕЧО У КАЖДОГО АГЕНТА (04.09.2026).
 *
 * Разбор живого случая: клиент перезвонил на общий номер после пропущенного от
 * своего агента и попал в очередь операторов, где ответить было физически
 * некому — `DEVICE/<номер>/dial` у большинства сотрудников был голым
 * `SIP/<номер>` без единого зарегистрированного аппарата (десктопные софтфоны
 * сняты, все звонки — через CRM). Внутренний номер, на который некому звонить,
 * не отличить снаружи от временно отошедшего человека — но при верном "втором
 * плече" звонок доходит на мобильный тем же путём, что уже работает в
 * `royalhome-agent-route` (Local/<девять цифр>@from-internal, звонок агенту в
 * известный клиент).
 *
 * Почему это не через Follow Me станции: тот путь настраивается ТОЛЬКО руками в
 * админке FreePBX (правки MySQL-таблиц станции у CRM нет — только туннели ARI
 * (8088) и AMI (5038), MySQL порт станции никуда не проброшен). Тот же приём,
 * что у failoverSync.ts/routingModeSync.ts: CRM не переписывает конфигурацию
 * станции, а кладёт значение в её AstDB и следит, чтобы оно оставалось верным —
 * если кто-то на станции перезапишет DEVICE/dial (например, Apply Config в
 * FreePBX по этому расширению), периодический обход вернёт мобильное плечо на
 * место, а не заставит директора вспоминать про ручную правку.
 *
 * ТОЛЬКО role=AGENT — тот же критерий «кто вообще должен принимать общие
 * входящие», что уже использует applyQueuePause в operatorQueue.ts. Директор и
 * админ купили себе отдельный обычный SIP-телефон именно чтобы НЕ попадать в
 * общий приём (решение владельца 04.09.2026, отменяет ручную правку 1001/1003
 * в тот же день) — расширять список ролей сюда нельзя без нового решения
 * владельца.
 *
 * ОДНО ИСКЛЮЧЕНИЕ ИЗ «ТОЛЬКО role=AGENT» (разбор 19.09.2026). Если настройками
 * выбрано «входящий идёт прямо на аппарат» (`Settings.incomingPrimaryTarget =
 * "extension"`), то ВЕСЬ приём агентства заведён на этот один аппарат — и его
 * достижимость больше не вопрос роли владельца. Живой случай: приём стоял на
 * 1003 (директор, роль вне списка), а `DEVICE/1003/dial` содержал только два
 * мёртвых PJSIP-плеча заброшенного эксперимента с браузерными звонками. Dial
 * мгновенно отдавал CHANUNAVAIL, а `incomingNoAnswerAction = none` клал трубку:
 * звонок клиента умирал за ~50 мс, «занято» снаружи и ни следа внутри. Ломалось
 * с 21.08.2026, нашлось 19.09 — месяц входящих с нулевой длительностью.
 *
 * Поэтому аппарат, выбранный приёмом входящих, получает мобильное плечо при
 * любой роли владельца. Это не отменяет решение 04.09: директор не попадает в
 * ОБЩУЮ очередь — но если весь приём направлен лично на него, звонок обязан
 * дойти, а не умереть в тишине.
 *
 * ВТОРОЕ ИСКЛЮЧЕНИЕ — ОПЕРАТОР ПЕРВОЙ ЛИНИИ (20.09.2026). Сотрудник с признаком
 * `takesUnknownCalls` получает мобильное плечо при ЛЮБОЙ роли, и по той же
 * причине: CRM сама дописывает его в очередь входящих на станции
 * (agentIncomingReadiness.ts), очередь звонит на его внутренний номер, а
 * внутренний номер без плеча — это тишина. Настольных аппаратов в агентстве нет
 * вовсе, все принимают на мобильный. Оставить здесь «только role=AGENT» значило
 * бы, что оператором можно назначить человека, до которого звонок физически не
 * доходит, — ровно та поломка 21.08-19.09, только с новым именем.
 */

/** Как CRM набирает мобильный агента — ровно то же самое, что в inboundRouting.ts. */
export function mobileFallbackTarget(mobilePhone: string): string | null {
  if (!isDialableTajikNumber(mobilePhone)) return null;
  return `Local/${normalizeDialNumber(mobilePhone)}@from-internal/n`;
}

/** Плечо, добавленное этой самой синхронизацией — по этому виду отличаем
 *  «наше» мобильное плечо от desktop/браузерных плеч, которые трогать нельзя. */
const OWN_LEG_PATTERN = /^Local\/\d+@from-internal\/n$/;

/**
 * Итоговая строка набора для DEVICE/dial — снимает СТАРОЕ мобильное плечо (если
 * оно было проставлено этой же синхронизацией раньше) и ставит текущее. Без
 * этого смена телефона агента копила бы мёртвые плечи вечно: номер, который
 * когда-то был у сотрудника, а потом достался кому-то ещё, продолжал бы
 * звонить при каждом входящем. Плечи десктопа/браузера (SIP/PJSIP) не трогает
 * никогда — только то, что подходит под OWN_LEG_PATTERN.
 *
 * `null` — писать нечего: мобильный уже стоит верным (или номер ненаборный и своего
 * плеча на станции нет), либо что-то не задано вовсе (extension/mobilePhone пусты —
 * вызывающий уже проверил).
 */
export function buildDialWithMobileFallback(
  currentDial: string | null,
  extension: string,
  mobilePhone: string
): string | null {
  const target = mobileFallbackTarget(mobilePhone);
  const base = currentDial?.trim() ? currentDial.trim() : `SIP/${extension}`;
  const legs = base.split("&").map((s) => s.trim());
  const others = legs.filter((leg) => !OWN_LEG_PATTERN.test(leg));
  // Новый номер ненаборный (зарубежный): СТАРОЕ своё плечо всё равно снимаем (CHANNEL-NEW-18,
  // 04.10.2026), иначе станция продолжала бы звонить прежнему владельцу номера. Если
  // кроме него плеч не осталось — голый SIP/<номер>, как у нового сотрудника.
  const next = target ? [...others, target].join("&") : others.length ? others.join("&") : `SIP/${extension}`;
  return next === base ? null : next;
}

/**
 * Аппарат, на который настройками заведён весь приём входящих, — в том же виде
 * цифр, в каком его кладёт на станцию failoverSync. Пусто — приём идёт очередью
 * операторов, и никакого особого аппарата у него нет.
 *
 * Читается ровно из тех же двух полей и тем же `internalExtensionDigits`, что и
 * в failoverSync: две копии этого разбора разъехались бы молча, и плечо тогда
 * получал бы не тот аппарат, на который станция реально ведёт звонок.
 */
export async function incomingPrimaryExtension(): Promise<string> {
  const settings = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { incomingPrimaryTarget: true, incomingPrimaryExtension: true },
  });
  if (settings?.incomingPrimaryTarget !== "extension") return "";
  return internalExtensionDigits(settings.incomingPrimaryExtension);
}

/**
 * Проставить/поправить мобильное плечо ОДНОМУ агенту. Вызывается сразу при
 * заведении сотрудника и при смене его номера/телефона (routes/agents.ts), а
 * также обходом reconcileAgentMobileFallback — та же пара «сразу + подстраховка
 * по расписанию», что у остальных синхронизаций с станцией в этом каталоге.
 *
 * Никогда не бросает исключение: телефония недоступна — сотрудник всё равно
 * заводится/сохраняется, обход подхватит расхождение позже.
 */
export async function syncAgentMobileFallback(
  agentId: string,
  creds?: AmiCredentials | null
): Promise<"station_unreachable" | void> {
  const agent = await prisma.agent.findUnique({
    where: { id: agentId },
    select: { sipExtension: true, phone: true, role: true, takesUnknownCalls: true },
  });
  if (!agent?.sipExtension) return;
  // Роль решает, нужен ли аппарату мобильный запасной путь, — кроме двух случаев
  // (см. шапку): аппарат, на который заведён весь приём входящих, и оператор
  // первой линии, которого CRM сама ставит в очередь станции.
  if (
    !(SALES_AGENT_ROLES as readonly string[]).includes(agent.role) &&
    !agent.takesUnknownCalls &&
    agent.sipExtension !== (await incomingPrimaryExtension())
  ) {
    return;
  }

  try {
    const credentials = creds ?? (await loadAmiCredentials());
    if (!credentials) return;

    const current = await amiDbGet(credentials, "DEVICE", `${agent.sipExtension}/dial`);
    if (!current.ok) {
      // Один ключ на все аппараты (02.10.2026): станция легла — отказывают ВСЕ
      // семь аппаратов разом, и журнал получал семь строк на одно событие.
      void logSystemError(
        "telephony",
        `Мобильное плечо ${agent.sipExtension}: станция не ответила на чтение DEVICE/dial: ${current.error}`,
        { dedupKey: "agent-mobile-fallback:read" }
      );
      return "station_unreachable";
    }

    const next = buildDialWithMobileFallback(current.value, agent.sipExtension, agent.phone);
    if (!next) return;
    if (!mobileFallbackTarget(agent.phone)) {
      void logSystemError(
        "telephony",
        `Мобильное плечо ${agent.sipExtension}: новый номер агента не набирается через транк — прежнее мобильное плечо снято.`,
        { dedupKey: "agent-mobile-fallback:undialable-removed" }
      );
    }

    const written = await amiDbPut(credentials, "DEVICE", `${agent.sipExtension}/dial`, next);
    if (!written.ok) {
      void logSystemError("telephony", `Мобильное плечо ${agent.sipExtension} не записалось на станцию: ${written.error}`, { dedupKey: "Мобильное плечо … не записалось на станцию: …" });
    }
  } catch (err) {
    void logSystemError(
      "telephony",
      `Синхронизация мобильного плеча ${agent.sipExtension} сорвалась: ${err instanceof Error ? err.message : err}`, { dedupKey: "Синхронизация мобильного плеча … сорвалась: …" }
    );
  }
}

/**
 * Обход всех активных агентов — каждые 15 минут (cron.ts), тот же принцип
 * подстраховки, что у reconcileOperatorQueuePresence: правка станции руками
 * (или Apply Config поверх нужного расширения) может стереть мобильное плечо
 * молча, и без периодической сверки об этом узнали бы только по новой жалобе
 * «клиент не дозвонился».
 */
export async function reconcileAgentMobileFallback(): Promise<void> {
  const creds = await loadAmiCredentials();
  if (!creds) return;
  const primary = await incomingPrimaryExtension();
  const agents = await prisma.agent.findMany({
    where: {
      isActive: true,
      sipExtension: { not: null },
      OR: [
        { role: { in: [...SALES_AGENT_ROLES] } },
        // Оператор первой линии — при любой роли: очередь звонит на его номер.
        { takesUnknownCalls: true },
        ...(primary ? [{ sipExtension: primary }] : []),
      ],
    },
    select: { id: true },
  });
  for (const agent of agents) {
    // Станция не ответила одному — не ответит и остальным: дальше каждый ждал
    // бы свой таймаут, и обход тянулся бы минуту впустую. Следующий обход
    // через 15 минут сверит всех заново.
    if ((await syncAgentMobileFallback(agent.id, creds)) === "station_unreachable") return;
  }
  await warnIfIncomingPrimaryUnreachable(primary);
}

/**
 * Сменили аппарат приёма в Настройках — поставить плечо сразу, не дожидаясь
 * обхода. Пятнадцать минут тишины после сохранения настройки — это пятнадцать
 * минут оборванных звонков, а человек в этот момент как раз смотрит, заработало
 * ли. Ничего не ждёт и не бросает: отказ станции уже попадает в журнал внутри.
 */
export function syncIncomingPrimaryReachabilityInBackground(): void {
  void reconcileAgentMobileFallback().catch(() => {});
}

/**
 * Есть ли у аппарата приёма мобильный запасной путь: владелец в CRM с номером,
 * который транк наберёт. Одна дверь — её читают и эта проверка, и сторож
 * офисного аппарата (officeDeskPhoneWatch.ts).
 */
export async function incomingPrimaryHasMobileLeg(primary: string): Promise<boolean> {
  const owner = await prisma.agent.findFirst({
    where: { sipExtension: primary, isActive: true },
    select: { phone: true },
  });
  return !!owner && !!mobileFallbackTarget(owner.phone);
}

/**
 * Что делает станция с незнакомым звонком, когда до аппарата приёма не достучаться
 * (ops/asterisk/extensions_custom.conf, блок офисного аппарата): аппарат сразу
 * отвечает «недоступен», дальше очередь операторов и правило «если не ответили» —
 * консультант, дежурный или автоответчик (правило «нет» с 09.10.2026 тоже ведёт на
 * автоответчик). Звонок не обрывается, но человек его не примет.
 */
export const PRIMARY_UNREACHABLE_CALL_PATH =
  "Незнакомые звонки и звонки из WhatsApp сейчас до людей не доходят: станция ведёт их в очередь операторов, " +
  "а затем по правилу «если не ответили» (консультант, дежурный или автоответчик, как задано в Настройках).";

export interface PrimaryReachabilityDeps {
  loadCreds?: typeof loadAriCredentials;
  listEndpoints?: (creds: NonNullable<Awaited<ReturnType<typeof loadAriCredentials>>>) => Promise<AriEndpoint[]>;
}

/**
 * Аппарат приёма заведён, а живого пути до него нет — журнал и директор.
 *
 * Изначальный случай (месяц тишины): станция отвечала CHANUNAVAIL, CRM об этом не
 * знала. Плечо поставить не из чего, если у аппарата нет владельца в CRM (аппарат
 * ресепшена) или у владельца ненаборный номер.
 *
 * ЛОЖНАЯ ТРЕВОГА 18.11.2026 16:44. Решение владельца — незнакомые звонки ТОЛЬКО на
 * офисный аппарат 2020, без владельца и без мобильного плеча. Это законная
 * настройка: аппарат зарегистрирован на станции и сам по себе живое плечо. Прежняя
 * проверка смотрела только на владельца и будила директоров «аппарат недостижим»
 * при работающем телефоне. Теперь станцию спрашивают, есть ли такой аппарат:
 *  - мобильное плечо есть — молчим;
 *  - аппарат есть на станции и на связи — молчим;
 *  - аппарат есть, но не на связи — молчим ЗДЕСЬ: эту тревогу ведёт один хозяин,
 *    officeDeskPhoneWatch.ts (рабочие часы, утренняя отсрочка, две проверки подряд,
 *    автозакрытие, и он же зовёт директора). Иначе выключенный ночью телефон будил
 *    бы директора CRITICAL-пушем каждые сутки, а днём тревог было бы две;
 *  - аппарата на станции НЕТ (опечатка в Настройках, номер удалён) — тревога сразу,
 *    в любое время: это не «выключили трубку», а настройка, которая не работает;
 *  - станция не ответила — молчим: обрыв связи ведёт своя сводная тревога;
 *  - ARI не настроен вовсе — проверить нечем, поведение прежнее (тревога).
 */
export async function warnIfIncomingPrimaryUnreachable(primary: string, deps: PrimaryReachabilityDeps = {}): Promise<void> {
  // Приём ушёл на очередь — прежние тревоги про любой аппарат приёма больше не правда.
  if (!primary) return resolvePrimaryAlarms(null);
  if (await incomingPrimaryHasMobileLeg(primary)) return resolvePrimaryAlarms(primary);
  const owner = await prisma.agent.findFirst({ where: { sipExtension: primary, isActive: true }, select: { id: true } });

  const creds = await (deps.loadCreds ?? loadAriCredentials)();
  let onStation: boolean | null = null;
  if (creds) {
    let endpoints: AriEndpoint[];
    try {
      endpoints = await (deps.listEndpoints ?? listEndpointsRetrying)(creds);
    } catch {
      return;
    }
    // Тот же признак аппарата, что у agentDeviceOnline (софтфон или rh-web-<номер>).
    onStation = endpoints.some((e) => e.resource === primary || e.resource === `rh-web-${primary}`);
    if (onStation) return resolvePrimaryAlarms(primary);
  }

  const reason = owner ? "у владельца аппарата ненаборный номер" : "аппарат ни за кем не закреплён в CRM";
  const where = onStation === false ? "такого аппарата нет на станции" : "проверить аппарат на станции нечем (ARI не настроен)";
  const message =
    `Весь приём входящих заведён на аппарат ${primary}, но ${where}, а мобильного запасного пути нет: ${reason}. ` +
    PRIMARY_UNREACHABLE_CALL_PATH;
  // Одна открытая строка на поломку: обход идёт каждые 15 минут, а дедуп журнала —
  // 10 минут по началу текста, и раньше на проде ложилась новая строка каждый обход.
  if (!(await openPrimaryAlarm(primary))) {
    await logSystemError("telephony", message, { dedupKey: `${PRIMARY_ALARM_PREFIX} ${primary},` });
  }
  await notifyDirectorsAboutUnreachablePrimary(primary, message);
}

/** Начало текста тревоги про аппарат приёма — и нынешней, и прежней («…мобильное плечо ему поставить не из чего»). */
const PRIMARY_ALARM_PREFIX = "Весь приём входящих заведён на аппарат";

/** Запятая после номера обязательна: иначе тревога про 202 гасила бы и тревогу про 2020. */
function primaryAlarmWhere(primary: string | null) {
  return {
    source: "telephony",
    resolvedAt: null,
    message: { startsWith: primary ? `${PRIMARY_ALARM_PREFIX} ${primary},` : PRIMARY_ALARM_PREFIX },
  };
}

async function openPrimaryAlarm(primary: string): Promise<boolean> {
  return (await prisma.errorLog.count({ where: primaryAlarmWhere(primary) })) > 0;
}

/**
 * Условие тревоги больше не выполняется — открытые строки закрываются сами (18.11.2026:
 * на проде висели строки, заведённые ложной тревогой). null — приём не на аппарат:
 * закрыть все тревоги про аппарат приёма. Сбой записи не роняет обход.
 */
async function resolvePrimaryAlarms(primary: string | null): Promise<void> {
  await prisma.errorLog
    .updateMany({ where: primaryAlarmWhere(primary), data: { resolvedAt: new Date() } })
    .catch((err) => console.error("[telephony] тревога аппарата приёма не закрыта:", err instanceof Error ? err.message : err));
}

/**
 * Та же находка — директору в руки, а не только в журнал.
 *
 * Журнал читают при разборе, а настройку меняет человек прямо сейчас и смотрит,
 * заработало ли. «Выбрали аппарат, до которого не дозвониться» он обязан узнать
 * в ту же минуту — иначе это снова месяц тишины, только с записью в журнале.
 *
 * Не чаще раза в сутки на аппарат (shouldAlert) и без оглядки на часы алармов:
 * приём входящих сломан прямо сейчас, это не отчёт к утру. Ничего не бросает —
 * сбой уведомления не должен ронять синхронизацию со станцией.
 */
export async function notifyDirectorsAboutUnreachablePrimary(primary: string, message: string): Promise<void> {
  try {
    const tag = `incoming-primary-unreachable-${primary}`;
    if (!(await shouldAlert(tag, 24 * 60 * 60 * 1000))) return;
    const directorIds = (
      await prisma.agent.findMany({
        where: { role: { in: ["DIRECTOR", "ADMIN"] }, isActive: true },
        select: { id: true },
      })
    ).map((d) => d.id);
    if (directorIds.length === 0) return;
    const payload = {
      kind: "oversight" as const,
      title: "📵 Аппарат приёма входящих недостижим",
      body: message,
      url: "/settings",
      tag,
      level: "CRITICAL" as const,
    };
    // По одному получателю, а не пачкой: createNotifications пишет получателей
    // последовательно и на первой же неудаче (например, руководителя удалили
    // ровно сейчас) бросает всю пачку — остальные не получили бы ничего. Для
    // тревоги про сломанный приём звонков это неприемлемо, а получателей
    // единицы, так что цена — несколько запросов.
    for (const agentId of directorIds) {
      await createNotifications([agentId], payload);
    }
    void sendPushToAgents(directorIds, payload).catch((err) =>
      console.error("[telephony] incoming-primary-unreachable push:", err)
    );
  } catch (err) {
    console.error("[telephony] incoming-primary-unreachable notification:", err);
  }
}
