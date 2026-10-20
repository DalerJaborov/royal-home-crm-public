import { prisma } from "../../db.js";
import { dushanbeDayRange } from "../dushanbeTime.js";

/**
 * ПРОПУЩЕННЫЙ ЗВОНОК БЕЗ ПЕРЕЗВОНА — остались только СЧЁТ и вспомогательные мерки.
 *
 * Механизм завели Пачкой 18 (12.09.2026) после факта с прода: 24 пропущенных за
 * 30 дней, по которым агент так и не перезвонил. Он слал два уведомления —
 * напоминание агенту и эскалацию руководству.
 *
 * 20.09.2026 владелец убрал и то, и другое, двумя решениями подряд:
 *   — напоминание агенту: «такие пропущенные пуши про звонки убери, типа как
 *     напоминания, оставь только реальные пропущенные, чтобы не путать людей,
 *     меньше пуша». Живой случай в тот же день: агент получила «Перезвоните —
 *     пропущенный звонок ждёт» и была уверена, что клиент звонит прямо сейчас,
 *     хотя звонок был вчерашний;
 *   — эскалацию руководству: «полностью удали пуш и эскалацию руководителю, нам
 *     это не нужно».
 *
 * ЧТО ОСТАЛОСЬ ВМЕСТО НИХ. Пропущенный звонок по-прежнему никуда не девается:
 * агент получает ОДИН пуш в момент самого звонка (incomingCalls.ts, notifyMissed)
 * и задачу перезвонить в хронологии клиента, а сколько вчерашних пропущенных до
 * сих пор без перезвона — видно в утренних числах директора
 * (countMissedCallsNoCallbackYesterday ниже). Порогов, ступеней и повторов нет.
 *
 * ПЕРЕЗВОН НАЙДЕН — минимальный признак: любая Interaction клиента (CALL/MESSAGE)
 * позже начала звонка с outcome, отличным от NO_ANSWER (включая null — оператор
 * ещё не разобрал, но контакт уже был). Этой планки достаточно и для счёта, и для
 * экрана звонков (routes/calls.ts), который тоже зовёт hasCallbackContact.
 */

function minutesOf(hhmm: string, fallback: number): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return fallback;
  return Number(m[1]) * 60 + Number(m[2]);
}

/**
 * Сколько РАБОЧИХ минут прошло между `from` и `to`, считая только внутри
 * ежедневного окна [startHHMM, endHHMM) по Душанбе. Окна через полночь (start >
 * end) не поддержаны — рабочие часы CRM всегда дневные (см. workingHours.ts).
 */
export function elapsedWorkingMinutes(from: Date, to: Date, startHHMM: string, endHHMM: string): number {
  if (to.getTime() <= from.getTime()) return 0;
  const startMin = minutesOf(startHHMM, 9 * 60 + 30);
  const endMin = minutesOf(endHHMM, 18 * 60);
  if (endMin <= startMin) return 0;

  let total = 0;
  // Начинаем с полуночи (по Душанбе) того дня, в который попал `from` — так окно
  // первого дня считается тем же способом, что и окна следующих.
  let cursor = dushanbeDayRange(from).start;
  // Предохранитель от бесконечного цикла на испорченных входных данных (например,
  // `to` в далёком будущем из-за сбойных часов) — реальный диапазон здесь не больше
  // LOOKBACK_DAYS+1 суток.
  let guard = 0;
  while (cursor.getTime() < to.getTime() && guard < 400) {
    guard++;
    const dayStart = cursor;
    const windowStart = new Date(dayStart.getTime() + startMin * 60_000);
    const windowEnd = new Date(dayStart.getTime() + endMin * 60_000);
    const overlapStart = Math.max(windowStart.getTime(), from.getTime());
    const overlapEnd = Math.min(windowEnd.getTime(), to.getTime());
    if (overlapEnd > overlapStart) total += (overlapEnd - overlapStart) / 60_000;
    cursor = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
  }
  return total;
}

const CLOSED_STATUSES = new Set(["LOST", "DEAL_CLOSED", "ARCHIVED"]);

/** Появился ли после звонка исходящий контакт с клиентом — см. doc-comment у файла.
 *  Обёртка над `findCallbackContacts` на один звонок: правило живёт в ОДНОМ месте,
 *  второй копии здесь намеренно нет. Для списка звонков зовите пачечную версию —
 *  этот вызов на каждую строку и есть тот N+1, ради которого она заведена. */
export async function hasCallbackContact(clientId: string, since: Date): Promise<boolean> {
  const done = await findCallbackContacts([{ id: "one", clientId, since }]);
  return done.has("one");
}

/**
 * ТО ЖЕ ПРАВИЛО, НО НА ПАЧКУ ЗВОНКОВ СРАЗУ (22.09.2026).
 *
 * `hasCallbackContact` делает по запросу на звонок. В журнале «Звонки» с фильтром
 * «без перезвона» список кандидатов — до 1000 строк (routes/calls.ts), то есть до
 * тысячи последовательных запросов на ОДНО открытие экрана; в утренних числах —
 * до двух тысяч. Экран при этом не падает и не предупреждает, он просто открывается
 * долго, и чем больше звонков накопилось, тем дольше.
 *
 * Здесь тот же признак считается одним запросом: берём все исходящие контакты по
 * нужным клиентам разом (начиная с САМОГО РАННЕГО `since` в пачке, чтобы не
 * вычитывать всю историю), запоминаем по клиенту самый поздний контакт и дальше
 * сравниваем в памяти. Самый поздний — потому что вопрос «был ли хоть один контакт
 * после звонка» решается именно им.
 *
 * Возвращает набор id тех пар, по которым перезвон БЫЛ. Пары без `clientId`
 * вызывающая сторона отсеивает сама — у звонка без карточки перезвона быть не может.
 */
export async function findCallbackContacts(
  pairs: { id: string; clientId: string; since: Date }[],
): Promise<Set<string>> {
  const done = new Set<string>();
  if (pairs.length === 0) return done;

  const earliest = pairs.reduce((min, p) => (p.since < min ? p.since : min), pairs[0].since);
  const rows = await prisma.interaction.findMany({
    where: {
      clientId: { in: [...new Set(pairs.map((p) => p.clientId))] },
      type: { in: ["CALL", "MESSAGE"] },
      createdAt: { gt: earliest },
      /**
       * `outcome` может быть null, и правило выше обещает считать такой контакт
       * перезвоном. Здесь стояло `NOT: { outcome: "NO_ANSWER" }` — Prisma отдаёт
       * это в SQL как `outcome <> 'NO_ANSWER'`, а `NULL <> 'NO_ANSWER'` в Postgres
       * не истина, и строка выпадает из выборки. Сообщение агента (type MESSAGE,
       * outcome всегда null) перезвоном не считалось: звонок оставался в «Мои
       * звонки» как неотработанный и попадал в утренние числа директора, хотя
       * контакт был. Тот же класс, что уже разобран в dealStalePipeline.ts и
       * routes/vacancies.ts, — поэтому явный OR, а не отрицание.
       */
      OR: [{ outcome: null }, { outcome: { not: "NO_ANSWER" } }],
    },
    select: { clientId: true, createdAt: true },
  });

  const latestByClient = new Map<string, Date>();
  for (const r of rows) {
    if (!r.clientId) continue;
    const seen = latestByClient.get(r.clientId);
    if (!seen || r.createdAt > seen) latestByClient.set(r.clientId, r.createdAt);
  }
  for (const p of pairs) {
    const latest = latestByClient.get(p.clientId);
    if (latest && latest > p.since) done.add(p.id);
  }
  return done;
}


/** Утренние числа (morningNumbers.ts): сколько пропущенных ЗА ВЧЕРА до сих пор без
 *  перезвона — считается НА СЕЙЧАС (та же логика, что unqualifiedNow), а не «сколько
 *  было вчера» — вчерашний разрыв, закрытый сегодня утром, уже не разрыв. */
export async function countMissedCallsNoCallbackYesterday(startOfToday: Date): Promise<number> {
  const startOfYesterday = new Date(startOfToday.getTime() - 24 * 60 * 60 * 1000);
  const calls = await prisma.incomingCall.findMany({
    where: {
      answered: false,
      irrelevant: false,
      startedAt: { gte: startOfYesterday, lt: startOfToday },
    },
    select: { id: true, clientId: true, startedAt: true, client: { select: { deletedAt: true, status: true } } },
    take: 2000,
  });
  if (calls.length === 0) return 0;

  const live = calls.filter(
    (call) => !call.client || (call.client.deletedAt === null && !CLOSED_STATUSES.has(call.client.status)),
  );
  const calledBack = await findCallbackContacts(
    live.flatMap((c) => (c.clientId ? [{ id: c.id, clientId: c.clientId, since: c.startedAt }] : [])),
  );
  return live.filter((c) => !calledBack.has(c.id)).length;
}
