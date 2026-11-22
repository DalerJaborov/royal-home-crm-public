import { Prisma } from "../generated/prisma/client.js";
import { prisma } from "../db.js";
import { CLIENT_IN_WORK_WHERE } from "./clientInWork.js";

/**
 * «НЕ СВЯЗЫВАЛИСЬ» НА СЕРВЕРЕ — одна дверь (правило и подписи: packages/shared/src/
 * clientNoContact.ts). Плитка «Клиенты», срез по нажатию (`/clients?noContact=1`),
 * «Контроль руководителя», «Команда», пульт, помощник директора — все берут условие отсюда.
 *
 * До 17.11.2026 здесь было «больше суток ни разговора, ни сообщения клиента», и агент,
 * которому клиент не берёт трубку, держал «без контакта» навсегда (жалоба Нозы).
 */

/** Разговор по телефону состоялся (клиент взял трубку). Нужен паузе бота и нагрузке
 *  агента — к счётчику «не связывались» не относится, там шире: любая попытка. */
export const TALKED_CALL_WHERE = {
  type: "CALL",
  // Звонок РОП «почему в Корзине» (#217, lib/archiveReviewCall.ts) — разбор
  // удалённого, а не работа с клиентом: контактом агента его не считаем.
  archiveReview: false,
  OR: [{ callAttempt: "TALKED" }, { recordingDurationSec: { gt: 0 } }],
} satisfies Prisma.InteractionWhereInput;

/**
 * Каждое примечание входящего звонка начинается так (lib/telephony/incomingCalls.ts,
 * сторож — tests/no-contact-rule.test.ts). Пропущенный входящий, уведённый агенту,
 * записывается от его имени без исхода дозвона — это клиент пытался дозвониться до
 * нас, а не сотрудник до клиента, поэтому связью не считается.
 */
export const INCOMING_CALL_NOTE_PREFIX = "Входящий звонок";

/**
 * Запись хронологии, после которой с клиентом «связывались»:
 *  - звонок с исходом дозвона: взял трубку, не ответил, сброшен, пока у клиента звонило
 *    (`AGENT_NO_PICKUP` — агент сам не снял трубку, до клиента вызов не дошёл — не в счёт);
 *  - любой разговор с длительностью, в том числе отвеченный входящий;
 *  - звонок, записанный сотрудником без отметки станции (ручная запись «связался со
 *    своего телефона», старые записи до 27.08.2026, автоответчик клиента) — кроме
 *    пропущенного входящего;
 *  - встреча или показ, записанные сотрудником (бот и система — не в счёт).
 * Запись типа MESSAGE — это заметка сотрудника, а не сообщение клиенту: настоящие
 * сообщения лежат в переписке и в `lastAgentAttemptAt` (см. neverContactedWhere).
 */
export const STAFF_CONTACT_INTERACTION_WHERE = {
  archiveReview: false,
  OR: [
    { type: "CALL", callAttempt: { in: ["TALKED", "NO_ANSWER", "CANCELLED"] } },
    { type: "CALL", recordingDurationSec: { gt: 0 } },
    { type: "CALL", actorKind: "AGENT", callAttempt: null, NOT: { notes: { startsWith: INCOMING_CALL_NOTE_PREFIX } } },
    { type: { in: ["MEETING", "SHOWING"] }, actorKind: "AGENT" },
  ],
} satisfies Prisma.InteractionWhereInput;

/** Реплика сотрудника в сохранённой переписке: из CRM (`by.kind = agent`) или прямо в
 *  мессенджере (`manual`). Ответы бота и служебные сообщения сюда не входят. */
const STAFF_MESSAGE_FILTERS = [
  { messages: { array_contains: [{ role: "assistant", by: { kind: "agent" } }] } },
  { messages: { array_contains: [{ role: "assistant", by: { kind: "manual" } }] } },
] as const;

/**
 * Условие правила без отбора «кто в работе»: с клиентом не связывались ни разу.
 * `lastAgentAttemptAt` — общая отметка «агент пытался» (lib/clientWorkStalled.ts):
 * звонок с исходом дозвона, сообщение из CRM, первое сообщение в WhatsApp, отказ
 * станции на нажатие «Позвонить». Переписка проверяется отдельно: в ней видны и ответы
 * сотрудников, которые не ведут карточку, и ответы прямо из мессенджера.
 */
export function neverContactedWhere(): Prisma.ClientWhereInput {
  return {
    lastAgentAttemptAt: null,
    interactions: { none: STAFF_CONTACT_INTERACTION_WHERE },
    botConversation: { none: { OR: [...STAFF_MESSAGE_FILTERS] } },
    telegramDirectConversations: { none: { OR: [...STAFF_MESSAGE_FILTERS] } },
    NOT: { telegramConversation: { is: { OR: [...STAFF_MESSAGE_FILTERS] } } },
  };
}

/**
 * Клиенты в работе (покупатели и продавцы с агентом), с которыми ни разу не связывались.
 * Срока нет: клиент, с которым связались хотя бы раз, сюда не попадает никогда.
 */
export function noContactWhere(): Prisma.ClientWhereInput {
  return {
    AND: [
      CLIENT_IN_WORK_WHERE,
      { kind: { in: ["BUYER", "SELLER"] }, assignedAgentId: { not: null } },
      neverContactedWhere(),
    ],
  };
}

/**
 * Пауза в контакте с порогом — для рассылки «вернуть клиента»
 * (lib/reactivationCampaign.ts): после `cutoff` не было ни сообщения самого клиента,
 * ни разговора по телефону. К счётчику «не связывались» отношения не имеет.
 */
export function noContactSinceWhere(cutoff: Date): Prisma.ClientWhereInput {
  return {
    AND: [
      { OR: [{ lastClientMessageAt: null }, { lastClientMessageAt: { lt: cutoff } }] },
      { interactions: { none: { ...TALKED_CALL_WHERE, createdAt: { gte: cutoff } } } },
    ],
  };
}

/**
 * ТО ЖЕ ПРАВИЛО КОНТАКТА ДЛЯ СЫРОГО SQL (21.11.2026) — «после момента `after` с клиентом
 * связывались другим путём, не в чате»: срез «Ждут» в «Чатах» (lib/inboxWaiting.ts) —
 * сырой запрос, и Prisma-условие `STAFF_CONTACT_INTERACTION_WHERE` ему не подставить.
 * Живёт РЯДОМ с условием выше, чтобы две записи правила правились вместе; тест
 * `inbox-waiting-truth.test.ts` прогоняет обе на одних и тех же записях и краснеет при
 * расхождении. Добавили строку в `STAFF_CONTACT_INTERACTION_WHERE` — допишите её здесь.
 *
 * `clientId`/`after` — SQL-выражения (колонка присоединённого `Client`, время последней
 * реплики клиента). Дополнительно `Client.lastAgentAttemptAt` позже `after`: сообщение
 * агента из CRM и отказ станции на «Позвонить» не лежат записью хронологии.
 */
export function staffContactAfterSql(
  clientId: Prisma.Sql,
  after: Prisma.Sql,
  lastAgentAttemptAt: Prisma.Sql,
): Prisma.Sql {
  return Prisma.sql`(
    COALESCE(${lastAgentAttemptAt} > ${after}, FALSE)
    OR EXISTS (
      SELECT 1 FROM "Interaction" i
      WHERE i."clientId" = ${clientId}
        AND i."createdAt" > ${after}
        AND i."archiveReview" = FALSE
        AND (
          (i."type"::text = 'CALL' AND i."callAttempt" IN ('TALKED', 'NO_ANSWER', 'CANCELLED'))
          OR (i."type"::text = 'CALL' AND i."recordingDurationSec" > 0)
          OR (i."type"::text = 'CALL' AND i."actorKind"::text = 'AGENT' AND i."callAttempt" IS NULL
              AND i."notes" NOT LIKE ${INCOMING_CALL_NOTE_PREFIX + "%"})
          OR (i."type"::text IN ('MEETING', 'SHOWING') AND i."actorKind"::text = 'AGENT')
        )
    )
  )`;
}

export interface StaffContactFacts {
  id: string;
  /** Общая отметка «агент пытался» (сообщение из CRM, отказ станции на «Позвонить» и т.п.). */
  lastAgentAttemptAt: Date | null;
  /** «Когда карточку трогали» — запасная дата, только если правило говорит «связывались», а даты нет. */
  lastContactAt: Date;
}

/**
 * ПОСЛЕДНИЙ КОНТАКТ СОТРУДНИКА — ТЕМ ЖЕ ПРАВИЛОМ, ЧТО «НЕ СВЯЗЫВАЛИСЬ» (21.11.2026).
 *
 * Строка списка клиентов писала «связывались 21.11 19:13» и «Давно не связывались ·
 * 03.10» по `Client.lastContactAt`. Это метка «карточку трогали»: её двигает любая
 * заметка, а у новой карточки она равна моменту создания (`@default(now())`), — то есть
 * «связывались» у клиента, которому никто не звонил (кадры владельца 21.11). Здесь дата
 * считается по ОДНОМУ правилу контакта (`STAFF_CONTACT_INTERACTION_WHERE` +
 * `lastAgentAttemptAt`) и одним запросом на пачку, не по клиенту.
 *
 * Сообщение сотрудника прямо в мессенджере правило считает связью, но времени у него в
 * базе нет (переписка — одно поле). Если других следов нет, а правило говорит «связывались»
 * (клиент не входит в `neverContactedWhere`), берётся `lastContactAt` — его двигает и ответ
 * агента в переписке (lib/conversationDelivery.ts). «Контакта ещё не было» (null) — только
 * когда правило говорит «ни разу»: та же граница, что у счётчика «Не связывались».
 *
 * Возвращает дату по каждому id пачки; null — сотрудники с клиентом ни разу не связывались.
 */
export async function lastStaffContactAtByClient(clients: StaffContactFacts[]): Promise<Map<string, Date | null>> {
  const result = new Map<string, Date | null>();
  if (clients.length === 0) return result;
  const ids = clients.map((c) => c.id);
  const [byInteraction, never] = await Promise.all([
    prisma.interaction.groupBy({
      by: ["clientId"],
      where: { clientId: { in: ids }, ...STAFF_CONTACT_INTERACTION_WHERE },
      _max: { createdAt: true },
    }),
    prisma.client.findMany({ where: { id: { in: ids }, AND: [neverContactedWhere()] }, select: { id: true } }),
  ]);
  const interactionAt = new Map(byInteraction.map((row) => [row.clientId, row._max.createdAt]));
  const neverIds = new Set(never.map((row) => row.id));
  for (const c of clients) {
    if (neverIds.has(c.id)) {
      result.set(c.id, null);
      continue;
    }
    const candidates = [interactionAt.get(c.id), c.lastAgentAttemptAt].filter((d): d is Date => d instanceof Date);
    const latest = candidates.length ? new Date(Math.max(...candidates.map((d) => d.getTime()))) : null;
    result.set(c.id, latest ?? c.lastContactAt);
  }
  return result;
}
