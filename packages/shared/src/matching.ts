import { z } from "zod";
import { dushanbeDayKey } from "./dushanbeDay.js";

/**
 * «Кому подойдёт объект» — общий словарь подбора для сервера и карточки объекта.
 *
 * Тип был объявлен дважды (routes/matching.ts и hooks/useProperties.ts). Пока
 * стороны описывают одно и то же порознь, расхождение замечает не компилятор, а
 * человек: сервер перестаёт слать поле, экран продолжает его читать и показывает
 * пустоту там, где раньше была причина совпадения.
 */
export interface MatchingClient {
  id: string;
  shortId: number;
  fullName: string;
  status: string;
  workStatus?: "ACTIVE" | "INACTIVE" | "DEFERRED";
  inactiveLevel?: "GREEN" | "YELLOW" | "RED" | null;
  /** Насколько подходит и почему — та же модель, что у объектов под клиента
   *  (lib/clientPropertyMatching.ts::matchClientProperty). Процента нет: это не
   *  вероятность сделки, а уровень и причины (решение владельца 10.11.2026). */
  match: ClientMatchEvidence;
  /** Текущий агент клиента; null — не назначен. Нужен, чтобы не предлагать «отдать»
   *  клиента тому же агенту, у которого он уже есть. */
  assignedAgentId: string | null;
  /** Имя текущего агента клиента (17.09.2026, единая панель «Подбор», план раздел
   *  6) — карточка строки кандидата показывает его без второго запроса по
   *  assignedAgentId. Опционально: старые вызовы findMatchingClients его не считают. */
  assignedAgentName?: string | null;
}

/**
 * Ответ GET /properties/:id/matching-clients (17.09.2026, docs/match-policy-plan-17-09.md
 * раздел 4) — БЫЛ голым массивом. `total` — размер ВСЕГО множества ждущих (то же число,
 * что у счётчика спроса «Ждут N покупателей» на объекте, computeDemandCounts); `items` —
 * первые по баллу, обрезанные лимитом показа. Разошедшиеся раньше числа («33 в спросе / 0
 * кому подходит») были ровно этим — разными фильтрами под одним и тем же названием.
 */
export interface MatchingClientsResponse {
  items: MatchingClient[];
  total: number;
}

/**
 * УРОВЕНЬ СОВПАДЕНИЯ «КЛИЕНТ ↔ ОБЪЕКТ» — одна модель в обе стороны (подбор 2.0,
 * владелец 10.11.2026: «надо написать, что именно подходит»). Процентов нет:
 *   exact              — 🎯 точно подходит: всё, что клиент назвал, совпало, и
 *                         главное (бюджет, место, комнаты) он назвал;
 *   alternative        — 👍 можно предложить: проходит, но с уступкой (tradeoffs);
 *   needs_verification — ❓ уточнить: уступок нет, но чего-то не знаем (unknowns).
 */
export type MatchTier = "exact" | "alternative" | "needs_verification";

export const MATCH_TIERS: readonly MatchTier[] = ["exact", "alternative", "needs_verification"];

/** Подписи уровней — одно место для экрана CRM и помощницы в Telegram. */
export const MATCH_TIER_TEXT: Record<"ru" | "tg", Record<MatchTier, { icon: string; label: string }>> = {
  ru: {
    exact: { icon: "🎯", label: "Точно подходит" },
    alternative: { icon: "👍", label: "Можно предложить" },
    needs_verification: { icon: "❓", label: "Уточнить" },
  },
  tg: {
    exact: { icon: "🎯", label: "Комилан мувофиқ" },
    alternative: { icon: "👍", label: "Пешниҳод кардан мумкин" },
    needs_verification: { icon: "❓", label: "Аниқ кунед" },
  },
};

export function matchTierLabel(tier: MatchTier, lang: "ru" | "tg" = "ru"): string {
  const text = MATCH_TIER_TEXT[lang][tier];
  return `${text.icon} ${text.label}`;
}

/** Порядок показа: сначала точные, потом с уступкой, потом «уточнить». */
export function matchTierRank(tier: MatchTier): number {
  return MATCH_TIERS.indexOf(tier);
}

/** Что именно совпало, где уступка и чего не знаем — без отправок. */
export interface MatchEvidence {
  tier: MatchTier;
  /** Что совпало: «Нужный район», «3 комнаты, как просил», «В бюджете». */
  reasons: string[];
  /** Честные уступки: «на 1 комнату меньше», «на 5% дороже бюджета». */
  tradeoffs: string[];
  /** Чего не знаем и из-за чего уровень «уточнить»: «Площадь объекта не указана». */
  unknowns: string[];
  /** Что стоит спросить у клиента, уровень не снижает: «Клиент не говорил про этаж — спросите». */
  ask: string[];
}

/** История отправок этой пары: сколько раз и когда последний раз (PropertyExposure). */
export interface MatchSendHistory {
  lastSentAt: string | null;
  sentCount: number;
}

/** Клиент под объект: уровень, причины и что ему уже отправляли этот объект. */
export type ClientMatchEvidence = MatchEvidence & MatchSendHistory;

/** Объект под клиента — то же и «мой ли это объект». */
export interface ClientPropertyMatchEvidence extends MatchEvidence, MatchSendHistory {
  isMine: boolean;
}

/**
 * «Уже отправляли 3 дня назад» — одна строка на экран и помощницу. Дни считаются
 * по календарю Душанбе, а не по 24 часам: вчера в 23:00 — это «вчера».
 */
export function sentAgoText(history: MatchSendHistory, lang: "ru" | "tg" = "ru", now: Date = new Date()): string | null {
  if (!history.lastSentAt || history.sentCount <= 0) return null;
  const day = (value: Date | string) => Date.parse(`${dushanbeDayKey(value)}T00:00:00Z`);
  const days = Math.max(0, Math.round((day(now) - day(history.lastSentAt)) / 86_400_000));
  const times = history.sentCount > 1 ? (lang === "tg" ? ` (${history.sentCount} бор)` : ` (${history.sentCount} раза)`) : "";
  if (lang === "tg") {
    const when = days === 0 ? "имрӯз" : days === 1 ? "дирӯз" : `${days} рӯз пеш`;
    return `Аллакай фиристода шуда буд ${when}${times}`;
  }
  const when = days === 0 ? "сегодня" : days === 1 ? "вчера" : `${days} ${pluralDays(days)} назад`;
  return `Уже отправляли ${when}${times}`;
}

function pluralDays(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return "день";
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return "дня";
  return "дней";
}

export const clientPropertyMatchQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(100000).default(1),
  pageSize: z.coerce.number().int().min(1).max(30).default(12),
  scope: z.enum(["all", "mine"]).default("all"),
});

export interface ClientPropertyMatchSummary {
  unfiltered: boolean;
  /** All visible AVAILABLE records compared before ranking and pagination. */
  scanned: number;
  /** All eligible recommendations before the optional mine filter. */
  eligible: number;
  total: number;
  mineTotal: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
  scope: "all" | "mine";
  /** closed — клиент уже купил или явно отказался (lib/matchPolicy.ts::clientDoneBuying). */
  reason: "not_buyer" | "pending_acceptance" | "needs_requirements" | "closed" | null;
  requirementsSummary: string[];
}

/**
 * Шкала порога «свой объект — свой клиент» (Настройки → Заявки,
 * ownPropertyMatchThreshold, 0..100). С подбора 2.0 (10.11.2026) это НЕ процент
 * совпадения на экране — там уровни и причины, — а только шкала, по которой
 * распределение заявок решает, отдать ли клиента хозяину подходящего объекта.
 * Значения прежние (прод с 13.08.2026), чтобы порог в Настройках не поменял
 * смысл молча. Бонус «горячему» убран: он был свойством клиента, а не пары, и
 * распределение его и так не начисляло.
 */
export const MATCH_SCORE_WEIGHTS = {
  base: 40,
  district: 25,
  rooms: 20,
  budget: 15,
  distance: 25,
} as const;
