import { z } from "zod";

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
  /** 0..100 — насколько точно совпало. Качество совпадения, а не вероятность сделки. */
  score: number;
  /** Почему показан: короткие причины для агента. */
  reasons: string[];
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

/** Card recommendations are evidence, never a percentage probability of success. */
export interface ClientPropertyMatchEvidence {
  tier: "exact" | "alternative" | "needs_verification";
  reasons: string[];
  tradeoffs: string[];
  unknowns: string[];
  isMine: boolean;
  lastSentAt: string | null;
  sentCount: number;
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
  reason: "not_buyer" | "pending_acceptance" | "needs_requirements" | null;
  requirementsSummary: string[];
}
