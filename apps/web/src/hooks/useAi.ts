import { useMutation, useQuery } from "@tanstack/react-query";
import type { Currency, PropertyDraftSuggestion } from "@royal-home/shared";
import { api } from "../lib/api";
import { SAFETY_REFETCH_MS } from "../lib/refetchIntervals";

interface ParseNoteResult {
  interaction: {
    type: string;
    outcome?: string;
    notes: string;
    nextAction?: string;
    nextActionDate?: string;
  };
  clientUpdates: {
    budgetMin?: number;
    budgetMax?: number;
    desiredDistrict?: string;
    desiredRooms?: number;
    requirementsNotes?: string;
  };
  degraded?: boolean;
}

export function useParseNote() {
  return useMutation({
    mutationFn: (body: { text: string; clientId: string }) =>
      api<ParseNoteResult>("/ai/parse-note", { method: "POST", body }),
  });
}

/**
 * Описание объявления от ИИ — кнопка в карточке объекта (PropertyDetail).
 *
 * Мутация, а не запрос: вызов платный, и повторять его при каждом возврате фокуса
 * в окно (что кэш запросов делает с GET) незачем. Возвращает несколько вариантов
 * текста — человек выбирает, а не получает подстановку без спроса.
 *
 * Маршрут закрыт правом `properties.aiListing`; до 10.08.2026 право выдавалось,
 * но нажать в интерфейсе было нечего, и у роли «Монтажёр» не оставалось работы.
 *
 * Здесь же лежали useCardFillSuggestion и useScoreClient — тоже без единой кнопки,
 * удалены при разборе 09.08.2026. Их маршруты (/ai/card-fill, /ai/score) живы.
 */
export function useGenerateListing() {
  return useMutation({
    mutationFn: (body: { propertyId: string; language?: "ru" | "tj" }) =>
      api<{ variants: string[] }>("/ai/generate-listing", { method: "POST", body }),
  });
}

/**
 * Черновик карточки объекта по переписке/звонкам с продавцом (задача K, план
 * docs/audit-02-09-2026/19-plan-03-09-evening.md) — кнопка «Заполнить из переписки
 * с продавцом» на форме создания объекта (PropertyFormModal), видна только когда
 * объект создаётся с привязкой к существующей карточке продавца. Ничего не
 * сохраняет: подставляет поля в форму с пометкой «заполнено ИИ, проверьте»,
 * агент правит и сохраняет обычным POST /properties.
 *
 * Мутация, а не запрос — тот же довод, что у useGenerateListing: вызов платный,
 * повторять его при каждом фокусе в форму незачем.
 */
export function usePropertyDraftFromClient() {
  return useMutation({
    mutationFn: (clientId: string) => api<PropertyDraftSuggestion>(`/ai/property-draft/${clientId}`, { method: "POST" }),
  });
}

export interface AiInsights {
  likelyDeals: { id: string; shortId: number; fullName: string; aiScore: number; aiScoreReason: string }[];
  staleProperties: {
    id: string;
    shortId: number;
    title: string;
    price: string;
    currency: Currency;
    district: string;
    daysSinceCreated: number;
    medianPricePerSqmInDistrict: number | null;
    diffPercent: number | null;
  }[];
  forgottenClients: { id: string; shortId: number; fullName: string; status: string; daysSinceContact: number }[];
  overdueTasks: { id: string; shortId: number; fullName: string; nextAction: string | null; daysOverdue: number }[];
  staleSellers: { id: string; shortId: number; fullName: string; daysSinceAccepted: number }[];
  unseenProperties: { id: string; shortId: number; title: string; price: string; currency: Currency; daysSincePublished: number }[];
  stuckDeals: {
    id: string;
    stage: string;
    daysOpen: number;
    propertyShortId: number;
    propertyTitle: string;
    clientShortId: number;
    clientFullName: string;
  }[];
  hotWithoutDeal: { id: string; shortId: number; fullName: string }[];
}

export function useAiInsights() {
  return useQuery({
    refetchInterval: SAFETY_REFETCH_MS,
    queryKey: ["ai-insights"],
    queryFn: () => api<AiInsights>("/ai/insights"),
  });
}
