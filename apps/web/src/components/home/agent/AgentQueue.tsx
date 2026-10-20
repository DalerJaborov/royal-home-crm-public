import { useRef, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { Card, Chip, List, Row, Button, Skeleton } from "../../rh2";
import type { RowAvatar } from "../../rh2";
import { SwipeRow } from "../../SwipeRow";
import { useNow } from "../../../hooks/useNow";
import { mmss } from "../../../lib/countdown";
import { clientDisplayName } from "../../../lib/clientFormat";
import { dushanbeTime } from "../../../lib/date";
import { pluralizeRu } from "../../../lib/format";
import { initials } from "../../../lib/theme2026Person";
import { NO_CONTACT_DAYS } from "../../../lib/agentDay";
import { leadHint, nextStepLine, type AgentTodoItem } from "../../../lib/agentFocus";
import { CallCircle, DuplicateReviewActions, PendingLeadActions, ReactivationActions } from "./AgentActions";

/**
 * «ОЧЕРЕДЬ» (контракт 06.10.2026): всё, что не заняло «Сначала это», по
 * приоритету. Одна строка, один чип, и чип называет действие (словарь в
 * `docs/design/contract-2026-10/review-statuses.md`); справа зелёная трубка.
 * Ничего, что можно прочитать из соседней строки, в чипе не повторяется:
 * «горячий» и «новый» чипом не бывают.
 *
 * Строки-решения (лид на принятие, «ваш клиент?», возврат прежнего) несут свои
 * кнопки прямо в строке: это те же действия, что в тёмной карточке, и терять
 * их, когда в очереди не одна заявка, нельзя.
 *
 * Смахивание строки (позвонить / открыть) осталось с прежней телефонной
 * главной: `SwipeRow` сам включается только на телефоне и нажимает настоящую
 * кнопку звонка внутри строки, так что правило «звонок только через CRM»
 * живёт в одном месте.
 */

const TONES: RowAvatar["tone"][] = ["lime", "aqua", "lav", "sky", "pink"];
/** Сколько строк в очереди видно сразу; остальное в «Клиентах». */
export const QUEUE_LIMIT = 5;

/** Таймер срока первого звонка живёт в листьях: перерисовывается секундой только он. */
function DueLine({ dueAt }: { dueAt: string }) {
  const left = Date.parse(dueAt) - useNow();
  if (!Number.isFinite(left)) return <>Первый звонок</>;
  return left <= 0 ? <>Срок вышел, звоните сейчас</> : <>Первый звонок, осталось {mmss(left)}</>;
}
function DueChip({ dueAt }: { dueAt: string }) {
  const left = Date.parse(dueAt) - useNow();
  return left <= 0 ? <Chip tone="crit">Позвонить сейчас</Chip> : <Chip tone="warn">Позвонить</Chip>;
}

function SwipeCall({ to, canCall, children }: { to: string; canCall: boolean; children: ReactNode }) {
  const navigate = useNavigate();
  const ref = useRef<HTMLDivElement>(null);
  return (
    <SwipeRow
      onOpen={() => navigate(to)}
      onCall={canCall ? () => ref.current?.querySelector<HTMLButtonElement>("[data-call-button]")?.click() : null}
    >
      <div ref={ref}>{children}</div>
    </SwipeRow>
  );
}

function QueueRow({ todo, index }: { todo: AgentTodoItem; index: number }) {
  const tone = TONES[index % TONES.length];
  const av = (name: string | null | undefined, t = tone): RowAvatar => ({ label: initials(name ?? ""), tone: t });

  switch (todo.kind) {
    case "pending": {
      const c = todo.client;
      const escalated = !c.acceptedAt && !!c.escalatedAt;
      return (
        <SwipeCall to={`/clients/${c.shortId}`} canCall={false}>
          <Row
            className="rh-decide"
            avatar={av(c.fullName, escalated ? "pink" : "lime")}
            title={clientDisplayName(c.fullName)}
            line={`${escalated ? "Никто не принял" : "Ждёт принятия"} · ${leadHint(c)}`}
            href={`/clients/${c.shortId}`}
            actions={<PendingLeadActions client={c} compact />}
          />
        </SwipeCall>
      );
    }
    case "duplicate": {
      const r = todo.review;
      const other = r.duplicateReviewOfClient;
      return (
        <Row
          className="rh-decide"
          avatar={av(r.fullName, "pink")}
          title={clientDisplayName(r.fullName)}
          line={`Похоже на «${other?.fullName ?? "?"}»: тот же человек?`}
          href={other ? `/clients/${other.shortId}` : undefined}
          actions={<DuplicateReviewActions review={r} compact />}
        />
      );
    }
    case "reactivation": {
      const o = todo.offer;
      return (
        <Row
          className="rh-decide"
          avatar={av(o.fullName, "aqua")}
          title={clientDisplayName(o.fullName)}
          line="Написал снова, вернуть карточку себе?"
          href={`/clients/${o.shortId}`}
          actions={<ReactivationActions offer={o} compact />}
        />
      );
    }
    case "supervisor": {
      const i = todo.item;
      const canCall = !!i.phone; // маска номера звонку не мешает: номер берёт сервер (аудит №54)
      return (
        <SwipeCall to={`/clients/${i.shortId}`} canCall={canCall}>
          <Row
            avatar={av(i.fullName)}
            title={clientDisplayName(i.fullName)}
            line={i.byName ? `Вам назначил(а) ${i.byName}` : "Вам назначил руководитель"}
            chip={<Chip tone="warn">Позвонить</Chip>}
            href={`/clients/${i.shortId}`}
            actions={canCall ? <CallCircle clientId={i.id} phone={i.phone} /> : undefined}
          />
        </SwipeCall>
      );
    }
    case "firstCall": {
      const i = todo.item;
      const canCall = !!i.phone;
      return (
        <SwipeCall to={`/clients/${i.shortId}`} canCall={canCall}>
          <Row
            avatar={av(i.fullName, "pink")}
            title={clientDisplayName(i.fullName)}
            line={<DueLine dueAt={i.dueAt} />}
            chip={<DueChip dueAt={i.dueAt} />}
            href={`/clients/${i.shortId}`}
            actions={canCall ? <CallCircle clientId={i.id} phone={i.phone} /> : undefined}
          />
        </SwipeCall>
      );
    }
    case "task": {
      const t = todo.task;
      const c = t.client;
      const canCall = !!c?.id && !!c.phone;
      const to = c?.shortId != null ? `/clients/${c.shortId}` : "/calendar";
      const what = t.property?.title ?? (t.nextAction || "Задача");
      return (
        <SwipeCall to={to} canCall={canCall}>
          <Row
            avatar={av(c?.fullName ?? t.nextAction)}
            title={clientDisplayName(c?.fullName)}
            line={t.nextActionDate ? `${what} · к ${dushanbeTime(t.nextActionDate)}` : what}
            chip={t.type === "CALL" ? <Chip tone="warn">Позвонить</Chip> : undefined}
            href={to}
            actions={canCall ? <CallCircle clientId={c?.id} phone={c?.phone} /> : undefined}
          />
        </SwipeCall>
      );
    }
    case "client":
    case "cold": {
      const c = todo.client;
      const canCall = !!c.phone;
      const overdue = todo.kind === "client" && todo.urgency === "overdue";
      const chip = overdue ? (
        <Chip tone="crit">Позвонить сейчас</Chip>
      ) : todo.days >= NO_CONTACT_DAYS ? (
        <Chip tone="warn">
          {todo.days} {pluralizeRu(todo.days, ["день", "дня", "дней"])}
        </Chip>
      ) : undefined;
      return (
        <SwipeCall to={`/clients/${c.shortId}`} canCall={canCall}>
          <Row
            avatar={av(c.fullName)}
            title={clientDisplayName(c.fullName)}
            line={nextStepLine(c)}
            chip={chip}
            href={`/clients/${c.shortId}`}
            actions={canCall ? <CallCircle clientId={c.id} phone={c.phone} /> : undefined}
          />
        </SwipeCall>
      );
    }
  }
}

export function AgentQueue({ queue, loading }: { queue: AgentTodoItem[]; loading: boolean }) {
  const navigate = useNavigate();
  if (loading) {
    return (
      <Card tight title="Очередь" aria-label="Очередь">
        <List>
          <Skeleton kind="row" />
          <Skeleton kind="row" />
          <Skeleton kind="row" />
        </List>
      </Card>
    );
  }
  if (queue.length === 0) return null;
  const shown = queue.slice(0, QUEUE_LIMIT);
  const hidden = queue.length - shown.length;
  return (
    <Card tight title="Очередь" aria-label="Очередь" data-testid="agent-queue">
      <List>
        {shown.map((todo, i) => (
          <QueueRow key={todo.key} todo={todo} index={i} />
        ))}
      </List>
      {hidden > 0 && (
        <Button variant="ghost" size="sm" className="rh-home-more" onClick={() => navigate("/clients")}>
          Все клиенты
        </Button>
      )}
    </Card>
  );
}
