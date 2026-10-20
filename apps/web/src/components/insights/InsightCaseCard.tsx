import { useState } from "react";
import { AlertTriangle, CheckCircle, ChevronDown, Loader2, Star } from "lucide-react";
import type { InsightCaseKind } from "@royal-home/shared";
import type { InsightCaseView, InsightTimeline } from "../../hooks/useInsights";
import { useReviewInsightCase } from "../../hooks/useInsights";
import { VoiceNotePlayer } from "../VoiceNotePlayer";

/**
 * Карточка кейса «Инсайты от ИИ» — одна и та же на десктопе и телефоне
 * (pages/Insights.tsx и components/mobile/MobileInsights.tsx): различаются
 * только обёртки-страницы, содержание разбора не должно расходиться.
 *
 * ОБЛИК — тема «Royal Home 2026», эталон `screens/insights.html`. Кейс в
 * макете нарисован строкой `.mod` (шапка `.t`, метки и кнопка записи в
 * `.acts`, «как надо было» в `.why` цитатой). Здесь кейс раскрывается, поэтому
 * взят раскрывающийся кирпич эталона `.acc` / `.acc-h` / `.acc-b`, а его
 * содержимое — те же `.mod`, `.why`, `.quote`, `.chip`, `.pill` макета.
 */

export const CASE_KIND_LABEL: Record<InsightCaseKind, string> = {
  call_low_score: "Слабый звонок",
  score_penalty: "Штраф Royal Score",
  agent_bypass: "Обход CRM в переписке",
  client_lost: "Потерянный клиент",
  complaint: "Жалоба клиента",
  positive: "Хороший пример",
};

/** Тон метки кейса классами эталона: положительный — ok, тяжёлый — crit, средний — warn. */
function severityChip(severity: number, kind: InsightCaseKind): string {
  if (kind === "positive") return "chip ok";
  if (severity >= 4) return "chip crit";
  if (severity === 3) return "chip warn";
  return "chip";
}

export function formatDayMonth(iso: string): string {
  return new Date(iso).toLocaleDateString("ru-RU", { timeZone: "Asia/Dushanbe", day: "numeric", month: "long" });
}

export function InsightCaseCard({ item, digestId }: { item: InsightCaseView; digestId: string }) {
  const [expanded, setExpanded] = useState(false);
  const [note, setNote] = useState(item.meetingNote ?? "");
  const review = useReviewInsightCase(digestId);
  const reviewed = !!item.reviewedAt;

  return (
    <article className="acc">
      <button className="acc-h" type="button" onClick={() => setExpanded((v) => !v)} aria-expanded={expanded}>
        <span style={{ flex: 1, minWidth: 0 }}>
          <span style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
            <span className={severityChip(item.severity, item.kind)}>
              {item.kind === "positive" ? (
                <Star className="i" aria-hidden />
              ) : item.severity >= 4 ? (
                <AlertTriangle className="i" aria-hidden />
              ) : null}
              {CASE_KIND_LABEL[item.kind]}
            </span>
            {item.kind !== "positive" && <span className="chip mute">серьёзность {item.severity}/5</span>}
            {reviewed && (
              <span className="chip ok">
                <span className="dot ok" /> разобрано
              </span>
            )}
          </span>
          <h3 style={{ marginTop: 4 }}>
            {item.agentName ?? "Агент"} → {item.clientName ?? "клиент"}
            {item.clientShortId != null && <span className="note"> · КЛ-{item.clientShortId}</span>}
          </h3>
          {item.verdict?.summary && (
            <span style={{ display: "block", fontSize: "var(--fs-13)", color: "var(--muted)", marginTop: 2 }}>
              {item.verdict.summary}
            </span>
          )}
        </span>
        <ChevronDown className="i ch" aria-hidden />
      </button>

      {expanded && (
        <div className="acc-b">
          {item.recordingUrl && (
            <div className="mod">
              <div className="t">
                <b>Запись разговора</b>
                <VoiceNotePlayer url={item.recordingUrl} className="h-9 w-full" />
              </div>
            </div>
          )}

          <TimelineBlock timeline={item.timeline} />

          {item.verdict ? (
            <>
              {item.verdict.wrong && item.verdict.wrong.length > 0 && (
                <div className="mod">
                  <div className="t">
                    <b>Что было не так</b>
                    {item.verdict.wrong.map((w, i) => (
                      <span className="quote" key={i}>
                        <b>«{w.quote}»</b>
                        {w.why}
                      </span>
                    ))}
                  </div>
                </div>
              )}
              {item.verdict.better && item.verdict.better.length > 0 && (
                <div className="mod">
                  <div className="t">
                    <b>{item.kind === "positive" ? "Что масштабировать на команду" : "Как надо было"}</b>
                    {item.verdict.better.map((b, i) => (
                      <span className="quote" key={i}>
                        {b}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </>
          ) : (
            <div className="quiet warn">
              <span className="dot warn" />
              <span className="txt">
                Разбор ИИ по этому кейсу не получен (модель не ответила или кончился дневной бюджет) —
                разбирайте по записи и транскрипту.
              </span>
            </div>
          )}

          <div className="mod">
            <label className="fld" htmlFor={`note-${item.id}`}>
              <span className="lab">Заметка со собрания</span>
              <textarea
                id={`note-${item.id}`}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={2}
                maxLength={2000}
                placeholder="Что решили, кому что поручили"
              />
            </label>
            <div className="acts" style={{ flex: "1 1 100%" }}>
              <button
                className="pill sm"
                type="button"
                disabled={review.isPending}
                onClick={() => review.mutate({ caseId: item.id, meetingNote: note.trim() || undefined })}
              >
                {review.isPending ? <Loader2 className="i" aria-hidden /> : <CheckCircle className="i" aria-hidden />}
                {reviewed ? "Обновить заметку" : "Разобрано на собрании"}
              </button>
            </div>
            {review.isError && (
              <div className="quiet crit" style={{ flex: "1 1 100%" }} role="alert">
                <span className="dot crit" />
                <span className="txt">Не удалось сохранить, попробуйте ещё раз</span>
              </div>
            )}
          </div>
        </div>
      )}
    </article>
  );
}

function TimelineBlock({ timeline }: { timeline: InsightTimeline | null }) {
  if (!timeline) return null;
  const meta = timeline.meta ?? {};

  if (timeline.kind === "call_low_score" || timeline.kind === "positive") {
    const transcript = typeof timeline.content === "string" ? timeline.content : null;
    const score = typeof meta.score === "number" ? meta.score : null;
    const coaching = typeof meta.coaching === "string" ? meta.coaching : null;
    return (
      <div className="mod">
        <div className="t">
          {score != null && (
            <b>
              Оценка разговора ИИ: {score}/100
            </b>
          )}
          {transcript ? (
            <details>
              <summary style={{ cursor: "pointer", minHeight: 44, display: "flex", alignItems: "center", color: "var(--muted)" }}>
                Транскрипт разговора
              </summary>
              <span className="quote" style={{ whiteSpace: "pre-wrap" }}>
                {transcript}
              </span>
            </details>
          ) : (
            <span>Транскрипта нет — слушайте запись.</span>
          )}
          {coaching && <span>{coaching}</span>}
        </div>
      </div>
    );
  }

  if (timeline.kind === "score_penalty") {
    const delta = typeof meta.delta === "number" ? meta.delta : null;
    return (
      <div className="mod">
        <div className="t">
          {delta != null && <b style={{ color: "var(--crit)" }}>{delta} баллов</b>}
          <span>{typeof timeline.content === "string" ? timeline.content : "Причина штрафа не сохранена"}</span>
        </div>
      </div>
    );
  }

  if (timeline.kind === "agent_bypass") {
    const messages = Array.isArray(timeline.content) ? (timeline.content as unknown[]) : [];
    const quote = typeof meta.quote === "string" ? meta.quote : null;
    return (
      <div className="mod">
        <div className="t">
          {quote && (
            <span className="quote">
              <b>Реплика, из-за которой кейс попал в разбор</b>«{quote}»
            </span>
          )}
          {messages.length > 0 && (
            <details>
              <summary style={{ cursor: "pointer", minHeight: 44, display: "flex", alignItems: "center", color: "var(--muted)" }}>
                Последние реплики переписки
              </summary>
              {messages.map((m, i) => {
                const msg = (m ?? {}) as { role?: string; content?: string; text?: string };
                const mine = msg.role === "assistant";
                return (
                  <span className="quote" key={i}>
                    <b>{mine ? "Мы" : "Клиент"}</b>
                    {msg.content ?? msg.text ?? ""}
                  </span>
                );
              })}
            </details>
          )}
        </div>
      </div>
    );
  }

  return null;
}
