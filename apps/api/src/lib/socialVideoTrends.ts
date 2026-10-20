import type { SocialVideoTrends } from "@royal-home/shared";
import { callGeminiGrounded, resolveGeminiKey } from "../ai/geminiClient.js";

/**
 * СВЕЖИЕ ТРЕНДЫ ОФОРМЛЕНИЯ ОБЛОЖЕК (12.10.2026).
 *
 * Владелец хочет, чтобы обложка роликов была «по моде», а мода меняется быстрее, чем выходят
 * обновления CRM. Поэтому тренды спрашиваем у Gemini с поиском Google (callGeminiGrounded) и
 * вписываем в промт рисования (socialVideoAi.ts).
 *
 * НИЧЕГО НЕ ВЫДУМЫВАЕМ ПОД ВИДОМ НАЙДЕННОГО. Если поиск не ответил, ключа нет или ответ не
 * разобрался в нормальные пункты, возвращаем `source: "FALLBACK"` и пять вечных правил оформления,
 * честно помеченных как запасные: экран показывает «поиск недоступен», а не «тренды октября».
 *
 * Кэш в памяти процесса: тренды за сутки не меняются, а поиск стоит и времени (десятки секунд),
 * и денег. Принудительное обновление (`refresh`) обходит кэш, но не чаще раза в пять минут:
 * кнопку «обновить» легко нажать пять раз подряд. Одновременные вызовы делят один запрос.
 */

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
/** Запасной ответ держим недолго: если поиск упал на минуту, незачем сутки сидеть на «вечных» правилах. */
const FALLBACK_TTL_MS = 10 * 60 * 1000;
/** Не чаще раза в это время поиск запускается принудительно. */
const REFRESH_COOLDOWN_MS = 5 * 60 * 1000;
/** Потолок на весь запрос: callGeminiGrounded внутри сам перебирает модели и может тянуть минуты. */
const SEARCH_TIMEOUT_MS = 45_000;
const OVERALL_TIMEOUT_MS = 60_000;

const MIN_ITEMS = 3;
const MAX_ITEMS = 7;
const MAX_ITEM_CHARS = 140;
const MIN_ITEM_CHARS = 12;
const MAX_SOURCES = 5;

/** Вечные правила: годятся в любой месяц и ни на что «свежее» не ссылаются. */
export const EVERGREEN_COVER_RULES: readonly string[] = [
  "Крупный план человека или интерьера вместо общего плана здания",
  "Один сильный акцентный цвет на спокойном нейтральном фоне",
  "Мягкий естественный свет, без жёстких теней и пересветов",
  "Чистая композиция с пустым местом под заголовок сверху или снизу",
  "Без текста, цифр и логотипов на самой картинке",
];

const MONTHS_RU = [
  "январь", "февраль", "март", "апрель", "май", "июнь",
  "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь",
] as const;

interface CacheEntry {
  value: SocialVideoTrends;
  /** Когда запись перестаёт быть годной. */
  expiresAt: number;
}

let cache: CacheEntry | null = null;
let inflight: Promise<SocialVideoTrends> | null = null;
/** Когда в последний раз реально ходили в поиск (успех или нет) — для защиты `refresh`. */
let lastSearchAt = 0;

/** Для тестов: забыть кэш и защиту. */
export function resetSocialVideoTrendsCache(): void {
  cache = null;
  inflight = null;
  lastSearchAt = 0;
}

function fallbackTrends(): SocialVideoTrends {
  return { digest: [...EVERGREEN_COVER_RULES], updatedAt: new Date().toISOString(), source: "FALLBACK", sources: [] };
}

/** «октябрь 2026» по времени Душанбе (UTC+5): граница месяца не должна уезжать в UTC. */
function currentMonthLabel(now: Date): string {
  const local = new Date(now.getTime() + 5 * 60 * 60 * 1000);
  return `${MONTHS_RU[local.getUTCMonth()]} ${local.getUTCFullYear()}`;
}

function buildQuery(now: Date): string {
  const month = currentMonthLabel(now);
  return [
    `Найди в интернете, что СЕЙЧАС (${month}) в тренде в оформлении вертикальных обложек и первых кадров для Reels, YouTube Shorts и TikTok,`,
    "особенно у агентств недвижимости и в тематике дома, интерьера, архитектуры, лайфстайла.",
    "Нужны конкретные визуальные приёмы: цвет и палитра, свет, композиция, тип кадра, стиль съёмки или обработки.",
    "",
    "Ответь СТРОГО списком из 5-7 строк, по одному приёму на строку, без вступления и заключения.",
    `Каждая строка короткая, не длиннее ${MAX_ITEM_CHARS - 20} символов, по-русски, без нумерации, без ссылок и без слов «в ${month.split(" ")[0]}».`,
    "Не выдумывай: пиши только то, что подтверждается найденными источниками.",
  ].join("\n");
}

/** Обрезка по границе слова. */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return (space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,.:;!?\-]+$/u, "");
}

/**
 * Текст ответа → пункты. Убираем нумерацию, маркеры, markdown, сноски вида [1] и ссылки, вступление
 * («Вот тренды:») и слишком короткий мусор. Ответ поиска — данные, а не команда: в промт рисования
 * он попадёт только как короткие строки без ссылок.
 */
export function parseTrendDigest(text: string): string[] {
  const seen = new Set<string>();
  const items: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine
      .replace(/\[\d+(?:[,\s-]+\d+)*\]/g, "")
      .replace(/https?:\/\/\S+/g, "")
      .replace(/[*_`#>]+/g, "")
      .replace(/^[\s•·\-–—\d.)(]+/u, "")
      .replace(/\s+/g, " ")
      .trim();
    if (line.length < MIN_ITEM_CHARS) continue;
    // Строка-вступление «Вот основные тренды:» — не приём.
    if (/:$/.test(line)) continue;
    const clipped = clip(line, MAX_ITEM_CHARS);
    const key = clipped.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(clipped);
    if (items.length === MAX_ITEMS) break;
  }
  return items;
}

async function searchTrends(): Promise<SocialVideoTrends> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const apiKey = await resolveGeminiKey();
    if (!apiKey) return fallbackTrends();
    const now = new Date();
    const answer = await Promise.race([
      callGeminiGrounded({
        apiKey,
        system:
          "Ты исследователь визуальных трендов в соцсетях. Отвечай кратко, по делу и только тем, что нашёл в источниках.",
        query: buildQuery(now),
        maxTokens: 1500,
        timeoutMs: SEARCH_TIMEOUT_MS,
      }),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), OVERALL_TIMEOUT_MS);
      }),
    ]);
    if (!answer) return fallbackTrends();

    const digest = parseTrendDigest(answer.text);
    // Меньше трёх пунктов — это не подборка, а обрывок; выдавать его за тренды нельзя.
    if (digest.length < MIN_ITEMS) return fallbackTrends();

    const sources = answer.sources
      .filter((s) => /^https?:\/\//i.test(s.url))
      .slice(0, MAX_SOURCES)
      .map((s) => ({ title: (s.title?.trim() || new URL(s.url).hostname).slice(0, 120), url: s.url }));
    return { digest, updatedAt: now.toISOString(), source: "LIVE", sources };
  } catch {
    // callGeminiGrounded уже записал причину в журнал ошибок; здесь честный запасной ответ.
    return fallbackTrends();
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Тренды оформления обложек. Не бросает: при любом отказе возвращает `source: "FALLBACK"`.
 * `refresh: true` обходит кэш, но поиск не запускается чаще раза в пять минут.
 */
export async function getSocialVideoTrends(opts: { refresh?: boolean } = {}): Promise<SocialVideoTrends> {
  if (inflight) return inflight;

  const now = Date.now();
  if (cache && now < cache.expiresAt) {
    const refreshAllowed = opts.refresh === true && now - lastSearchAt >= REFRESH_COOLDOWN_MS;
    if (!refreshAllowed) return cache.value;
  }

  lastSearchAt = now;
  const request = searchTrends()
    .then((value) => {
      // Принудительное обновление не нашло ничего: не меняем живые найденные тренды на запасные правила.
      if (value.source === "FALLBACK" && cache?.value.source === "LIVE" && Date.now() < cache.expiresAt) {
        return cache.value;
      }
      cache ={ value, expiresAt: Date.now() + (value.source === "LIVE" ? CACHE_TTL_MS : FALLBACK_TTL_MS) };
      return value;
    })
    .finally(() => {
      inflight = null;
    });
  inflight = request;
  return request;
}
