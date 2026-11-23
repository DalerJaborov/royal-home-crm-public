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

export function VoiceSamplePicker({ voices, value, onChange, samples, lang, disabled, name, lastPickedId, recommendedId }: {
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
  /** Голос по умолчанию из Настроек (20.11.2026): подпись «по умолчанию». */
  recommendedId?: string | null;
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
      <legend className="sr-only">Голос</legend>
      {groups.map(([label, list]) => list.length > 0 && (
        <div key={label ?? "other"} className="space-y-1">
          {label && <p className="text-[15px] text-[var(--muted)]">{label}</p>}
          {/* Плитки (14.11.2026): два в ряд на телефоне, четыре на ПК; вся плитка — выбор, кнопка — прослушать. */}
          <div className="grid grid-cols-1 gap-2 min-[420px]:grid-cols-2 sm:grid-cols-3">
            {list.map((voice) => {
              const on = value === voice.id;
              return (
                <div key={voice.id} className={`flex h-full min-w-0 flex-col gap-2 rounded-2xl border-2 p-3 ${on ? "border-blue bg-blue/10" : "border-line"}`}>
                  <label className="flex min-h-12! min-w-0 cursor-pointer items-center gap-2 text-[17px]">
                    <input type="radio" name={name} value={voice.id} checked={on} onChange={() => onChange(voice.id)} />
                    {/* Имя целиком, переносом, а не «Nataly Vershini…» (20.11.2026, кадр владельца с телефона). */}
                    <span className="min-w-0 break-words font-medium">{voice.name}</span>
                  </label>
                  {(recommendedId === voice.id || lastPickedId === voice.id) && <span className="self-start rounded-full bg-[var(--soft)] px-2.5 py-0.5 text-[13px] text-[var(--muted)]" data-testid="voice-note">
                    {[recommendedId === voice.id ? "по умолчанию" : null, lastPickedId === voice.id ? "вы выбирали в прошлый раз" : null].filter(Boolean).join(", ")}</span>}
                  {has.has(voice.id) && (
                    <button type="button" className="pill ghost mt-auto min-h-12! text-base!" aria-pressed={playing === voice.id} aria-label={`${playing === voice.id ? "Остановить" : "Прослушать"} голос ${voice.name}`}
                      onClick={() => void play(voice)}>
                      {playing === voice.id ? "■ Стоп" : "▶ Прослушать"}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ))}
      {error && <p className="text-base text-red-700" role="status">{error}</p>}
    </fieldset>
  );
}
