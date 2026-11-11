import { useId } from "react";
import { useQuery } from "@tanstack/react-query";
import { narrationDraftText, pickNarrationVoice, type NarrationFacts, type NarrationOptionsView, type NarrationWizardChoice } from "@royal-home/shared";
import { api } from "../../lib/api";
import { VoiceSamplePicker } from "../VoiceSamplePicker";

/**
 * КОНЕЦ МАСТЕРА — ОЗВУЧКА РОЛИКА (схема владельца 10.11.2026). Текст собирается
 * той же функцией `narrationDraftText`, что у Шабнам и у сервера; шаблоны и голоса
 * правит руководство в настройках озвучки. Выбор уходит полем `narration` запроса
 * создания объекта, генерация и одобрение — после сохранения (lib/narrationAutoFlow.ts).
 * Один адаптивный блок для ПК и телефона.
 */
/** Что уходит в запрос создания: короткий или пустой текст не шлём — сервер соберёт по шаблону. */
export function narrationChoiceForCreate(value: NarrationWizardChoice): NarrationWizardChoice | undefined {
  const script = value.script?.trim();
  const out: NarrationWizardChoice = { ...(value.templateId ? { templateId: value.templateId } : {}), ...(value.voiceId ? { voiceId: value.voiceId } : {}), ...(script && script.length >= 10 ? { script } : {}) };
  return Object.keys(out).length ? out : undefined;
}

export function NarrationChoice({ facts, value, onChange }: {
  facts: NarrationFacts;
  value: NarrationWizardChoice;
  onChange: (next: NarrationWizardChoice) => void;
}) {
  const ids = useId();
  const { data } = useQuery({ queryKey: ["narration-options"], queryFn: () => api<NarrationOptionsView>("/properties/narration-options"), staleTime: 5 * 60_000, retry: false });
  const templates = data?.templates ?? [];
  const drafted = narrationDraftText({ templates, defaultTemplateId: data?.defaultTemplateId ?? undefined }, facts, value.templateId);
  const text = value.script ?? drafted.text;
  const voiceId = data ? pickNarrationVoice({ voices: data.voices, defaultVoiceId: data.defaultVoiceId ?? undefined }, value.voiceId) : null;

  return (
    <section className="card mt-4 space-y-3 p-4" aria-label="Озвучка ролика">
      <h3 className="font-semibold">Озвучка ролика</h3>
      {templates.length > 1 && (
        <label className="block text-sm" htmlFor={`${ids}-tpl`}>Шаблон
          <select id={`${ids}-tpl`} className="mt-1 w-full rounded-lg border p-2" value={drafted.templateId ?? ""}
            onChange={(e) => onChange({ ...value, templateId: e.target.value, script: undefined })}>
            {templates.map((t) => <option key={t.id} value={t.id}>{t.name} · {t.lang === "tg" ? "по-таджикски" : "по-русски"}</option>)}
          </select>
        </label>
      )}
      <label className="block text-sm" htmlFor={`${ids}-text`}>Текст
        <textarea id={`${ids}-text`} rows={5} maxLength={5000} className="mt-1 w-full rounded-lg border p-3" value={text}
          onChange={(e) => onChange({ ...value, script: e.target.value, templateId: drafted.templateId ?? undefined })} />
      </label>
      {!!data?.voices.length && (
        // Голос выбирают на слух: у каждого «▶ Прослушать» одной и той же фразой на языке шаблона.
        <VoiceSamplePicker name={`${ids}-voice`} voices={data.voices} value={voiceId} samples={data.samples} lang={drafted.lang}
          onChange={(id) => onChange({ ...value, voiceId: id })} />
      )}
      <p className="text-sm text-slate-600">
        {data?.autoGenerate
          ? "После сохранения озвучка придёт вам на прослушивание в CRM и в Шабнам. Цена звучит словами; поменяется цена — озвучка обновится и снова придёт на одобрение."
          : "Озвучку можно будет подготовить в карточке объекта."}
      </p>
    </section>
  );
}
