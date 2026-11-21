import { useEffect, useId, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { chooseNarration, narrationFitsType, pickNarrationVoice, type NarrationFacts, type NarrationOptionsView, type NarrationWizardChoice } from "@royal-home/shared";
import { api } from "../../lib/api";
import { NarrationComposer, narrationListenFresh, resolveNarrationDraft, type NarrationListened } from "../NarrationComposer";

/**
 * КОНЕЦ МАСТЕРА — ОЗВУЧКА РОЛИКА (схема владельца 10.11.2026). Текст собирается
 * той же функцией `narrationDraftText`, что у Шабнам и у сервера; шаблоны и голоса
 * правит руководство в настройках озвучки. Выбор уходит полем `narration` запроса
 * создания объекта, генерация и одобрение — после сохранения (lib/narrationAutoFlow.ts).
 * Один адаптивный блок для ПК и телефона.
 *
 * С 14.11.2026 — общий NarrationComposer (тот же, что в карточке): сначала голос, потом текст по
 * шаблону. С 16.11.2026 шаблон и концовка предвыбираются СЛУЧАЙНО (подходят типу объекта, не равны прошлому
 * выбору сотрудника; одно ядро chooseNarration) и уходят в запрос кодами: то, что агент видит, сервер и соберёт.
 */
/** Выбор в мастере: то, что уходит в запрос, плюс прослушанный звук (только на экране). */
export type WizardNarrationValue = NarrationWizardChoice & { listened?: NarrationListened };

/** Что уходит в запрос создания: короткий или пустой текст не шлём — сервер соберёт по шаблону.
 *  Прослушанный звук — его id (listenId): сервер сам сверит, что текст и голос те же, и возьмёт звук без второй оплаты. */
export function narrationChoiceForCreate(value: WizardNarrationValue): NarrationWizardChoice | undefined {
  // «Без озвучки» (12.11.2026): ничего не готовится и не тратится, остальной выбор не нужен.
  if (value.none) return { none: true };
  const script = value.script?.trim();
  const out: NarrationWizardChoice = { ...(value.templateId ? { templateId: value.templateId } : {}), ...(value.endingId ? { endingId: value.endingId } : {}), ...(value.templateId && value.autoPicked ? { autoPicked: true as const } : {}), ...(value.voiceId ? { voiceId: value.voiceId } : {}), ...(script && script.length >= 10 ? { script } : {}), ...(value.listened ? { listenId: value.listened.id } : {}) };
  return Object.keys(out).length ? out : undefined;
}

export function NarrationChoice({ facts, value, onChange }: {
  facts: NarrationFacts;
  value: WizardNarrationValue;
  onChange: (next: WizardNarrationValue) => void;
}) {
  const ids = useId();
  const { data } = useQuery({ queryKey: ["narration-options"], queryFn: () => api<NarrationOptionsView>("/properties/narration-options"), staleTime: 5 * 60_000, retry: false });
  const templates = useMemo(() => data?.templates ?? [], [data]);
  const endings = useMemo(() => data?.endings ?? [], [data]);
  // Голос — последний выбор сотрудника; шаблон и концовка — случайные, зафиксированные один раз на тип объекта.
  const last = data?.lastChoice ?? {};
  const type = facts.type;
  const picked = useMemo(() => data ? chooseNarration({ templates, endings, defaultTemplateId: data.defaultTemplateId ?? undefined }, type, { avoid: { templateId: data.lastChoice?.usedTemplateId ?? data.lastChoice?.templateId, endingId: data.lastChoice?.usedEndingId ?? data.lastChoice?.endingId } }) : null,
    [data, templates, endings, type]);
  const defaultTemplateId = picked?.templateId ?? null;
  const defaultEndingId = picked?.endingId ?? null;
  // Предвыбор уходит в выбор агента сразу: иначе сервер выбрал бы другой случайный, чем виден на экране.
  // Сменился тип объекта (агент вернулся на шаг назад), а прежний шаблон ему не подходит — берём новый.
  useEffect(() => {
    // Не зацикливается: как только предвыбранный шаблон записан в выбор, условие снова ложно, даже если запасной шаблон типу не подходит.
    if (!picked?.templateId || value.none || value.script || value.templateId === picked.templateId) return;
    const current = templates.find((t) => t.id === value.templateId);
    if (!current || !narrationFitsType(current, type)) onChange({ ...value, templateId: picked.templateId, endingId: picked.endingId ?? "", autoPicked: true });
  }, [picked, templates, type, value, onChange]);
  const defaultVoiceId = data ? pickNarrationVoice({ voices: data.voices, defaultVoiceId: last.voiceId ?? data.defaultVoiceId ?? undefined }) : null;
  const shownFacts = facts.currency === "USD" && data?.usdToTjs ? { ...facts, usdToTjs: data.usdToTjs } : facts;
  // Прослушанное устарело (сменили текст, голос, язык или вернулись и поменяли цену) — его id в запрос не уходит.
  const resolved = data ? resolveNarrationDraft({ templates, endings, facts: shownFacts, value, defaultTemplateId, defaultEndingId, defaultVoiceId }) : null;
  const listenStale = !!value.listened && !!resolved && !narrationListenFresh(value.listened, resolved);
  useEffect(() => {
    if (!listenStale) return;
    const { listened: _stale, ...rest } = value;
    onChange(rest);
  }, [listenStale, value, onChange]);

  return (
    <section className="card mt-4 space-y-4 p-4" aria-label="Озвучка ролика">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="font-semibold">Озвучка ролика</h3>
          {!value.none && <p className="text-sm text-[var(--muted)]">Выберите голос, текст поставится сам. Его можно поправить.</p>}
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={!!value.none} onChange={(e) => onChange(e.target.checked ? { none: true } : {})} />
          Без озвучки
        </label>
      </div>
      {value.none ? (
        <p className="text-sm text-[var(--muted)]">Озвучка не готовится и не тратит деньги, монтажёр получит пометку «без озвучки». Включить можно потом в карточке объекта.</p>
      ) : <>
        <NarrationComposer name={`${ids}-voice`} templates={templates} endings={endings} voices={data?.voices ?? []} samples={data?.samples} facts={shownFacts}
          value={value} onChange={(next) => onChange({ ...next })} defaultTemplateId={defaultTemplateId} defaultEndingId={defaultEndingId} defaultVoiceId={defaultVoiceId} lastPickedVoiceId={last.voiceId ?? null}
          canListen={!!data?.autoGenerate} />
        {/* Правда о том, что будет (21.11.2026, владелец: «одобрение сразу там же»): «Сохранить» = одобрить, просьб потом нет. */}
        <p className="rounded-lg bg-blue/10 p-3 text-sm">
          {data?.autoGenerate
            ? "Озвучка уйдёт монтажёру сразу после сохранения. Послушайте её здесь перед сохранением."
            : "Озвучку можно будет подготовить в карточке объекта."}
        </p>
      </>}
    </section>
  );
}
