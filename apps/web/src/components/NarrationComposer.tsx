import { nextNarrationTemplateId, narrationTemplateLangs, renderNarrationTemplate, suggestedNarration, type NarrationFacts, type NarrationLang, type NarrationTemplate, type NarrationVoiceSampleRef } from "@royal-home/shared";
import { VoiceSamplePicker } from "./VoiceSamplePicker";

/**
 * ОЗВУЧКА ДЛЯ АГЕНТА — ОДИН БЛОК ДЛЯ МАСТЕРА И КАРТОЧКИ (14.11.2026, владелец).
 *
 * Порядок владельца: «сначала выбирается озвучка, потом сразу текст ставится, который по шаблону
 * меняется лишь там, допустим, цифры; несколько шаблонов, чтобы не каждый раз одинаковые; агент
 * может сам менять текст». Поэтому:
 *   1. Голос: язык (если шаблоны есть на двух языках) и плитки голосов с «▶ Прослушать».
 *   2. Текст: ставится сам из шаблона выбранного языка с цифрами объекта; варианты-шаблоны
 *      кнопками и «Другой вариант» по кругу; агент правит текст, «Вернуть текст шаблона» отменяет.
 * Ни модели, ни ключей, ни пределов здесь нет: это Настройки CRM → «Озвучка роликов».
 * Текст собирает та же `renderNarrationTemplate`, что у сервера и Шабнам.
 */
export type NarrationDraft = { templateId?: string; script?: string; voiceId?: string };

/** Что на самом деле уйдёт в озвучку: шаблон, язык, текст и голос с учётом умолчаний. Карточка зовёт её
 *  перед «Озвучить», блок — для показа: одна функция, иначе отправленное разойдётся с показанным. */
export function resolveNarrationDraft({ templates, facts, value, defaultTemplateId, defaultVoiceId, defaultScript }: {
  templates: NarrationTemplate[]; facts: NarrationFacts; value: NarrationDraft;
  defaultTemplateId: string | null; defaultVoiceId: string | null; defaultScript?: string | null;
}) {
  const templateId = value.templateId ?? defaultTemplateId ?? null;
  const template = templates.find((t) => t.id === templateId) ?? null;
  const lang: NarrationLang = template?.lang ?? "ru";
  const fromTemplate = template ? renderNarrationTemplate(template, facts) : suggestedNarration(facts);
  // Агент ничего не трогал — текст версии (карточка) или шаблона; выбрал вариант — всегда шаблон.
  const text = value.script ?? (value.templateId === undefined && defaultScript ? defaultScript : fromTemplate);
  return { templateId: template ? templateId : null, lang, fromTemplate, text, edited: text !== fromTemplate, voiceId: value.voiceId ?? defaultVoiceId ?? null };
}

const LANG_LABEL: Record<NarrationLang, string> = { tg: "Тоҷикӣ", ru: "Русский" };

export function NarrationComposer({ templates, voices, samples, facts, value, onChange, defaultTemplateId, defaultVoiceId, defaultScript, lastPickedVoiceId, disabled, name }: {
  templates: NarrationTemplate[];
  voices: Array<{ id: string; name: string; gender?: "male" | "female" }>;
  samples?: NarrationVoiceSampleRef[];
  facts: NarrationFacts;
  value: NarrationDraft;
  onChange: (next: NarrationDraft) => void;
  /** Шаблон, если агент ещё ничего не трогал (мастер — следующий вариант по кругу, карточка — шаблон версии). */
  defaultTemplateId: string | null;
  defaultVoiceId: string | null;
  /** Текст, если агент ещё ничего не трогал (карточка — текст текущей версии). */
  defaultScript?: string | null;
  lastPickedVoiceId?: string | null;
  disabled?: boolean;
  name: string;
}) {
  const { templateId, lang, fromTemplate, text, edited, voiceId } = resolveNarrationDraft({ templates, facts, value, defaultTemplateId, defaultVoiceId, defaultScript });
  const langs = narrationTemplateLangs(templates);
  const variants = templates.filter((t) => t.lang === lang);
  const pickTemplate = (id: string | null) => onChange({ ...value, templateId: id ?? undefined, script: undefined });

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <p className="text-sm font-semibold"><span className="mr-2 inline-flex h-6 w-6 items-center justify-center rounded-full bg-blue/10 text-sm">1</span>Голос</p>
        {langs.length > 1 && (
          <div className="flex flex-wrap gap-2" role="group" aria-label="Язык озвучки">
            {langs.map((l) => (
              <button key={l} type="button" className="pill sm" aria-pressed={l === lang} disabled={disabled}
                onClick={() => l !== lang && pickTemplate(nextNarrationTemplateId(templates, l, null))}>
                {l === lang ? "✓ " : ""}{LANG_LABEL[l]}
              </button>
            ))}
          </div>
        )}
        {voices.length > 0
          ? <VoiceSamplePicker name={name} voices={voices} value={voiceId} samples={samples} lang={lang} disabled={disabled} lastPickedId={lastPickedVoiceId ?? null}
              onChange={(id) => onChange({ ...value, voiceId: id })} />
          : <p className="text-sm text-slate-600">Голоса ещё не добавлены. Их добавляет руководство в Настройках → «Озвучка роликов».</p>}
      </div>

      <div className="space-y-2">
        <p className="text-sm font-semibold"><span className="mr-2 inline-flex h-6 w-6 items-center justify-center rounded-full bg-blue/10 text-sm">2</span>Текст</p>
        {variants.length > 1 && (
          <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Вариант текста">
            {variants.map((t) => (
              <button key={t.id} type="button" className="pill sm" aria-pressed={t.id === templateId && !edited} disabled={disabled} onClick={() => pickTemplate(t.id)}>
                {t.id === templateId && !edited ? "✓ " : ""}{t.name}
              </button>
            ))}
            <button type="button" className="pill sm" disabled={disabled} onClick={() => pickTemplate(nextNarrationTemplateId(templates, lang, templateId))}>↻ Другой вариант</button>
          </div>
        )}
        <textarea aria-label="Текст озвучки" rows={5} maxLength={5000} readOnly={disabled} className="w-full rounded-lg border p-3 text-base leading-relaxed"
          value={text} onChange={(e) => onChange({ ...value, templateId: templateId ?? undefined, script: e.target.value })} />
        <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-slate-600">
          <span>{edited ? "Текст изменён вами." : "Цифры и район подставлены из объекта, цена звучит словами. Можно поправить."}</span>
          {edited && !disabled && <button type="button" className="pill sm" onClick={() => pickTemplate(templateId)}>Вернуть текст шаблона</button>}
        </div>
      </div>
    </div>
  );
}
