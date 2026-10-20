import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Check, Clock, Film, Image as ImageIcon, Loader2 } from "lucide-react";
import type { DraftMediaItem } from "../../lib/draftUploads";
import { computeSpeedBps, formatSpeedBps, formatUploadSize, type ProgressSample } from "../../lib/uploadFormat";

/**
 * ФИНАЛЬНЫЙ ЭКРАН «СОХРАНИТЬ» (07.10.2026, владелец: «чтобы он видел процесс»).
 * Полноэкранный: пока файлы едут, агент видит каждый — полосу, процент и МБ/с —
 * и итоговую строку «Загружено X из Y». Закрыть его до конца нельзя, кнопка
 * «Готово» неактивна, пока всё не доехало и объект не создан.
 *
 * Облик — шторка мастера на всю высоту (`.sheet`/`.wfoot .next` из темы).
 */
export function SaveProgressOverlay({
  items,
  phase,
  onDone,
}: {
  items: DraftMediaItem[];
  /** uploading — файлы едут; creating — все доехали, создаём объект; done — всё готово. */
  phase: "uploading" | "creating" | "done";
  onDone: () => void;
}) {
  const speeds = useUploadSpeeds(items);
  const total = items.length;
  const ready = items.filter((i) => i.status === "ready").length;
  const title =
    phase === "done" ? "Объект сохранён" : phase === "creating" ? "Создаю карточку…" : "Загружаю файлы в карточку";

  return (
    <div className="sheet" data-open="1" role="dialog" aria-modal="true" aria-label={title} data-testid="wizard-save-progress">
      <div className="scrim" />
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          flexDirection: "column",
          background: "var(--page)",
          paddingTop: "env(safe-area-inset-top)",
        }}
      >
        <div style={{ padding: "18px 16px 8px" }}>
          <div className="ttl" role="heading" aria-level={2}>
            {title}
          </div>
          <div
            role="status"
            aria-live="polite"
            data-testid="wizard-save-progress-total"
            style={{ fontSize: 14, color: "var(--muted)", marginTop: 4 }}
          >
            Загружено {ready} из {total}
          </div>
        </div>

        <div style={{ flex: 1, overflowY: "auto", padding: "8px 16px", display: "grid", gap: 8, alignContent: "start" }}>
          {items.map((item) => (
            <Row key={item.uploadKey} item={item} speedBps={speeds[item.uploadKey] ?? null} />
          ))}
        </div>

        <div className="wfoot">
          <span style={{ fontSize: 13, color: "var(--muted)" }}>
            {phase === "done" ? "Всё на месте" : "Не закрывайте приложение, пока идёт загрузка"}
          </span>
          <button type="button" className="next" data-testid="wizard-save-progress-done" disabled={phase !== "done"} onClick={onDone}>
            Готово
          </button>
        </div>
      </div>
    </div>
  );
}

function Row({ item, speedBps }: { item: DraftMediaItem; speedBps: number | null }) {
  const percent =
    item.status === "ready" ? 100 : item.sizeBytes > 0 ? Math.min(99, Math.round((item.loaded / item.sizeBytes) * 100)) : 0;
  const bad = item.status === "failed" || item.status === "lost";
  const meta =
    item.status === "ready"
      ? `${formatUploadSize(item.sizeBytes)} · готово`
      : item.status === "uploading"
        ? `${formatUploadSize(item.loaded)} из ${formatUploadSize(item.sizeBytes)} · ${percent}%${speedBps ? ` · ${formatSpeedBps(speedBps)}` : ""}`
        : item.status === "queued"
          ? `${formatUploadSize(item.sizeBytes)} · ждёт очереди`
          : `${formatUploadSize(item.sizeBytes)} · ${item.error ?? "не ушло"}`;
  return (
    <div className="vrow" data-testid="wizard-save-progress-row" data-upload-status={item.status}>
      <span className="ic">
        {item.status === "uploading" ? (
          <Loader2 width={16} height={16} aria-hidden />
        ) : item.status === "ready" ? (
          <Check width={16} height={16} aria-hidden />
        ) : item.status === "queued" ? (
          <Clock width={16} height={16} aria-hidden />
        ) : bad ? (
          <AlertTriangle width={16} height={16} aria-hidden />
        ) : item.kind === "video" ? (
          <Film width={16} height={16} aria-hidden />
        ) : (
          <ImageIcon width={16} height={16} aria-hidden />
        )}
      </span>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div className="nm" style={{ fontSize: 14, overflowWrap: "anywhere" }}>
          {item.name}
        </div>
        <div className="mt" style={{ fontSize: 13 }}>
          {meta}
        </div>
        <span aria-hidden style={{ display: "block", height: 4, borderRadius: 2, marginTop: 5, background: "rgba(127,132,145,.25)" }}>
          <span
            style={{
              display: "block",
              height: 4,
              borderRadius: 2,
              width: `${percent}%`,
              background: bad ? "var(--warn)" : "var(--acc)",
              transition: "width .2s linear",
            }}
          />
        </span>
      </div>
    </div>
  );
}

/** Скользящая скорость по каждому едущему файлу: точки (время, отдано) за последние секунды. */
function useUploadSpeeds(items: DraftMediaItem[]): Record<string, number | null> {
  const samples = useRef(new Map<string, ProgressSample[]>());
  const [speeds, setSpeeds] = useState<Record<string, number | null>>({});

  useEffect(() => {
    const now = Date.now();
    const next: Record<string, number | null> = {};
    const alive = new Set<string>();
    for (const item of items) {
      if (item.status !== "uploading") continue;
      alive.add(item.uploadKey);
      const list = (samples.current.get(item.uploadKey) ?? []).filter((s) => now - s.t <= 6_000);
      list.push({ t: now, loaded: item.loaded });
      samples.current.set(item.uploadKey, list);
      next[item.uploadKey] = computeSpeedBps(list, now);
    }
    for (const key of [...samples.current.keys()]) if (!alive.has(key)) samples.current.delete(key);
    setSpeeds((prev) => {
      const same = Object.keys(prev).length === Object.keys(next).length && Object.keys(next).every((k) => prev[k] === next[k]);
      return same ? prev : next;
    });
  }, [items]);

  return speeds;
}
