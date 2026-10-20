import { prisma } from "../db.js";
import { workingDaysBetween, type DaysOffCalendar } from "./alarmCalendar.js";
import { loadDaysOffCalendar } from "./daysOffCalendar.js";
import { loadWorkWindow, outagesBetween, workingOutageMs } from "./stationOutage.js";

/**
 * «РАБОТА ВСТАЛА» — фундамент контроля без всплывающих окон (владелец 08.09.2026,
 * docs/voronka-prodavca-08-09-2026.md).
 *
 * ГЛАВНОЕ ПРАВИЛО, ради которого всё это существует:
 *
 *   «Агент звонит, клиент не берёт трубку» — ЭТО НЕ ТИШИНА. Это работа.
 *   Тишина — это когда агент сам перестал пытаться.
 *
 * Отсюда единственный вопрос модуля: когда сотрудник в последний раз ПЫТАЛСЯ
 * связаться, и сколько рабочих дней прошло с тех пор. Ответил клиент или нет —
 * значения не имеет: молчание клиента не вина агента и никогда не должно
 * превращаться в обвинение.
 *
 * ЧТО СЧИТАЕТСЯ ПОПЫТКОЙ — только проверяемое (Client.lastAgentAttemptAt, см.
 * комментарий у поля): звонок через CRM с исходом дозвона, проведённая встреча,
 * отправленное агентом сообщение. Заметка в карточке не считается: её пишет сам
 * агент, и принимать её за работу — значит выдать кнопку «замолчать».
 *
 * ЖИЗНЬ КЛИЕНТА ТОЖЕ СЧИТАЕТСЯ. Если клиент сам написал позже последней попытки
 * агента — разговор идёт, и отсчёт ведём от этого момента. Иначе живая переписка,
 * в которой отвечает клиент, выглядела бы тишиной.
 */

/** Сколько рабочих дней тишины считаем сигналом. Числа владельца 08.09.2026. */
export const STALLED_WORKING_DAYS = 3;
/**
 * Укороченный срок для карточки, где засветился номер клиента. Пока номера у
 * агента нет, увести клиента некуда и можно быть терпеливыми; как только номер
 * прозвучал — окно возможности открыто, и терпение дорого стоит.
 */
/**
 * ПРАВИЛО «НОМЕР ЗАСВЕТИЛСЯ» ЗДЕСЬ БОЛЬШЕ НЕ ЖИВЁТ (09.09.2026).
 *
 * Здесь была вторая, укороченная планка: 2 рабочих дня вместо трёх, если у клиента
 * «засветился номер». Она опиралась на поле `Client.phoneLeakedAt`, которое НИКТО НЕ
 * ЗАПОЛНЯЛ, — то есть не срабатывала ни разу.
 *
 * И чинить её было нечем: это же правило уже написано, и написано лучше, в
 * `lib/agentOffCrmAlarm.ts` (решение владельца 07.09.2026). Там триггер — «агент
 * спросил номер» (`Client.phoneAskFlaggedAt`, ставит agentPhoneAskDetector) ПЛЮС
 * два дня тишины ИЛИ брошенная договорённость, и ПЕРЕД тем как будить владельца,
 * идёт ИИ-проверка, не объяснил ли паузу сам клиент. У здешней версии такой
 * проверки не было вовсе — она бы обвиняла честных агентов там, где та молчит.
 *
 * Две реализации одного правила в этом проекте уже расходились (см. шапку
 * services/leads/selection.ts). Поэтому здесь остаётся одна простая планка, а
 * случай «номер засветился» целиком принадлежит agentOffCrmAlarm.
 */

export interface WorkStalledVerdict {
  /** Работа встала: агент не пытался дольше положенного. */
  stalled: boolean;
  /** От какого момента считали. null — попыток не было вовсе с момента принятия. */
  lastAttemptAt: Date | null;
  /** Сколько рабочих дней прошло с последней попытки. */
  workingDaysSince: number;
  /** Какой порог применяли (обычный или укороченный). */
  thresholdDays: number;
}

export interface WorkStalledInput {
  lastAgentAttemptAt: Date | null;
  lastClientMessageAt: Date | null;
  /** Отсечка, раньше которой считать нечего: принятие лида или назначение агента. */
  since: Date;
  /**
   * Рабочие миллисекунды, которые станция лежала внутри считаемого окна
   * (lib/stationOutage.ts). Вычитаются из срока: звонок через АТС — главный
   * доказанный след работы, и в часы, когда звонить было физически некуда,
   * тишина агента ничего о нём не говорит. Не передан — ноль, поведение прежнее.
   */
  outageMs?: number;
  /** Выходные компании и агента карточки (11.10.2026): в «тишину» не идут. Не передан —
   *  выходных нет, считаем каждый день. */
  calendar?: DaysOffCalendar;
}

/**
 * Чистая проверка без похода в базу — её же зовут крон и тесты.
 *
 * Отсчёт ведём от самого свежего из трёх моментов: последняя попытка агента,
 * последнее сообщение клиента, отсечка `since`. Последняя нужна для карточки, по
 * которой не было ещё ничего: считать «тишину» от сотворения мира нельзя, иначе
 * только что назначенный клиент сразу выглядел бы заброшенным.
 */
export function evaluateWorkStalled(input: WorkStalledInput, now: Date = new Date()): WorkStalledVerdict {
  const thresholdDays = STALLED_WORKING_DAYS;

  const candidates: Date[] = [input.since];
  if (input.lastAgentAttemptAt) candidates.push(input.lastAgentAttemptAt);
  if (input.lastClientMessageAt) candidates.push(input.lastClientMessageAt);
  const from = candidates.reduce((a, b) => (a > b ? a : b));

  // Простой станции отодвигает «сейчас» назад, а не обнуляет счётчик: день без
  // АТС стоит агенту одного дня отсрочки, а не прощения всей накопленной тишины.
  const effectiveNow = input.outageMs ? new Date(now.getTime() - input.outageMs) : now;
  const workingDaysSince = workingDaysBetween(from, effectiveNow, input.calendar);
  return {
    stalled: workingDaysSince >= thresholdDays,
    lastAttemptAt: input.lastAgentAttemptAt,
    workingDaysSince,
    thresholdDays,
  };
}

/** Та же проверка по конкретной карточке. */
export async function isWorkStalled(clientId: string, now: Date = new Date()): Promise<WorkStalledVerdict | null> {
  const client = await prisma.client.findFirst({
    where: { id: clientId, deletedAt: null },
    select: {
      lastAgentAttemptAt: true,
      lastClientMessageAt: true,
      acceptedAt: true,
      assignedAt: true,
      createdAt: true,
      assignedAgentId: true,
    },
  });
  if (!client) return null;
  const since = client.acceptedAt ?? client.assignedAt ?? client.createdAt;
  const from = [since, client.lastAgentAttemptAt, client.lastClientMessageAt]
    .filter((d): d is Date => d !== null)
    .reduce((a, b) => (a > b ? a : b));
  const [outages, window, calendar] = await Promise.all([
    outagesBetween(from, now),
    loadWorkWindow(),
    loadDaysOffCalendar(client.assignedAgentId),
  ]);
  return evaluateWorkStalled(
    {
      outageMs: workingOutageMs(from, now, outages, window, calendar),
      calendar,
      lastAgentAttemptAt: client.lastAgentAttemptAt,
      lastClientMessageAt: client.lastClientMessageAt,
      // Принятие лида — честная точка отсчёта: до него карточка агенту закрыта, и
      // требовать с него работу было бы нечестно. Нет принятия — берём назначение,
      // нет и его — создание карточки.
      since: client.acceptedAt ?? client.assignedAt ?? client.createdAt,
    },
    now
  );
}

/**
 * Отметить попытку связаться. Зовётся из мест, где попытка ДОКАЗАНА: звонок с
 * исходом дозвона, проведённая встреча, отправленное агентом сообщение.
 *
 * ЗАСЧИТЫВАЕТСЯ ТОЛЬКО НАЗНАЧЕННОМУ АГЕНТУ (09.09.2026). Раньше отметку двигало
 * любое исходящее по карточке — в том числе ответ на «уточню у собственника»
 * (lib/ownerQuestionAnswer.ts), который уходит клиенту от имени того, кто ответил.
 * Ответить мог владелец или другой сотрудник, и чужая работа обнуляла счётчик
 * тишины агента: карточка выглядела рабочей, хотя её агент к клиенту не
 * прикасался. `byAgentId` не передан — отметку ставим (старое поведение для мест,
 * где автор действия и есть агент карточки по построению).
 *
 * Никогда не бросает: отметка вторична по отношению к самому действию, и уронить
 * отправку сообщения из-за неё было бы обменом ценного на служебное.
 */
export async function markAgentAttempt(
  clientId: string,
  at: Date = new Date(),
  byAgentId?: string | null
): Promise<void> {
  try {
    await prisma.client.updateMany({
      where: {
        id: clientId,
        deletedAt: null,
        ...(byAgentId ? { assignedAgentId: byAgentId } : {}),
      },
      data: { lastAgentAttemptAt: at },
    });
  } catch (err) {
    console.error("[контроль] отметка попытки агента не записана:", err instanceof Error ? err.message : err);
  }
}
