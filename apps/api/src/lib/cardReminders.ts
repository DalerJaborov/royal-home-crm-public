import { prisma } from "../db.js";
import { CARD_INCOMPLETE_WHERE } from "./clientCard.js";
import { absentAgentIds } from "./agentAvailability.js";
import { loadEventPoints, recordScoreEvent } from "./scoreJournal.js";
import { reportCronRowError } from "./cronHeartbeat.js";

/**
 * Контроль заполнения карточки клиента (решение владельца 30.07, третий пакет п. 7).
 *
 * Через час после принятия лида агенту приходит напоминание дозаполнить карточку,
 * через 12 часов о незаполненной карточке узнаёт руководство. Пустая карточка — это
 * клиент, с которым нельзя работать: подбор по ней ничего не найдёт, и лид тихо
 * умирает.
 *
 * Отсчёт продлевается САМ — разговором или показом по клиенту (lastContactAt), а
 * также входящим сообщением от него самого (lastClientMessageAt). Раньше для этого
 * была кнопка «Я в работе»: агент должен был
 * сообщить системе то, что она и так знала из хронологии. Владелец убрал её
 * 08.08.2026 — «хочу, чтобы агенты меньше меняли всё руками». Отметка
 * workingMarkedAt осталась в базе и по-прежнему учитывается: у карточек, где на
 * неё нажимали до этого дня, отсчёт не должен внезапно поехать назад.
 *
 * Смысл сохранился: агент, который правда работает с клиентом, напоминаний не
 * получает; молчащая пустая карточка через час напомнит о себе агенту, через
 * двенадцать — руководству.
 *
 * Считаем от ПРИНЯТИЯ лида, а не от создания: до принятия карточка агенту закрыта,
 * и требовать с него заполнение было бы нечестно.
 */
const REMIND_AFTER_MS = 60 * 60 * 1000;
const ESCALATE_AFTER_MS = 12 * 60 * 60 * 1000;

/**
 * Точка отсчёта — самое позднее из: принятие лида, последняя работа с клиентом,
 * входящее сообщение от клиента, старая отметка «в работе».
 *
 * lastContactAt двигают ровно те действия, ради которых напоминание и существует:
 * добавленное взаимодействие (routes/clients.ts), назначенный и состоявшийся показ
 * (lib/showingBooking.ts). То есть агент, который звонит и показывает, продлевает
 * себе срок молча — ничего не нажимая.
 *
 * lastClientMessageAt (lib/clientMessageAlert.ts) — живая переписка в карточке.
 * Напоминание «вы забыли про клиента» посреди идущего диалога это ложная тревога,
 * ровно ради неё поле и заведено. ЗДЕСЬ и только здесь: отчёты об остывании и
 * «забытых клиентах» его намеренно не смотрят — им нужно отсутствие человеческой
 * работы, а переписка с ботом работой не является.
 */
function countFrom(client: {
  acceptedAt: Date | null;
  workingMarkedAt: Date | null;
  lastContactAt: Date;
  lastClientMessageAt: Date | null;
}): Date | null {
  if (!client.acceptedAt) return null;
  const marks = [
    client.acceptedAt,
    client.lastContactAt,
    client.lastClientMessageAt,
    client.workingMarkedAt,
  ].filter((d): d is Date => d instanceof Date);
  return new Date(Math.max(...marks.map((d) => d.getTime())));
}

export async function remindIncompleteCards(now: Date = new Date()): Promise<{ reminded: number; escalated: number }> {
  /**
   * АГЕНТА НЕТ НА РАБОТЕ — не напоминаем и не штрафуем (владелец 08.09.2026, см.
   * agentAvailability.ts). Отпуск и больничный до этой правки ничего не значили:
   * отсутствующему шли напоминания «заполните карточку», через 12 часов ему
   * начислялся штраф `card_not_filled`, а руководителю уходила тревога о брошенной
   * карточке. Пауза «не принимаю лидов» отсутствием не считается — там агент на
   * месте и со своими карточками работать обязан.
   */
  const absent = await absentAgentIds();
  const candidates = await prisma.client.findMany({
    where: {
      ...CARD_INCOMPLETE_WHERE,
      deletedAt: null,
      acceptedAt: { not: null, lte: new Date(now.getTime() - REMIND_AFTER_MS) },
      // Одно условие на поле: отсутствующие исключаются здесь же, иначе второй ключ
      // assignedAgentId в этом же объекте затёр бы первый.
      assignedAgentId: absent.size > 0 ? { not: null, notIn: [...absent] } : { not: null },
      // «Прочие обращения» агенту не назначаются — спрашивать не с кого.
      kind: { not: "OTHER" },
      // Закрытых и архивных не дёргаем: карточка уже не в работе.
      status: { notIn: ["DEAL_CLOSED", "ARCHIVED"] },
      /**
       * Тем, кому уже написали И кого уже эскалировали, здесь делать нечего.
       *
       * Обе отметки проверялись ТОЛЬКО в цикле, а выборка их не знала: карточка, по
       * которой всё отправлено, оставалась кандидатом навсегда. Джоб тикает каждые
       * пять минут, и за год такие карточки копятся тысячами — каждый тик поднимал
       * их все вместе со связью на агента, чтобы не отправить ничего.
       *
       * Через AND, а НЕ вторым ключом OR: у CARD_INCOMPLETE_WHERE свой OR («какое
       * поле карточки пустое»), и второй ключ с тем же именем молча затёр бы его —
       * джоб начал бы писать по заполненным карточкам. Ровно на этом уже обожглись
       * в фильтрах списка объектов.
       *
       * Третья и четвёртая ветки — карточки, по которым недавно работали или в
       * которых клиент недавно писал сам: отсчёт у них поехал вперёд (countFrom), и
       * посланное когда-то напоминание к нему уже не относится. Без них
       * автоматическое продление работало бы в одну сторону: сроки сдвинулись,
       * а напоминание после них не пришло бы никогда.
       */
      AND: [
        {
          OR: [
            { cardReminderSentAt: null },
            { cardEscalatedAt: null },
            { lastContactAt: { gt: new Date(now.getTime() - ESCALATE_AFTER_MS) } },
            { lastClientMessageAt: { gt: new Date(now.getTime() - ESCALATE_AFTER_MS) } },
          ],
        },
      ],
    },
    // Сначала самые давние: очередь двигается, а не топчется на случайной сотне.
    orderBy: { acceptedAt: "asc" },
    take: 300,
    select: {
      id: true,
      shortId: true,
      fullName: true,
      assignedAgentId: true,
      acceptedAt: true,
      workingMarkedAt: true,
      lastContactAt: true,
      lastClientMessageAt: true,
      cardReminderSentAt: true,
      cardEscalatedAt: true,
      assignedAgent: { select: { fullName: true } },
    },
  });
  if (candidates.length === 0) return { reminded: 0, escalated: 0 };

  let reminded = 0;
  let escalated = 0;
  const points = await loadEventPoints();

  for (const client of candidates) {
    // СБОЙ ОДНОЙ КАРТОЧКИ НЕ ОБРЫВАЕТ ОСТАЛЬНЫЕ (E8 глубокой проверки 02.10.2026,
    // класс №173): отказ пуша или базы на одной записи раньше оставлял без
    // напоминания всех, кто шёл следом.
    try {
      const counted = await remindOneCard(client, now, points);
      if (counted.reminded) reminded++;
      if (counted.escalated) escalated++;
    } catch (err) {
      reportCronRowError("Напоминание о незаполненной карточке", client.shortId, err);
    }
  }

  return { reminded, escalated };
}

type CardCandidate = {
  id: string;
  shortId: number;
  fullName: string;
  assignedAgentId: string | null;
  acceptedAt: Date | null;
  workingMarkedAt: Date | null;
  lastContactAt: Date;
  lastClientMessageAt: Date | null;
  cardReminderSentAt: Date | null;
  cardEscalatedAt: Date | null;
  assignedAgent: { fullName: string } | null;
};

async function remindOneCard(
  client: CardCandidate,
  now: Date,
  points: Awaited<ReturnType<typeof loadEventPoints>>
): Promise<{ reminded: boolean; escalated: boolean }> {
  let reminded = false;
  let escalated = false;
  const from = countFrom(client);
  if (!from) return { reminded, escalated };
  const elapsed = now.getTime() - from.getTime();

  // «Уже писали» — только если писали В ЭТОМ отсчёте. После разговора с клиентом
  // точка отсчёта уезжает вперёд, и прошлое напоминание относится к прошлому кругу.
  const remindedThisRound = !!client.cardReminderSentAt && client.cardReminderSentAt >= from;
  const escalatedThisRound = !!client.cardEscalatedAt && client.cardEscalatedAt >= from;

  // Напоминание агенту — через час после точки отсчёта, один раз.
  if (elapsed >= REMIND_AFTER_MS && !remindedThisRound) {
    /**
     * Пуш и запись в ленту агенту о незаполненной карточке УБРАНЫ (решение
     * владельца 02.10.2026: уведомления-«пилилки» агенту не нужны). Отметка
     * cardReminderSentAt остаётся: без неё выборка кандидатов (take: 300)
     * каждый тик забивалась бы теми же клиентами; эскалация через 12 ч
     * (штраф card_not_filled + руководителю) не затронута.
     */
    await prisma.client.update({ where: { id: client.id }, data: { cardReminderSentAt: now } });
    reminded = true;
  }

  // Руководству — через 12 часов, тоже один раз на текущий отсчёт.
  if (elapsed >= ESCALATE_AFTER_MS && !escalatedThisRound) {
    // Royal Score: «Карточка не заполнена» (таблица владельца, п. 11) — БЕЗ
    // ОГЛЯДКИ на успех push ниже (тот же принцип, что и в notifyMissedShowings):
    // штраф зависит от факта «двенадцать часов без карточки», а не от того,
    // получилось ли доставить уведомление руководству. Дубль при повторном тике
    // исключён уникальностью по sourceId. await обязателен: ниже ставится
    // cardEscalatedAt, после которого этот отсчёт больше не разбирается, —
    // незавершённая фоновая запись теряла бы штраф молча.
    await recordScoreEvent({
      agentId: client.assignedAgentId!,
      kind: "card_not_filled",
      delta: points.card_not_filled,
      reason: `Карточка не заполнена 12 часов: ${client.fullName}`,
      sourceId: client.id,
    });

    /**
     * Уведомление руководителю «Карточка не заполнена 12 часов» УБРАНО (решение
     * владельца 02.10.2026). Штраф card_not_filled выше и отметка cardEscalatedAt
     * ниже остаются: без отметки клиент возвращался бы в выборку каждый тик.
     */
    await prisma.client.update({ where: { id: client.id }, data: { cardEscalatedAt: now } });
    escalated = true;
  }
  return { reminded, escalated };
}
