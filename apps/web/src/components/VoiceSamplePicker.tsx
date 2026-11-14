import { useEffect, useRef, useState } from "react";
import type { NarrationLang, NarrationVoiceSampleRef } from "@royal-home/shared";
import { api } from "../lib/api";

/**
 * ВЫБОР ГОЛОСА НА СЛУХ (11.11.2026, владелец). У каждого голоса — «▶ Прослушать»: одна и та же
 * фраза (NARRATION_VOICE_SAMPLE_TEXT) этим голосом. Образец готовит руководство один раз в
 * настройках озвучки; здесь он только проигрывается, без затрат. Нет образца — нет кнопки.
 * Один блок для мастера объекта и карточки, ПК и телефона: строки переносятся сами.
 */
type Voice = { id: string; name: string; gender?: "male" | "female" };
type Player = { el: HTMLAudioElement | null; url: string | null };
function release(p: Player) {
  p.el?.pause();
  if (p.url) URL.revokeObjectURL(p.url);
  p.el = null; p.url = null;
}

export function VoiceSamplePicker({ voices, value, onChange, samples, lang, disabled, name, lastPickedId }: {
  voices: Voice[];
  value: string | null;
  onChange: (voiceId: string) => void;
  samples?: NarrationVoiceSampleRef[];
  lang: NarrationLang;
  disabled?: boolean;
  /** Имя группы переключателей: на странице может быть два выбора голоса. */
  name: string;
  /** Голос, который этот сотрудник выбрал в прошлый раз (12.11.2026): подпись рядом с именем. */
  lastPickedId?: string | null;
}) {
  const [playing, setPlaying] = useState<string | null>(null);
  const [error, setError] = useState("");
  // Один проигрыватель на блок: новый образец останавливает прежний.
  const player = useRef<Player>({ el: null, url: null });
  const stop = () => { release(player.current); setPlaying(null); };
  useEffect(() => { const p = player.current; return () => release(p); }, []);
  const has = new Set((samples ?? []).filter((s) => s.lang === lang).map((s) => s.voiceId));
  const groups: Array<[string | null, Voice[]]> = [
    ["Женские", voices.filter((v) => v.gender === "female")],
    ["Мужские", voices.filter((v) => v.gender === "male")],
    [null, voices.filter((v) => !v.gender)],
  ];

  async function play(voice: Voice) {
    if (playing === voice.id) { stop(); return; }
    stop();
    setError("");
    try {
      const blob = await api<Blob>(`/properties/narration-voice-samples/${encodeURIComponent(voice.id)}/${lang}`, { responseType: "blob" });
      player.current.url = URL.createObjectURL(blob);
      const el = new Audio(player.current.url);
      player.current.el = el;
      el.onended = stop;
      setPlaying(voice.id);
      await el.play();
    } catch {
      stop();
      setError("Образец не воспроизвёлся. Попробуйте ещё раз.");
    }
  }

  return (
    <fieldset className="space-y-2" disabled={disabled}>
      <legend className="text-sm font-medium">Голос</legend>
      {groups.map(([label, list]) => list.length > 0 && (
        <div key={label ?? "other"} className="space-y-1">
          {label && <p className="text-sm text-slate-600">{label}</p>}
          {list.map((voice) => (
            <div key={voice.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-2">
              <label className="flex min-w-0 flex-1 items-center gap-2 text-sm">
                <input type="radio" name={name} value={voice.id} checked={value === voice.id} onChange={() => onChange(voice.id)} />
                <span className="truncate">{voice.name}</span>
                {lastPickedId === voice.id && <span className="text-sm text-slate-600">последний раз выбран</span>}
              </label>
              {has.has(voice.id) && (
                <button type="button" className="pill sm" aria-pressed={playing === voice.id} aria-label={`${playing === voice.id ? "Остановить" : "Прослушать"} голос ${voice.name}`}
                  onClick={() => void play(voice)}>
                  {playing === voice.id ? "■ Стоп" : "▶ Прослушать"}
                </button>
              )}
            </div>
          ))}
        </div>
      ))}
      {error && <p className="text-sm text-red-700" role="status">{error}</p>}
    </fieldset>
  );
}
