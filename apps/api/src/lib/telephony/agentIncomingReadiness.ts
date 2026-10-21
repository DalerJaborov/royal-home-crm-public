import { prisma } from "../../db.js";
import { logSystemError } from "../systemError.js";
import { amiQueueAdd, amiQueueRemove, loadAmiCredentials, type AmiCredentials } from "./amiClient.js";
import { readQueueMembers, type QueueMemberRow } from "./operatorQueue.js";

/**
 * НОВЫЙ СОТРУДНИК НЕ ПОЛУЧАЕТ ОБЩИЕ ВХОДЯЩИЕ — и об этом никто не узнаёт
 * (найдено 19.09.2026 по жалобе владельца: «у новых агентов проверь, трубка
 * вроде бы автоматически должна подключаться, но у Сурайё не получается
 * входящие звонки, и Комрона тоже проверь»).
 *
 * ЧТО ПРОИСХОДИЛО ПРИ ЗАВЕДЕНИИ СОТРУДНИКА. CRM делала два шага из трёх: брала
 * свободный внутренний номер из пула (extensionPool.ts) и прописывала мобильное
 * плечо в DEVICE/<номер>/dial, чтобы звонок доходил на мобильный
 * (agentMobileFallback.ts). Третьего шага — записи номера в ОЧЕРЕДЬ входящих —
 * не делал никто: считалось, что состав очереди можно поменять только через AMI
 * `Command`, которого телефония агентства сознательно не даёт (см. шапку
 * amiClient.ts и «СТАВИМ НА ПАУЗУ, А НЕ УБИРАЕМ ИЗ ОЧЕРЕДИ» в operatorQueue.ts).
 * Получалось: номер выдан, в карточке он есть, «трубка на связи» горит зелёным —
 * а общие входящие до человека не доходят вовсе, и единственный способ это
 * узнать — жалоба самого сотрудника через неделю.
 *
 * ЧТО ИЗМЕНИЛОСЬ (та же просьба владельца, 19.09.2026: «чтобы всегда, даже когда
 * новых добавляем, тоже всё сработало в будущем»). Прежний запрет относился к
 * правке КОНФИГУРАЦИИ станции. `QueueAdd` её не трогает: это действие класса
 * `agent`, того самого, которым CRM уже ставит людей на паузу, и добавляет оно
 * ДИНАМИЧЕСКОГО участника. Значит CRM может и обязана доделывать третий шаг
 * сама.
 *
 * ПОЧЕМУ ОДНОГО ДОБАВЛЕНИЯ МАЛО. Динамический участник не переживает перезапуск
 * Asterisk и «Apply Config» в FreePBX. Ровно та же история, что у мобильного
 * плеча, и лечится ровно так же: сверка по расписанию возвращает недостающих на
 * место (reconcileIncomingQueue, cron.ts каждые 15 минут). Без сторожа это было
 * бы хуже молчания — видимость настроенного, которая разваливается от первого
 * нажатия «Apply Config».
 *
 * КУДА ДОБАВЛЯТЬ — СПРАШИВАЕМ У СТАНЦИИ, А НЕ ЗАШИВАЕМ. Номер очереди и форма
 * записи участника (`Local/1001@from-queue/n`) живут в чужой конфигурации и
 * меняются без выката CRM — на таком допущении CRM однажды уже потеряла все
 * входящие (см. isInboundContext). Поэтому очередь и форма берутся с тех
 * сотрудников, что уже в ней числятся: новичок попадает туда же, где его
 * коллеги, и в том же виде. Не из кого вывести — ничего не делаем и говорим об
 * этом; угадывать имя очереди нельзя.
 *
 * КТО ДОЛЖЕН БЫТЬ В ОЧЕРЕДИ — ПЕРЕПИСАНО 20.09.2026 (решение владельца: «когда
 * незнакомый номер звонит впервые, он должен попасть только в очередь на
 * оператора, ни агенту, ни кому больше; агент отвечает только своим клиентам,
 * оператор отвечает всем неизвестным»). Прежний критерий — все `role=AGENT` —
 * ОТМЕНЁН целиком, вместе с решением от 16.08/19.09 о том, что общие входящие
 * положены каждому агенту.
 *
 * Теперь критерий — признак `Agent.takesUnknownCalls`, обязанность, а не роль:
 * оператором человека назначают и снимают, не меняя ему ни прав, ни доступа,
 * поэтому нового значения `Role` для этого не заводилось.
 *
 * ИЗ ЭТОГО СЛЕДУЕТ, ЧТО СВЕРКА ТЕПЕРЬ И УБИРАЕТ. Одного «добавлять недостающих»
 * мало: агенты, записанные в очередь прежним правилом, остались бы там навсегда
 * и продолжали бы получать незнакомые звонки — то самое, что владелец запретил.
 * Убираем ТОЛЬКО своих: участника, чей номер принадлежит известному CRM
 * сотруднику без признака оператора. Участник, которого CRM не знает вовсе
 * (аппарат на ресепшене, внешний колл-центр, подменный номер), не трогается
 * никогда — его мог записать человек по причине, которой CRM не знает.
 */

export interface IncomingReadinessGap {
  agentId: string;
  fullName: string;
  extension: string;
}

export interface IncomingReadinessReport {
  /** Участники очередей, как их видит станция. */
  members: QueueMemberRow[];
  /** Операторы с номером, которых в очередях нет. */
  gaps: IncomingReadinessGap[];
  /** Свои сотрудники в очереди, которые операторами НЕ назначены, — их оттуда убираем. */
  extra: IncomingReadinessGap[];
  /** Оператора не назначили ни одного: состав очереди не трогаем вовсе (см. ниже). */
  noOperatorsAssigned?: boolean;
  /** Станция не ответила: судить о готовности нельзя вовсе. */
  problem?: string;
}

type AgentRow = { id: string; fullName: string; sipExtension: string };

/** Операторы первой линии с внутренним номером — те, кто обязан быть в очереди. */
async function operatorsExpectedInQueue(): Promise<AgentRow[]> {
  const agents = await prisma.agent.findMany({
    where: { takesUnknownCalls: true, isActive: true, frozenAt: null, sipExtension: { not: null } },
    select: { id: true, fullName: true, sipExtension: true },
  });
  return agents as AgentRow[];
}

/**
 * ВСЕ сотрудники с внутренним номером, любой роли и хоть отключённые.
 *
 * Две разные работы, поэтому отдельно от операторов выше:
 *
 * 1. По ним опознаётся сама очередь входящих (pickTargetQueue): операторов может
 *    не быть назначено ни одного, и тогда по ним ничего не вывелось бы — а
 *    очередь нужно знать как раз чтобы убрать из неё лишних.
 * 2. Они же — граница дозволенного при удалении: убрать можно только того, кто
 *    заведён в CRM. Отключённые и замороженные сюда входят намеренно: уволенный
 *    сотрудник тем более не должен принимать незнакомые звонки.
 */
async function agentsWithExtension(): Promise<AgentRow[]> {
  const agents = await prisma.agent.findMany({
    where: { sipExtension: { not: null } },
    select: { id: true, fullName: true, sipExtension: true },
  });
  return agents as AgentRow[];
}

/**
 * Кто из операторов не получает незнакомые звонки и кто получает их зря.
 * Никогда не бросает исключение: экран сотрудников обязан открываться и при
 * мёртвой АТС, просто без этих отметок.
 */
export async function checkIncomingReadiness(creds?: AmiCredentials | null): Promise<IncomingReadinessReport> {
  const empty = { members: [] as QueueMemberRow[], gaps: [], extra: [] };
  const credentials = creds ?? (await loadAmiCredentials());
  if (!credentials) return { ...empty, problem: "Управление станцией не настроено" };

  const read = await readQueueMembers(credentials).catch((err) => ({
    ok: false as const,
    error: err instanceof Error ? err.message : String(err),
  }));
  if (!read.ok) return { ...empty, problem: read.error };

  const inQueue = new Set(read.members.map((m) => m.extension));
  const operators = await operatorsExpectedInQueue();
  const operatorExtensions = new Set(operators.map((a) => a.sipExtension));
  const gaps = operators
    .filter((a) => !inQueue.has(a.sipExtension))
    .map((a) => ({ agentId: a.id, fullName: a.fullName, extension: a.sipExtension }));

  /**
   * НИ ОДНОГО ОПЕРАТОРА НЕ НАЗНАЧЕНО — НЕ ТРОГАЕМ НИЧЕГО.
   *
   * Разница между «операторы назначены, и это не ты» и «операторов нет вовсе»
   * решает судьбу всех входящих агентства. Пустой список — это не требование
   * «очередь должна быть пуста», а признак того, что признак ещё никому не
   * проставили: он появился 20.09.2026 и по умолчанию выключен у всех. Убрать по
   * нему всех из очереди значит оставить агентство совсем без приёма незнакомых
   * звонков — ровно тот исход, от которого CRM тут и защищает. Пока оператора не
   * назначили, состав очереди остаётся как есть, а директор видит просьбу
   * назначить (Настройки → Сотрудники).
   */
  const extra =
    operators.length === 0
      ? []
      : (await agentsWithExtension())
          .filter((a) => inQueue.has(a.sipExtension) && !operatorExtensions.has(a.sipExtension))
          .map((a) => ({ agentId: a.id, fullName: a.fullName, extension: a.sipExtension }));

  return { members: read.members, gaps, extra, noOperatorsAssigned: operators.length === 0 };
}

/**
 * Очередь, в которую дописывать новичка, и образец записи участника.
 *
 * Берём ту очередь, где больше всего ИЗВЕСТНЫХ CRM агентов: на станции кроме
 * очереди входящих могут жить и другие (исходящий обзвон, тестовая), и попасть
 * в чужую хуже, чем не попасть никуда. Свои агенты — единственный признак «это
 * та самая очередь», который у CRM есть без новых настроек.
 *
 * При ничьей — никуда: две очереди с равным числом агентов означают, что мы не
 * знаем ответа, а не что можно выбрать любую.
 */
export function pickTargetQueue(
  members: QueueMemberRow[],
  knownExtensions: Set<string>
): { queue: string; sample: QueueMemberRow } | null {
  const byQueue = new Map<string, { own: number; sample: QueueMemberRow }>();
  for (const m of members) {
    if (!m.queue) continue;
    const entry = byQueue.get(m.queue) ?? { own: 0, sample: m };
    if (knownExtensions.has(m.extension)) {
      entry.own += 1;
      // Образец — обязательно от СВОЕГО агента: форма записи у случайного
      // участника (аппарат на ресепшене, тестовый софтфон) может отличаться.
      entry.sample = m;
    }
    byQueue.set(m.queue, entry);
  }

  const ranked = [...byQueue.entries()].filter(([, v]) => v.own > 0).sort((a, b) => b[1].own - a[1].own);
  if (ranked.length === 0) return null;
  if (ranked.length > 1 && ranked[0][1].own === ranked[1][1].own) return null;
  return { queue: ranked[0][0], sample: ranked[0][1].sample };
}

/**
 * Запись участника для нового номера — по образцу уже работающего.
 *
 * Подставляем номер в ту же форму, в какой в очереди записан коллега:
 * `Local/1001@from-queue/n` + `1007` → `Local/1007@from-queue/n`. Собирать
 * строку самим означало бы зашить в код и контекст (`from-queue`), и суффикс —
 * то есть ровно то, что живёт в конфигурации станции и меняется без нас.
 */
export function memberInterfaceFor(sample: QueueMemberRow, extension: string): string | null {
  if (!/^\d{3,5}$/.test(extension)) return null;
  const next = sample.iface.replace(sample.extension, extension);
  // Замена ничего не изменила — значит номер в образце записан не так, как мы
  // думаем, и подстановка была бы догадкой. Лучше не добавить, чем добавить не то.
  return next === sample.iface || !next.includes(extension) ? null : next;
}

export interface QueueFixResult {
  /** Оператора не назначили ни одного — состав очереди намеренно не трогали. */
  noOperatorsAssigned?: boolean;
  added: { fullName: string; extension: string; queue: string }[];
  /** Кого убрали из очереди: не оператор, а незнакомые звонки получал. */
  removed: { fullName: string; extension: string; queue: string }[];
  /** С кем не вышло и почему — для журнала и для честного ответа директору. */
  failed: { fullName: string; extension: string; error: string }[];
  /** Ничего не делали вовсе: станция молчит, очередь не вывелась, менять нечего. */
  skipped?: string;
}

/**
 * Привести состав очереди входящих к списку операторов: дописать недостающих,
 * убрать своих не-операторов.
 *
 * УДАЛЕНИЕ ОГРАНИЧЕНО ДВАЖДЫ, и оба ограничения существенны. Во-первых, убираем
 * только сотрудников CRM (см. `extra` в checkIncomingReadiness): участник, о
 * котором CRM не знает, мог быть записан руками по причине, которой CRM не
 * знает, и снять его значило бы терять звонки клиентов. Во-вторых, убираем
 * только из той очереди, в которой человек реально числится, — не угадывая имя.
 *
 * Отключённый и замороженный сотрудник по-прежнему перестаёт звонить ещё и
 * паузой (syncAgentQueuePresence): пауза обратима и работает мгновенно, а эта
 * сверка приводит в порядок сам состав.
 */
export async function ensureAgentsInIncomingQueue(creds?: AmiCredentials | null): Promise<QueueFixResult> {
  const credentials = creds ?? (await loadAmiCredentials());
  if (!credentials) return { added: [], removed: [], failed: [], skipped: "Управление станцией не настроено" };

  const report = await checkIncomingReadiness(credentials);
  if (report.problem) return { added: [], removed: [], failed: [], skipped: report.problem };
  // Признак «операторов не назначено» несём дальше и при полном бездействии:
  // именно этот случай обязан дойти до директора, а не утонуть в «делать нечего».
  const unassigned = report.noOperatorsAssigned ? { noOperatorsAssigned: true as const } : {};
  if (report.gaps.length === 0 && report.extra.length === 0) {
    return { added: [], removed: [], failed: [], ...unassigned };
  }

  const added: QueueFixResult["added"] = [];
  const removed: QueueFixResult["removed"] = [];
  const failed: QueueFixResult["failed"] = [];

  // Убираем ПЕРВЫМ делом и не спрашивая очередь-цель: где человек числится, оттуда
  // и снимаем. Порядок важен — если добавление упрётся в неопознанную очередь,
  // лишние всё равно уже не получают незнакомые звонки, а это и есть запрет владельца.
  for (const person of report.extra) {
    for (const member of report.members.filter((m) => m.extension === person.extension && m.queue)) {
      const result = await amiQueueRemove(credentials, member.queue, member.iface);
      if (result.ok) removed.push({ fullName: person.fullName, extension: person.extension, queue: member.queue });
      else failed.push({ fullName: person.fullName, extension: person.extension, error: result.error });
    }
  }

  if (report.gaps.length === 0) return { added, removed, failed, ...unassigned };

  // Очередь опознаём по ВСЕМ своим сотрудникам, а не по операторам: операторов
  // может не быть назначено ни одного, и тогда выводить цель было бы не из кого.
  const known = new Set((await agentsWithExtension()).map((a) => a.sipExtension));
  const target = pickTargetQueue(report.members, known);
  if (!target) {
    return {
      added,
      removed,
      failed,
      ...unassigned,
      skipped:
        "Не удалось определить очередь входящих: в очередях станции нет ни одного сотрудника из CRM, " +
        "по которому можно понять, куда добавлять. Добавьте первого участника в FreePBX руками — дальше CRM подхватит сама.",
    };
  }

  for (const gap of report.gaps) {
    const iface = memberInterfaceFor(target.sample, gap.extension);
    if (!iface) {
      failed.push({ ...gap, error: `не удалось собрать запись участника по образцу «${target.sample.iface}»` });
      continue;
    }
    const result = await amiQueueAdd(credentials, target.queue, iface, { memberName: gap.fullName });
    if (result.ok) added.push({ fullName: gap.fullName, extension: gap.extension, queue: target.queue });
    else failed.push({ fullName: gap.fullName, extension: gap.extension, error: result.error });
  }
  return { added, removed, failed, ...unassigned };
}

/**
 * Обход по расписанию (cron.ts, рядом со сверкой мобильного плеча): привести
 * состав очереди к списку операторов и рассказать, если не вышло.
 *
 * В журнал ошибок — ОДНА строка на всех, а не по строке на сотрудника: у журнала
 * свой дедуп по тексту (systemError.ts), и пять отдельных сообщений про одну и
 * ту же очередь он бы честно пропустил все пять, засорив утреннюю сводку
 * директору ровно тем, от чего она защищает.
 *
 * Успешные добавление и удаление в журнал ошибок не пишем — это не поломка. Оно
 * и так видно: отметки «не получает незнакомые звонки» и «принимает незнакомые
 * звонки, хотя не оператор» на экране Настройки → Сотрудники гаснут сами.
 *
 * Недоступная станция молчит совсем: о том, что АТС не на связи, сообщает своя,
 * отдельная проверка, и второй голос об одном событии читался бы как две разные
 * поломки.
 */
export async function reconcileIncomingQueue(): Promise<void> {
  const result = await ensureAgentsInIncomingQueue();

  if (result.failed.length > 0) {
    const who = result.failed.map((f) => `${f.fullName} (${f.extension}): ${f.error}`).join("; ");
    void logSystemError("telephony", `Не удалось привести состав очереди входящих в порядок — ${who}`);
    return;
  }
  // Оператора не назначили ни одного, а незнакомые звонки кому-то всё же идут:
  // правило владельца от 20.09.2026 не действует, пока признак не проставлен, и
  // узнать об этом можно только здесь — молчание выглядело бы как «всё сделано».
  if (result.noOperatorsAssigned) {
    void logSystemError(
      "telephony",
      "Оператор приёма не назначен ни одному сотруднику: звонки незнакомых номеров идут по-старому. " +
        "Включите «Принимает незнакомые звонки» тем, кто сидит на приёме (Настройки → Сотрудники)."
    );
  }
  // «Некого добавлять» и «станция не на связи» тоже приходят сюда со skipped —
  // но говорить стоит только о том, что требует человека: непонятная очередь.
  if (result.skipped && result.skipped.startsWith("Не удалось определить очередь")) {
    void logSystemError("telephony", result.skipped);
  }
}

/**
 * Что сказать директору о очереди в ответе на ЗАВЕДЕНИЕ сотрудника.
 *
 * Найдено 22.10.2026 по заведению Бехруза Неъматова (1016): ответ говорил
 * «в очередь входящих добавить не удалось (станция не ответила)», хотя станция
 * ответила, а в очередь человек и не должен был попасть. Проверка в маршруте
 * была написана 19.09, когда в очередь шли все агенты, и после правила 20.09
 * («незнакомые звонки — только операторам», `takesUnknownCalls`) не менялась:
 * новичок без признака оператора не попадал в `added`, и это читалось как отказ
 * станции. Каждое заведение агента с номером пугало директора ложной поломкой
 * и слало его в FreePBX добавлять участника, которого по правилу быть не должно.
 *
 * Поэтому ответ выводится из ожидания, а не из факта добавления: не оператор —
 * сказать нечего (сверка при этом всё равно отработала: она ещё и снимает с
 * очереди прежнего владельца номера из пула); оператор — говорим только о
 * настоящей неудаче, с настоящей причиной. «Станция не ответила» — только когда
 * сверка упала целиком (`fix === null`), а не как слово-заглушка на всё.
 */
export function describeNewAgentQueueOutcome(
  agent: { sipExtension: string; takesUnknownCalls: boolean },
  fix: QueueFixResult | null
): string | undefined {
  const failure = fix?.failed.find((f) => f.extension === agent.sipExtension)?.error;
  if (failure) return queueOutcomeNote(agent.sipExtension, failure);
  if (!agent.takesUnknownCalls) return undefined;
  if (!fix) return queueOutcomeNote(agent.sipExtension, "станция не ответила");
  if (fix.skipped) return queueOutcomeNote(agent.sipExtension, fix.skipped);
  // Добавили или уже числился — всё на месте.
  return undefined;
}

function queueOutcomeNote(extension: string, reason: string): string {
  return (
    `Внутренний номер ${extension} выдан, но в очередь входящих на АТС его добавить не удалось (${reason}) — ` +
    `пока общие входящие звонки до сотрудника не дойдут. CRM попробует снова в ближайшие 15 минут; ` +
    `если не поможет — добавьте участника в FreePBX (Applications → Queues).`
  );
}
