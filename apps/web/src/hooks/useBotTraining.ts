import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";

/**
 * Экран «Тренировка» (23.08.2026): реальный вопрос клиента из живой переписки +
 * 2-3 сгенерированных варианта ответа. Владелец выбирает лучший или вписывает
 * свой — пара уходит в StyleExample и подмешивается в промт бота как образец
 * манеры (apps/api/src/ai/styleLearning.ts, source "TRAINING").
 */
export interface GroundedSource {
  url: string;
  title?: string;
}

export interface TrainingQuestion {
  done: boolean;
  clientText?: string;
  channel?: string | null;
  conversationId?: string;
  variants?: string[];
  /** Индекс варианта, найденного живым поиском (Search grounding), а не только
   *  стилем, — и ссылки, по которым владелец может проверить факт перед выбором. */
  groundedIndex?: number;
  groundedSources?: GroundedSource[];
}

/**
 * Каждый вызов — новый случайный вопрос и заново сгенерированные варианты, а не
 * повторное чтение того же самого: кэшировать нечего, поэтому staleTime/gcTime
 * нулевые, и следующий вопрос грузится по явному `refetch()` из компонента
 * («Дальше»), а не сам по себе от смены queryKey.
 */
export function useNextTrainingQuestion(enabled: boolean) {
  return useQuery({
    queryKey: ["bot-training", "next"],
    queryFn: () => api<TrainingQuestion>("/bot-training/next"),
    enabled,
    staleTime: 0,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
  });
}

export interface TrainingDecisionInput {
  clientText: string;
  channel?: string | null;
  variants?: string[];
  chosenIndex?: number;
  customText?: string;
}

export interface TrainingDecisionResult {
  ok: boolean;
  /** true — такая пара «вопрос → ответ» в базе уже была. Не ошибка: владелец мог
   *  случайно выбрать то же самое второй раз. */
  duplicate?: boolean;
}

/**
 * Инвалидацию текущего вопроса намеренно не делаем: следующий вопрос грузится
 * ТОЛЬКО по явному клику «Дальше» (см. BotTraining.tsx) — авто-инвалидация после
 * сохранения увела бы карточку сразу же, и владелец не успел бы увидеть
 * подтверждение «сохранено».
 */
export function useDecideTraining() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: TrainingDecisionInput) =>
      api<TrainingDecisionResult>("/bot-training/decide", { method: "POST", body }),
    // Список сохранённых образцов (карточка «Сохранённые примеры манеры») должен
    // показать новую пару сразу — в отличие от «следующего вопроса» выше,
    // инвалидацию которого намеренно не делают, здесь ничего не «уводит» экран.
    onSuccess: () => qc.invalidateQueries({ queryKey: ["bot-training", "samples"] }),
  });
}

/**
 * Счётчики фильтров ответа за 14 дней (ai/guardMetrics.ts на сервере) — сколько
 * раз каждый guard сработал: старые «чинят реплику бота» (повтор приветствия,
 * переспрошенный вопрос…) и новые «нецелевой лид» (география, услуги, земля и
 * коммерция…), добавленные 30.08.2026. Не зависит от рубильника «Тренировка
 * ответов» — эндпоинт открыт всем с правом settings.view.
 */
export interface GuardStatTotal {
  guard: string;
  label: string;
  count: number;
}

export interface GuardStatsResponse {
  days: number;
  totals: GuardStatTotal[];
}

export function useGuardStats() {
  return useQuery({
    queryKey: ["bot-training", "guard-stats"],
    queryFn: () => api<GuardStatsResponse>("/bot-training/guard-stats"),
    staleTime: 60_000,
  });
}

/**
 * Сохранённые образцы манеры (StyleExample, source TRAINING/HISTORY/TAKEOVER),
 * свежие сверху, GET /bot-training/samples — те же 50, что реально участвуют в
 * промте бота (`enabled: true`, как в ai/training.ts и ai/styleLearning.ts).
 */
export interface TrainingSample {
  id: string;
  clientText: string;
  agentText: string;
  source: string;
  channel: string | null;
  createdAt: string;
}

export interface TrainingSamplesPage {
  samples: TrainingSample[];
  /** id последнего образца страницы — курсор для «показать ещё». null — дальше
   *  ничего нет. */
  nextCursor: string | null;
  /** Честный count() по базе (только enabled: true), не длина текущей выдачи. */
  total: number;
}

export function useTrainingSamples() {
  return useQuery({
    queryKey: ["bot-training", "samples"],
    queryFn: () => api<TrainingSamplesPage>("/bot-training/samples"),
    staleTime: 30_000,
  });
}

/**
 * Следующая страница «Сохранённых примеров манеры» (14.09.2026: до хвоста
 * списка было не добраться, сервер резал выдачу пределом в 50). Отдельная
 * функция, не useQuery: страниц может быть сколько угодно, компонент сам
 * копит уже показанное в локальном состоянии — тот же приём, что у ленты
 * «Обучение бота» (loadMoreBotLessons, hooks/useBotLearning.ts).
 */
export function loadMoreTrainingSamples(cursor: string) {
  return api<TrainingSamplesPage>(`/bot-training/samples?cursor=${encodeURIComponent(cursor)}`);
}

/**
 * Выключить неудачный образец манеры, не удаляя (14.09.2026, жалоба владельца:
 * единственное место в интерфейсе, откуда убрать образец было нельзя иначе
 * как правкой базы). Текст образца попадает прямо в промт бота — как только
 * образец выключен, GET /bot-training/samples (фильтр enabled: true) и подбор
 * кандидата для тренировки (ai/training.ts) больше его не используют.
 */
export function useUpdateTrainingSample() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      api<{ id: string; enabled: boolean }>(`/bot-training/samples/${id}`, { method: "PATCH", body: { enabled } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["bot-training", "samples"] }),
  });
}

/** Убрать образец манеры совсем — необратимо, подтверждение спрашивает экран. */
export function useDeleteTrainingSample() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<{ ok: true; id: string }>(`/bot-training/samples/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["bot-training", "samples"] }),
  });
}
