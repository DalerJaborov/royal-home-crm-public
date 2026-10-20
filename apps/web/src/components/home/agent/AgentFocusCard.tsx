import type { ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Button, Card } from "../../rh2";
import { useSettings } from "../../../hooks/useSettings";
import { useNow } from "../../../hooks/useNow";
import { mmss } from "../../../lib/countdown";
import { clientDisplayName } from "../../../lib/clientFormat";
import { focusReason } from "../../../lib/focusReason";
import { pluralizeRu, relativeTime } from "../../../lib/format";
import { leadHint, nextStepLine, type AgentTodoItem } from "../../../lib/agentFocus";
import {
  CallWide,
  DuplicateReviewActions,
  PendingLeadActions,
  ReactivationActions,
} from "./AgentActions";

/**
 * «СНАЧАЛА ЭТО» (контракт 06.10.2026, раздел 4): одна тёмная карточка с одним
 * делом, которое нельзя откладывать. Что именно, решает `lib/agentFocus.ts`;
 * здесь только рисуем. Номер клиента до принятия не показывается и звонить
 * нельзя: у лида на принятие кнопок звонка нет, это не оплошность.
 *
 * Таймеры стоят в листьях (`Until`, `PendingTimer`), а не в экране: общая
 * секундная подписка (`useNow`) перерисовывает только их, а не всю Главную и
 * не шапку, которой экран отдал заголовок.
 */

/** Сколько осталось до момента `at`; после него — `doneText`. */
function Until({ at, label, doneText }: { at: string; label: string; doneText: string }) {
  const now = useNow();
  const left = Date.parse(at) - now;
  if (!Number.isFinite(left)) return null;
  return left <= 0 ? (
    <span className="rh-focus-note">{doneText}</span>
  ) : (
    <>
      <span className="rh-focus-timer">{mmss(left)}</span>
      <span className="rh-focus-note">{label}</span>
    </>
  );
}

/** Срок принятия лида. Число минут живёт в Настройках; у агента его может не быть, тогда честно «ждёт N». */
function PendingTimer({ assignedAt, escalated }: { assignedAt: string; escalated: boolean }) {
  const { data: settings } = useSettings();
  const now = useNow();
  const minutes =
    typeof settings?.leadAcceptMinutes === "number" && Number.isFinite(settings.leadAcceptMinutes)
      ? settings.leadAcceptMinutes
      : null;
  const assigned = Date.parse(assignedAt);
  if (!Number.isFinite(assigned)) return null;
  const waited = now - assigned;
  const left = minutes !== null ? minutes * 60_000 - waited : null;
  if (escalated) return <span className="rh-focus-note">никто не принял, лид ждёт</span>;
  if (left !== null && left <= 0) return <span className="rh-focus-note">время вышло, примите сейчас</span>;
  if (left !== null) {
    return (
      <>
        <span className="rh-focus-timer">{mmss(left)}</span>
        <span className="rh-focus-note">до передачи другому агенту</span>
      </>
    );
  }
  return (
    <>
      <span className="rh-focus-timer">{mmss(waited)}</span>
      <span className="rh-focus-note">ждёт принятия</span>
    </>
  );
}

interface FocusView {
  title: string;
  to: string | null;
  line?: ReactNode;
  why?: string;
  timer?: ReactNode;
  actions: ReactNode;
}

/** Две кнопки «позвонить» и «открыть карточку» для всех случаев, где номер уже доступен. */
function CallAndOpen({
  clientId,
  phone,
  to,
}: {
  clientId: string | undefined;
  phone: string | null | undefined;
  to: string | null;
}) {
  const navigate = useNavigate();
  const canCall = !!clientId && !!phone;
  return (
    <>
      {canCall && <CallWide clientId={clientId} phone={phone} />}
      {to && (
        <Button variant="soft" onClick={() => navigate(to)}>
          Открыть карточку
        </Button>
      )}
    </>
  );
}

function describe(todo: AgentTodoItem): FocusView {
  switch (todo.kind) {
    case "pending": {
      const c = todo.client;
      return {
        title: `Новый лид: ${clientDisplayName(c.fullName)}`,
        to: `/clients/${c.shortId}`,
        line: [leadHint(c), c.leadReason?.text].filter(Boolean).join(". "),
        timer: <PendingTimer assignedAt={c.assignedAt} escalated={!c.acceptedAt && !!c.escalatedAt} />,
        actions: <PendingLeadActions client={c} />,
      };
    }
    case "duplicate": {
      const r = todo.review;
      const other = r.duplicateReviewOfClient;
      return {
        title: `Это ваш клиент? ${clientDisplayName(r.fullName)}`,
        to: other ? `/clients/${other.shortId}` : null,
        line: `Новая заявка похожа на «${other?.fullName ?? "?"}»`,
        actions: <DuplicateReviewActions review={r} />,
      };
    }
    case "reactivation": {
      const o = todo.offer;
      return {
        title: `${clientDisplayName(o.fullName)} написал снова`,
        to: `/clients/${o.shortId}`,
        line: "Вернуть карточку себе?",
        actions: <ReactivationActions offer={o} />,
      };
    }
    case "supervisor": {
      const i = todo.item;
      const to = `/clients/${i.shortId}`;
      return {
        title: `Позвонить: ${clientDisplayName(i.fullName)}`,
        to,
        line: `${i.byName ? `Вам назначил(а) ${i.byName}` : "Вам назначил руководитель"}, клиент ждёт звонка`,
        actions: <CallAndOpen clientId={i.id} phone={i.phone} to={to} />,
      };
    }
    case "firstCall": {
      const i = todo.item;
      const to = `/clients/${i.shortId}`;
      return {
        title: `Позвонить: ${clientDisplayName(i.fullName)}`,
        to,
        line: "Первый звонок новому клиенту",
        timer: <Until at={i.dueAt} label="до срока первого звонка" doneText="срок вышел, звоните сейчас" />,
        actions: <CallAndOpen clientId={i.id} phone={i.phone} to={to} />,
      };
    }
    case "task": {
      const t = todo.task;
      const c = t.client;
      const to = c?.shortId != null ? `/clients/${c.shortId}` : "/calendar";
      return {
        title: clientDisplayName(c?.fullName),
        to,
        line: t.property?.title ?? (t.nextAction || "Ждёт ответа"),
        why: focusReason(t),
        actions: <CallAndOpen clientId={c?.id} phone={c?.phone} to={to} />,
      };
    }
    case "cold": {
      const c = todo.client;
      const to = `/clients/${c.shortId}`;
      return {
        title: `${clientDisplayName(c.fullName)}: ${todo.days} ${pluralizeRu(todo.days, ["день", "дня", "дней"])} без контакта`,
        to,
        line: `${nextStepLine(c)}. Последний контакт ${relativeTime(c.lastContactAt)}`,
        actions: <CallAndOpen clientId={c.id} phone={c.phone} to={to} />,
      };
    }
    case "client":
      // Строка портфеля в фокус не попадает (agentFocus.ts); ветка нужна полноте перечисления.
      return { title: clientDisplayName(todo.client.fullName), to: `/clients/${todo.client.shortId}`, actions: null };
  }
}

export function AgentFocusCard({ todo }: { todo: AgentTodoItem }) {
  const v = describe(todo);
  return (
    <Card tight className="rh-focus" aria-label="Сначала это" data-testid="agent-focus">
      <p className="rh-focus-lbl">Сначала это</p>
      <h2 className="rh-focus-title">{v.to ? <Link to={v.to}>{v.title}</Link> : v.title}</h2>
      {v.line ? <p className="rh-focus-line">{v.line}</p> : null}
      {v.why ? <p className="rh-focus-line">{v.why}</p> : null}
      {v.timer ? <div className="rh-focus-time">{v.timer}</div> : null}
      <div className="rh-focus-acts">{v.actions}</div>
    </Card>
  );
}
