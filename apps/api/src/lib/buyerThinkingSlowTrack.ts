import { prisma } from "../db.js";
import { mapWithConcurrency } from "./concurrency.js";
import { logTimeline } from "./timeline.js";

/** Инцидент 11-12.09.2026: `for … await` по строкам вперемешку с 2-4 запросами
 *  на строку (до 600-800 круговых запросов за прогон) насыщал пул соединений
 *  Prisma в час пик (09:30 Душанбе) — тик зависал, следующие срабатывания
 *  терялись молча (см. cron.ts::scheduleTracked timeoutMs). Пять одновременных
 *  строк — тот же приём, что в lib/concurrency.ts, без новой библиотеки. */
const TICK_CONCURRENCY = 5;

/**
 * «Покупатель думает» — медленный трек, ПОДСТРАХОВКА, не основной путь (владелец
 * 30.08.2026, решение по мозговому штурму 20-21.08.2026: Settings.buyerThinkingFirstPingHours/
 * SecondPingHours/SlowTrackDays).
 *
 * ОСНОВНОЙ ПУТЬ — агент сам выбирает дату повторного контакта в «Итоге показа»
 * (routes/me.ts, THINKING_DELAY_DAYS: завтра/через 3 дня/через неделю/своя дата).
 * Это работает и не тронуто. Подстраховка включается ТОЛЬКО когда агент это поле
 * вообще не заполнил (thinkingDelay пуст — необязательное поле схемы): до
 * 31.08.2026 такой случай молча превращался в «завтра», то есть решение не
 * выбравшего агента ничем не отличалось от явного выбора «завтра».
 *
 * ТРИ МАРКЕРА — состояние трека читается по тексту задачи (Interaction.nextAction),
 * тем же приёмом, что и «Лид в общем пуле «ничьих»» в leads.ts, без новых полей
 * схемы (schema.prisma сейчас правит другая сессия — лишнее поле подождёт):
 *  1) AUTO_THINKING_MARKER — заведена в routes/me.ts в момент «Итога показа»,
 *     срок — buyerThinkingFirstPingHours часов;
 *  2) SECOND_TIER_MARKER — заводит эта же функция, когда первая просрочена,
 *     срок — ещё buyerThinkingSecondPingHours часов после первой;
 *  3) SLOW_TRACK_MARKER — заводит эта же функция после второй, срок —
 *     buyerThinkingSlowTrackDays дней. Первые buyerThinkingSlowTrackCycles раз
 *     подряд продлевает САМА СЕБЯ тем же сроком («раз в неделю» по дефолту);
 *  4) FINAL_TRACK_MARKER — как только число уже отработанных еженедельных
 *     циклов достигает buyerThinkingSlowTrackCycles, следующий шаг заводится
 *     уже с этим маркером и сроком buyerThinkingFinalTrackDays («раз в две
 *     недели» по дефолту) — решение владельца 01.09.2026, поля схемы добавлены
 *     и смигрированы в тот же день. Дальше FINAL_TRACK_MARKER продлевает САМ
 *     СЕБЯ тем же buyerThinkingFinalTrackDays бесконечно — это терминальный
 *     темп: циклы на нём больше не считаются, перехода на что-то ещё более
 *     редкое нет.
 *
 * СЧЁТЧИК ЦИКЛОВ — отдельного поля под него не заводим (посчитать можно по
 * уже имеющимся данным — заводить лишнее поле дороже задачи): берём количество
 * ЗАВЕРШЁННЫХ (completedAt заполнен) Interaction с nextAction=SLOW_TRACK_MARKER
 * у этого клиента, тем же приёмом, что и остальные маркеры — состояние трека
 * целиком читается из истории Interaction, без счётчиков на Client/PendingSummary.
 * Как только это число достигает buyerThinkingSlowTrackCycles — следующая
 * заводимая задача уже с маркером FINAL_TRACK_MARKER, и обратного перехода нет:
 * FINAL_TRACK_MARKER никогда не сравнивается со SLOW_TRACK_MARKER, посчитать
 * циклы «уже на финальном темпе» просто не для чего.
 *
 * ОСТАНОВКА (проверяется на КАЖДОМ шаге, не только при заведении): клиент удалён,
 * закрыт (LOST/DEAL_CLOSED/ARCHIVED), ИЛИ агент с момента заведения ЭТОЙ задачи
 * уже записал по клиенту свежий «Итог показа» (новая Interaction type="MEETING",
 * созданная позже задачи) — неважно, каким исходом закончился: раз агент снова
 * посмотрел на клиента и что-то решил, подстраховка сделала своё дело.
 *
 * НЕ ПРОВЕРЯЕМ Client.buyerStage (найденная 30.08.2026 ошибка первой версии):
 * BuyerStage — реальный enum схемы со значениями ТОЛЬКО SELECTION/NEGOTIATION,
 * "THINKING" в нём нет и не было — это значение ветки «Итога показа»
 * (SHOWING_OUTCOME_BRANCHES), не буквенное состояние клиента. При branch="THINKING"
 * routes/me.ts buyerStage вообще не трогает (см. код: обновляется только для
 * SELECTION/NEGOTIATION, обнуляется для RESCHEDULE/DEAL, для THINKING — не входит
 * ни в одну ветку). Проверка `buyerStage === "THINKING"` была всегда ложна, и
 * трек молча умирал после первого же напоминания, ни разу не дойдя до шага 2.
 */
export const AUTO_THINKING_MARKER = "Связаться с клиентом — думает над показом (авто-подстраховка)";
const SECOND_TIER_MARKER = "Связаться с клиентом — думает над показом (авто-подстраховка, шаг 2)";
const SLOW_TRACK_MARKER = "Связаться с клиентом — думает над показом (медленный трек)";
const FINAL_TRACK_MARKER = "Связаться с клиентом — думает над показом (финальный темп)";
/** Задача, которую заводит ЯВНЫЙ выбор агента в «Итоге показа» (routes/me.ts):
 *  срок выбран человеком, автоматика её не ведёт и не продлевает. Маркеров в
 *  тексте у неё нет — это и есть признак «ведёт человек». */
export const MANUAL_THINKING_TASK = "Связаться с клиентом — думает над показом";

/**
 * ВСЕ ПЯТЬ ТЕКСТОВ ЗАДАЧИ «КЛИЕНТ ДУМАЕТ» — ручная и четыре ступени автотрека.
 *
 * Состояние ветки «думает» в этой CRM хранится текстом задачи, а не полем
 * (см. шапку файла: BuyerStage такого значения не имеет и никогда не имел).
 * Значит, любой, кому нужно ответить «клиент сейчас в «думает»?», обязан знать
 * все пять строк сразу — список живёт здесь, рядом с самими строками, чтобы
 * шестая ступень не появилась в одном месте и не потерялась в другом.
 *
 * Потребитель кроме самого трека: взвешенные слоты лимита лидов
 * (lib/leadLimits.ts) — «думающий» клиент занимает четверть слота.
 */
export const THINKING_TASK_MARKERS = [
  MANUAL_THINKING_TASK,
  AUTO_THINKING_MARKER,
  SECOND_TIER_MARKER,
  SLOW_TRACK_MARKER,
  FINAL_TRACK_MARKER,
] as const;

interface DueTask {
  id: string;
  clientId: string;
  agentId: string;
  createdAt: Date;
  client: {
    id: string;
    shortId: number;
    fullName: string;
    status: string;
    assignedAgentId: string | null;
    deletedAt: Date | null;
  } | null;
}

const CLOSED_STATUSES = new Set(["LOST", "DEAL_CLOSED", "ARCHIVED"]);

async function stillThinking(task: DueTask): Promise<boolean> {
  const client = task.client;
  if (!client || client.deletedAt !== null || CLOSED_STATUSES.has(client.status)) return false;
  const newerOutcome = await prisma.interaction.findFirst({
    where: { clientId: client.id, type: "MEETING", createdAt: { gt: task.createdAt } },
    select: { id: true },
  });
  return !newerOutcome;
}

async function advanceTier(marker: string, nextMarker: string, hoursOrDaysMs: number, now: Date): Promise<number> {
  const due = await prisma.interaction.findMany({
    where: { nextAction: marker, completedAt: null, taskCancelledAt: null, nextActionDate: { lte: now } },
    select: {
      id: true,
      clientId: true,
      agentId: true,
      createdAt: true,
      client: { select: { id: true, shortId: true, fullName: true, status: true, assignedAgentId: true, deletedAt: true } },
    },
    take: 200,
  });
  if (due.length === 0) return 0;

  const results = await mapWithConcurrency(due as DueTask[], TICK_CONCURRENCY, async (task) => {
    if (!(await stillThinking(task))) {
      // клиент закрыт или агент уже записал свежий «Итог показа» — трек останавливается сам
      await prisma.interaction.update({ where: { id: task.id }, data: { completedAt: now } });
      return false;
    }

    // stillThinking вернула true — client гарантированно не null (проверено внутри неё).
    const client = task.client!;
    const agentId = client.assignedAgentId ?? task.agentId;
    // Закрытие старой задачи и создание преемника — ОДНА транзакция (аудит Codex 04.10,
    // CHANNEL-NEW-02): раньше старая закрывалась первой, и временный сбой создания
    // преемника оставлял трек без единой незавершённой задачи, которую выборка
    // подхватила бы повторно. Условие completedAt: null, taskCancelledAt: null заодно не даёт двум
    // перекрывшимся тикам завести двух преемников.
    return prisma.$transaction(async (tx) => {
      const claimed = await tx.interaction.updateMany({
        where: { id: task.id, completedAt: null, taskCancelledAt: null },
        data: { completedAt: now },
      });
      if (claimed.count === 0) return false;
      await logTimeline({
        clientId: client.id,
        actor: { kind: "system", source: "buyerThinkingSlowTrack", subjectAgentId: agentId },
        type: "SYSTEM",
        notes: "Автонапоминание: клиент всё ещё думает над показом, агент не выбрал свою дату повторного контакта",
        nextAction: nextMarker,
        nextActionDate: new Date(now.getTime() + hoursOrDaysMs),
        tx,
      });
      return true;
    });
  });
  return results.filter(Boolean).length;
}

/** Тик медленного трека (SLOW_TRACK_MARKER): в отличие от advanceTier следующий
 *  маркер и срок не фиксированы — зависят от того, сколько полных еженедельных
 *  циклов клиент уже отходил (см. «СЧЁТЧИК ЦИКЛОВ» в шапке файла). Пока их
 *  меньше buyerThinkingSlowTrackCycles — продлеваем тем же SLOW_TRACK_MARKER и
 *  slowTrackMs; как только достигли — переключаем на FINAL_TRACK_MARKER и
 *  finalTrackMs, и это состояние уже терминальное (следующий тик такую задачу
 *  просто продлит через generic advanceTier(FINAL_TRACK_MARKER, FINAL_TRACK_MARKER, ...)). */
async function advanceSlowTrackTier(cycles: number, slowTrackMs: number, finalTrackMs: number, now: Date): Promise<number> {
  const due = await prisma.interaction.findMany({
    where: { nextAction: SLOW_TRACK_MARKER, completedAt: null, taskCancelledAt: null, nextActionDate: { lte: now } },
    select: {
      id: true,
      clientId: true,
      agentId: true,
      createdAt: true,
      client: { select: { id: true, shortId: true, fullName: true, status: true, assignedAgentId: true, deletedAt: true } },
    },
    take: 200,
  });
  if (due.length === 0) return 0;

  const results = await mapWithConcurrency(due as DueTask[], TICK_CONCURRENCY, async (task) => {
    if (!(await stillThinking(task))) {
      // клиент закрыт или агент уже записал свежий «Итог показа» — трек останавливается сам
      await prisma.interaction.update({ where: { id: task.id }, data: { completedAt: now } });
      return false;
    }

    const client = task.client!;
    const agentId = client.assignedAgentId ?? task.agentId;

    // Закрытие и преемник — одна транзакция, как в advanceTier (CHANNEL-NEW-02).
    return prisma.$transaction(async (tx) => {
      const claimed = await tx.interaction.updateMany({
        where: { id: task.id, completedAt: null, taskCancelledAt: null },
        data: { completedAt: now },
      });
      if (claimed.count === 0) return false;

      // Сколько еженедельных циклов у этого клиента уже полностью отработано,
      // включая тот, что только что закрыли выше (completedAt уже проставлен).
      const completedCycles = await tx.interaction.count({
        where: { clientId: client.id, nextAction: SLOW_TRACK_MARKER, completedAt: { not: null } },
      });
      const reachedFinal = completedCycles >= cycles;
      const nextMarker = reachedFinal ? FINAL_TRACK_MARKER : SLOW_TRACK_MARKER;
      const intervalMs = reachedFinal ? finalTrackMs : slowTrackMs;

      await logTimeline({
        clientId: client.id,
        actor: { kind: "system", source: "buyerThinkingSlowTrack", subjectAgentId: agentId },
        type: "SYSTEM",
        notes: "Автонапоминание: клиент всё ещё думает над показом, агент не выбрал свою дату повторного контакта",
        nextAction: nextMarker,
        nextActionDate: new Date(now.getTime() + intervalMs),
        tx,
      });
      return true;
    });
  });
  return results.filter(Boolean).length;
}

/** ОДИН ТИК — крон вызывает раз в 30 минут (см. cron.ts), тем же ритмом, что и
 *  светофор неактивных/антифрод «продавец без объекта». */
export async function runBuyerThinkingSlowTrackTick(now: Date = new Date()): Promise<{ advanced: number }> {
  const s = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: {
      buyerThinkingSecondPingHours: true,
      buyerThinkingSlowTrackDays: true,
      buyerThinkingSlowTrackCycles: true,
      buyerThinkingFinalTrackDays: true,
    },
  });
  const secondPingMs = (s?.buyerThinkingSecondPingHours ?? 72) * 3600_000;
  const slowTrackMs = (s?.buyerThinkingSlowTrackDays ?? 7) * 86_400_000;
  const slowTrackCycles = s?.buyerThinkingSlowTrackCycles ?? 4;
  const finalTrackMs = (s?.buyerThinkingFinalTrackDays ?? 14) * 86_400_000;

  const step1to2 = await advanceTier(AUTO_THINKING_MARKER, SECOND_TIER_MARKER, secondPingMs, now);
  const step2toSlow = await advanceTier(SECOND_TIER_MARKER, SLOW_TRACK_MARKER, slowTrackMs, now);
  const slowRenew = await advanceSlowTrackTier(slowTrackCycles, slowTrackMs, finalTrackMs, now);
  const finalRenew = await advanceTier(FINAL_TRACK_MARKER, FINAL_TRACK_MARKER, finalTrackMs, now);

  return { advanced: step1to2 + step2toSlow + slowRenew + finalRenew };
}
