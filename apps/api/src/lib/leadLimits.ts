import { prisma } from "../db.js";
import { conductedShowingBaseWhere } from "./conductedShowing.js";
import { THINKING_TASK_MARKERS } from "./buyerThinkingSlowTrack.js";

/**
 * Лимит активных лидов — в одном месте.
 *
 * До 11.08.2026 фолбэк был написан трижды и трижды числом 5 (leads.ts,
 * routes/dashboard.ts, MoneyTab.tsx), тогда как в схеме с 03.08 стоит
 * `@default(6)`. Расходились они молча: агент видел на дашборде «5 из 5» и
 * получал шестой лид. Одна функция вместо трёх копий — чтобы следующая правка
 * числа не оставила позади ещё один экран.
 *
 * Здесь же живёт РАЗДЕЛЬНЫЙ подсчёт лидов, без которого не выразить правило
 * владельца от 11.08.2026: лимит ограничивает смешанный портфель, а лиды по
 * своим объектам («на 1%») за него выходят.
 */

/**
 * Состояния, которые НИКОГДА не занимают слот в лимите — сделка закрыта или
 * клиент потерян, слот освобождён окончательно (в отличие от workStatus=INACTIVE,
 * который освобождает слот, оставаясь при этом обратимым).
 */
const TERMINAL_STATUSES = ["LOST", "DEAL_CLOSED", "ARCHIVED"] as const;

/**
 * Условие «занимает слот в лимите» (переработка 12.08.2026, ТЗ владельца: «пока
 * один из клиентов не будет закрыт, новый лид агенту не распределяется»).
 *
 * ДО ЭТОГО занятость мерили по ClientStatus (NEW/CONTACTED/HOT) — из-за чего
 * COLD и UNRESPONSIVE слот молча не занимали, хотя ничьё явное решение их не
 * закрывало. Теперь единственный сигнал «закрыт» — это действие агента
 * (workStatus="INACTIVE", «Передача», «Завершить сделку»), а не то, до какой
 * степени клиент остыл сам по себе.
 */
/**
 * ЛИМИТ — ТОЛЬКО НА ПОКУПАТЕЛЕЙ (владелец 20.08.2026, дословно: «лимита нет на
 * продавцов, то есть кто-то продаёт квартиру — такие лиды должны без лимита
 * приходить», лимит на 6 покупателей).
 *
 * ПОЧЕМУ. Покупатель — это работа вширь: подбор, показы, переговоры, и держать
 * их одновременно можно ровно столько, скольким успеваешь звонить; ради этого
 * лимит и заводился. Продавец — работа вглубь по ОДНОМУ объекту: принять, снять,
 * выставить. Он не соревнуется с покупателями за время агента и, главное,
 * приносит агентству объект — отказывать в приёме объекта из-за того, что у
 * агента шесть покупателей, значит терять товар, которого и так мало.
 *
 * `kind: "BUYER"` здесь закрывает ОБА конца правила разом: продавец не занимает
 * слот (activeLeadCounts считает по этому же условию) и не упирается в лимит при
 * раздаче (pickByKpiQueue сравнивает с тем же счётчиком). Прочие обращения
 * (kind="OTHER") в раздаче не участвуют вовсе — см. acceptingLeadsWhere в leads.ts.
 */
export const OCCUPIES_SLOT_WHERE = {
  assignmentCompletedAt: null,
  kind: "BUYER" as const,
  workStatus: "ACTIVE" as const,
  status: { notIn: [...TERMINAL_STATUSES] },
};

/**
 * Лимит, когда строки Settings ещё нет вовсе (пустая база, первый запуск).
 *
 * ШЕСТЬ — цифра из спецификации владельца (31.07.2026, «Ограничение по лидам»),
 * она же стоит в `@default(6)` у Settings.leadActiveLimit. В коде до 11.08.2026
 * фолбэк был написан пятёркой в трёх местах сразу, и агент видел на дашборде
 * «5 из 5», получая при этом шестой лид. Число живёт здесь в единственном
 * экземпляре — импортировать, а не повторять.
 */
export const DEFAULT_LEAD_ACTIVE_LIMIT = 6;

export interface LeadLimits {
  /** Предел смешанного портфеля. 0 = без лимита. */
  activeLimit: number;
  /** Пускать ли лиды по своим объектам сверх предела. */
  overLimitEnabled: boolean;
  /** Предлагать ли освободить место, отдав обычный лид. */
  releaseEnabled: boolean;
  /**
   * Кто выбирает освобождаемого клиента. "random" убран по закону владения
   * (П-4/П-6, 17.09.2026) — система жертву больше не выбирает сама, поле
   * оставлено в типе только ради обратной совместимости старых записей
   * настроек в БД (миграция не делалась).
   */
  releaseMode: "agent_choice" | "random";
  /** Потолок лидов по своим объектам сверх предела. 0 = без предела. */
  ownPropertyCap: number;
  /** Считать ли слоты взвешенно — см. SLOT_WEIGHTS_DOC ниже. */
  weightedSlotsEnabled: boolean;
}

/**
 * ВЗВЕШЕННЫЕ СЛОТЫ (мозговой штурм владельца 20-21.08.2026, «Логика 2.0»,
 * рубеж «слив»): «дальний прицел — взвешенные слоты (свежий 1.0 / после показа
 * 0.5 / думает 0.25): гейминг становится бессмысленным, а не запрещённым».
 *
 * ЗАЧЕМ. Слот сейчас одинаков для всех: свежий лид, по которому ещё не
 * звонили, и клиент после трёх показов занимают ровно одно из шести мест.
 * Отсюда прецедент 20.08.2026 — чтобы освободить место под новый лид, агенту
 * выгодно слить в Неактивные того, с кем работа почти сделана. Веса убирают
 * саму выгоду, ничего не запрещая.
 *
 * ЧТО СЧИТАЕТСЯ ЧЕМ (ровно три ступени плана, других нет):
 *  • «свежий» — проведённого показа ещё не было (lib/conductedShowing.ts, то же
 *    определение «проведён», по которому открываются «Передать» и «Завершить
 *    сделку»: не отменён И либо отмечен выполненным, либо записан задним
 *    числом, либо его время прошло);
 *  • «после показа» — хотя бы один проведённый показ есть;
 *  • «думает» — по клиенту висит незакрытая задача ветки «думает» из «Итога
 *    показа» (THINKING_TASK_MARKERS). Эта ветка бывает только ПОСЛЕ показа,
 *    поэтому она перекрывает предыдущую, а не складывается с ней.
 *
 * ВЫКЛЮЧЕНО ПО УМОЛЧАНИЮ (Settings.weightedLeadSlotsEnabled = false). Правило
 * меняет раздачу лидов всей компании, живьём владелец его не видел; пока
 * рубильник выключен, activeLeadCounts не делает НИ ОДНОГО лишнего запроса и
 * weighted равен total байт в байт.
 */
interface SlotWeights {
  enabled: boolean;
  fresh: number;
  afterShowing: number;
  thinking: number;
}

/**
 * Отрицательный вес перевернул бы лимит с ног на голову (чем больше клиентов,
 * тем свободнее агент), поэтому ноль — нижняя граница. Верхней нет: владелец
 * вправе сделать «думающего» дороже свежего, если решит, что так честнее.
 */
function weightFromPercent(percent: number | undefined, fallback: number): number {
  const p = percent ?? fallback;
  return Math.max(0, p) / 100;
}

async function loadSlotWeights(): Promise<SlotWeights> {
  const s = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: {
      weightedLeadSlotsEnabled: true,
      leadSlotWeightFreshPercent: true,
      leadSlotWeightAfterShowingPercent: true,
      leadSlotWeightThinkingPercent: true,
    },
  });
  return {
    enabled: s?.weightedLeadSlotsEnabled ?? false,
    fresh: weightFromPercent(s?.leadSlotWeightFreshPercent, 100),
    afterShowing: weightFromPercent(s?.leadSlotWeightAfterShowingPercent, 50),
    thinking: weightFromPercent(s?.leadSlotWeightThinkingPercent, 25),
  };
}

export async function loadLeadLimits(): Promise<LeadLimits> {
  const s = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: {
      leadActiveLimit: true,
      ownPropertyOverLimitEnabled: true,
      ownPropertyReleaseEnabled: true,
      ownPropertyReleaseMode: true,
      ownPropertyLeadCap: true,
      weightedLeadSlotsEnabled: true,
    },
  });
  return {
    activeLimit: s?.leadActiveLimit ?? DEFAULT_LEAD_ACTIVE_LIMIT,
    overLimitEnabled: s?.ownPropertyOverLimitEnabled ?? true,
    releaseEnabled: s?.ownPropertyReleaseEnabled ?? true,
    releaseMode: s?.ownPropertyReleaseMode === "random" ? "random" : "agent_choice",
    weightedSlotsEnabled: s?.weightedLeadSlotsEnabled ?? false,
    /**
     * Фолбэк — ЕДИНИЦА, как `@default(1)` в схеме. Стоял ноль, а ноль здесь
     * означает «без предела вовсе»: на пустой базе правило владельца от 13.08.2026
     * («не более 7 активных») молча выключалось, и портфель по своим объектам рос
     * без края. Ровно та же ошибка, из-за которой и появился этот файл: фолбэк
     * разошёлся с умолчанием колонки и разошёлся молча (см. шапку про «5 из 5»).
     */
    ownPropertyCap: s?.ownPropertyLeadCap ?? 1,
  };
}

export interface LeadCounts {
  /** Всего активных лидов у агента — ШТУКАМИ. Это число показывают экраны. */
  total: number;
  /** Из них по СВОИМ объектам («на 1%») — они за лимит выходить могут. */
  own: number;
  /** Из них обычные («на 0.5%») — только их и предлагается освободить. */
  regular: number;
  /**
   * Сколько СЛОТОВ лимита эти лиды занимают на самом деле — дробное число.
   * Пока взвешивание выключено, равно total. Сверять с лимитом надо это
   * значение, а не total, — для того и есть slotsTaken() ниже.
   */
  weighted: number;
}

/**
 * СКОЛЬКО СЛОТОВ ЛИМИТА ЗАНЯТО — единственное число, которое можно сравнивать
 * с activeLimit.
 *
 * Отдельная функция, а не поле, чтобы обе стороны правила лежали рядом:
 * штучный total идёт на экраны («5 из 6»), взвешенный — в решения о раздаче.
 * Раньше в решениях стоял total, и первая же строка `counts.total >= limit`,
 * пропущенная при включении весов, тихо вернула бы старое поведение в одном
 * месте из десяти.
 */
export function slotsTaken(counts: LeadCounts | undefined, limits: Pick<LeadLimits, "weightedSlotsEnabled">): number {
  if (!counts) return 0;
  return limits.weightedSlotsEnabled ? counts.weighted : counts.total;
}

/**
 * Сколько активных лидов у каждого агента, с разбивкой на свои и обычные.
 *
 * Одним запросом на всех: цикл с подсчётом на агента давал обращение к базе
 * на каждого кандидата при выборе получателя лида.
 *
 * Со включёнными весами запросов три (портфель, проведённые показы, задачи
 * «думает») — тоже сразу по всем агентам, без цикла: N+1 здесь означал бы
 * запрос на каждого кандидата в каждой раздаче лида.
 */
export async function activeLeadCounts(agentIds: string[]): Promise<Map<string, LeadCounts>> {
  const result = new Map<string, LeadCounts>();
  if (agentIds.length === 0) return result;
  for (const id of agentIds) result.set(id, { total: 0, own: 0, regular: 0, weighted: 0 });

  const weights = await loadSlotWeights();

  const portfolioWhere = {
    assignedAgentId: { in: agentIds },
    ...OCCUPIES_SLOT_WHERE,
    // Удалённые в Корзину не создают агенту реальной нагрузки — иначе лимит
    // запирал бы приём из-за записей, которых для человека уже не существует.
    deletedAt: null,
  };

  if (!weights.enabled) {
    const rows = await prisma.client.groupBy({
      by: ["assignedAgentId", "ownPropertyLead"],
      where: portfolioWhere,
      _count: { _all: true },
    });
    for (const row of rows) {
      if (!row.assignedAgentId) continue;
      const counts = result.get(row.assignedAgentId);
      if (!counts) continue;
      const n = row._count._all;
      counts.total += n;
      counts.weighted += n;
      if (row.ownPropertyLead) counts.own += n;
      else counts.regular += n;
    }
    return result;
  }

  // Взвешенный режим: нужны сами карточки, а не только их количество — вес
  // зависит от стадии каждой. Выборка ограничена активным портфелем этих
  // агентов (по лимиту это единицы карточек на человека), поэтому «весь список
  // в память» здесь не безразмерная выборка, а ровно то, что и так считалось.
  const clients = await prisma.client.findMany({
    where: portfolioWhere,
    select: { id: true, assignedAgentId: true, ownPropertyLead: true },
  });
  if (clients.length === 0) return result;

  const clientIds = clients.map((c) => c.id);
  const now = new Date();
  const [shownRows, thinkingRows] = await Promise.all([
    prisma.interaction.findMany({
      where: { clientId: { in: clientIds }, ...conductedShowingBaseWhere(now) },
      select: { clientId: true },
      distinct: ["clientId"],
    }),
    prisma.interaction.findMany({
      where: {
        clientId: { in: clientIds },
        completedAt: null, taskCancelledAt: null,
        nextAction: { in: [...THINKING_TASK_MARKERS] },
      },
      select: { clientId: true },
      distinct: ["clientId"],
    }),
  ]);
  const hadShowing = new Set(shownRows.map((r) => r.clientId));
  const isThinking = new Set(thinkingRows.map((r) => r.clientId));

  for (const c of clients) {
    if (!c.assignedAgentId) continue;
    const counts = result.get(c.assignedAgentId);
    if (!counts) continue;
    counts.total += 1;
    if (c.ownPropertyLead) counts.own += 1;
    else counts.regular += 1;
    // Порядок веток — не косметика: «думает» бывает только после показа и
    // обязана перекрывать его, иначе третья ступень плана недостижима.
    counts.weighted += isThinking.has(c.id)
      ? weights.thinking
      : hadShowing.has(c.id)
        ? weights.afterShowing
        : weights.fresh;
  }
  return result;
}

/** Пустой счёт — для агента, которого нет в выборке (лидов у него нет). */
export const NO_LEADS: LeadCounts = { total: 0, own: 0, regular: 0, weighted: 0 };
