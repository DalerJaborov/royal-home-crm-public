import { telephonyOptionTitle, type TelephonyOptionField } from "@royal-home/shared";
import { prisma } from "../../db.js";
import { amiActionRetrying, type AmiCredentials } from "./amiClient.js";
import { ROUTE_DIALPLAN_FILE } from "./dialplanContext.js";
import { consultantStationMode, internalExtensionDigits, localDialDigits } from "./failoverSync.js";
import { configuredRtpHost } from "./liveVoiceRtpConfig.js";

/**
 * ЭТАЛОН РАБОЧЕЙ ТЕЛЕФОНИИ — И СТОРОЖ, КОТОРЫЙ ЗАМЕЧАЕТ ЛЮБОЙ ОТХОД ОТ НЕГО.
 *
 * Просьба владельца 21.09.2026, дословно: «если всё работает — сделай так,
 * чтобы никто больше не трогал эти настройки».
 *
 * ЗАЧЕМ ОТДЕЛЬНЫЙ СТОРОЖ, КОГДА ЕСТЬ stationHealth. Тот отвечает на вопрос
 * «станция жива и отвечает». Этот — на другой: «настройка осталась той, при
 * которой звонки доходили». Разница не теоретическая. С 21.08 по 19.09.2026
 * входящие не доходили НИ ОДИН РАЗ тридцать дней подряд, и всё это время
 * станция была совершенно жива: ARI отвечал, диалплан грузился, транк принимал
 * звонки. Сломана была ОДНА настройка — приём был переведён на аппарат, у
 * которого строку набора чужой эксперимент заменил на несуществующие
 * PJSIP-плечи. Ни одна проверка «живости» такого не видит по определению.
 *
 * ПОЧЕМУ СТОРОЖ, А НЕ ЗАПРЕТ. Сделать значения неизменяемыми — значит однажды
 * заблокировать самого владельца, когда настройку надо будет поменять по делу
 * (сменился оператор приёма, сменился номер). Поэтому здесь не замок, а
 * свидетель: изменить можно, изменить ТИХО — нельзя. Отход от эталона попадает
 * в журнал именем поля, прежним значением и новым, а дальше решает человек:
 * вернуть настройку или обновить эталон в коде вместе с объяснением, зачем.
 *
 * КАЖДАЯ СТРОКА ЭТАЛОНА — СЛЕД РЕАЛЬНОЙ ПОТЕРИ ЗВОНКОВ, а не вкусовщина. Ниже
 * у каждой написано, что именно ломалось, когда значение было другим. Поле, не
 * имеющее такой истории, сюда добавлять не надо: сторож, который стережёт всё,
 * скоро начнёт кричать о безобидном, и его выключат вместе с полезным.
 */

export interface BaselineRule {
  /** Поле настроек или признак — как его назвать человеку в журнале. */
  name: string;
  /** Чем это значение заслужило охрану: что ломалось, когда было иначе. */
  why: string;
  /** Как читается живое значение. */
  actual: string;
  /** Каким оно должно быть. */
  expected: string;
  ok: boolean;
  /** Поле настроек с вариантами: значения в сообщении подписываются общим словарём (packages/shared/src/telephonyOptions.ts). */
  field?: TelephonyOptionField;
  /** Единица измерения числового значения для сообщения («с»). */
  unit?: string;
}

/** Ожидаемая настройка CRM. Меняется ТОЛЬКО вместе с решением владельца и
 *  объяснением в комментарии — иначе сторож теряет смысл. */
const EXPECTED = {
  /**
   * Приём ведёт ОФИСНЫЙ АППАРАТ 2020, а не очередь операторов.
   *
   * До 23.11.2026 здесь стояло «очередь»: прямой аппарат стоил тридцати дней
   * тишины (21.08-19.09.2026) — приём был переведён на 1003, а строку набора
   * этого аппарата чужой эксперимент заменил на два PJSIP-плеча без контакта;
   * Dial падал мгновенно, запасное действие было «ничего не делать».
   *
   * Решение владельца 18.11.2026 (docs/JOURNAL.md): незнакомые звонки — только на
   * офисный аппарат 2020. Решение 23.11.2026: «звонки должны 10 секунд идти на
   * 2020, если не отвечают — сразу директору». Сторож, оставшийся на «очереди»,
   * кричал «сломан» на рабочую схему (ложная тревога, снята 23.11.2026).
   * Урок 1003 не забыт, а закрыт иначе: аппарат обязан быть именно 2020, без
   * ответа звонок обязан уходить директору (правило ниже), а выключенный в
   * рабочее время аппарат ловит officeDeskPhoneWatch.ts.
   */
  incomingPrimaryTarget: "extension",
  /** Какой аппарат принимает (решение владельца 18.11.2026, подтверждено 23.11.2026). */
  incomingPrimaryExtension: "2020",
  /**
   * Известный клиент уходит своему агенту напрямую.
   *
   * Выключенный флаг означает «все звонки оператору» — прямо противоположное
   * решению владельца 21.09.2026: «свои клиенты звонят агентам прямо, чужих
   * обслуживаю я».
   */
  incomingRouteToAssignedAgent: true,
  /**
   * Агенту звоним на мобильный, не на настольный аппарат.
   *
   * Настольных трубок в агентстве нет ни у кого с 18.08.2026 — `sip show
   * registry` отдаёт ноль регистраций. Режим «extension» отправил бы каждый
   * перевод в несуществующую трубку.
   */
  asteriskAgentDialMode: "mobile",
  /**
   * Сколько звонит аппарат приёма, прежде чем звонок уйдёт директору.
   *
   * История: 21.09.2026 — две минуты; 24.09.2026 — 40 секунд (неотвеченный вызов
   * держит сеть звонящего, две минуты она не держит). Решение владельца
   * 23.11.2026: 10 секунд на аппарате 2020, дальше сразу директору — директор
   * отвечает быстрее, чем клиент успевает бросить трубку.
   */
  incomingNoAnswerSeconds: 10,
  /**
   * Незнакомый номер идёт оператору, а не агенту.
   *
   * Решение владельца 20.09.2026 (docs/JOURNAL.md, «Решения»): «незнакомый
   * входящий номер — только оператору; агенты общие входящие не принимают».
   * Режимы «kpi_queue» (любому свободному агенту по KPI) и «dedicated_operator»
   * (дежурному по календарю) живы в коде и включаются одной кнопкой в
   * Настройках → Каналы связи, где подписаны «уже работают»; при них
   * kpiQueueRouting.ts / dutyRosterRouting.ts уводят канал из очереди
   * оператора агенту. Добавлено ночной проверкой 24.09.2026 (К2-З1): до этого
   * переключение проходило тихо — сторож поле не сверял.
   */
  incomingRoutingMode: "assigned_then_forward",
} as const;

/**
 * Строки диалплана, которыми держится «один звонок одному человеку».
 *
 * Стережём не весь файл, а ровно механизм: правки в соседних контекстах —
 * обычная работа, а исчезновение ЭТИХ строк возвращает гонку, из-за которой
 * оператор перехватывал чужих клиентов (замер 20.09.2026 — три раза за день,
 * один разговор 80 секунд). Сравнение по всему файлу давало бы тревогу на любую
 * невинную правку, и сторож был бы выключен на второй день.
 */
const REQUIRED_DIALPLAN_LINES = [
  "RH_CRM_VERDICT",
  // тик ожидания вердикта: с 24.09.2026 Wait(1), канал до ответа человека не отвечается
  "Wait(1)",
];

function rule(name: string, why: string, expected: string, actual: string, extra: Pick<BaselineRule, "field" | "unit"> = {}): BaselineRule {
  return { name, why, expected, actual, ok: expected === actual, ...extra };
}

/** Поля настроек, которые читает сторож. Отдельным типом — чтобы сверку можно было проверить без базы. */
export interface BaselineSettings {
  incomingPrimaryTarget: string | null;
  incomingPrimaryExtension: string | null;
  incomingRouteToAssignedAgent: boolean;
  asteriskAgentDialMode: string | null;
  incomingNoAnswerAction: string | null;
  incomingNoAnswerSeconds: number;
  incomingRoutingMode: string | null;
  incomingForwardPhone: string | null;
}

/** Что, кроме самих настроек, нужно сверке «не ответили — директору». */
export interface BaselineContext {
  /** Телефоны действующих директоров (как записаны в карточках сотрудников). */
  directorPhones: string[];
  /**
   * Режим консультанта, который РЕАЛЬНО уедет на станцию (consultantStationMode в failoverSync.ts).
   * Непусто — диалплан отдаёт неотвеченный звонок роботу, а не директору.
   */
  consultantStationMode: string;
}

/** Действия «если не ответили», при которых станция звонит на номер переадресации (extensions_custom.conf, метка forward). */
const FORWARDING_ACTIONS = new Set(["forward", "both"]);

/**
 * Сверка настроек с эталоном — чистая функция, без базы и станции (ради теста).
 * Номера читаются тем же разбором, что применяет failoverSync.ts (internalExtensionDigits,
 * localDialDigits): сверяем то, что реально получит станция, а не сырую строку формы.
 */
export function evaluateSettingsBaseline(s: BaselineSettings, ctx: BaselineContext): BaselineRule[] {
  const rules: BaselineRule[] = [
    rule(
      "Куда идёт входящий",
      "решение владельца 18.11.2026 и 23.11.2026: незнакомый звонок сначала звонит офисному аппарату 2020; " +
        "операторов в очереди нет, и звонок, отправленный в очередь, никто не примет",
      EXPECTED.incomingPrimaryTarget,
      s.incomingPrimaryTarget ?? "",
      { field: "incomingPrimaryTarget" }
    ),
  ];
  if (s.incomingPrimaryTarget === EXPECTED.incomingPrimaryTarget) {
    // Мусор в поле failoverSync отбрасывает целиком, и станция молча возвращается к
    // очереди — поэтому сверяем уже разобранное значение, а не строку формы.
    rules.push(
      rule(
        "Аппарат приёма",
        "решение владельца 18.11.2026: принимает офисный аппарат 2020; другой номер или пустое поле уводят звонки не туда",
        EXPECTED.incomingPrimaryExtension,
        internalExtensionDigits(s.incomingPrimaryExtension) || "не задан"
      )
    );
  }
  rules.push(
    rule(
      "Известный клиент — своему агенту",
      "если выключено, все звонки идут оператору, а владелец решил 21.09.2026, что знакомый клиент звонит своему агенту",
      String(EXPECTED.incomingRouteToAssignedAgent),
      String(s.incomingRouteToAssignedAgent)
    ),
    rule(
      "Чем звонить агенту",
      "настольных телефонов нет ни у кого с 18.08.2026, а звонок на стол уходит в пустоту",
      EXPECTED.asteriskAgentDialMode,
      s.asteriskAgentDialMode ?? "",
      { field: "asteriskAgentDialMode" }
    ),
    rule(
      "Сколько звонит аппарат приёма",
      "решение владельца 23.11.2026: 10 секунд звонит аппарат 2020, не ответили — сразу директору",
      String(EXPECTED.incomingNoAnswerSeconds),
      String(s.incomingNoAnswerSeconds),
      { unit: "с" }
    ),
    // Пустая строка в колонке читается как умолчание (incomingSettings.ts:
    // `|| "assigned_then_forward"`) — сверяем то, что реально применит станция.
    rule(
      "Незнакомый звонок — оператору",
      "Незнакомые звонки должны идти оператору (решение 20.09.2026); другие режимы отправляют их агенту мимо очереди",
      EXPECTED.incomingRoutingMode,
      s.incomingRoutingMode || EXPECTED.incomingRoutingMode,
      { field: "incomingRoutingMode" }
    )
  );

  // Правило проверяет только «задано ли хоть что-то»: годится и автоответчик, и
  // переадресация дежурному, и «none». С 03.10.2026 в диалплане `none` — осознанный
  // выбор владельца «звонить без предела, пока не снимут» (extensions_custom.conf,
  // RH_DWAIT), а не обрыв в тишине. Тревога — только на пустое значение: пустая
  // колонка не говорит станции ничего, и выбор остаётся за случайным умолчанием.
  const action = s.incomingNoAnswerAction ?? "";
  rules.push({
    name: "Что делать, если не ответили",
    why:
      "если ничего не выбрано, станция не знает, что делать с неотвеченным звонком (так было в простой 21.08-19.09.2026); " +
      "вариант «звонить без предела, пока не снимут» выбран владельцем 03.10.2026 и тревогой не считается",
    expected: "любой вариант, в том числе «Ничего не делать»",
    actual: action === "" ? "не задано" : action,
    ok: action !== "",
    field: "incomingNoAnswerAction",
  });

  // НЕ ОТВЕТИЛИ НА АППАРАТЕ — ДИРЕКТОРУ (решение владельца 23.11.2026). Эта половина
  // схемы и закрывает урок 1003 (21.08-19.09.2026): аппарат выключен или его не сняли —
  // звонок всё равно доходит до человека. Ломается она тихо, и каждый способ сверяется
  // так, как его увидит станция:
  //  - действие не «переадресация» — директору никто не звонит;
  //  - номер пустой — failoverSync без номера молча ставит станции «ничего»;
  //  - номер не директора — звонок уходит другому человеку;
  //  - робот на входящих: при непустом aimode диалплан ставит RH_ACTION=ai, ждёт
  //    aiseconds вместо 10 с и отдаёт звонок роботу, а не директору.
  const forwardDigits = localDialDigits(s.incomingForwardPhone);
  const directorDigits = new Set(ctx.directorPhones.map((p) => localDialDigits(p)).filter((d) => d.length === 9));
  const forwardActual = !FORWARDING_ACTIONS.has(action)
    ? "не переадресуется (выбрано другое действие)"
    : forwardDigits.length !== 9
      ? "номер для переадресации не задан"
      : !directorDigits.has(forwardDigits)
        ? "номер для переадресации не директора"
        : ctx.consultantStationMode
          ? "трубку берёт робот, а не директор"
          : "директору";
  rules.push(
    rule(
      "Не ответили на аппарате — директору",
      "решение владельца 23.11.2026: не ответили на 2020 за 10 секунд — звонок сразу уходит директору",
      "директору",
      forwardActual
    )
  );

  return rules;
}

/** Сверка настроек CRM с эталоном. Станцию не трогает — только свою базу. */
export async function checkSettingsBaseline(): Promise<BaselineRule[]> {
  const s = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: {
      incomingPrimaryTarget: true,
      incomingPrimaryExtension: true,
      incomingRouteToAssignedAgent: true,
      asteriskAgentDialMode: true,
      incomingNoAnswerAction: true,
      incomingNoAnswerSeconds: true,
      incomingRoutingMode: true,
      incomingForwardPhone: true,
      liveVoiceEnabled: true,
      liveVoiceInboundMode: true,
    },
  });
  if (!s) return [];
  const directors = await prisma.agent.findMany({
    where: { role: "DIRECTOR", isActive: true, frozenAt: null },
    select: { phone: true },
  });
  return evaluateSettingsBaseline(s, {
    directorPhones: directors.map((d) => d.phone ?? "").filter(Boolean),
    consultantStationMode: consultantStationMode({
      enabled: s.liveVoiceEnabled,
      mode: s.liveVoiceInboundMode,
      rtpHost: configuredRtpHost(),
    }),
  });
}

/**
 * Есть ли хоть один оператор приёма.
 *
 * Отдельно от списка полей: признак живёт на сотруднике, а не в настройках, и
 * снимается обычным редактированием карточки. Ноль операторов — это молча
 * опустевшая очередь станции через пятнадцать минут (сверка состава,
 * agentIncomingReadiness.ts), то есть незнакомый клиент не дозванивается
 * никому, а в интерфейсе всё выглядит настроенным.
 */
export async function checkOperatorsBaseline(): Promise<BaselineRule> {
  const count = await prisma.agent.count({
    where: { takesUnknownCalls: true, isActive: true, frozenAt: null, sipExtension: { not: null } },
  });
  return {
    name: "Операторы приёма",
    why: "если операторов нет, очередь пустеет за 15 минут, и незнакомый звонящий не дозвонится никому",
    expected: "хотя бы один",
    actual: `${count}`,
    ok: count > 0,
  };
}

/**
 * Нужны ли операторы очереди при текущей схеме приёма.
 *
 * С 18.11.2026 (подтверждено владельцем 23.11.2026) незнакомый звонок звонит
 * аппарату 2020, а не очереди: ноль операторов при этой схеме — норма, и тревога
 * «операторов нет» была ложной (снята 23.11.2026). Если приём вернули в очередь,
 * правило снова действует: тогда пустая очередь — та же тишина, что и раньше.
 * Отдельной функцией — ради теста без базы.
 */
export function operatorsMatter(settingsRules: BaselineRule[]): boolean {
  const target = settingsRules.find((r) => r.name === "Куда идёт входящий");
  return !target || target.actual !== "extension";
}

/**
 * На месте ли на станции механизм «один звонок одному человеку».
 *
 * Читаем тот же файл тем же действием, что и проверка контекстов
 * (`GetConfig`) — новых прав AMI не требуется. Станция не ответила — молчим:
 * о недоступной станции говорит своя проверка, и второй голос об одном событии
 * читался бы как две разные поломки.
 */
export async function checkDialplanBaseline(creds: AmiCredentials): Promise<BaselineRule | null> {
  const result = await amiActionRetrying(creds, "GetConfig", { Filename: ROUTE_DIALPLAN_FILE }, { timeoutMs: 3_000 });
  if (!result.ok) return null;
  const text = result.packets
    .flatMap((p) => Object.entries(p).filter(([k]) => /^line-\d+-\d+$/.test(k)).map(([, v]) => v))
    .join("\n");
  const missing = REQUIRED_DIALPLAN_LINES.filter((line) => !text.includes(line));
  return {
    name: "Ожидание ответа CRM перед звонком оператору",
    why: "без этого звонок уходит оператору по таймеру, и оператор перехватывает чужих клиентов (20.09.2026: три раза за день)",
    expected: "включено",
    actual: missing.length === 0 ? "включено" : "выключено (в схеме звонков пропали нужные строки)",
    ok: missing.length === 0,
  };
}

/**
 * Полная сверка с эталоном. Возвращает ТОЛЬКО отклонения — совпадения никого не
 * интересуют и в журнал не идут.
 */
export async function collectBaselineDrift(creds: AmiCredentials | null): Promise<BaselineRule[]> {
  const settingsRules = await checkSettingsBaseline();
  const rules: BaselineRule[] = [...settingsRules];
  if (operatorsMatter(settingsRules)) rules.push(await checkOperatorsBaseline());
  if (creds) {
    const dialplan = await checkDialplanBaseline(creds);
    if (dialplan) rules.push(dialplan);
  }
  return rules.filter((r) => !r.ok);
}

/** Одна строка на все отклонения — у журнала свой дедуп по тексту, и пять
 *  отдельных сообщений об одной и той же правке он пропустил бы все пять. */
/**
 * Значения настроек словами: в журнале их читает директор, а не разработчик. Названия вариантов берутся из общего словаря
 * `telephonyOptions.ts` по ПОЛЮ (то же значение «extension» в разных полях значит разное), а не придумываются здесь.
 */
function valueWords(d: BaselineRule, v: string): string {
  if (d.field) return telephonyOptionTitle(d.field, v);
  if (v === "true") return "включено";
  if (v === "false") return "выключено";
  return d.unit && /^\d+$/.test(v) ? `${v} ${d.unit}` : v;
}

export function describeDrift(drift: BaselineRule[]): string {
  const items = drift.map((d) => `${d.name}: сейчас «${valueWords(d, d.actual)}», нужно «${valueWords(d, d.expected)}» (${d.why})`);
  return (
    // Текст для человека — без пути к файлу и без имён внутренних режимов (ночная проверка 24.09.2026, №9а;
    // 20.11.2026: «простыми словами»). Совет чинить оставлен разработчику.
    `Настройки телефонии изменились, звонки могут теряться. Что отличается (${drift.length}): ${items.join("; ")}. ` +
    "Если вы поменяли это сами, сообщите разработчику: он закрепит новое значение вместе с причиной. " +
    "Если нет, верните прежнее значение, пока звонки не потерялись."
  );
}
