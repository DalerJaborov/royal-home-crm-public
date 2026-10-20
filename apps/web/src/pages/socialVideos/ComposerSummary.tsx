import { CalendarClock, Image as ImageIcon, Loader2, Rocket, Save } from "lucide-react";
import {
  destinationKeyOf,
  formatBytesRu,
  formatDurationRu,
  type ChannelVerdict,
  type SocialVideoChannel,
  type SocialVideoChannelInfo,
  type SocialVideoChannelLive,
  type SocialVideoDestination,
  type SocialVideoFacts,
} from "@royal-home/shared";
import { exactDateTime } from "../../lib/format";
import { destinationLabel } from "../../lib/socialVideoDestinations";
import { ChannelBadge } from "../../components/socialVideos/ChannelBadge";

/**
 * Липкая сводка композитора «Как уйдёт»: что, куда и когда — до нажатия кнопки.
 * Здесь же главная кнопка и причина, по которой она может быть заблокирована
 * (серая кнопка без слов читается как поломка).
 */
export interface ComposerSummaryProps {
  title: string;
  facts: SocialVideoFacts | null;
  /** Выбранные адреса «канал + аккаунт»; вердикты и лимиты остаются по каналу. */
  selected: SocialVideoDestination[];
  /** Справочник каналов — названия аккаунтов для подписей. */
  infos: SocialVideoChannelInfo[];
  verdicts: ChannelVerdict[];
  live: Partial<Record<SocialVideoChannel, SocialVideoChannelLive>>;
  mode: "NOW" | "SCHEDULE";
  scheduledAt: string | null;
  hasCover: boolean;
  /** Почему публиковать пока нельзя; пусто — можно. */
  blockReasons: string[];
  busy: "saving" | "publishing" | null;
  /** Состояние автосохранения словами: «Сохранено», «Сохраняем…» или текст ошибки. */
  saveNote: string | null;
  canSaveDraft: boolean;
  onSaveDraft: () => void;
  onPublish: () => void;
}

const LEVEL_CHIP = {
  OK: { cls: "chip ok", text: "Подходит" },
  WARN: { cls: "chip warn", text: "Есть замечания" },
  BLOCK: { cls: "chip crit", text: "Не уйдёт" },
} as const;

export function ComposerSummary({
  title,
  facts,
  selected,
  infos,
  verdicts,
  live,
  mode,
  scheduledAt,
  hasCover,
  blockReasons,
  busy,
  saveNote,
  canSaveDraft,
  onSaveDraft,
  onPublish,
}: ComposerSummaryProps) {
  const verdictOf = (c: SocialVideoChannel) => verdicts.find((v) => v.channel === c);
  const publishLabel =
    mode === "NOW" ? "Опубликовать сейчас" : scheduledAt ? `Запланировать на ${exactDateTime(scheduledAt)}` : "Запланировать";
  const disabled = blockReasons.length > 0 || busy !== null;

  return (
    <aside className="card" aria-label="Как уйдёт ролик">
      <div className="sec-h stack">
        <h2>Как уйдёт</h2>
        {saveNote && <span className="note">{saveNote}</span>}
      </div>

      <p className="sub" style={{ marginTop: 0 }}>
        <b>{title.trim() || "Ролик без названия"}</b>
        {facts && (
          <>
            <br />
            {[
              facts.durationSec !== null ? formatDurationRu(facts.durationSec) : null,
              formatBytesRu(facts.sizeBytes),
              facts.width !== null && facts.height !== null ? `${facts.width}×${facts.height}` : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </>
        )}
      </p>

      {selected.length === 0 ? (
        <div className="quiet">
          <span className="dot warn" />
          <span className="txt">Каналы пока не выбраны — отметьте, куда публиковать.</span>
        </div>
      ) : (
        <div className="list">
          {selected.map((d) => {
            const c = d.channel;
            const v = verdictOf(c);
            const level = v ? LEVEL_CHIP[v.level] : null;
            const quota = live[c]?.quota;
            const label = destinationLabel(d, infos);
            return (
              <div className="row wrapt" key={destinationKeyOf(d)}>
                <ChannelBadge channel={c} size={28} label={label} />
                <div className="t">
                  <b>{label}</b>
                  <span>
                    {v?.format ?? "формат уточнится после загрузки"}
                    {quota ? ` · осталось ${quota.remaining} из ${quota.total} публикаций` : ""}
                  </span>
                  {v?.warnings.map((w) => (
                    <span key={w}>{w}</span>
                  ))}
                  {v?.blockers.map((b) => (
                    <span key={b} style={{ color: "var(--crit)" }}>
                      {b}
                    </span>
                  ))}
                </div>
                {level && <span className={level.cls}>{level.text}</span>}
              </div>
            );
          })}
        </div>
      )}

      <div className="list" style={{ marginTop: 12 }}>
        <div className="row">
          <span className="av" aria-hidden="true">
            <CalendarClock className="i" />
          </span>
          <div className="t">
            <b>Когда</b>
            <span>
              {mode === "NOW"
                ? "Сразу после подтверждения"
                : scheduledAt
                  ? `${exactDateTime(scheduledAt)} по Душанбе`
                  : "Дата и время ещё не выбраны"}
            </span>
          </div>
        </div>
        <div className="row">
          <span className="av" aria-hidden="true">
            <ImageIcon className="i" />
          </span>
          <div className="t">
            <b>Обложка</b>
            <span>{hasCover ? "Есть" : "Без обложки — площадка возьмёт кадр из ролика"}</span>
          </div>
        </div>
      </div>

      {blockReasons.length > 0 && (
        <div className="quiet crit" role="status" style={{ marginTop: 12 }}>
          <span className="dot crit" />
          <span className="txt">
            Пока нельзя опубликовать:
            <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
              {blockReasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          </span>
        </div>
      )}

      <div className="acts" style={{ marginTop: 16, display: "flex", flexWrap: "wrap", gap: 8 }}>
        <button className="pill" type="button" disabled={disabled} onClick={onPublish} style={{ flex: "1 1 220px" }}>
          {busy === "publishing" ? <Loader2 className="i animate-spin" aria-hidden /> : <Rocket className="i" aria-hidden />}
          {busy === "publishing" ? "Отправляем…" : publishLabel}
        </button>
        <button
          className="pill ghost"
          type="button"
          disabled={!canSaveDraft || busy !== null}
          onClick={onSaveDraft}
          style={{ flex: "1 1 160px" }}
        >
          {busy === "saving" ? <Loader2 className="i animate-spin" aria-hidden /> : <Save className="i" aria-hidden />}
          Сохранить черновик
        </button>
      </div>
    </aside>
  );
}
