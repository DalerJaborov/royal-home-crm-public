import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { instagramAppBindingInputSchema, instagramAppBindingResultSchema, instagramAppBindingStatusSchema } from "@royal-home/shared";
import { api } from "../../lib/api";

export function InstagramAppBinding({ accountId }: { accountId: string }) {
  const [open, setOpen] = useState(false), [appId, setAppId] = useState("");
  const [selectedSource, setSelectedSource] = useState(""), [confirmed, setConfirmed] = useState(false);
  const [saved, setSaved] = useState<boolean | null>(null), [saving, setSaving] = useState(false), [saveFailed, setSaveFailed] = useState(false);
  const inFlight = useRef(false), client = useQueryClient();
  const path = `/settings/messenger-accounts/${accountId}/instagram-app-binding`;
  const query = useQuery({ queryKey: ["instagram-app-binding", accountId], enabled: open,
    queryFn: async () => instagramAppBindingStatusSchema.parse(await api(path)) });
  const candidate = query.data?.candidates.find(value => value.secretSource === selectedSource);
  useEffect(() => { setConfirmed(false); }, [candidate?.observationVersion, query.data?.configurationVersion]);
  const parsed = instagramAppBindingInputSchema.safeParse({ mode: "owner_selected_observed_signer", appId,
    secretSource: selectedSource, observationId: candidate?.observationId, observationVersion: candidate?.observationVersion,
    configurationVersion: query.data?.configurationVersion, confirmFutureInputs: confirmed });
  function reset() { setSelectedSource(""); setConfirmed(false); setSaved(null); }
  async function save() {
    if (!parsed.success || inFlight.current || saveFailed) return;
    inFlight.current = true; setSaving(true); setSaved(null);
    try {
      const result = instagramAppBindingResultSchema.parse(await api(path, { method: "POST", body: parsed.data, queueOffline: false }));
      const { configurationChanged, ...status } = result;
      client.setQueryData(["instagram-app-binding", accountId], instagramAppBindingStatusSchema.parse(status));
      setSaved(configurationChanged); setConfirmed(false); setSelectedSource("");
      void client.invalidateQueries({ queryKey: ["messenger-accounts"] });
    } catch { setSaveFailed(true); setConfirmed(false); }
    finally { setSaving(false); inFlight.current = false; }
  }
  return <div style={{ padding: "var(--s2)" }}>
    <button className="pill ghost sm" type="button" aria-expanded={open} disabled={saving} onClick={() => {
      setOpen(!open); reset(); setSaveFailed(false);
    }}>Подпись входящих Instagram</button>
    {open && <form style={{ marginTop: "var(--s3)", display: "grid", gap: "var(--s3)" }}
      onSubmit={event => { event.preventDefault(); void save(); }}>
      {query.isPending && <p className="sub">Загрузка подключения…</p>}
      {query.isError && <p role="alert">Не удалось загрузить подключение.</p>}
      {query.data && <>
        <p className="sub">{query.data.configuredAppId
          ? query.data.freshSignatureObservedAt ? "Настройка сохранена. Получен новый запрос с подписью аккаунта."
            : "Настройка сохранена. Ожидаем новый подписанный запрос аккаунта."
          : "Отдельная привязка подписанта ещё не настроена."}</p>
        <label className="fld"><span>ID приложения Instagram</span><input value={appId} inputMode="numeric" autoComplete="off"
          maxLength={64} disabled={saving} onChange={event => { setAppId(event.target.value); setConfirmed(false); setSaved(null); }} /></label>
        <label className="fld"><span>Наблюдавшийся подписант</span><select value={selectedSource} disabled={saving || saveFailed}
          onChange={event => { setSelectedSource(event.target.value); setConfirmed(false); setSaved(null); }}>
          <option value="">Выберите явно</option>
          {query.data.candidates.map(value => <option key={value.secretSource} value={value.secretSource}>
            {value.secretSource === "settings_instagram" ? "Ключ Instagram из настроек" : "Ключ Meta из настроек"}
          </option>)}
        </select></label>
        {candidate && <p className="sub">Последний подтверждённый входящий запрос: {new Date(candidate.observedAt).toLocaleString("ru-RU")}.</p>}
        {!query.data.candidates.length && <p role="status">За последние сутки подходящий подписанный запрос не найден. Сохранение недоступно.</p>}
        <p className="sub">Администратор выбирает существующий ключ для этого аккаунта. Проверяются аккаунт и подписки;
          это не подтверждение владения секретом приложения со стороны Meta. Старые сообщения не меняются.</p>
        <label className="sub"><input type="checkbox" checked={confirmed} disabled={saving || !candidate || saveFailed}
          onChange={event => setConfirmed(event.target.checked)} /> Подтверждаю выбор подписанта для новых входящих сообщений этого аккаунта.</label>
        <div><button className="pill sm" type="submit" disabled={saving || saveFailed || !parsed.success}>
          {saving ? "Проверяем подключение…" : "Сохранить выбор подписанта"}</button></div>
        {saveFailed && <p role="alert">Результат сохранения не подтверждён. Обновите состояние перед повторной попыткой.</p>}
        {(saveFailed || query.isError) && <div><button className="pill ghost sm" type="button" onClick={async () => {
          const result = await query.refetch(); if (result.isSuccess) { reset(); setSaveFailed(false); }
        }}>Обновить состояние</button></div>}
        {saved !== null && <p role="status">{saved ? "Выбранный подписант сохранён. Ожидаем новый подписанный запрос."
          : "Выбор уже сохранён; ключ и ревизия не изменились."}</p>}
      </>}
    </form>}
  </div>;
}
