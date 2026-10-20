import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { InsightCaseKind, InsightDigestStatus } from "@royal-home/shared";
import { api } from "../lib/api";
import { SAFETY_REFETCH_MS } from "../lib/refetchIntervals";

/**
 * «Инсайты от ИИ» — диджесты кейсов клиент+агент для собрания 15 и 30 числа.
 * Контракт — routes/insights.ts; формы данных ниже повторяют ответ сервера,
 * а не выдумывают свою (03.09.2026 экран жил на моках и к API не ходил вовсе).
 */

export interface InsightDigestSummary {
  id: string;
  periodStart: string;
  periodEnd: string;
  meetingAt: string;
  /** GENERATING — пока крон/кнопка ещё собирают выпуск. */
  status: InsightDigestStatus | "GENERATING";
  coverage: { calls: number; analyzed: number; findings: number; penalties: number; error?: string };
  createdAt: string;
  caseCount: number;
}

export interface InsightVerdict {
  wrong?: { quote: string; why: string }[];
  better?: string[];
  summary?: string;
}

/** Снапшот источника кейса (lib/insightDigest.ts, snapshotTimeline). */
export interface InsightTimeline {
  kind: InsightCaseKind;
  /** Транскрипт (звонок), последние реплики (обход бота), причина штрафа. */
  content: unknown;
  meta: Record<string, unknown>;
}

export interface InsightCaseView {
  id: string;
  agentId: string;
  agentName: string | null;
  clientId: string;
  clientName: string | null;
  clientShortId: number | null;
  kind: InsightCaseKind;
  /** 1–5, чем выше — тем серьёзнее. */
  severity: number;
  sourceKey: string;
  /** Защищённый маршрут записи звонка (только у кейсов из разбора звонков). */
  recordingUrl: string | null;
  timeline: InsightTimeline | null;
  verdict: InsightVerdict | null;
  reviewedAt: string | null;
  reviewedById: string | null;
  meetingNote: string | null;
}

export function useInsightDigests() {
  return useQuery({
    refetchInterval: SAFETY_REFETCH_MS,
    queryKey: ["insights"],
    queryFn: () => api<InsightDigestSummary[]>("/insights"),
  });
}

export function useInsightCases(digestId: string | null) {
  return useQuery({
    queryKey: ["insights", digestId, "cases"],
    queryFn: () => api<InsightCaseView[]>(`/insights/${digestId}`),
    enabled: !!digestId,
  });
}

export function useReviewInsightCase(digestId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { caseId: string; meetingNote?: string }) =>
      api<InsightCaseView>(`/insights/cases/${input.caseId}`, {
        method: "PATCH",
        body: { reviewedAt: new Date().toISOString(), ...(input.meetingNote ? { meetingNote: input.meetingNote } : {}) },
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["insights", digestId, "cases"] });
    },
  });
}

export function useGenerateInsightDigest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<{ id: string; status: string; casesCount: number }>("/insights/generate", { method: "POST", body: {} }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["insights"] });
    },
  });
}
