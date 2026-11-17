import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { NarrationPreviewDecision, PropertyNarrationView } from "@royal-home/shared";
import { api } from "../lib/api";
import { VideoPlayerWithFallback } from "./VideoPlayerWithFallback";

/**
 * ПРОСЛУШАТЬ ПЕРЕД ВЫПУСКОМ (17.11.2026, владелец).
 *
 * CRM сама наложила новую озвучку на вышедший ролик (например, агент поменял цену). Новый ролик не
 * заменяет вышедший сразу: он «кандидат» и ждёт решения хозяина объекта; молчит — выходит сам в dueAt.
 * Сервер — lib/narrationPreview.ts, решение — POST /properties/:id/narration/preview.
 */
type Preview = NonNullable<PropertyNarrationView["preview"]>;

const MESSAGES: Record<NarrationPreviewDecision, string> = {
  RELEASE: "Новый ролик выпускается: через минуту-две он заменит прежний.",
  KEEP_OLD: "Оставили прежний ролик. Новая озвучка не наложена.",
  CHANGE: "Выберите другой голос или текст: CRM наложит озвучку заново.",
};

/** «15:20» сегодня, иначе «18 ноября, 15:20»; всегда по Душанбе (UTC+5). */
export function formatDueAt(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const day = (x: Date) => x.toLocaleDateString("ru-RU", { timeZone: "Asia/Dushanbe" });
  const time = d.toLocaleTimeString("ru-RU", { timeZone: "Asia/Dushanbe", hour: "2-digit", minute: "2-digit" });
  return day(d) === day(now) ? time : `${d.toLocaleDateString("ru-RU", { timeZone: "Asia/Dushanbe", day: "numeric", month: "long" })}, ${time}`;
}

export function previewLengthLine(p: Pick<Preview, "voiceSec" | "clipSec">): string | null {
  const parts: string[] = [];
  if (p.voiceSec != null) parts.push(`Голос ${Math.round(p.voiceSec)} с`);
  if (p.clipSec != null) parts.push(`ролик ${Math.round(p.clipSec)} с`);
  return parts.length ? parts.join(" · ") : null;
}

/** Аудио версии: грузится по нажатию (закрытая раздача, нужна авторизация), как в PropertyNarrationManager. */
function VersionAudio({ propertyId, versionId, label }: { propertyId: string; versionId: string; label: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false), [failed, setFailed] = useState(false);
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);
  async function load() {
    setBusy(true); setFailed(false);
    try {
      const blob = await api<Blob>(`/properties/${propertyId}/narration/${versionId}/audio`, { responseType: "blob" });
      setUrl(URL.createObjectURL(blob));
    } catch { setFailed(true); } finally { setBusy(false); }
  }
  return (
    <div className="space-y-1">
      <p className="text-sm font-medium">{label}</p>
      {url ? <audio className="w-full" controls autoPlay src={url} />
        : <button type="button" className="pill sm w-full sm:w-auto" disabled={busy} onClick={() => void load()}>▶ Прослушать</button>}
      {failed && <p className="text-sm text-[var(--muted)]" role="status">Не удалось загрузить запись.</p>}
    </div>
  );
}

export function NarrationPreviewBlock({ propertyId, data, onMessage, onChangeVoice }: {
  propertyId: string;
  data: Pick<PropertyNarrationView, "preview" | "previewDeclined" | "versions">;
  onMessage?: (text: string) => void;
  /** «Другой голос или текст»: открыть существующий выбор голоса и текста. */
  onChangeVoice?: () => void;
}) {
  const client = useQueryClient();
  const [confirm, setConfirm] = useState<NarrationPreviewDecision | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const p = data.preview;

  if (!p) {
    return data.previewDeclined
      ? <p className="text-sm text-[var(--muted)]" role="status">Новая озвучка не наложена: оставлен старый ролик. Выберите другой голос или текст — CRM наложит заново.</p>
      : null;
  }

  const versionNo = (id: string | null) => data.versions.find((v) => v.id === id)?.revision;
  const oldNo = versionNo(p.oldVersionId), newNo = versionNo(p.versionId) ?? p.revision;
  const length = previewLengthLine(p);

  async function decide(decision: NarrationPreviewDecision) {
    if (!p) return;
    setBusy(true); setError(""); setConfirm(null);
    try {
      await api(`/properties/${propertyId}/narration/preview`, { method: "POST", body: { versionId: p.versionId, decision } });
      onMessage?.(MESSAGES[decision]);
      await client.invalidateQueries({ queryKey: ["property-narration", propertyId] });
      // «Выпустить» меняет готовый ролик объекта — плеер в карточке должен показать новый (ревью 18.11.2026).
      if (decision === "RELEASE") void client.invalidateQueries({ queryKey: ["property"] });
      if (decision === "CHANGE") onChangeVoice?.();
    } catch (err) {
      setError(err instanceof Error && /409|уже|устар/i.test(err.message) ? "Решение уже принято или ролик устарел. Обновляем." : err instanceof Error ? err.message : "Не получилось сохранить решение");
      await client.invalidateQueries({ queryKey: ["property-narration", propertyId] });
    } finally { setBusy(false); }
  }

  return (
    <div className="space-y-3 rounded-xl border-2 border-blue p-3" role="region" aria-label="Прослушать перед выпуском">
      <h4 className="text-base font-semibold">Новый ролик с новой озвучкой — послушайте</h4>
      <div className="mx-auto w-full max-w-[360px]" style={{ aspectRatio: "9 / 16" }}>
        <VideoPlayerWithFallback src={p.previewPath} onDownload={() => window.open(p.previewPath, "_blank", "noopener")}
          style={{ width: "100%", height: "100%", objectFit: "contain", borderRadius: "var(--r-md)", background: "var(--track)" }} />
      </div>
      {(length || p.note) && <p className="text-sm">{[length, p.note].filter(Boolean).join(". ")}</p>}

      {p.currentPath && <details className="rounded-lg border p-2">
        <summary className="cursor-pointer text-sm font-medium">Сравнить со старым</summary>
        <div className="mt-2 space-y-3">
          <div className="mx-auto w-full max-w-[360px]">
            <VideoPlayerWithFallback src={p.currentPath} onDownload={() => window.open(p.currentPath!, "_blank", "noopener")} />
          </div>
          {p.oldVersionId && <div className="space-y-2">
            <VersionAudio propertyId={propertyId} versionId={p.oldVersionId} label={oldNo != null ? `Было (версия ${oldNo})` : "Было"} />
            <VersionAudio propertyId={propertyId} versionId={p.versionId} label={`Стало (версия ${newNo})`} />
          </div>}
        </div>
      </details>}

      <p className="text-sm text-[var(--muted)]">{p.dueAt ? `Если не решите — выйдет сам в ${formatDueAt(p.dueAt)}` : "Сам не выйдет — ждёт вашего решения"}</p>

      {p.canDecide ? <div className="space-y-2">
        {confirm ? <div className="flex flex-col gap-2 sm:flex-row sm:items-center" role="alert">
          <span className="text-sm">{confirm === "KEEP_OLD" ? "Оставить старый ролик? Новая озвучка не наложится." : "Отказаться от этого ролика и выбрать другой голос или текст?"}</span>
          <button type="button" className="pill w-full sm:w-auto" disabled={busy} onClick={() => void decide(confirm)}>Да</button>
          <button type="button" className="pill ghost w-full sm:w-auto" disabled={busy} onClick={() => setConfirm(null)}>Нет</button>
        </div> : <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
          <button type="button" className="pill w-full bg-blue! text-on-accent! sm:w-auto" disabled={busy} onClick={() => void decide("RELEASE")}>Выпустить</button>
          <button type="button" className="pill w-full sm:w-auto" disabled={busy} onClick={() => setConfirm("CHANGE")}>Другой голос или текст</button>
          <button type="button" className="pill w-full sm:w-auto" disabled={busy} onClick={() => setConfirm("KEEP_OLD")}>Оставить старый</button>
        </div>}
      </div> : <p className="text-sm text-[var(--muted)]">Решает агент объекта.</p>}
      {error && <p className="text-sm" role="status">{error}</p>}
    </div>
  );
}
