import { useMemo, useRef, useState, type FormEvent } from "react";
import { ArrowUpRight } from "lucide-react";
import type { ActionRowAction, ActionRowData } from "../pult/ActionRow";
import {
  INBOX_GROUP_LABEL,
  INBOX_GROUP_ORDER,
  usePultInbox,
  usePultInboxActions,
  type InboxGroup,
  type InboxItem,
  type InboxQueueState,
  type PultInboxActions,
} from "../../hooks/usePultInbox";
import { useNavigation } from "../../lib/navigation";
import { mcOk, useMissionControl } from "../../hooks/useMissionControl";
import { transferChoice } from "../pult/leastLoadedAgent";
import { CleanDecisionRow } from "./CleanDecisionRow";
import { CButton, CCard, CHead } from "./ui";
import { Link } from "react-router-dom";

/**
 * «ЕЩЁ ЖДУТ РЕШЕНИЯ» (23.10.2026): очереди, которые сервер уже решает, а пульт не
 * показывал. Вид — тот же, что у «Нужны ваши решения»: строка `CleanDecisionRow`,
 * примитивы `ui.tsx`. Решённая строка исчезает сразу; при отказе возвращается
 * с текстом ошибки. Падение одной очереди не трогает остальные.
 */

const PER_QUEUE = 5;
const EMPTY_PHOTOS = new Map<string, string>();
type Filter = "all" | InboxGroup;

const AVATAR_TONE: Record<InboxGroup, ActionRowData["avatar"]["tone"]> = {
  clients: "sky",
  video: "lav",
  social: "pink",
  system: "aqua",
};

const errorText = (cause: unknown) => (cause instanceof Error && cause.message ? cause.message : "Не удалось выполнить действие. Можно повторить.");

/** Кнопки без поля ввода — через общий `CleanDecisionRow` (его «Выполняем…», ошибка, фокус). */
function simpleActions(item: InboxItem, a: PultInboxActions, wrap: (fn: () => Promise<void>) => () => Promise<boolean>, defaultAgentId?: string): ActionRowAction[] {
  const act = (label: string, endpoint: string, fn: () => Promise<void>, doneMessage: string): ActionRowAction =>
    ({ label, endpoint, onRun: wrap(fn), doneMessage });
  switch (item.type) {
    case "unassigned":
      // Агент приходит из выбора в строке (по умолчанию наименее загруженный); нет принимающих — кнопки нет.
      if (!defaultAgentId) return [];
      return [{
        label: "Назначить", endpoint: "POST /api/v1/clients/:id/assign", doneMessage: "Клиент назначен",
        onRun: (choiceId) => wrap(() => a.assignUnassigned(item.clientId, choiceId ?? defaultAgentId))(),
      }];
    case "reactivation":
      return [
        act("Забрать себе", "POST /api/v1/clients/:id/reactivation-offer/accept", () => a.reactivation(item.clientId, true), "Клиент ваш"),
        act("Отклонить", "POST /api/v1/clients/:id/reactivation-offer/decline", () => a.reactivation(item.clientId, false), "Отклонено"),
      ];
    case "duplicate":
      return [
        act("Да, мой клиент", "POST /api/v1/clients/:id/duplicate-review/confirm", () => a.duplicate(item.clientId, true), "Карточки объединены"),
        act("Это разные люди", "POST /api/v1/clients/:id/duplicate-review/deny", () => a.duplicate(item.clientId, false), "Оставлены раздельно"),
      ];
    case "editor":
      return [
        ...(item.canResend ? [act("Отправить снова", "POST /api/v1/marketing/video-handoff/:id/resend", () => a.resendHandoff(item.propertyId), "Отправлено монтажёру")] : []),
        ...(item.canHold ? [act("Отложить", "POST /api/v1/marketing/video-handoff/:id/hold", () => a.holdHandoff(item.propertyId), "Отложено")] : []),
      ];
    case "video":
      return [act("Повторить", "POST /api/v1/social-videos/:id/retry", () => a.retryVideo(item.videoId), "Публикация запущена снова")];
    case "stuckWork":
      return [act("Повторить", "POST /api/v1/stuck-work/:id/retry", () => a.retryStuckWork(item.jobId), "Поставлено на повтор")];
    case "audit":
      return [
        act("Бот прав", "POST /api/v1/bot-audit/:id/resolve", () => a.resolveAudit(item.findingId, "bot_right"), "Находка закрыта"),
        act("Бот ошибся", "POST /api/v1/bot-audit/:id/resolve", () => a.resolveAudit(item.findingId, "bot_error"), "Учтено как ошибка бота"),
      ];
    case "site":
      return [act("Принято", "POST /api/v1/site-notifications/:id/resolve", () => a.acceptSiteChange(item.notificationId), "Принято")];
    default:
      return [];
  }
}

function InboxEntry({ item, show, hidden, onGone, onBack, actions, agentChoice }: {
  item: InboxItem; show: boolean; hidden: boolean;
  agentChoice?: ReturnType<typeof transferChoice>;
  onGone: (id: string) => void; onBack: (id: string) => void;
  actions: PultInboxActions;
}) {
  const [error, setError] = useState("");
  const [text, setText] = useState("");
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const armTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const lock = useRef(false);

  /** Оптимистично: строка уходит сразу, при отказе возвращается с текстом. */
  async function optimistic(fn: () => Promise<void>): Promise<boolean> {
    if (lock.current) return false;
    lock.current = true; setBusy(true); setError(""); onGone(item.id);
    try { await fn(); return true; }
    catch (cause) { onBack(item.id); setError(errorText(cause)); throw cause; }
    finally { lock.current = false; setBusy(false); }
  }
  const swallow = (fn: () => Promise<void>) => () => optimistic(fn);
  const quiet = async (fn: () => Promise<void>) => { try { await optimistic(fn); } catch { /* текст ошибки уже в строке */ } };

  if (!show && !hidden) return null;
  if (hidden) return null;

  const row: ActionRowData = {
    id: `inbox-${item.id}`,
    tone: "warn",
    k: INBOX_GROUP_LABEL[item.group],
    avatar: { label: item.title, tone: AVATAR_TONE[item.group] },
    title: item.title,
    actions: simpleActions(item, actions, swallow, agentChoice?.defaultId),
    choice: item.type === "unassigned" && agentChoice ? { ...agentChoice, label: "Кому назначить" } : undefined,
  };
  if (item.type === "unassigned" && !agentChoice) row.k = `${row.k} · нет агентов, принимающих лиды`;
  // Вторая строка: возраст и суть. `k` выводится после «Требует внимания».
  row.k = [INBOX_GROUP_LABEL[item.group], item.detail].filter(Boolean).join(" · ");

  const customBar = item.type === "dialog" || item.type === "comment" || item.type === "stuckConversations";
  const send = (e: FormEvent) => {
    e.preventDefault();
    const value = text.trim();
    if (!value || busy) return;
    if (item.type === "dialog") void quiet(() => actions.replyDialog(item.conversationId, value));
    if (item.type === "comment") void quiet(() => actions.replyComment(item.commentId, value));
  };
  const arm = () => {
    setArmed(true);
    clearTimeout(armTimer.current);
    armTimer.current = setTimeout(() => setArmed(false), 6000);
  };

  return <div>
    <CleanDecisionRow row={row} photos={EMPTY_PHOTOS} />
    {customBar && <div className="mt-2 flex flex-wrap items-center gap-2 pl-0 sm:pl-[54px]">
      {(item.type === "dialog" || item.type === "comment") && <form onSubmit={send} className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          maxLength={item.type === "dialog" ? 2000 : 2200}
          disabled={busy}
          aria-label={item.type === "dialog" ? `Ответ клиенту ${item.title}` : `Ответ на комментарий ${item.title}`}
          placeholder="Напишите ответ…"
          className="min-h-11 min-w-[180px] flex-1 rounded-[14px] bg-row-alt px-3.5 text-[14px] text-ink placeholder:text-gray-500 focus-visible:outline-2 focus-visible:outline-blue"
        />
        <CButton type="submit" variant="primary" size="sm" disabled={busy || !text.trim()}>{busy ? "Выполняем…" : "Ответить"}</CButton>
      </form>}
      {item.type === "dialog" && item.paused && <CButton variant="soft" size="sm" disabled={busy} data-endpoint="POST /api/v1/conversations/:id/resume" onClick={() => void quiet(() => actions.resumeBot(item.conversationId))}>Вернуть бота</CButton>}
      {item.type === "comment" && <CButton variant="soft" size="sm" disabled={busy} data-endpoint="POST /api/v1/instagram-comments/:id/hide" onClick={() => void quiet(() => actions.hideComment(item.commentId))}>Скрыть</CButton>}
      {item.type === "stuckConversations" && <CButton variant="primary" size="sm" disabled={busy} data-endpoint="POST /api/v1/errors/stuck-conversations/retry"
        onClick={() => { if (!armed) { arm(); return; } clearTimeout(armTimer.current); setArmed(false); void quiet(() => actions.retryStuckConversations()); }}>
        {busy ? "Выполняем…" : armed ? `Точно? Повторить для ${item.count}` : "Повторить всем"}
      </CButton>}
    </div>}
    {error && <p role="alert" className="clean-decision-error">{error}</p>}
  </div>;
}

function QueueErrors({ queues }: { queues: InboxQueueState[] }) {
  const failed = queues.filter((q) => q.isError);
  if (!failed.length) return null;
  return <div className="grid gap-1.5">
    {failed.map((q) => <div key={q.id} role="alert" className="flex flex-wrap items-center gap-2 rounded-[14px] bg-red-bg px-4 py-2.5 text-[14px] text-red">
      <span className="min-w-0 flex-1">«{q.label}» не загрузилось. Данные не подтверждены.</span>
      <CButton variant="soft" size="sm" onClick={() => void q.refetch()}>Повторить</CButton>
    </div>)}
  </div>;
}

export function CleanPultInbox({ enabled = true }: { enabled?: boolean }) {
  const queues = usePultInbox(enabled);
  const actions = usePultInboxActions();
  // Те же агенты и та же нагрузка, что у «Передать» в «Нужны ваши решения»: на паузе приёма — не в списке.
  const mission = useMissionControl(enabled && queues.some((q) => q.id === "unassigned"));
  const agentChoice = useMemo(() => transferChoice(mission.data?.team && mcOk(mission.data.team) ? mission.data.team.agents : []), [mission.data]);
  const { all: navigation } = useNavigation();
  const hasRoute = (path: string) => navigation.some((item) => item.to === path);
  const [filter, setFilter] = useState<Filter>("all");
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const onGone = useMemo(() => (id: string) => setHidden((p) => new Set(p).add(id)), []);
  const onBack = useMemo(() => (id: string) => setHidden((p) => { const n = new Set(p); n.delete(id); return n; }), []);

  if (!queues.length) return null;

  const hiddenIn = (q: InboxQueueState) => q.items.filter((i) => hidden.has(i.id)).length;
  const left = (q: InboxQueueState) => Math.max(0, q.total - hiddenIn(q));
  const groupCount = (g: InboxGroup) => queues.filter((q) => q.group === g).reduce((s, q) => s + left(q), 0);
  const allCount = queues.reduce((s, q) => s + left(q), 0);
  const chips: { id: Filter; label: string; count: number }[] = [
    { id: "all", label: "Все", count: allCount },
    ...INBOX_GROUP_ORDER.filter((g) => queues.some((q) => q.group === g)).map((g) => ({ id: g as Filter, label: INBOX_GROUP_LABEL[g], count: groupCount(g) })),
  ];
  const shown = queues
    .filter((q) => filter === "all" || q.group === filter)
    .sort((a, b) => INBOX_GROUP_ORDER.indexOf(a.group) - INBOX_GROUP_ORDER.indexOf(b.group));
  const loading = shown.some((q) => q.isLoading);
  const anyData = shown.some((q) => q.items.length > 0);
  const anyError = shown.some((q) => q.isError);
  const allEmpty = !loading && !anyError && shown.every((q) => left(q) === 0);

  return <CCard aria-label="Ещё ждут решения">
    <CHead title="Ещё ждут решения" count={loading && !anyData ? "…" : allCount} />
    <div className="mb-3 flex flex-wrap gap-2" role="group" aria-label="Фильтр очередей">
      {chips.map((c) => <CButton key={c.id} variant={filter === c.id ? "primary" : "soft"} size="sm" aria-pressed={filter === c.id} onClick={() => setFilter(c.id)}>
        {c.label}{loading && !anyData ? "" : ` ${c.count}`}
      </CButton>)}
    </div>
    <QueueErrors queues={shown} />
    {loading && !anyData
      ? <div className="grid gap-1.5" role="status" aria-label="Загружаем очереди">
          {[0, 1, 2].map((i) => <div key={i} className="h-[72px] animate-pulse rounded-[14px] bg-row-alt" />)}
        </div>
      : allEmpty
        ? <p className="m-0 text-gray-600">Всё разобрано</p>
        : <div className="mt-1 grid gap-4">
            {shown.map((q) => {
              const visibleIds = new Set(q.items.filter((i) => !hidden.has(i.id)).slice(0, PER_QUEUE).map((i) => i.id));
              const more = left(q) - visibleIds.size;
              if (!q.items.length && !more) return null;
              return <section key={q.id} aria-label={q.label} className="grid gap-1.5">
                <p className="m-0 text-[13px] text-gray-500">{q.label} · {left(q)}</p>
                {q.items.map((item) => <InboxEntry key={item.id} item={item} show={visibleIds.has(item.id)} hidden={hidden.has(item.id)}
                  onGone={onGone} onBack={onBack} actions={actions} agentChoice={agentChoice} />)}
                {more > 0 && (hasRoute(q.href)
                  ? <Link to={q.href} className="inline-flex min-h-11 items-center gap-1 text-[13px] text-gray-500 hover:text-ink">ещё {more} <ArrowUpRight className="size-4" /></Link>
                  : <span className="text-[13px] text-gray-500">ещё {more}</span>)}
              </section>;
            })}
          </div>}
  </CCard>;
}
