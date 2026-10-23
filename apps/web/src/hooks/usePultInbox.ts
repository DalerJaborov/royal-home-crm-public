import { useMemo } from "react";
import { useQueries, useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { PermissionId, SocialVideoItem, SocialVideoListResponse } from "@royal-home/shared";
import { api } from "../lib/api";
import { SAFETY_REFETCH_MS } from "../lib/refetchIntervals";
import { useCan } from "../lib/permissions";
import { useAuthStore } from "../store/auth";
import type { AuditList } from "./useBotAudit";
import type { ConversationListItem } from "./useConversations";
import type { DuplicateReviewItem, ReactivationOffer } from "./useClients";
import type { EditorQueue } from "./useMarketing";
import type { InstagramCommentsPage } from "./useInstagramComments";
import type { SiteNotificationsResponse } from "./useSiteNotifications";

/**
 * «ЕЩЁ ЖДУТ РЕШЕНИЯ» на светлом пульте (23.10.2026): очереди, которые сервер уже
 * умеет решать, но пульт не показывал. Ничего нового на сервере — только
 * существующие адреса, каждый со своей проверкой прав.
 *
 * КЛЮЧИ ЗАПРОСОВ — префиксы, которые гасит `lib/liveEvents.ts` (INVALIDATION),
 * чтобы очереди обновлялись по живым событиям, а не только по таймеру:
 *   ["conversations", "pult-inbox", …]   ← message.new, conversation.updated
 *   ["marketing", "pult-inbox", …]       ← property.updated
 *   ["reactivation-offers", "pult-inbox"] ← client.updated
 *   ["clients", "pult-inbox", …]          ← lead.*, client.updated
 * Остальные (комментарии, ролики, система, правки сайта) живых событий не имеют:
 * их держит запасной опрос SAFETY_REFETCH_MS, а действия на этом экране гасят
 * префикс своей страницы (["instagram-comments"], ["social-videos"],
 * ["site-notifications"], ["bot-audit"]).
 */

export type InboxGroup = "clients" | "video" | "social" | "system";

export const INBOX_GROUP_ORDER: InboxGroup[] = ["clients", "video", "social", "system"];
export const INBOX_GROUP_LABEL: Record<InboxGroup, string> = {
  clients: "Клиенты",
  video: "Видео",
  social: "Соцсети",
  system: "Система",
};

export type InboxQueueId =
  | "waiting"
  | "comments"
  | "reactivation"
  | "duplicates"
  | "editor"
  | "videos"
  | "stuckConversations"
  | "stuckWork"
  | "botAudit"
  | "siteChanges";

interface InboxBase {
  /** Уникален среди всех очередей: `<очередь>:<id записи>`. */
  id: string;
  queue: InboxQueueId;
  group: InboxGroup;
  title: string;
  detail: string;
  /** С какого момента ждёт — по нему сортируем («по давности»: давнее выше). */
  at: string | null;
}

export type InboxItem = InboxBase &
  (
    | { type: "dialog"; conversationId: string; paused: boolean }
    | { type: "comment"; commentId: string }
    | { type: "reactivation"; clientId: string }
    | { type: "duplicate"; clientId: string }
    | { type: "editor"; propertyId: string; canResend: boolean; canHold: boolean }
    | { type: "video"; videoId: string }
    | { type: "stuckConversations"; count: number }
    | { type: "stuckWork"; jobId: string }
    | { type: "audit"; findingId: string }
    | { type: "site"; notificationId: string }
  );

export interface InboxQueueMeta {
  id: InboxQueueId;
  group: InboxGroup;
  label: string;
  /** Раздел, куда ведёт «ещё N». */
  href: string;
}

export interface InboxQueueResult {
  items: InboxItem[];
  /** Сколько всего ждёт на сервере (может быть больше, чем загружено). */
  total: number;
}

export const INBOX_QUEUES: InboxQueueMeta[] = [
  { id: "waiting", group: "clients", label: "Клиент ждёт человека", href: "/messages" },
  { id: "comments", group: "clients", label: "Комментарии без ответа", href: "/comments" },
  { id: "reactivation", group: "clients", label: "Вернувшиеся клиенты", href: "/clients" },
  { id: "duplicates", group: "clients", label: "Возможные дубли", href: "/clients" },
  { id: "editor", group: "video", label: "Монтаж просрочен", href: "/marketing" },
  { id: "videos", group: "social", label: "Ролик не вышел в соцсети", href: "/social-videos" },
  { id: "stuckConversations", group: "system", label: "Диалоги без ответа бота", href: "/health" },
  { id: "stuckWork", group: "system", label: "Что не доехало", href: "/stuck-work" },
  { id: "botAudit", group: "system", label: "Находки судьи бота", href: "/ai-learning" },
  { id: "siteChanges", group: "system", label: "Изменения на сайте", href: "/site-changes" },
];

const MIN = 60_000;

/** «15 мин», «3 ч», «2 д» — сколько прошло с момента `iso`. */
export function formatAge(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "";
  const ms = now - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "";
  if (ms < MIN) return "только что";
  if (ms < 60 * MIN) return `${Math.floor(ms / MIN)} мин`;
  if (ms < 24 * 60 * MIN) return `${Math.floor(ms / (60 * MIN))} ч`;
  return `${Math.floor(ms / (24 * 60 * MIN))} д`;
}

const CHANNEL_LABEL: Record<string, string> = {
  TELEGRAM: "Telegram",
  WHATSAPP: "WhatsApp",
  INSTAGRAM: "Instagram",
  FACEBOOK: "Facebook",
  MESSENGER: "Messenger",
  SITE: "Сайт",
};
const channelLabel = (channel: string | null | undefined) => (channel ? (CHANNEL_LABEL[channel.toUpperCase()] ?? channel) : "");

/** Давнее выше; запись без даты — в конец. */
export function byAge(a: { at: string | null }, b: { at: string | null }): number {
  if (!a.at && !b.at) return 0;
  if (!a.at) return 1;
  if (!b.at) return -1;
  return a.at.localeCompare(b.at);
}

// ───────────────────────────── загрузчики очередей ─────────────────────────────

export async function loadWaiting(): Promise<InboxQueueResult> {
  const [needs, paused] = await Promise.all([
    api<{ items: ConversationListItem[]; total: number }>("/conversations?needsHuman=1"),
    api<{ items: ConversationListItem[]; total: number }>("/conversations?paused=1"),
  ]);
  const byId = new Map<string, ConversationListItem>();
  for (const c of [...needs.items, ...paused.items]) byId.set(c.id, c);
  const items: InboxItem[] = [...byId.values()].map((c) => ({
    id: `waiting:${c.id}`,
    queue: "waiting",
    group: "clients",
    type: "dialog",
    conversationId: c.id,
    paused: c.paused,
    title: c.name?.trim() || "Клиент без имени",
    detail: [
      channelLabel(c.channel),
      c.awaitingHumanSince ? `ждёт ${formatAge(c.awaitingHumanSince)}` : c.paused ? "бот на паузе" : "",
      c.lastMessage?.content ? `«${c.lastMessage.content.slice(0, 80)}»` : "",
    ].filter(Boolean).join(" · "),
    at: c.awaitingHumanSince ?? c.pausedSince ?? c.lastMessageAt,
  }));
  const hiddenOnServer = Math.max(0, needs.total - needs.items.length) + Math.max(0, paused.total - paused.items.length);
  return { items, total: items.length + hiddenOnServer };
}

export async function loadComments(): Promise<InboxQueueResult> {
  const page = await api<InstagramCommentsPage>("/instagram-comments?status=ESCALATED&pageSize=30");
  return {
    total: page.total,
    items: page.items.map((c): InboxItem => ({
      id: `comments:${c.id}`,
      queue: "comments",
      group: "clients",
      type: "comment",
      commentId: c.id,
      title: c.authorName?.trim() || "Автор комментария",
      detail: `«${c.text.slice(0, 100)}»`,
      at: c.createdAt,
    })),
  };
}

export async function loadReactivation(): Promise<InboxQueueResult> {
  const { items } = await api<{ items: ReactivationOffer[] }>("/clients/reactivation-offers");
  return {
    total: items.length,
    items: items.map((c): InboxItem => ({
      id: `reactivation:${c.id}`,
      queue: "reactivation",
      group: "clients",
      type: "reactivation",
      clientId: c.id,
      title: c.fullName,
      detail: "Клиент вернулся — забрать себе?",
      at: c.reactivationOfferedAt,
    })),
  };
}

export async function loadDuplicates(): Promise<InboxQueueResult> {
  const { items } = await api<{ items: DuplicateReviewItem[] }>("/clients/duplicate-reviews");
  return {
    total: items.length,
    items: items.map((c): InboxItem => ({
      id: `duplicates:${c.id}`,
      queue: "duplicates",
      group: "clients",
      type: "duplicate",
      clientId: c.id,
      title: c.fullName,
      detail: c.duplicateReviewOfClient ? `Похож на «${c.duplicateReviewOfClient.fullName}» — это ваш клиент?` : "Похож на существующего клиента",
      at: c.duplicateReviewAskedAt,
    })),
  };
}

export async function loadEditor(): Promise<InboxQueueResult> {
  const queue = await api<EditorQueue>("/marketing/editor-queue");
  const overdue = queue.inEditing.filter((r) => r.pipeline?.overdue);
  return {
    total: Math.max(queue.counts.overdue, overdue.length),
    items: overdue.map((r): InboxItem => ({
      id: `editor:${r.id}`,
      queue: "editor",
      group: "video",
      type: "editor",
      propertyId: r.id,
      canResend: r.videoHandoffStatus === "SENT_TO_EDITOR" && !r.videoHandoffManualSince,
      canHold: r.videoHandoffStatus === "QUEUED",
      title: r.title,
      detail: `на монтаже ${r.pipeline?.daysInStage ?? "?"} дн.${r.pipeline?.limitDays ? ` из ${r.pipeline.limitDays}` : ""}`,
      at: r.pipeline ? new Date(Date.now() - r.pipeline.daysInStage * 86_400_000).toISOString() : null,
    })),
  };
}

function videoError(v: SocialVideoItem): string {
  const failed = Object.values(v.results ?? {}).find((r) => r.state === "FAILED" && r.error);
  return failed?.error ?? (v.status === "PARTIAL" ? "вышел не везде" : "не опубликован");
}

export async function loadVideos(): Promise<InboxQueueResult> {
  const [failed, partial] = await Promise.all([
    api<SocialVideoListResponse>("/social-videos?status=FAILED&limit=20&offset=0"),
    api<SocialVideoListResponse>("/social-videos?status=PARTIAL&limit=20&offset=0"),
  ]);
  const all = [...failed.items, ...partial.items];
  return {
    total: failed.total + partial.total,
    items: all.map((v): InboxItem => ({
      id: `videos:${v.id}`,
      queue: "videos",
      group: "social",
      type: "video",
      videoId: v.id,
      title: v.title || v.originalName,
      detail: videoError(v).slice(0, 120),
      at: v.finishedAt ?? v.createdAt,
    })),
  };
}

export async function loadStuckConversations(): Promise<InboxQueueResult> {
  const r = await api<{ count: number; items: { id: string; lastMessageAt: string | null }[] }>("/errors/stuck-conversations");
  if (r.count === 0) return { items: [], total: 0 };
  const oldest = r.items.map((i) => i.lastMessageAt).filter((v): v is string => !!v).sort()[0] ?? null;
  return {
    total: 1,
    items: [{
      id: "stuckConversations:all",
      queue: "stuckConversations",
      group: "system",
      type: "stuckConversations",
      count: r.count,
      title: `${r.count} диалогов без ответа клиенту`,
      detail: "Бот не ответил — повторить всем сразу",
      at: oldest,
    }],
  };
}

export async function loadStuckWork(): Promise<InboxQueueResult> {
  const r = await api<{
    givenUp: { id: string; typeLabel: string; label: string; lastError: string | null; updatedAt: string }[];
    hanging: { id: string; typeLabel: string; label: string; lastError: string | null; runAt: string }[];
    counts: { givenUp: number; hanging: number };
  }>("/stuck-work");
  const items: InboxItem[] = [
    ...r.hanging.map((j): InboxItem => ({
      id: `stuckWork:${j.id}`, queue: "stuckWork", group: "system", type: "stuckWork", jobId: j.id,
      title: j.typeLabel, detail: [j.label, j.lastError].filter(Boolean).join(" · ").slice(0, 140), at: j.runAt,
    })),
    ...r.givenUp.map((j): InboxItem => ({
      id: `stuckWork:${j.id}`, queue: "stuckWork", group: "system", type: "stuckWork", jobId: j.id,
      title: j.typeLabel, detail: [j.label, j.lastError].filter(Boolean).join(" · ").slice(0, 140), at: j.updatedAt,
    })),
  ];
  return { items, total: Math.max(items.length, r.counts.givenUp + r.counts.hanging) };
}

export async function loadBotAudit(): Promise<InboxQueueResult> {
  const r = await api<AuditList>("/bot-audit");
  const items: InboxItem[] = r.groups.filter((g) => g.examples.length > 0).map((g) => ({
    id: `botAudit:${g.examples[0].id}`,
    queue: "botAudit",
    group: "system",
    type: "audit",
    findingId: g.examples[0].id,
    title: g.why.slice(0, 90),
    detail: `${g.count > 1 ? `ещё ${g.count - 1} такого же · ` : ""}«${g.examples[0].quote.slice(0, 80)}»`,
    at: g.examples[0].createdAt,
  }));
  return { items, total: r.groupsTotal };
}

export async function loadSiteChanges(): Promise<InboxQueueResult> {
  const r = await api<SiteNotificationsResponse>("/site-notifications?page=1&pageSize=50");
  const verb = { CREATED: "добавлен на сайте", UPDATED: "изменён на сайте", DELETED: "удалён на сайте" } as const;
  return {
    total: r.total,
    items: r.items.filter((n) => !n.resolvedAt).map((n): InboxItem => ({
      id: `siteChanges:${n.id}`,
      queue: "siteChanges",
      group: "system",
      type: "site",
      notificationId: n.id,
      title: n.property.title,
      detail: `Объект №${n.property.shortId} ${verb[n.action]}`,
      at: n.createdAt,
    })),
  };
}

const LOADERS: Record<InboxQueueId, { key: unknown[]; load: () => Promise<InboxQueueResult> }> = {
  waiting: { key: ["conversations", "pult-inbox", "waiting"], load: loadWaiting },
  comments: { key: ["instagram-comments", "pult-inbox"], load: loadComments },
  reactivation: { key: ["reactivation-offers", "pult-inbox"], load: loadReactivation },
  duplicates: { key: ["clients", "pult-inbox", "duplicates"], load: loadDuplicates },
  editor: { key: ["marketing", "pult-inbox", "editor"], load: loadEditor },
  videos: { key: ["social-videos", "pult-inbox"], load: loadVideos },
  stuckConversations: { key: ["conversations", "pult-inbox", "stuck"], load: loadStuckConversations },
  stuckWork: { key: ["pult-inbox", "stuck-work"], load: loadStuckWork },
  botAudit: { key: ["bot-audit", "pult-inbox"], load: loadBotAudit },
  siteChanges: { key: ["site-notifications", "pult-inbox"], load: loadSiteChanges },
};

export interface InboxQueueState extends InboxQueueMeta {
  items: InboxItem[];
  total: number;
  isLoading: boolean;
  isError: boolean;
  refetch: () => unknown;
}

/** Какие очереди доступны роли — повторяет проверки прав соответствующих роутов. */
export function enabledInboxQueues(has: (p: PermissionId) => boolean, role: string | undefined): Set<InboxQueueId> {
  const marketing = role === "DIRECTOR" || role === "ADMIN" || role === "MARKETING";
  const out = new Set<InboxQueueId>();
  if (has("messages.view")) out.add("waiting");
  if (has("comments.moderate")) out.add("comments");
  if (has("clients.assign")) { out.add("reactivation"); out.add("duplicates"); }
  if (marketing) { out.add("editor"); out.add("videos"); }
  if (has("auditLog.view")) { out.add("stuckConversations"); out.add("stuckWork"); out.add("botAudit"); }
  if (has("siteChanges.view") && has("siteChanges.resolve")) out.add("siteChanges");
  return out;
}

export function usePultInbox(enabled = true): InboxQueueState[] {
  const can = useCan();
  const role = useAuthStore((s) => s.agent?.role);
  const allowed = enabledInboxQueues(can, role);
  const queues = INBOX_QUEUES.filter((q) => allowed.has(q.id));
  const results = useQueries({
    queries: queues.map((q) => ({
      queryKey: LOADERS[q.id].key,
      queryFn: LOADERS[q.id].load,
      enabled,
      refetchInterval: SAFETY_REFETCH_MS,
      refetchIntervalInBackground: false,
      staleTime: 15_000,
    })),
  });
  // Результат useQueries каждый рендер новый объект — собираем по данным, не по ссылке.
  const signature = results.map((r) => `${r.dataUpdatedAt}:${r.status}:${r.fetchStatus}`).join("|");
  return useMemo(
    () =>
      queues.map((q, i) => {
        const r = results[i];
        return {
          ...q,
          items: r.data ? [...r.data.items].sort(byAge) : [],
          total: r.data?.total ?? 0,
          isLoading: r.isLoading,
          isError: r.isError,
          refetch: () => r.refetch(),
        };
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [signature, queues.map((q) => q.id).join(",")],
  );
}

// ─────────────────────────────────── действия ───────────────────────────────────

function settle(qc: QueryClient, keys: string[][]) {
  for (const queryKey of keys) void qc.invalidateQueries({ queryKey });
}

/** Все действия бросают Error с понятным текстом при отказе (его покажет строка). */
export function usePultInboxActions() {
  const qc = useQueryClient();
  return useMemo(() => ({
    replyDialog: async (id: string, text: string) => {
      await api(`/conversations/${encodeURIComponent(id)}/reply`, { method: "POST", body: { text } });
      settle(qc, [["conversations"], ["counters"], ["mission-control"]]);
    },
    resumeBot: async (id: string) => {
      await api(`/conversations/${encodeURIComponent(id)}/resume`, { method: "POST" });
      settle(qc, [["conversations"], ["counters"], ["mission-control"]]);
    },
    replyComment: async (id: string, text: string) => {
      await api(`/instagram-comments/${id}/reply`, { method: "POST", body: { text } });
      settle(qc, [["instagram-comments"]]);
    },
    hideComment: async (id: string) => {
      await api(`/instagram-comments/${id}/hide`, { method: "POST" });
      settle(qc, [["instagram-comments"]]);
    },
    reactivation: async (clientId: string, accept: boolean) => {
      await api(`/clients/${clientId}/reactivation-offer/${accept ? "accept" : "decline"}`, { method: "POST" });
      settle(qc, [["reactivation-offers"], ["clients"], ["client"], ["mission-control"]]);
    },
    duplicate: async (clientId: string, same: boolean) => {
      await api(`/clients/${clientId}/duplicate-review/${same ? "confirm" : "deny"}`, { method: "POST" });
      settle(qc, [["duplicate-reviews"], ["clients"], ["client"], ["client-duplicates"], ["mission-control"]]);
    },
    resendHandoff: async (propertyId: string) => {
      await api(`/marketing/video-handoff/${propertyId}/resend`, { method: "POST" });
      settle(qc, [["marketing"], ["properties"], ["property"]]);
    },
    holdHandoff: async (propertyId: string) => {
      await api(`/marketing/video-handoff/${propertyId}/hold`, { method: "POST", body: {} });
      settle(qc, [["marketing"], ["properties"], ["property"]]);
    },
    retryVideo: async (id: string) => {
      await api(`/social-videos/${id}/retry`, { method: "POST", body: {} });
      settle(qc, [["social-videos"]]);
    },
    retryStuckConversations: async () => {
      await api("/errors/stuck-conversations/retry", { method: "POST" });
      settle(qc, [["conversations"]]);
    },
    retryStuckWork: async (id: string) => {
      await api(`/stuck-work/${id}/retry`, { method: "POST" });
      settle(qc, [["pult-inbox", "stuck-work"], ["stuck-work"]]);
    },
    resolveAudit: async (id: string, verdict: "bot_right" | "bot_error") => {
      await api(`/bot-audit/${id}/resolve`, { method: "POST", body: { verdict } });
      settle(qc, [["bot-audit"]]);
    },
    acceptSiteChange: async (id: string) => {
      await api(`/site-notifications/${id}/resolve`, { method: "POST", body: { resolution: "ACCEPTED" } });
      settle(qc, [["site-notifications"]]);
    },
  }), [qc]);
}

export type PultInboxActions = ReturnType<typeof usePultInboxActions>;
