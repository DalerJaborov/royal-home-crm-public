/**
 * Сравнение манер продажи бота — общий словарь для сервера и экрана Настроек.
 *
 * Типы были объявлены дважды и успели разойтись: у веб-клиента в описании ответа
 * есть `minConversationsPerScenario`, у сервера в его собственном типе — нет,
 * потому что поле добавляется уже в маршруте поверх расчёта. Пока стороны
 * описывают ответ каждая по-своему, такое расхождение не замечает никто: в этой
 * паре компилятор молчит.
 *
 * Поэтому здесь их два: `ScenarioComparison` — то, что считает движок, и
 * `ScenarioComparisonResponse` — то, что реально уходит на экран.
 */

/** Числа по одной манере продажи. */
export interface ScenarioStats {
  id: string;
  name: string;
  summary: string;
  /** Есть ли манера ещё в реестре кода. false — диалоги по ней прошли, а сама она удалена. */
  known: boolean;
  /** Сколько диалогов досталось этой манере. */
  conversations: number;
  /** Сколько из них кончилось созданной заявкой. */
  leads: number;
  /** Сколько признано ушедшими молча (по разбору оборванных переписок). */
  lost: number;
  /** Ни заявки, ни вердикта «ушёл»: разговор ещё идёт или разбор до него не дошёл. */
  undecided: number;
  /** Доля заявок, 0..1. Считается от ВСЕХ диалогов манеры, включая нерешённые. */
  rate: number;
  /** Границы того, где эта доля может лежать на самом деле (интервал Уилсона, 95%). */
  rateLow: number;
  rateHigh: number;
  /** Набралось ли диалогов хотя бы до порога, ниже которого выводы не делаются. */
  enough: boolean;
}

export type ScenarioVerdict =
  /** Сравнение ещё не дало ни одного диалога. */
  | "no_data"
  /** Диалоги есть, но хотя бы у одной манеры их слишком мало для любого вывода. */
  | "too_little"
  /** Данных достаточно, но разница между манерами в пределах случайности. */
  | "no_difference"
  /** Одна манера уверенно впереди. */
  | "leader";

/** Результат расчёта (lib/salesScenarioStats.ts). */
export interface ScenarioComparison {
  /** Включено ли сравнение прямо сейчас. */
  testEnabled: boolean;
  scenarios: ScenarioStats[];
  totalConversations: number;
  totalLeads: number;
  verdict: ScenarioVerdict;
  /** Код победителя — только при verdict="leader". */
  leaderId: string | null;
  /** Сколько диалогов на КАЖДУЮ манеру нужно, чтобы вывод стал осмысленным. */
  requiredPerScenario: number;
  /** Когда начался первый диалог с манерой. null — сравнение ещё не начиналось. */
  startedAt: string | null;
}

/** Что уходит на экран: расчёт плюс порог, ниже которого сервер не берётся сравнивать. */
export interface ScenarioComparisonResponse extends ScenarioComparison {
  minConversationsPerScenario: number;
}
