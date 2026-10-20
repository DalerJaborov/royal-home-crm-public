import { useMutation, useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { SAFETY_REFETCH_MS } from "../lib/refetchIntervals";

/**
 * «Тренажёр бота» (17.09.2026) — одна переписка, одно решение, применяется
 * сразу. См. apps/api/src/routes/botTrainer.ts за подробным разбором того, из
 * каких трёх источников собирается очередь и через какие уже существующие
 * ручки применяется каждое решение.
 */
export interface BotTrainerItem {
  id: string;
  kind: "question" | "finding" | "sample";
  channel: string;
  name: string;
  bucket: string;
  at: string;
  ctx: { role: "user" | "assistant"; text: string }[];
  q: string;
  a: string;
  dupCount: number;
  urgent: boolean;
  conversationId: string | null;
  messageKey?: string;
  lessonId?: string;
  lessonGroupIds?: string[];
  findingType?: string;
  findingWhy?: string;
}

interface QueueResponse {
  items: BotTrainerItem[];
  /** Сколько случаев ждут решения ВСЕГО (count() на сервере, повторы считаются
   *  как случаи) — не длина очереди: очередь режется до 30, а счётчик нет. */
  total: number;
}

/**
 * Очередь — один запрос, без пагинации (лимит 30, владелец 17.09.2026:
 * «ничего не должно зависать»). Долгий staleTime намеренно: очередь не должна
 * дёргаться сама по себе, пока владелец решает по одному элементу — сервер и
 * так узнает о каждом решении сразу (useBotTrainerDecide инвалидирует кэш).
 */
export function useBotTrainerQueue(options?: { enabled?: boolean }) {
  return useQuery({
    refetchInterval: SAFETY_REFETCH_MS,
    queryKey: ["bot-trainer-queue"],
    queryFn: () => api<QueueResponse>("/bot-trainer/queue?limit=30"),
    enabled: options?.enabled,
    staleTime: 60_000,
  });
}

/** Два варианта «как надо было ответить» — запрашиваются ТОЛЬКО по нажатию
 *  «Неверно» (владелец 17.09.2026), таймаут 20с уже на сервере — здесь просто
 *  дожидаемся ответа {variants:[]} и не гоняем свой отдельный таймер. */
export function useBotTrainerVariants() {
  return useMutation({
    mutationFn: (input: { conversationId: string; messageKey: string }) =>
      api<{ variants: string[] }>("/bot-trainer/variants", { method: "POST", body: input }),
  });
}

export interface DecideInput {
  item: BotTrainerItem;
  verdict: "good" | "bad" | "mute";
  note?: string;
}

/**
 * Одно решение. Компонент (BotTrainer.tsx) применяет его ОПТИМИСТИЧНО сам —
 * убирает карточку из локальной очереди и переходит дальше немедленно, не
 * дожидаясь ответа сервера (владелец 17.09.2026: «ничего не должно
 * тормозить»); этот хук просто отправляет решение в фоне. `meta:{silent:true}`
 * — свой тост тренажёр показывает сам, общий дублировал бы его.
 */
export function useBotTrainerDecide() {
  return useMutation({
    mutationFn: ({ item, verdict, note }: DecideInput) =>
      api<{ ok: true; itemId: string; lessonCreated: boolean }>("/bot-trainer/decide", {
        method: "POST",
        body: {
          itemId: item.id,
          kind: item.kind,
          verdict,
          note,
          channel: item.channel,
          conversationId: item.conversationId,
          messageKey: item.messageKey,
          lessonId: item.lessonId,
          lessonGroupIds: item.lessonGroupIds,
          findingType: item.findingType,
          findingWhy: item.findingWhy,
          q: item.q,
          a: item.a,
        },
      }),
    meta: { silent: true },
  });
}
