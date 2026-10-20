import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { InstagramCommentStatus } from "@royal-home/shared";
import { api } from "../lib/api";
import { keepWhilePaging } from "../lib/keepWhilePaging";
import type { Paginated } from "../types";

/**
 * Лента комментариев под публикациями Instagram. Закрыта правом messages.view —
 * тем же, что и инбокс: это переписка бота от имени компании, просто публичная.
 */

/** Публикация, под которой оставлен комментарий, — через карточку объекта CRM.
 *  Адреса самой публикации в комментарии нет: он берётся из Property.instagramUrl,
 *  поэтому у поста без привязки к объекту ссылки не будет вовсе. */
export interface InstagramCommentPost {
  propertyId: string;
  propertyShortId: number;
  propertyTitle: string;
  instagramUrl: string | null;
}

export interface InstagramCommentItem {
  id: string;
  /** Идентификатор у Meta — нужен только для служебных сверок, не для показа. */
  commentId: string;
  /** Площадка: INSTAGRAM | FACEBOOK | YOUTUBE. Подпись — commentNetworkName. */
  channel: string;
  mediaId: string;
  /** Заполнен, если комментарий — ответ внутри ветки. */
  parentId: string | null;
  authorName: string | null;
  text: string;
  status: InstagramCommentStatus;
  /** Код причины или фраза модели «чего не хватило» — см. instagramCommentNoteLabel. */
  note: string | null;
  /** Что бот написал публично под комментарием. */
  replyText: string | null;
  repliedAt: string | null;
  hiddenAt: string | null;
  /** Личное сообщение автору, если бот его отправил. */
  dmText: string | null;
  dmSentAt: string | null;
  attempts: number;
  createdAt: string;
  post: InstagramCommentPost | null;
}

/** Счётчики по всем статусам сразу — по ним рисуются вкладки фильтра, поэтому они
 *  считаются от всей таблицы, а не от выбранного фильтра. */
export type InstagramCommentCounts = Record<InstagramCommentStatus | "all", number>;

export type InstagramCommentsPage = Paginated<InstagramCommentItem> & {
  counts: InstagramCommentCounts;
};

export interface InstagramCommentFilters {
  status?: InstagramCommentStatus;
  page?: number;
  /** Сколько строк тянуть. Настройкам нужны только счётчики — там ставят 1, чтобы
   *  не возить тридцать комментариев ради одной цифры. */
  pageSize?: number;
}

function toQuery(filters: InstagramCommentFilters) {
  const params = new URLSearchParams();
  if (filters.status) params.set("status", filters.status);
  if (filters.page && filters.page > 1) params.set("page", String(filters.page));
  if (filters.pageSize) params.set("pageSize", String(filters.pageSize));
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

/**
 * Страница ленты. Опрос раз в минуту и только на видимой вкладке: бот отвечает
 * не раньше чем через 1-3 минуты после комментария, и чаще спрашивать нечего.
 */
export function useInstagramComments(filters: InstagramCommentFilters = {}, options?: { enabled?: boolean }) {
  return useQuery<InstagramCommentsPage>({
    queryKey: ["instagram-comments", filters],
    queryFn: () => api(`/instagram-comments${toQuery(filters)}`),
    placeholderData: keepWhilePaging<InstagramCommentsPage>(["instagram-comments", filters]),
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
    // Роль без права на переписку получит 403 — за ним не ходим вовсе, иначе
    // журнал ошибок засоряется отказами при каждом заходе по прямой ссылке.
    enabled: options?.enabled ?? true,
  });
}

/** Скрыть комментарий от подписчиков или вернуть его обратно. */
export function useModerateInstagramComment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, hide }: { id: string; hide: boolean }) =>
      api<{ ok: true; status: InstagramCommentStatus }>(`/instagram-comments/${id}/${hide ? "hide" : "unhide"}`, {
        method: "POST",
      }),
    // silent: скрытие/возврат комментария — не сохранение, а вызывающий
    // (pages/Comments.tsx) уже рисует отказ через <MutationError mutation={moderate}>,
    // а успех виден по смене статуса строки.
    // Общий тост дублировал ошибку и врал словом на успехе (аудит 22.08.2026, раунд 5).
    meta: { silent: true },
    // Меняется и статус строки, и счётчики вкладок — перезапрашиваем ленту целиком,
    // а не правим кэш руками: точечная правка счётчиков разъезжается с сервером.
    onSuccess: () => qc.invalidateQueries({ queryKey: ["instagram-comments"] }),
  });
}

/**
 * Ответить на комментарий прямо из CRM (владелец 15.09.2026) — там, где бот
 * спасовал (ESCALATED, «Бот не знал ответа»), сотрудник больше не идёт в
 * приложение Instagram руками.
 */
export function useReplyToInstagramComment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, text }: { id: string; text: string }) =>
      api<{ ok: true; status: InstagramCommentStatus; replyText: string; repliedAt: string }>(
        `/instagram-comments/${id}/reply`,
        { method: "POST", body: { text } }
      ),
    // Отказ (окно истекло, комментарий удалён, нет прав) рисует MutationError
    // на месте вызова — тот же приём, что у useModerateInstagramComment.
    meta: { silent: true },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["instagram-comments"] }),
  });
}
