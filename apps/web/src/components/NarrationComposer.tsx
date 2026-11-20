import { useLayoutEffect, useRef, type TextareaHTMLAttributes } from "react";
import {
  chooseNarration, narrationDraftText, narrationLengthLine, narrationTemplateLangs, narrationVariants, suggestedNarration,
  type NarrationEnding, type NarrationLengthCheck, type NarrationFacts, type NarrationLang, type NarrationTemplate, type NarrationVoiceSampleRef,
} from "@royal-home/shared";
import { VoiceSamplePicker } from "./VoiceSamplePicker";

/**
 * ОЗВУЧКА ДЛЯ АГЕНТА — ОДИН БЛОК ДЛЯ МАСТЕРА И КАРТОЧКИ (14.11.2026, владелец).
 *
 * Порядок владельца: «сначала выбирается озвучка, потом сразу текст ставится, который по шаблону
 * меняется лишь там, допустим, цифры; несколько шаблонов, чтобы не каждый раз одинаковые; агент
 * может сам менять текст». Поэтому:
 *   1. Голос: язык (если шаблоны есть на двух языках) и плитки голосов с «▶ Прослушать».
 *   2. Текст: ставится сам из шаблона выбранного языка с цифрами объекта и концовкой (призывом);
 *      показаны только шаблоны, подходящие типу объекта; «↻ Другой вариант» берёт случайные другие
 *      шаблон и концовку (16.11.2026, одно ядро chooseNarration); агент правит текст, «Вернуть текст
 *      шаблона» отменяет.
 * Ни модели, ни ключей, ни пределов здесь нет: это Настройки CRM → «Озвучка роликов».
 * Текст собирает та же `narrationDraftText`, что у сервера и Шабнам.
 */
/** endingId: "" — агент явно выбрал «без концовки» (после «Другого варианта» без подходящих концовок). */
export type NarrationDraft = { templateId?: string; endingId?: string; script?: string; voiceId?: string; autoPicked?: true };

/** Что на самом деле уйдёт в озвучку: шаблон, концовка, язык, текст и голос с учётом умолчаний. Карточка зовёт её
 *  перед «Озвучить», блок — для показа: одна функция, иначе отправленное разойдётся с показанным. */
export function resolveNarrationDraft({ templates, endings = [], facts, value, defaultTemplateId, defaultEndingId = null, defaultVoiceId, defaultScript }: {
  templates: NarrationTemplate[]; endings?: NarrationEnding[]; facts: NarrationFacts; value: NarrationDraft;
  defaultTemplateId: string | null; defaultEndingId?: string | null; defaultVoiceId: string | null; defaultScript?: string | null;
}) {
  const templateId = value.templateId ?? defaultTemplateId ?? null;
  const template = templates.find((t) => t.id === templateId) ?? null;
  // Концовка: выбранная; иначе умолчание. Шаблон «только вручную» несёт свой призыв и без выбора концовку не получает.
  const wantedEnding = value.endingId !== undefined ? value.endingId || null : template && !template.manualOnly ? defaultEndingId : null;
  const drafted = template ? narrationDraftText({ templates, endings }, facts, template.id, wantedEnding) : null;
  const lang: NarrationLang = template?.lang ?? "ru";
  const fromTemplate = drafted ? drafted.text : suggestedNarration(facts);
  // Агент ничего не трогал — текст версии (карточка) или шаблона; выбрал вариант — всегда шаблон.
  const text = value.script ?? (value.templateId === undefined && defaultScript ? defaultScript : fromTemplate);
  return { templateId: template ? templateId : null, endingId: drafted?.endingId ?? null, lang, fromTemplate, text, edited: text !== fromTemplate, voiceId: value.voiceId ?? defaultVoiceId ?? null };
}

const LANG_LABEL: Record<NarrationLang, string> = { tg: "Тоҷикӣ", ru: "Русский" };

export function NarrationComposer({ templates, endings = [], voices, samples, facts, value, onChange, defaultTemplateId, defaultEndingId, defaultVoiceId, defaultScript, lastPickedVoiceId, recommendedVoiceId, disabled, name, lengthCheck }: {
  templates: NarrationTemplate[];
  endings?: NarrationEnding[];
  voices: Array<{ id: string; name: string; gender?: "male" | "female" }>;
  samples?: NarrationVoiceSampleRef[];
  facts: NarrationFacts;
  value: NarrationDraft;
  onChange: (next: NarrationDraft) => void;
  /** Шаблон и концовка, если агент ещё ничего не трогал (мастер — случайные, карточка — шаблон версии). */
  defaultTemplateId: string | null;
  defaultEndingId?: string | null;
  defaultVoiceId: string | null;
  /** Текст, если агент ещё ничего не трогал (карточка — текст текущей версии). */
  defaultScript?: string | null;
  lastPickedVoiceId?: string | null;
  /** Голос по умолчанию из Настроек (20.11.2026): подпись «по умолчанию» у плитки. */
  recommendedVoiceId?: string | null;
  disabled?: boolean;
  name: string;
  /** Укладывается ли текст в ролик (18.11.2026, shared narrationLengthCheck); null — ролика ещё нет. */
  lengthCheck?: NarrationLengthCheck | null;
}) {
  const { templateId, endingId, lang, fromTemplate, text, edited, voiceId } = resolveNarrationDraft({ templates, endings, facts, value, defaultTemplateId, defaultEndingId, defaultVoiceId, defaultScript });
  const langs = narrationTemplateLangs(templates);
  const variants = narrationVariants(templates, lang, facts.type);
  // Шаблон «только вручную» несёт свой призыв: концовка с него снимается; с него обратно на обычный — возвращается умолчание.
  // Новый шаблон: текущая концовка остаётся, если подходит; нет концовки или не подходит — берётся через ядро chooseNarration.
  const pickTemplate = (id: string | null) => {
    const next = id ? chooseNarration({ templates, endings }, facts.type, { templateId: id, previous: { templateId, endingId } }) : null;
    onChange({ ...value, templateId: id ?? undefined, endingId: next ? next.endingId ?? "" : value.endingId, autoPicked: undefined, script: undefined });
  };
  // Случайный другой шаблон и концовка (одно ядро); lang — язык, на который переключаемся, иначе текущий.
  const reroll = (toLang: NarrationLang) => {
    const next = chooseNarration({ templates, endings }, facts.type, {
      reroll: true, lang: toLang, previous: toLang === lang ? { templateId, endingId } : null,
    });
    onChange({ ...value, templateId: next.templateId ?? undefined, endingId: next.endingId ?? "", autoPicked: undefined, script: undefined });
  };

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <p className="text-[17px] font-bold"><span className="mr-2 inline-flex h-7 w-7 items-center justify-center rounded-full bg-blue/10 text-[15px]">1</span>Голос</p>
        {langs.length > 1 && (
          <div className="flex flex-wrap gap-2" role="group" aria-label="Язык озвучки">
            {langs.map((l) => (
              <button key={l} type="button" className={l === lang ? "pill min-h-12! text-base!" : "pill min-h-12! text-base! ghost"} aria-pressed={l === lang} disabled={disabled}
                onClick={() => l !== lang && reroll(l)}>
                {l === lang ? "✓ " : ""}{LANG_LABEL[l]}
              </button>
            ))}
          </div>
        )}
        {voices.length > 0
          ? <VoiceSamplePicker name={name} voices={voices} value={voiceId} samples={samples} lang={lang} disabled={disabled} lastPickedId={lastPickedVoiceId ?? null} recommendedId={recommendedVoiceId ?? null}
              onChange={(id) => onChange({ ...value, voiceId: id })} />
          : <p className="text-base text-[var(--muted)]">Голоса ещё не добавлены. Их добавляет руководство в Настройках → «Озвучка роликов».</p>}
      </div>

      <div className="space-y-2">
        <p className="text-[17px] font-bold"><span className="mr-2 inline-flex h-7 w-7 items-center justify-center rounded-full bg-blue/10 text-[15px]">2</span>Текст</p>
        {variants.length > 1 && (
          <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Вариант текста">
            {variants.map((t) => (
              <button key={t.id} type="button" className={t.id === templateId && !edited ? "pill min-h-12! text-base!" : "pill min-h-12! text-base! ghost"} aria-pressed={t.id === templateId && !edited} disabled={disabled} onClick={() => pickTemplate(t.id)}>
                {t.id === templateId && !edited ? "✓ " : ""}{t.name}
              </button>
            ))}
            <button type="button" className="pill min-h-12! text-base! ghost ml-auto" disabled={disabled} onClick={() => reroll(lang)}>↻ Другой вариант</button>
          </div>
        )}
        <AutoGrowTextarea aria-label="Текст озвучки" minRows={6} maxLength={5000} readOnly={disabled} className="w-full rounded-2xl border-2 p-4 text-[17px] leading-relaxed"
          value={text} onChange={(e) => onChange({ ...value, templateId: templateId ?? undefined, script: e.target.value })} />
        {lengthCheck && <p className={`rounded-xl px-4 py-3 text-base font-semibold ${lengthCheck.fits ? "bg-[var(--ok-bg)] text-[var(--ok)]" : "bg-[var(--crit-bg)] text-[var(--crit)]"}`} role="status">
          {lengthCheck.fits ? "✓ " : ""}{narrationLengthLine(lengthCheck)}</p>}
        <div className="flex flex-wrap items-center justify-between gap-2 text-[15px] text-[var(--muted)]">
          <span>{edited ? (value.script !== undefined ? "Текст изменён вами." : "Текст этой озвучки, его можно поправить.") : "Числа и район подставлены из объекта и звучат словами. Можно поправить."}</span>
          {edited && !disabled && <button type="button" className="pill min-h-12! text-base! ghost" onClick={() => pickTemplate(templateId)}>Вернуть текст шаблона</button>}
        </div>
      </div>
    </div>
  );
}

/**
 * Поле, которое растёт по тексту (владелец 20.11.2026: конец текста «с радостью покажем!» пряталась за внутренней прокруткой
 * поля). Высота равна содержимому — весь текст виден без прокрутки внутри поля; `minRows` — нижняя граница.
 */
export function AutoGrowTextarea({ minRows, value, className, ...rest }: Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "rows"> & { minRows: number; value: string }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight + 2}px`;
  }, [value]);
  return <textarea ref={ref} rows={minRows} value={value} className={`${className ?? ""} resize-none overflow-hidden`} data-autogrow="" {...rest} />;
}
