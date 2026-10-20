import { useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { clientBuyerRequirementsSchema, clientIntents, type PropertyType, type ClientBuyerRequirementsInput } from "@royal-home/shared";
import { useDistricts } from "../hooks/useDistricts";
import { api } from "../lib/api";
import { PROPERTY_TYPE_LABELS } from "../lib/format";
import type { Client } from "../types";
import { ClientCardFacts } from "./ClientCardContext";
import { Rh2Sheet } from "./rh2/Rh2Sheet";

type BuyerRequirementsDraft = {
  budgetMin: string; budgetMax: string; currency: "TJS" | "USD"; desiredType: string; desiredRooms: string;
  desiredDistrictId: string; desiredAreaMin: string; desiredFloorMin: string; desiredFloorMax: string;
  desiredTotalFloors: string; requirementsNotes: string;
};
const value = (n: string | number | null | undefined) => n == null ? "" : String(n);
/** Explicitly tagged seller fields are never presented as the buyer's own request. */
export function buyerRequirementsDraft(client: Client): BuyerRequirementsDraft {
  const current = !client.requirementsFieldsKind || client.requirementsFieldsKind === "BUYER";
  return {
    budgetMin: current ? value(client.budgetMin) : "", budgetMax: current ? value(client.budgetMax) : "",
    currency: current ? client.currency : "TJS", desiredType: current ? client.desiredType ?? "" : "",
    desiredRooms: current ? value(client.desiredRooms) : "", desiredDistrictId: current ? client.desiredDistrictId ?? "" : "",
    desiredAreaMin: current ? value(client.desiredAreaMin) : "", desiredFloorMin: current ? value(client.desiredFloorMin) : "",
    desiredFloorMax: current ? value(client.desiredFloorMax) : "", desiredTotalFloors: current ? value(client.desiredTotalFloors) : "",
    requirementsNotes: current ? client.requirementsNotes ?? "" : "",
  };
}
export function buyerRequirementsPayload(form: BuyerRequirementsDraft) {
  const numberOrNull = (text: string) => text.trim() === "" ? null : Number(text);
  return {
    budgetMin: numberOrNull(form.budgetMin), budgetMax: numberOrNull(form.budgetMax), currency: form.currency,
    desiredType: (form.desiredType || null) as PropertyType | null, desiredRooms: numberOrNull(form.desiredRooms),
    desiredDistrictId: form.desiredDistrictId || null, desiredAreaMin: numberOrNull(form.desiredAreaMin),
    desiredFloorMin: numberOrNull(form.desiredFloorMin), desiredFloorMax: numberOrNull(form.desiredFloorMax),
    desiredTotalFloors: numberOrNull(form.desiredTotalFloors), requirementsNotes: form.requirementsNotes.trim() || null,
  };
}

export function ClientBuyerRequirementsEditor({ client, locked }: { client: Client; locked: boolean }) {
  const [open, setOpen] = useState(false);
  if (!clientIntents(client).buys) return null;
  return <div className="client-buyer-summary">
    <ClientCardFacts client={client} />
    {!locked && !client.pendingAcceptance && <button type="button" className="pill ghost sm" onClick={() => setOpen(true)}>Уточнить пожелания</button>}
    {open && !locked && !client.pendingAcceptance && <BuyerRequirementsForm key={`${client.id}:${client.requirementsFieldsKind ?? "legacy"}`} client={client} locked={locked} onClose={() => setOpen(false)} />}
  </div>;
}
function BuyerRequirementsForm({ client, locked, onClose }: { client: Client; locked: boolean; onClose: () => void }) {
  const [form, setForm] = useState(() => buyerRequirementsDraft(client));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const districts = useDistricts();
  const query = useQueryClient();
  const lockedRef = useRef(locked);
  lockedRef.current = locked;
  const save = useMutation({
    mutationFn: (body: ClientBuyerRequirementsInput) => api(`/clients/${client.id}/buyer-requirements`, { method: "POST", body }),
    onSuccess: async () => {
      await Promise.all([query.invalidateQueries({ queryKey: ["client"] }), query.invalidateQueries({ queryKey: ["clients"] }), query.invalidateQueries({ queryKey: ["client-match", client.id] })]);
      onClose();
    },
  });
  function update<K extends keyof BuyerRequirementsDraft>(key: K, next: BuyerRequirementsDraft[K]) {
    setForm(previous => ({ ...previous, [key]: next }));
    setErrors(previous => { const changed = { ...previous }; delete changed[key]; return changed; });
    save.reset();
  }
  function submit() {
    if (lockedRef.current || save.isPending) return;
    const parsed = clientBuyerRequirementsSchema.safeParse(buyerRequirementsPayload(form));
    if (!parsed.success) {
      const next: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const key = String(issue.path[0] ?? "form");
        next[key] ??= issue.message.startsWith("Invalid") || issue.message.startsWith("Too ") ? "Проверьте значение и допустимые границы." : issue.message;
      }
      setErrors(next); return;
    }
    setErrors({}); save.mutate(parsed.data);
  }
  const numberField = (key: Exclude<keyof BuyerRequirementsDraft, "currency" | "desiredType" | "desiredDistrictId" | "requirementsNotes">, label: string, min: number, max?: number) => <label className="fld">
    <span className="lab">{label}</span>
    <input className="inp" type="number" inputMode="numeric" min={min} max={max} step={min < 1 ? 0.01 : 1} value={form[key]} onChange={event => update(key, event.target.value)} aria-invalid={!!errors[key]} aria-describedby={errors[key] ? `buyer-${key}-error` : undefined} />
    {errors[key] && <span className="sub" id={`buyer-${key}-error`}>{errors[key]}</span>}
  </label>;
  const stale = !!client.requirementsFieldsKind && client.requirementsFieldsKind !== "BUYER";
  return <Rh2Sheet title="Пожелания покупателя" wide onClose={() => { if (!save.isPending) onClose(); }} closeOnBackdrop={false} dismissible={!save.isPending}
    onSubmit={event => { event.preventDefault(); submit(); }}
    footer={<><button type="button" className="pill ghost" disabled={save.isPending} onClick={onClose}>Отмена</button><button type="submit" className="pill" disabled={save.isPending}>{save.isPending ? "Сохранение…" : "Сохранить пожелания"}</button></>}>
    <p className="sub">Запишите актуальные пожелания по словам клиента. После сохранения подбор обновится. Пустое поле означает, что условие не задано.</p>
    {stale && <p className="sub">Старые поля относились к другому обращению. Здесь они не подставлены — уточните запрос на покупку.</p>}
    <fieldset disabled={save.isPending} className="client-buyer-form">
      <label className="fld"><span className="lab">Тип недвижимости</span><select className="inp" value={form.desiredType} onChange={event => update("desiredType", event.target.value)}><option value="">Не задан</option>{Object.entries(PROPERTY_TYPE_LABELS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
      {numberField("desiredRooms", "Комнат", 1)}
      {numberField("budgetMin", "Бюджет от", 0.01)}
      {numberField("budgetMax", "Бюджет до", 0.01)}
      <label className="fld"><span className="lab">Валюта бюджета</span><select className="inp" value={form.currency} onChange={event => update("currency", event.target.value as "TJS" | "USD")}><option value="TJS">Сомони (TJS)</option><option value="USD">Доллары (USD)</option></select></label>
      <label className="fld"><span className="lab">Район поиска</span><select className="inp" value={form.desiredDistrictId} disabled={districts.isLoading} onChange={event => update("desiredDistrictId", event.target.value)}><option value="">Не задан</option>{form.desiredDistrictId && !districts.data?.some(district => district.id === form.desiredDistrictId) && <option value={form.desiredDistrictId}>{client.desiredDistrict?.name ?? "Сохранённый район"}</option>}{districts.data?.map(district => <option key={district.id} value={district.id}>{district.name}</option>)}</select></label>
      {numberField("desiredAreaMin", "Площадь от, м²", 1, 100000)}
      {numberField("desiredFloorMin", "Этаж от", 0, 200)}
      {numberField("desiredFloorMax", "Этаж до", 0, 200)}
      {numberField("desiredTotalFloors", "Дом не выше, этажей", 1, 200)}
      <label className="fld client-buyer-form-notes"><span className="lab">Другие пожелания к покупке</span><textarea className="inp" rows={4} value={form.requirementsNotes} onChange={event => update("requirementsNotes", event.target.value)} placeholder="Состояние, лифт, планировка, что обязательно и на какие уступки согласен клиент" /></label>
    </fieldset>
    {districts.isError && <p role="alert">Не удалось загрузить список районов. Сохранённый район не изменён. <button type="button" className="lnk" onClick={() => void districts.refetch()}>Загрузить районы ещё раз</button></p>}
    {Object.keys(errors).length > 0 && <p role="alert">Проверьте заполненные поля: {Object.values(errors).filter((message, index, all) => all.indexOf(message) === index).join(" ")}</p>}
    {save.error && <p role="alert">Не удалось сохранить пожелания. {save.error.message}</p>}
  </Rh2Sheet>;
}
