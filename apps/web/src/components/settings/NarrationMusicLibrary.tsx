import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { formatMusicDuration, narrationMusicTitleFromFile, type NarrationMusicLibraryView } from "@royal-home/shared";
import { api } from "../../lib/api";

/**
 * «СВОЯ МУЗЫКА» в Настройки → Озвучка (18.11.2026). Треки без авторских прав, которые подбирает владелец:
 * монтажёр берёт музыку только отсюда, а CRM при смене цены у вышедшего ролика снимает со старого ролика
 * весь звук и кладёт случайный трек отсюда и новый голос. Рубильник — в общем блоке настроек (сохраняется
 * кнопкой «Сохранить настройки озвучки», как соседние), список и загрузка — сразу.
 */
export function NarrationMusicLibrary({ enabled, onEnabledChange, disabled }: { enabled: boolean; onEnabledChange: (next: boolean) => void; disabled: boolean }) {
  const client = useQueryClient();
  const key = ["narration-music"];
  const { data, error, isPending } = useQuery({ queryKey: key, queryFn: () => api<NarrationMusicLibraryView>("/properties/narration-music"), retry: false });
  const [busy, setBusy] = useState(false), [message, setMessage] = useState("");
  const [playing, setPlaying] = useState<string | null>(null);
  const player = useRef<{ el: HTMLAudioElement | null; url: string | null }>({ el: null, url: null });
  const fileInput = useRef<HTMLInputElement>(null);

  function stop() {
    player.current.el?.pause();
    if (player.current.url) URL.revokeObjectURL(player.current.url);
    player.current = { el: null, url: null };
    setPlaying(null);
  }
  useEffect(() => stop, []);

  async function play(id: string) {
    if (playing === id) { stop(); return; }
    stop();
    setMessage("");
    try {
      const blob = await api<Blob>(`/properties/narration-music/${id}/file`, { responseType: "blob" });
      player.current.url = URL.createObjectURL(blob);
      const el = new Audio(player.current.url);
      player.current.el = el;
      el.onended = stop;
      setPlaying(id);
      await el.play();
    } catch {
      stop();
      setMessage("Трек не воспроизвёлся. Попробуйте ещё раз.");
    }
  }

  async function run(action: () => Promise<string>) {
    setBusy(true); setMessage("");
    try { setMessage(await action()); await client.invalidateQueries({ queryKey: key }); }
    catch (err) { setMessage(err instanceof Error ? err.message : "Действие не выполнено"); }
    finally { setBusy(false); if (fileInput.current) fileInput.current.value = ""; }
  }

  async function upload(file: File) {
    await run(async () => {
      const limit = data?.limits.maxBytes ?? 15 * 1024 * 1024;
      if (file.size > limit) throw new Error(`Файл больше ${Math.round(limit / 1024 / 1024)} МБ.`);
      const form = new FormData();
      form.append("title", narrationMusicTitleFromFile(file.name));
      form.append("file", file);
      await api("/properties/narration-music", { method: "POST", body: form, timeoutMs: 120_000 });
      return `Трек «${narrationMusicTitleFromFile(file.name)}» добавлен.`;
    });
  }

  const tracks = data?.tracks ?? [];
  const canConfigure = !!data?.canConfigure;
  return (
    <fieldset className="space-y-2" aria-labelledby="narration-music-title">
      <legend id="narration-music-title" className="text-sm font-semibold">Своя музыка</legend>
      <p className="text-sm text-[var(--muted)]">Треки без авторских прав. Монтажёр берёт музыку только отсюда. При смене цены у вышедшего ролика CRM снимает с него весь звук и кладёт случайный трек отсюда и новую озвучку.</p>
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" className="mt-0.5 h-6 w-6 shrink-0" checked={enabled} disabled={disabled} onChange={(e) => onEnabledChange(e.target.checked)} />
        <span>Своя музыка при перемонтаже. Выключено или треков нет: ролик уходит монтажёру</span>
      </label>
      {isPending && <p className="text-sm" aria-busy="true">Загружаем треки…</p>}
      {error && <p className="text-sm" role="status">Треки недоступны: {error instanceof Error ? error.message : "не удалось загрузить"}</p>}
      {!isPending && !error && tracks.length === 0 && <p className="rounded-lg bg-[var(--soft)] p-3 text-sm">Треков пока нет. Загрузите mp3 или m4a, до {Math.round((data?.limits.maxBytes ?? 0) / 1024 / 1024)} МБ.</p>}
      {tracks.length > 0 && <ul className="divide-y rounded border" aria-label="Треки">
        {tracks.map((t) => <li key={t.id} className="flex flex-wrap items-center gap-2 p-2">
          <span className="min-w-0 flex-1 basis-40 truncate text-sm font-medium" title={t.title}>{t.title}</span>
          <span className="text-sm tabular-nums text-[var(--muted)]">{formatMusicDuration(t.durationSec)}</span>
          <button type="button" className="pill sm ghost" aria-pressed={playing === t.id} onClick={() => void play(t.id)}>{playing === t.id ? "Стоп" : "Прослушать"}</button>
          {canConfigure && <button type="button" className="pill sm ghost" disabled={busy} onClick={() => {
            if (!window.confirm(`Удалить трек «${t.title}»? Вышедшие ролики с ним не изменятся.`)) return;
            if (playing === t.id) stop();
            void run(async () => { await api(`/properties/narration-music/${t.id}`, { method: "DELETE" }); return `Трек «${t.title}» удалён.`; });
          }}>Удалить</button>}
        </li>)}
      </ul>}
      {canConfigure && <div className="flex flex-wrap items-center gap-2">
        <input ref={fileInput} type="file" accept=".mp3,.m4a,audio/mpeg,audio/mp4" className="sr-only" id="narration-music-file" disabled={busy}
          onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); }} />
        <button type="button" className="pill" disabled={busy} onClick={() => fileInput.current?.click()}>{busy ? "Загружаем…" : "Загрузить трек"}</button>
        <span className="text-sm text-[var(--muted)]">mp3 или m4a, от 5 секунд до 10 минут.</span>
      </div>}
      {message && <p className="text-sm" role="status">{message}</p>}
    </fieldset>
  );
}
