import { amiQueuePause, amiQueueStatus, loadAmiCredentials, type AmiCredentials } from "./amiClient.js";
import { prisma } from "../../db.js";
import { logSystemError } from "../systemError.js";

/**
 * «Я на месте» / «Отошёл» — оператор входящих ставит себя в очереди на паузу.
 *
 * ЗАЧЕМ. Пока оператор числится в очереди, станция звонит ему, даже когда он на
 * обеде, в дороге или разбирает предыдущий разговор: клиент слушает гудки те же
 * пятнадцать секунд, а потом попадает в тишину. Снять себя человек мог только через
 * панель FreePBX, куда у него нет доступа, — то есть никак.
 *
 * ОЧЕРЕДЬ И ИНТЕРФЕЙС СПРАШИВАЮТСЯ У СТАНЦИИ, А НЕ ЗАШИТЫ. Сегодня очередь одна
 * (1000), а операторы записаны в неё Local-каналами (`Local/1001@from-queue/n`) —
 * но и номер очереди, и форма записи живут в чужой конфигурации и меняются без
 * выката CRM. Ровно на таком допущении CRM однажды потеряла все входящие звонки
 * (см. isInboundContext). Поэтому состав очередей читается через QueueStatus, и
 * оператор ищется по своему внутреннему номеру.
 */

export interface OperatorMembership {
  queue: string;
  /** Как оператор записан в очереди — то, что понимает QueuePause. */
  iface: string;
  paused: boolean;
}

/**
 * Внутренний номер из того, как оператор записан в очереди:
 * `Local/1001@from-queue/n` → `1001`, `SIP/1001` → `1001`.
 */
export function extensionFromMemberLocation(location: string): string | null {
  const match = /(?:^|\/)(\d{3,5})(?=[@/-]|$)/.exec(location);
  return match?.[1] ?? null;
}

/**
 * В какой очереди и под каким интерфейсом числится этот внутренний номер.
 *
 * null — оператора в очередях нет вовсе: он не оператор, либо его убрали со
 * станции. Это не ошибка связи, и интерфейс должен сказать об этом иначе.
 */
export async function findOperatorMembership(
  creds: AmiCredentials,
  extension: string
): Promise<{ ok: true; membership: OperatorMembership | null } | { ok: false; error: string }> {
  const result = await amiQueueStatus(creds);
  if (!result.ok) return result;

  for (const packet of result.packets) {
    if ((packet.event ?? "").toLowerCase() !== "queuemember") continue;
    const location = packet.location ?? packet.stateinterface ?? "";
    if (extensionFromMemberLocation(location) !== extension) continue;
    return {
      ok: true,
      membership: {
        queue: packet.queue ?? "",
        iface: location,
        // Станция отдаёт признак числом ("1"/"0"); в разных версиях встречается и
        // "true". Считаем паузой всё, что не ноль и не пусто.
        paused: !!packet.paused && packet.paused !== "0" && packet.paused.toLowerCase() !== "false",
      },
    };
  }
  return { ok: true, membership: null };
}

/** Один участник очереди, как его видит станция. */
export interface QueueMemberRow {
  queue: string;
  /** Как он записан (`Local/1001@from-queue/n`) — то, что понимают QueuePause/QueueAdd. */
  iface: string;
  /** Внутренний номер, вынутый из записи выше. */
  extension: string;
}

/**
 * ВСЕ участники ВСЕХ очередей станции — одним запросом QueueStatus.
 *
 * Отдельно от findOperatorMembership (19.09.2026): та спрашивает станцию про
 * ОДНОГО человека, и на списке сотрудников это превращалось бы в один разговор с
 * AMI на каждого. Здесь вопрос другой — «как устроены очереди целиком», и ответ
 * на него один на всех.
 *
 * Отдаём не только номера, но и ОЧЕРЕДЬ с ФОРМОЙ ЗАПИСИ: по ним же вычисляется,
 * куда и в каком виде дописывать нового сотрудника (agentIncomingReadiness.ts).
 * Имя очереди и форма участника живут в чужой конфигурации и меняются без
 * выката CRM — тот же довод, по которому состав очереди здесь спрашивается у
 * станции, а не зашит в код (см. шапку файла).
 *
 * Пустой список и `ok: true` — это «станция ответила, и в очередях нет никого»;
 * отказ связи возвращается через `ok: false`, потому что «не в очереди» и «не
 * знаем» для сотрудника значат совершенно разное.
 */
export async function readQueueMembers(
  creds: AmiCredentials
): Promise<{ ok: true; members: QueueMemberRow[] } | { ok: false; error: string }> {
  const result = await amiQueueStatus(creds);
  if (!result.ok) return result;

  const members: QueueMemberRow[] = [];
  for (const packet of result.packets) {
    if ((packet.event ?? "").toLowerCase() !== "queuemember") continue;
    const iface = packet.location ?? packet.stateinterface ?? "";
    const extension = extensionFromMemberLocation(iface);
    if (!extension) continue;
    members.push({ queue: packet.queue ?? "", iface, extension });
  }
  return { ok: true, members };
}

/**
 * Поставить оператора на паузу или снять. Возвращает состояние ПОСЛЕ изменения —
 * интерфейсу нужен ответ «как теперь», а не «команда отправлена».
 */
export async function setOperatorPaused(
  extension: string,
  paused: boolean,
  reason?: string
): Promise<{ ok: true; paused: boolean; queue: string } | { ok: false; error: string }> {
  const creds = await loadAmiCredentials();
  if (!creds) return { ok: false, error: "Управление станцией не настроено" };

  const found = await findOperatorMembership(creds, extension);
  if (!found.ok) return found;
  if (!found.membership) {
    return { ok: false, error: `Внутренний номер ${extension} не числится ни в одной очереди станции` };
  }

  const result = await amiQueuePause(creds, found.membership.queue, found.membership.iface, paused, reason);
  if (!result.ok) return result;
  return { ok: true, paused, queue: found.membership.queue };
}

/** Текущее состояние оператора — для экрана телефонии. */
export async function operatorQueueState(
  extension: string
): Promise<{ ok: true; membership: OperatorMembership | null } | { ok: false; error: string }> {
  const creds = await loadAmiCredentials();
  if (!creds) return { ok: false, error: "Управление станцией не настроено" };
  return findOperatorMembership(creds, extension);
}

/**
 * Связь CRM ↔ очередь входящих (владелец 19.08.2026): деактивированный или
 * замороженный сотрудник не должен звонить в трубке — раньше состав очереди
 * жил только в конфигурации станции и никак не знал про статус в CRM, поэтому
 * уволенный или замороженный агент продолжал получать общие входящие, пока
 * кто-то вручную не убирал его со станции.
 *
 * СТАВИМ НА ПАУЗУ, А НЕ УБИРАЕМ ИЗ ОЧЕРЕДИ. Список участников — конфигурация
 * станции (queues_details), и трогать её отсюда означало бы то самое `Command`,
 * которого этот модуль осознанно избегает (см. шапку amiClient.ts — одна дыра
 * в CRM не должна означать угнанную телефонию). QueuePause работает только с
 * УЖЕ существующим участником, ничего не меняет в конфигурации станции и снова
 * снимается тем же вызовом при реактивации — обратимо и безопасно.
 *
 * НЕ ЗАВЯЗАНО на leadsPausedUntil («пауза приёма лидов» — Бахтиёр, владелец
 * 19.08.2026: «просто на паузе», но по-прежнему должен получать звонки). Это
 * разные вещи: пауза лидов останавливает НОВОЕ распределение, а не отвечает на
 * вопрос «отвечает ли человек на телефон». Условие ровно то же, что делает
 * агента недоступным для назначения лида — см. acceptingLeadsWhere в leads.ts,
 * без учёта leadsPausedUntil.
 *
 * Отказ (станция недоступна, агент не найден среди участников очереди) не
 * бросает исключение — вызывающий (routes/agents.ts) не должен ронять смену
 * статуса сотрудника из-за того, что телефония сейчас не отвечает; крон
 * reconcileOperatorQueuePresence подхватит рассинхронизацию на следующем тике.
 */
async function applyQueuePause(agentId: string, paused: boolean): Promise<void> {
  // БЕЗ УСЛОВИЯ РОЛИ (№224 ночной проверки 24.09). В очереди входящих с
  // 20.09.2026 стоят операторы по признаку `takesUnknownCalls`, а он ставится
  // при ЛЮБОЙ роли. Прежнее `role === "AGENT"` оставляло замороженного или
  // отключённого оператора-руководителя в очереди не на паузе. Сотрудник,
  // которого в очереди нет вовсе, отсеивается ниже ответом «не числится».
  const agent = await prisma.agent.findUnique({
    where: { id: agentId },
    select: { sipExtension: true },
  });
  if (!agent?.sipExtension) return;

  const result = await setOperatorPaused(agent.sipExtension, paused, "статус в CRM");
  if (!result.ok) {
    // «Не числится ни в одной очереди» — это НЕ ошибка синхронизации: агент мог
    // никогда не входить в очередь входящих (например, только личные лиды).
    if (!result.error.includes("не числится")) {
      void logSystemError("telephony", `Синхронизация очереди со статусом агента: ${result.error}`);
    }
  }
}

/**
 * Вызывается СРАЗУ при явной смене статуса в CRM (routes/agents.ts: PATCH,
 * /freeze, /unfreeze) — владелец 19.08.2026: деактивированный/замороженный
 * сотрудник не должен звонить в трубке.
 *
 * ДВУНАПРАВЛЕННО ЗДЕСЬ — И ЭТО НАМЕРЕННО, В ОТЛИЧИЕ ОТ СТОРОЖЕВОГО ОБХОДА НИЖЕ.
 * Разница принципиальна (найдено ревью 19.08.2026 в тот же день, что и вся эта
 * фича): человек может поставить себя на паузу в очереди САМ («Я на месте» /
 * «Отошёл», см. кнопку у оператора, тот же setOperatorPaused) по причине, о
 * которой CRM знать не может, — обед, вышел покурить. Снимать эту паузу вправе
 * только явное действие того же уровня: реальная смена isActive/frozenAt
 * ЗДЕСЬ, вызванная человеком через API именно сейчас. Периодический обход
 * (reconcileOperatorQueuePresence) снимать чужую паузу не имеет права вовсе —
 * он не знает, поставил её человек сам или это стухшее состояние.
 */
export async function syncAgentQueuePresence(agentId: string): Promise<void> {
  const agent = await prisma.agent.findUnique({
    where: { id: agentId },
    select: { isActive: true, frozenAt: true },
  });
  if (!agent) return;
  await applyQueuePause(agentId, !(agent.isActive && !agent.frozenAt));
}

/**
 * Сторожевой обход — ловит только ОДНО направление: сотрудника, которому по
 * статусу CRM звонить нельзя, а на станции он всё ещё числится не на паузе
 * (AMI была недоступна в момент увольнения/заморозки — см. syncAgentQueuePresence).
 *
 * НИКОГДА НЕ СНИМАЕТ ПАУЗУ САМ. Если агент активен и не заморожен, но на
 * станции стоит на паузе — это не рассинхронизация, а решение самого агента
 * («Отошёл»), и обход его не трогает. Иначе крон каждые 5 минут молча
 * возвращал бы в очередь того, кто явно ушёл на обед (найдено код-ревью
 * 19.08.2026 в день, когда фича появилась, — не выкатывалось в проде).
 */
export async function reconcileOperatorQueuePresence(): Promise<void> {
  const creds = await loadAmiCredentials();
  if (!creds) return;
  // Только те, кому звонить сейчас нельзя по статусу CRM — активных сюда не
  // берём вовсе, им обход ничего не делает ни в одну сторону.
  // Любой роли — см. applyQueuePause (№224). Предел выборки: обход опрашивает
  // станцию по каждому, а отключённых с номером за годы может накопиться много.
  const agents = await prisma.agent.findMany({
    where: { sipExtension: { not: null }, OR: [{ isActive: false }, { frozenAt: { not: null } }] },
    select: { id: true },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  for (const agent of agents) {
    await applyQueuePause(agent.id, true).catch(() => {});
  }
}
