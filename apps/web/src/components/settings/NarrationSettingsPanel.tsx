import { useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { NARRATION_TAJIK_MODELS, type NarrationConfig, type NarrationSettingsView, type NarrationTemplate } from "@royal-home/shared";
import { api } from "../../lib/api";

/**
 * НАСТРОЙКИ CRM → «ОЗВУЧКА РОЛИКОВ» (14.11.2026, владелец: «всю техническую часть полностью
 * убирать в настройки CRM, в настройках объекта этого вообще не должно быть»).
 *
 * Сюда переехало всё, что раньше раскрывалось кнопкой «Настройки голосов» в карточке объекта:
 * модель ElevenLabs, список голосов и образцы, рубильники (автоозвучка, кто вклеивает голос,
 * проход по очереди монтажа, черновик отчёта собственнику), дневные пределы, шаблоны текста и
 * словарь произношения. Карточка объекта показывает агенту только голос, текст и «Озвучить».
 * Сохраняет директор или администратор (PUT /properties/narration-settings), маркетинг видит.
 */
type Rule = NonNullable<NarrationConfig["pronunciationRules"]>[number];

export function NarrationSettingsPanel() {
  const client = useQueryClient();
  const key = ["narration-settings"];
  const { data, error, isPending } = useQuery({ queryKey: key, queryFn: () => api<NarrationSettingsView>("/properties/narration-settings"), retry: false });
  const [busy, setBusy] = useState(false), [message, setMessage] = useState("");
  const [modelId, setModelId] = useState<string | null>(null), [voicesText, setVoicesText] = useState<string | null>(null);
  const [autoGenerate, setAutoGenerate] = useState<boolean | null>(null), [mixByCrm, setMixByCrm] = useState<boolean | null>(null);
  const [backfill, setBackfill] = useState<boolean | null>(null), [monthlyPreview, setMonthlyPreview] = useState<boolean | null>(null);
  const [limitsText, setLimitsText] = useState<{ chars?: string; gens?: string; pause?: string }>({});
  const [templatesDraft, setTemplatesDraft] = useState<NarrationTemplate[] | null>(null);
  const [rulesDraft, setRulesDraft] = useState<Rule[] | null>(null);

  async function run(action: () => Promise<void>) {
    setBusy(true); setMessage("");
    try { await action(); await client.invalidateQueries({ queryKey: key }); await client.invalidateQueries({ queryKey: ["narration-options"] }); }
    catch (err) { setMessage(err instanceof Error ? err.message : "Действие не выполнено"); }
    finally { setBusy(false); }
  }

  if (isPending) return <p className="text-sm" aria-busy="true">Загружаем настройки озвучки…</p>;
  if (error || !data) return <p className="text-sm" role="status">Настройки озвучки недоступны: {error instanceof Error ? error.message : "не удалось загрузить"}</p>;
  const config = data.config;
  const readOnly = !data.canConfigure;
  const model = modelId ?? config.modelId;
  const templates = templatesDraft ?? config.templates ?? [];
  const rules = rulesDraft ?? config.pronunciationRules ?? [];

  return (
    <div className="space-y-4">
      {readOnly && <p className="rounded-lg bg-slate-50 p-3 text-sm" role="status">Менять настройки озвучки может директор или администратор.</p>}
      <p className="text-sm">
        Ключ ElevenLabs: <b>{data.apiKeyConfigured ? "настроен" : "не настроен"}</b> · модель: <b>{config.modelId ? "выбрана" : "не выбрана"}</b> · голосов: <b>{config.voices.length}</b>
        {" · "}автоозвучка: <b>{data.autoGenerate ? "работает" : "выключена"}</b>
      </p>
      {data.quotaExceeded && <p className="rounded-lg bg-amber-50 p-3 text-sm" role="status">Кредиты ElevenLabs закончились. Озвучки ждут пополнения, проверка раз в час; агентам ничего не отправляется.</p>}
      <p className="text-sm text-slate-600">Сегодня потрачено: {data.budget.usedChars} из {data.budget.dailyChars} символов, {data.budget.usedGenerations} из {data.budget.dailyGenerations} озвучек.</p>

      <fieldset className="space-y-2" disabled={readOnly || busy}>
        <legend className="text-sm font-semibold">Модель и голоса</legend>
        <label className="block text-sm">Модель озвучки
          <select className="mt-1 w-full rounded border p-2" value={model} onChange={(e) => setModelId(e.target.value)}>
            {!model && <option value="">Выберите модель</option>}
            {NARRATION_TAJIK_MODELS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
            {model && !NARRATION_TAJIK_MODELS.some((m) => m.id === model) && <option value={model}>{model} (без таджикского)</option>}
          </select>
        </label>
        <label className="block text-sm">Голоса: одна строка «ID | название | м или ж»
          <textarea className="mt-1 min-h-24 w-full rounded border p-2 font-mono text-sm" value={voicesText ?? voiceLines(config)} onChange={(e) => setVoicesText(e.target.value)} />
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className="pill sm" disabled={readOnly || busy || !data.configured} onClick={() => void run(async () => {
            const result = await api<{ message: string }>("/properties/narration-voice-samples/prepare", { method: "POST", body: { confirmed: true }, timeoutMs: 150_000 });
            setMessage(result.message);
          })}>Подготовить образцы голосов</button>
          <span className="text-sm text-slate-600">Одна фраза каждым голосом, платно один раз. Готово образцов: {data.samplesReady}. По ним агенты выбирают голос на слух.</span>
        </div>
      </fieldset>

      <fieldset className="space-y-2" disabled={readOnly || busy}>
        <legend className="text-sm font-semibold">Как работает</legend>
        <Check checked={autoGenerate ?? !!config.autoGenerate} onChange={setAutoGenerate}>Автоозвучка: аудио готовится само после создания объекта и после правки его данных, агент слушает и одобряет</Check>
        <Check checked={mixByCrm ?? config.mixByCrm === true} onChange={setMixByCrm}>Голос накладывает CRM: монтажёр присылает только ролик без голоса. Выключено: монтажёр вклеивает mp3 сам и присылает ещё тот же ролик без голоса</Check>
        <Check checked={backfill ?? config.backfillMontageQueue === true} onChange={setBackfill}>Озвучка к роликам, которые уже в монтаже: готовить по шаблону и голосу по умолчанию, одобряет владелец</Check>
        <Check checked={monthlyPreview ?? !!config.ownerReportPreviewEnabled} onChange={setMonthlyPreview}>Готовить черновик каждого месяца для уже согласованных отчётов собственнику. SMS не отправлять</Check>
      </fieldset>

      <fieldset className="space-y-2" disabled={readOnly || busy}>
        <legend className="text-sm font-semibold">Пределы расхода</legend>
        <div className="grid gap-2 sm:grid-cols-3">
          <label className="block text-sm">Символов в сутки<input inputMode="numeric" className="mt-1 w-full rounded border p-2" value={limitsText.chars ?? String(config.dailyCharLimit ?? 20000)} onChange={(e) => setLimitsText({ ...limitsText, chars: e.target.value })} /></label>
          <label className="block text-sm">Озвучек в сутки<input inputMode="numeric" className="mt-1 w-full rounded border p-2" value={limitsText.gens ?? String(config.dailyGenerationLimit ?? 40)} onChange={(e) => setLimitsText({ ...limitsText, gens: e.target.value })} /></label>
          <label className="block text-sm">Пауза после правки, мин<input inputMode="numeric" className="mt-1 w-full rounded border p-2" value={limitsText.pause ?? String(config.debounceMinutes ?? 3)} onChange={(e) => setLimitsText({ ...limitsText, pause: e.target.value })} /></label>
        </div>
      </fieldset>

      <fieldset className="space-y-2" disabled={readOnly || busy}>
        <legend className="text-sm font-semibold">Шаблоны текста</legend>
        <p className="text-sm text-slate-600">
          Агент выбирает голос, и текст ставится сам из шаблона этого языка. Несколько шаблонов на язык: у агента появляется кнопка «Другой вариант»,
          а каждый новый объект получает следующий вариант, чтобы ролики не звучали одинаково.
          Слова в фигурных скобках подставляются из объекта: {"{вид} {комнаты} {площадь} {этаж} {этаж_пор} {этажей} {район} {цена}"}. Квадратные скобки: «если есть».
        </p>
        {templates.map((t, i) => <div key={t.id} className="space-y-1 rounded border p-2">
          <div className="flex flex-wrap gap-2">
            <input aria-label="Название шаблона" className="min-w-0 flex-1 rounded border p-2 text-sm" value={t.name} onChange={(e) => setTemplatesDraft(templates.map((x, j) => j === i ? { ...x, name: e.target.value } : x))} />
            <select aria-label="Язык шаблона" className="rounded border p-2 text-sm" value={t.lang} onChange={(e) => setTemplatesDraft(templates.map((x, j) => j === i ? { ...x, lang: e.target.value as "tg" | "ru" } : x))}>
              <option value="tg">по-таджикски</option><option value="ru">по-русски</option>
            </select>
            <button type="button" className="pill sm" onClick={() => setTemplatesDraft(templates.filter((_, j) => j !== i))}>Убрать</button>
          </div>
          <textarea aria-label="Текст шаблона" rows={4} className="w-full rounded border p-2 text-sm" value={t.text} onChange={(e) => setTemplatesDraft(templates.map((x, j) => j === i ? { ...x, text: e.target.value } : x))} />
        </div>)}
        <button type="button" className="pill sm" onClick={() => setTemplatesDraft([...templates, { id: `t-${Date.now().toString(36)}`, name: "Новый шаблон", lang: "tg", text: "{вид} барои фурӯш. Масоҳаташ {площадь} метри мураббаъ." }])}>Добавить шаблон</button>
      </fieldset>

      <fieldset className="space-y-2" disabled={readOnly || busy}>
        <legend className="text-sm font-semibold">Словарь произношения</legend>
        <p className="text-sm text-slate-600">Слово и как его читать. Сохраните, и CRM сама обновит словарь в ElevenLabs. Пометка «проверить носителем»: чтение собрано по правилам и на слух ещё не проверено.</p>
        {rules.map((r, i) => <div key={i} className="flex flex-wrap items-center gap-2 rounded border p-2">
          <input aria-label="Слово" className="min-w-0 flex-1 rounded border p-2 text-sm" value={r.word} onChange={(e) => setRulesDraft(rules.map((x, j) => j === i ? { ...x, word: e.target.value } : x))} />
          <input aria-label="Как читать" placeholder="как читать" className="min-w-0 flex-1 rounded border p-2 text-sm" value={r.alias ?? ""} onChange={(e) => setRulesDraft(rules.map((x, j) => j === i ? { ...x, alias: e.target.value || undefined } : x))} />
          <input aria-label="Звуки IPA" placeholder="IPA, по желанию" className="min-w-0 flex-1 rounded border p-2 text-sm" value={r.phoneme ?? ""} onChange={(e) => setRulesDraft(rules.map((x, j) => j === i ? { ...x, phoneme: e.target.value || undefined } : x))} />
          {r.needsNative && <button type="button" className="chip" title="Нажмите, когда носитель проверил" onClick={() => setRulesDraft(rules.map((x, j) => j === i ? { ...x, needsNative: undefined } : x))}>проверить носителем</button>}
          <button type="button" className="pill sm" onClick={() => setRulesDraft(rules.filter((_, j) => j !== i))}>Убрать</button>
        </div>)}
        <button type="button" className="pill sm" onClick={() => setRulesDraft([...rules, { word: "", alias: "" }])}>Добавить слово</button>
      </fieldset>

      {!readOnly && <button className="pill" type="button" disabled={busy} onClick={() => void run(async () => {
        // Настройки синтеза у голоса (12.11.2026) строкой не редактируются: переносим их по id.
        const voices = parseVoiceLines(voicesText ?? voiceLines(config)).map((v) => {
          const settings = config.voices.find((old) => old.id === v.id)?.settings;
          return settings ? { ...v, settings } : v;
        });
        const number = (text: string | undefined, fallback: number | undefined) => text === undefined ? fallback : Math.max(0, Math.round(Number(text) || 0));
        const patch: Partial<NarrationConfig> = { modelId: model, voices, ownerReportPreviewEnabled: monthlyPreview ?? !!config.ownerReportPreviewEnabled,
          autoGenerate: autoGenerate ?? !!config.autoGenerate, mixByCrm: mixByCrm ?? config.mixByCrm === true, backfillMontageQueue: backfill ?? config.backfillMontageQueue === true,
          ...(rulesDraft ? { pronunciationRules: rulesDraft.filter((r) => r.word.trim() && (r.alias?.trim() || r.phoneme?.trim())) } : {}),
          dailyCharLimit: number(limitsText.chars, config.dailyCharLimit), dailyGenerationLimit: number(limitsText.gens, config.dailyGenerationLimit),
          debounceMinutes: number(limitsText.pause, config.debounceMinutes), ...(templatesDraft ? { templates: templatesDraft } : {}) };
        const saved = await api<{ message?: string }>("/properties/narration-settings", { method: "PUT", body: patch });
        setRulesDraft(null); setTemplatesDraft(null); setVoicesText(null); setLimitsText({});
        setMessage(saved.message ?? "Настройки озвучки сохранены.");
      })}>Сохранить настройки озвучки</button>}
      {message && <p className="text-sm" role="status">{message}</p>}
    </div>
  );
}

function Check({ checked, onChange, children }: { checked: boolean; onChange: (next: boolean) => void; children: ReactNode }) {
  return <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={checked} onChange={(e) => onChange(e.target.checked)} /><span>{children}</span></label>;
}

function voiceLines(config: NarrationConfig): string {
  return config.voices.map((v) => [v.id, v.name, v.gender === "male" ? "м" : v.gender === "female" ? "ж" : ""].filter(Boolean).join(" | ")).join("\n");
}
/** «ID | название | м/ж» в голоса настроек. Пол необязателен. */
export function parseVoiceLines(text: string): NarrationConfig["voices"] {
  return text.split("\n").filter((line) => line.trim()).map((line) => {
    const parts = line.split("|").map((part) => part.trim());
    const last = parts.length > 2 ? parts[parts.length - 1].toLowerCase() : "";
    const gender = last === "м" || last === "муж" ? "male" as const : last === "ж" || last === "жен" ? "female" as const : undefined;
    const name = (gender ? parts.slice(1, -1) : parts.slice(1)).join(" | ");
    return { id: parts[0], name, ...(gender ? { gender } : {}) };
  });
}
