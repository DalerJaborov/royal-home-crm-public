import { useId } from "react";
import { useQuery } from "@tanstack/react-query";
import { narrationRotatedTemplateId, pickNarrationTemplate, pickNarrationVoice, type NarrationFacts, type NarrationOptionsView, type NarrationWizardChoice } from "@royal-home/shared";
import { api } from "../../lib/api";
import { NarrationComposer } from "../NarrationComposer";

/**
 * КОНЕЦ МАСТЕРА — ОЗВУЧКА РОЛИКА (схема владельца 10.11.2026). Текст собирается
 * той же функцией `narrationDraftText`, что у Шабнам и у сервера; шаблоны и голоса
 * правит руководство в настройках озвучки. Выбор уходит полем `narration` запроса
 * создания объекта, генерация и одобрение — после сохранения (lib/narrationAutoFlow.ts).
 * Один адаптивный блок для ПК и телефона.
 *
 * С 14.11.2026 — общий NarrationComposer (тот же, что в карточке): сначала голос, потом текст по
 * шаблону; не выбрал шаблон — следующий вариант после прошлого (narrationRotatedTemplateId, сервер
 * ставит тот же).
 */
/** Что уходит в запрос создания: короткий или пустой текст не шлём — сервер соберёт по шаблону. */
export function narrationChoiceForCreate(value: NarrationWizardChoice): NarrationWizardChoice | undefined {
  // «Без озвучки» (12.11.2026): ничего не готовится и не тратится, остальной выбор не нужен.
  if (value.none) return { none: true };
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
  // Голос — последний выбор сотрудника; шаблон — следующий вариант после прошлого (сервер ставит тот же).
  const last = data?.lastChoice ?? {};
  const defaultTemplateId = narrationRotatedTemplateId(templates, last.templateId)
    ?? pickNarrationTemplate({ templates, defaultTemplateId: data?.defaultTemplateId ?? undefined })?.id ?? null;
  const defaultVoiceId = data ? pickNarrationVoice({ voices: data.voices, defaultVoiceId: last.voiceId ?? data.defaultVoiceId ?? undefined }) : null;

  return (
    <section className="card mt-4 space-y-4 p-4" aria-label="Озвучка ролика">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="font-semibold">Озвучка ролика</h3>
          {!value.none && <p className="text-sm text-slate-600">Выберите голос, текст поставится сам. Его можно поправить.</p>}
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={!!value.none} onChange={(e) => onChange(e.target.checked ? { none: true } : {})} />
          Без озвучки
        </label>
      </div>
      {value.none ? (
        <p className="text-sm text-slate-600">Озвучка не готовится и не тратит деньги, монтажёр получит пометку «без озвучки». Включить можно потом в карточке объекта.</p>
      ) : <>
        <NarrationComposer name={`${ids}-voice`} templates={templates} voices={data?.voices ?? []} samples={data?.samples} facts={facts}
          value={value} onChange={(next) => onChange({ ...next })} defaultTemplateId={defaultTemplateId} defaultVoiceId={defaultVoiceId} lastPickedVoiceId={last.voiceId ?? null} />
        <p className="rounded-lg bg-blue/10 p-3 text-sm">
          {data?.autoGenerate
            ? "После сохранения объекта озвучка придёт вам на прослушивание в CRM и в Шабнам. Поменяется цена — озвучка обновится сама и снова придёт на одобрение."
            : "Озвучку можно будет подготовить в карточке объекта."}
        </p>
      </>}
    </section>
  );
}
