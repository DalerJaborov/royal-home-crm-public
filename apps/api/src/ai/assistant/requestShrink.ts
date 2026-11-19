/**
 * СЖАТИЕ ЗАПРОСА ПОМОЩНИЦЫ, КОГДА ВХОД НЕ ВЛЕЗ В ПРЕДЕЛ ТОКЕНОВ (19.11.2026).
 *
 * Прод 19.11: директор попросил «подробный список» обращений за день, на втором шаге
 * хода в запрос легли два больших результата инструментов, вход перевалил за предел,
 * и человек получил «лимит вызовов ИИ достигнут» при потраченных 1,47 $ из 30.
 * Теперь слишком большой запрос сначала ужимается и повторяется (не больше
 * MAX_SHRINK_RETRIES раз на шаг, каждая попытка — через тот же кошелёк хода), и
 * только если не влезло и так — человек слышит «сузьте вопрос».
 *
 * Порядок сжатия (от наименее ценного для ответа):
 *  1. Самые большие результаты инструментов этого хода режутся «водой» до общей доли:
 *     у списка остаются первые N записей, а модель получает честную пометку
 *     «показаны первые N из M, предложи сузить вопрос» — иначе она выдала бы часть
 *     за целое. Порядок записей сохраняется (инструменты уже отдают их по важности).
 *  2. Если результатов мало, а запрос всё ещё велик, — уходят самые старые реплики
 *     прошлых ходов (окно истории). Текущий вопрос и всё, что модель сделала в этом
 *     ходе (вызовы и ответы инструментов, подписи мыслей), не трогаются никогда:
 *     без пары functionCall/functionResponse Google отвергает запрос.
 * Вторая попытка целится ниже первой: соотношение «знаков на токен» у результатов
 * (кириллица в JSON) хуже среднего по запросу, и одна оценка может не попасть.
 */

export const MAX_SHRINK_RETRIES = 2;
/** Доля предела, в которую целится сжатие на попытке 1 и 2. */
const TARGET_SHARE = [0.8, 0.6] as const;
/** Меньше этого результат не режется: пометка и пара записей важнее пустоты. */
const MIN_RESULT_CHARS = 1_200;

type Part = Record<string, unknown>;
export interface ShrinkContent {
  role: "user" | "model";
  parts: Part[];
}

export interface ShrinkMeasure {
  inputTokens: number;
  requestChars: number;
  limitTokens: number;
}

export interface ShrinkReport {
  changed: boolean;
  /** Обрезанные результаты: имя инструмента, сколько показано и сколько было. */
  truncated: { name: string; shown: number | null; total: number | null }[];
  droppedHistory: number;
}

export function shrinkNote(shown: number, total: number): string {
  return (
    `Список обрезан из-за размера: показаны первые ${shown} из ${total}. ` +
    "Обязательно скажи человеку, что это только часть, и предложи сузить вопрос " +
    "(один день, один агент или первые 10 строк). Не выдавай часть за весь список."
  );
}

const WHOLE_NOTE =
  "Результат слишком большой и показан только началом. Скажи человеку, что данных больше, " +
  "и предложи сузить вопрос (один день, один агент или первые 10 строк).";

const size = (value: unknown): number => JSON.stringify(value ?? null).length;

/** Самый тяжёлый массив внутри результата (до трёх уровней вглубь) — путь к нему. */
function heaviestArrayPath(value: unknown, depth = 0): { path: (string | number)[]; weight: number } | null {
  if (depth > 3 || value === null || typeof value !== "object") return null;
  let best: { path: (string | number)[]; weight: number } | null = null;
  if (Array.isArray(value)) {
    best = { path: [], weight: size(value) };
    return best;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const found = heaviestArrayPath(child, depth + 1);
    if (found && (!best || found.weight > best.weight)) best = { path: [key, ...found.path], weight: found.weight };
  }
  return best;
}

function withArrayAt(root: unknown, path: (string | number)[], keep: number, total: number): unknown {
  const note = shrinkNote(keep, total);
  if (path.length === 0) {
    return { items: (root as unknown[]).slice(0, keep), _обрезано: note };
  }
  const clone = JSON.parse(JSON.stringify(root)) as Record<string, unknown>;
  let node: Record<string, unknown> = clone;
  for (const key of path.slice(0, -1)) node = node[key as string] as Record<string, unknown>;
  const last = path[path.length - 1] as string;
  node[last] = (node[last] as unknown[]).slice(0, keep);
  clone._обрезано = note;
  return clone;
}

/**
 * Результат инструмента не длиннее maxChars знаков JSON. Список режется с конца
 * (двоичным поиском по числу записей), остальное — началом текста с пометкой.
 */
export function shrinkToolResult(result: unknown, maxChars: number): { value: unknown; shown: number | null; total: number | null } | null {
  if (size(result) <= maxChars) return null;
  const found = heaviestArrayPath(result);
  if (found) {
    let node: unknown = result;
    for (const key of found.path) node = (node as Record<string, unknown>)[key as string];
    const list = node as unknown[];
    let lo = 0;
    let hi = list.length - 1;
    let best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (size(withArrayAt(result, found.path, mid, list.length)) <= maxChars) {
        best = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    if (best >= 0) return { value: withArrayAt(result, found.path, best, list.length), shown: best, total: list.length };
  }
  const text = JSON.stringify(result);
  return { value: { _обрезано: WHOLE_NOTE, начало: text.slice(0, Math.max(0, maxChars - WHOLE_NOTE.length - 40)) }, shown: null, total: null };
}

/** Ответ инструмента в части запроса — { functionResponse: { name, response: { result } } }. */
function responseOf(part: Part): { name: string; holder: { result?: unknown } } | null {
  const fr = part.functionResponse as { name?: unknown; response?: unknown } | undefined;
  if (!fr || typeof fr !== "object" || !fr.response || typeof fr.response !== "object") return null;
  return { name: typeof fr.name === "string" ? fr.name : "?", holder: fr.response as { result?: unknown } };
}

/**
 * Ужать conversation НА МЕСТЕ. protectedFrom — индекс текущего вопроса человека:
 * всё начиная с него (вопрос, вызовы и ответы инструментов хода) не удаляется,
 * а у ответов инструментов режется только содержимое.
 */
export function shrinkConversation(
  conversation: ShrinkContent[],
  protectedFrom: number,
  measure: ShrinkMeasure,
  attempt: number,
): ShrinkReport {
  const report: ShrinkReport = { changed: false, truncated: [], droppedHistory: 0 };
  const share = TARGET_SHARE[Math.min(attempt, TARGET_SHARE.length) - 1] ?? TARGET_SHARE[TARGET_SHARE.length - 1];
  const charsPerToken = measure.requestChars / Math.max(1, measure.inputTokens);
  // Сколько знаков убрать, чтобы вход ушёл к доле предела (оценка по точному подсчёту Google).
  let excess = Math.ceil((measure.inputTokens - measure.limitTokens * share) * charsPerToken);
  if (excess <= 0) return report;

  // 1. Результаты инструментов: «вода» — общий потолок c, выше которого режется каждый.
  const responses: { name: string; holder: { result?: unknown }; chars: number }[] = [];
  for (const content of conversation.slice(protectedFrom)) {
    for (const part of content.parts) {
      const r = responseOf(part);
      if (r) responses.push({ ...r, chars: size(r.holder.result) });
    }
  }
  const total = responses.reduce((sum, r) => sum + r.chars, 0);
  if (responses.length && total > responses.length * MIN_RESULT_CHARS) {
    const allowed = Math.max(responses.length * MIN_RESULT_CHARS, total - excess);
    const sorted = responses.map((r) => r.chars).sort((a, b) => a - b);
    let cap = Number.POSITIVE_INFINITY; // все влезают целиком — резать нечего
    let rest = allowed;
    for (let i = 0; i < sorted.length; i++) {
      const even = Math.floor(rest / (sorted.length - i));
      if (sorted[i] <= even) {
        rest -= sorted[i];
        continue;
      }
      cap = Math.max(MIN_RESULT_CHARS, even);
      break;
    }
    if (sorted[sorted.length - 1] > cap) {
      for (const r of responses) {
        if (r.chars <= cap) continue;
        const cut = shrinkToolResult(r.holder.result, cap);
        if (!cut) continue;
        r.holder.result = cut.value;
        excess -= r.chars - size(cut.value);
        report.truncated.push({ name: r.name, shown: cut.shown, total: cut.total });
        report.changed = true;
      }
    }
  }

  // 2. Самые старые реплики прошлых ходов. Запрос обязан открываться репликой человека.
  let drop = 0;
  while (excess > 0 && drop < protectedFrom) {
    excess -= size(conversation[drop]);
    drop++;
  }
  while (drop < protectedFrom && conversation[drop].role !== "user") drop++;
  if (drop > 0) {
    conversation.splice(0, drop);
    report.droppedHistory = drop;
    report.changed = true;
  }
  return report;
}
