import type { ScenarioComparison, ScenarioStats, ScenarioVerdict } from "@royal-home/shared";
import { prisma } from "../db.js";
import { SALES_SCENARIOS, scenarioById, scenarioName } from "../ai/salesScenarios.js";

/**
 * Результат сравнения сценариев продаж — по фактам из базы, а не по ощущениям.
 *
 * Что считаем и почему именно это.
 *
 * 1. СКОЛЬКО ДИАЛОГОВ НАЧАТО — знаменатель. Без него доли врут: сценарий с тремя
 *    заявками из четырёх диалогов выглядит чемпионом ровно до пятого диалога.
 * 2. СКОЛЬКО КОНЧИЛОСЬ ЗАЯВКОЙ — `BotConversation.clientId` заполнен. Это и есть
 *    результат, ради которого бот существует: телефон получен, лид заведён, агент
 *    работает. Оценок «понравился ли ответ» здесь нет намеренно — их некому дать.
 * 3. СКОЛЬКО УШЛО МОЛЧА — берём ГОТОВЫЙ вердикт CRM: запись в LostConversation.
 *    Второго определения «ушёл» здесь нарочно НЕТ. Оно уже есть в
 *    lib/lostConversations.ts (заявки нет, живой сотрудник не вмешивался, тишина
 *    дольше полутора суток), там же живут его пороги, и ночной разбор каждую ночь
 *    применяет его к живым диалогам. Своя копия условия рано или поздно разошлась
 *    бы с той, и владелец получил бы два разных ответа на один вопрос.
 * 4. ОСТАЛЬНОЕ — «ещё не решилось»: разговор идёт, либо ночной разбор до него не
 *    дошёл (у него потолок на проход). Эту долю показываем отдельно и честно, а не
 *    приписываем к потерям: приписав, мы завышали бы провал у самых свежих диалогов.
 */

/** 95% — обычный уровень, при котором «разница есть» ещё можно говорить вслух. */
const Z = 1.96;

/**
 * Минимум диалогов на сценарий, ниже которого никакие проценты не показываются
 * как вывод. Тридцать — не магия: при обычной для мессенджеров конверсии (10-20%)
 * это две-пять заявок, и один случайный клиент двигает долю на 3-4 пункта. Меньше
 * тридцати — это не «слабый сигнал», это отсутствие сигнала.
 */
export const MIN_CONVERSATIONS_PER_SCENARIO = 30;

/** Потолок для оценки «сколько ещё нужно»: дальше число перестаёт быть советом и
 *  становится приговором, а к тому времени сценарии всё равно перепишут. */
const MAX_REQUIRED = 5000;
/** Запасная оценка, когда заявок нет вовсе и считать долю не от чего. */
const REQUIRED_WITHOUT_LEADS = 400;

// Типы описаны один раз в @royal-home/shared: их же читает экран Настроек, и
// копии здесь и там успели разойтись составом полей.
export type { ScenarioStats, ScenarioVerdict, ScenarioComparison };

/**
 * Интервал Уилсона: где на самом деле лежит доля, если у нас всего n наблюдений.
 *
 * Обычный «±» (нормальное приближение) на малых числах и редких событиях врёт
 * особенно нагло: при 1 заявке из 12 он выдаёт границы, заезжающие ниже нуля.
 * Уилсон устойчив ровно там, где нам и нужно — на первых десятках диалогов.
 */
export function wilsonInterval(successes: number, total: number): { low: number; high: number } {
  if (total <= 0) return { low: 0, high: 0 };
  const p = successes / total;
  const z2n = (Z * Z) / total;
  const center = (p + z2n / 2) / (1 + z2n);
  const margin =
    (Z / (1 + z2n)) * Math.sqrt((p * (1 - p)) / total + (Z * Z) / (4 * total * total));
  return { low: Math.max(0, center - margin), high: Math.min(1, center + margin) };
}

/**
 * Сколько диалогов на сценарий нужно, чтобы отличие было видно.
 *
 * Считаем на «полторы штуки»: сколько нужно, чтобы заметить сценарий, который даёт
 * в полтора раза больше заявок, чем нынешний. Прицел именно такой, потому что
 * разницу в пару процентов ловить бессмысленно — она не окупит ни времени, ни
 * риска гонять клиентов через непроверенную манеру разговора.
 *
 * Формула — стандартная для сравнения двух долей при 5% ошибке и 80% чувствительности:
 * n ≈ 16·p·(1−p)/Δ². При Δ = 0.5·p она сворачивается в n ≈ 64·(1−p)/p. Отсюда и
 * порядок величин: при конверсии 20% нужно ~256 диалогов на сценарий, при 10% ~576.
 */
export function requiredPerScenario(pooledRate: number): number {
  if (pooledRate <= 0 || pooledRate >= 1) return REQUIRED_WITHOUT_LEADS;
  return Math.min(MAX_REQUIRED, Math.ceil((64 * (1 - pooledRate)) / pooledRate));
}

/**
 * Вывод по набранным числам. Порядок проверок — от самого частого «нет» к «да»:
 * сначала мало данных, потом разница в пределах случайности, и только потом лидер.
 *
 * «Лидером» сценарий становится, только когда его интервал не пересекается с
 * интервалом следующего. Сравнивать голые проценты нельзя: 18% против 15% на
 * сорока диалогах — это одна заявка разницы, то есть ничего.
 */
/** Минимум, которого хватает для вывода. Отдельным типом, потому что тем же
 *  сравнением живут поставщики ИИ (lib/aiProviderStats.ts): математика у них общая,
 *  и вторая её копия однажды разошлась бы с этой. */
export interface ComparableArm {
  id: string;
  conversations: number;
  rate: number;
  rateLow: number;
  rateHigh: number;
  enough: boolean;
}

export function decideVerdict(scenarios: ComparableArm[]): { verdict: ScenarioVerdict; leaderId: string | null } {
  const played = scenarios.filter((s) => s.conversations > 0);
  if (played.length === 0) return { verdict: "no_data", leaderId: null };
  // Сравнивать не с чем — один сценарий это не сравнение.
  if (played.length < 2) return { verdict: "too_little", leaderId: null };
  if (played.some((s) => !s.enough)) return { verdict: "too_little", leaderId: null };

  const sorted = [...played].sort((a, b) => b.rate - a.rate);
  const [first, second] = sorted;
  if (first.rateLow > second.rateHigh) return { verdict: "leader", leaderId: first.id };
  return { verdict: "no_difference", leaderId: null };
}

/** Строка сырого подсчёта по одному сценарию. */
interface RawRow {
  id: string;
  conversations: number;
  leads: number;
  lost: number;
  startedAt: Date;
}

/**
 * Числа по каждому сценарию — ОДНИМ запросом.
 *
 * Почему $queryRaw, а не groupBy Prisma. У LostConversation нет связи с
 * BotConversation (там просто строка conversationId), и собрать «ушедших» через
 * Prisma можно было бы только вытащив все id потерянных диалогов в память — это
 * выборка без предела, ровно то, чего в роутах быть не должно. Здесь же вся
 * свёртка происходит в базе и наружу выходит по строке на сценарий, то есть три.
 */
async function countByScenario(): Promise<RawRow[]> {
  return prisma.$queryRaw<RawRow[]>`
    SELECT c."salesScenario" AS id,
           COUNT(*)::int AS conversations,
           COUNT(c."clientId")::int AS leads,
           COUNT(*) FILTER (WHERE c."clientId" IS NULL AND l."id" IS NOT NULL)::int AS lost,
           MIN(c."createdAt") AS "startedAt"
    FROM "BotConversation" c
    LEFT JOIN "LostConversation" l ON l."conversationId" = c."id"
    WHERE c."salesScenario" IS NOT NULL
    GROUP BY c."salesScenario"`;
}

/**
 * Полное сравнение сценариев для экрана Настройки → Бот.
 *
 * В список попадают ВСЕ сценарии реестра, даже с нулём диалогов (иначе владелец не
 * увидит, что жребий до кого-то не дошёл), плюс коды из базы, которых в реестре уже
 * нет: их числа настоящие и прятать их нечестно.
 */
export async function buildScenarioComparison(): Promise<ScenarioComparison> {
  const [rows, settings] = await Promise.all([
    countByScenario(),
    prisma.settings.findUnique({ where: { id: "singleton" }, select: { salesScenarioTestEnabled: true } }),
  ]);

  const byId = new Map(rows.map((r) => [r.id, r]));
  // Реестр задаёт порядок вывода: контроль первым, дальше манеры в порядке кода.
  // Сортировать по результату нельзя — таблица переставлялась бы от каждой новой
  // заявки, и следить за одним сценарием стало бы невозможно.
  const ids = [...SALES_SCENARIOS.map((s) => s.id), ...rows.map((r) => r.id).filter((id) => !scenarioById(id))];

  const scenarios: ScenarioStats[] = [...new Set(ids)].map((id) => {
    const row = byId.get(id);
    const conversations = row?.conversations ?? 0;
    const leads = row?.leads ?? 0;
    const lost = row?.lost ?? 0;
    const known = !!scenarioById(id);
    const { low, high } = wilsonInterval(leads, conversations);
    return {
      id,
      name: scenarioName(id),
      summary: scenarioById(id)?.summary ?? "Сценарий удалён из кода, но диалоги по нему остались.",
      known,
      conversations,
      leads,
      lost,
      undecided: conversations - leads - lost,
      rate: conversations > 0 ? leads / conversations : 0,
      rateLow: low,
      rateHigh: high,
      enough: conversations >= MIN_CONVERSATIONS_PER_SCENARIO,
    };
  });

  const totalConversations = scenarios.reduce((sum, s) => sum + s.conversations, 0);
  const totalLeads = scenarios.reduce((sum, s) => sum + s.leads, 0);
  const startedAt = rows.reduce<Date | null>(
    (min, r) => (r.startedAt && (!min || r.startedAt < min) ? r.startedAt : min),
    null
  );

  return {
    testEnabled: settings?.salesScenarioTestEnabled === true,
    scenarios,
    totalConversations,
    totalLeads,
    ...decideVerdict(scenarios),
    requiredPerScenario: requiredPerScenario(totalConversations > 0 ? totalLeads / totalConversations : 0),
    startedAt: startedAt ? startedAt.toISOString() : null,
  };
}
