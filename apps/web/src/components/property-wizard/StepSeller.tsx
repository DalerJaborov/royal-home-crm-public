import { useEffect, useMemo, useRef, useState } from "react";
import { useQueries } from "@tanstack/react-query";
import type { SellerObjectSummary } from "@royal-home/shared";
import { useAgents } from "../../hooks/useAgents";
import { useClient, useClients } from "../../hooks/useClients";
import { useAuthStore } from "../../store/auth";
import { api } from "../../lib/api";
import type { Client } from "../../types";
import { PhoneInput } from "../FormField";
import { SearchableSelect } from "../SearchableSelect";
import { phoneDigits, type WizardValues } from "./types";

/**
 * «МОИ НЕДАВНИЕ ПРОДАВЦЫ» (владелец 21.09.2026: «чтобы не искать» — первым
 * должен стоять именно тот продавец, с которым только что говорили).
 *
 * Пул шире итоговых пяти строк (RECENT_POOL), чтобы было из чего вытащить
 * «без объектов — выше» уже ПОСЛЕ проверки на дубль ниже — сортировка по
 * давности контакта одна, а видимый порядок другой (owner: «продавцы без
 * объектов — выше»).
 */
const RECENT_POOL = 12;
const RECENT_SHOWN = 5;
/** Автовыбор — только когда разговор правда только что был, не «на этой неделе». */
const RECENT_AUTOPICK_MS = 30 * 60_000;

/**
 * Пул кандидатов — своя книга SELLER плюс dualIntent BUYER (человек мог начать
 * покупателем, а потом решить продать своё — владелец: «kind SELLER или
 * dualIntent»), отсортированные СЕРВЕРОМ по давности контакта (`sort:
 * contact_desc` — тот же порядок, что у «Мой вид» экрана «Клиенты», параметр
 * уже есть в API, второй раз не заводится).
 *
 * «БЕЗ ОБЪЕКТОВ — ВЫШЕ». Дешёвого признака «есть ли у клиента объект» в
 * списке клиентов нет (список отдаёт карточки клиентов, не карточки объектов),
 * а заводить его ради пяти строк на одном экране значило бы трогать самый
 * горячий роут (`GET /clients`) ради виджета. Вместо этого — ТОТ ЖЕ маршрут,
 * что уже смотрит DraftGate.tsx (`GET /clients/:id/seller-object`, читает
 * фоновое задание, не ИИ), но не по одному хуку на строку (хуки нельзя звать в
 * цикле) — один `useQueries` на весь пул, ограниченный RECENT_POOL кандидатами.
 */
function useRecentSellers(enabled: boolean) {
  const sellerPool = useClients({ kind: "SELLER", sort: "contact_desc", pageSize: RECENT_POOL }, enabled);
  const dualPool = useClients({ kind: "BUYER", sort: "contact_desc", pageSize: RECENT_POOL }, enabled);
  const merged = useMemo(() => {
    const sellers = sellerPool.data?.items ?? [];
    const duals = (dualPool.data?.items ?? []).filter((c) => c.dualIntent);
    return [...sellers, ...duals]
      .sort((a, b) => new Date(b.lastContactAt).getTime() - new Date(a.lastContactAt).getTime())
      .slice(0, RECENT_POOL);
  }, [sellerPool.data, dualPool.data]);

  const hasPropertyQueries = useQueries({
    queries: merged.map((c) => ({
      queryKey: ["seller-object", c.id],
      queryFn: () => api<SellerObjectSummary>(`/clients/${c.id}/seller-object`),
      enabled,
      staleTime: 60_000,
    })),
  });

  const items = useMemo(() => {
    // Устойчивая сортировка (JS Array.sort) — внутри «без объектов»/«с
    // объектами» порядок по давности контакта, посчитанный выше, сохраняется.
    return merged
      .map((c, i) => ({ client: c, hasProperty: (hasPropertyQueries[i]?.data?.properties.length ?? 0) > 0 }))
      .sort((a, b) => Number(a.hasProperty) - Number(b.hasProperty))
      .slice(0, RECENT_SHOWN)
      .map((r) => r.client);
  }, [merged, hasPropertyQueries]);

  return {
    items,
    isLoading: sellerPool.isLoading || dualPool.isLoading,
    /** Самый свежий контакт по факту, БЕЗ перестановки «без объектов — выше» —
     *  автовыбор ниже решает по реальной давности разговора, а не по порядку показа. */
    topByRecency: merged[0] ?? null,
  };
}

/**
 * ШАГ 4 — ПРОДАВЕЦ. Облик — артефакт владельца (stepSeller): два поля `.f`
 * (имя, телефон) и список известных продавцов `.sugg` под ними, вместо
 * прежнего выпадающего `SellerPicker`. Список и выбор — та же связка
 * `GET /clients?kind=SELLER`, что была в `SellerPicker.tsx` (его не трогаем:
 * он используется ещё в `PropertyFormModal.tsx`, второй потребитель тех же
 * классов эталона не пускает).
 *
 * `.tag mine`/`.tag` — «мой»/«база» по `assignedAgentId` карточки против
 * текущего агента: рядового агента сервер и так ограничивает своими
 * (`scopeToOwnAgent`), поэтому для него все строки будут «мой»; различие
 * видно только руководителю, который видит чужих продавцов тоже.
 *
 * `.rg` в артефакте — «N объектов»: такого счётчика на клиенте сервер не
 * отдаёт (нет `propertyCount` в ответе `/clients`), выдумывать число нельзя —
 * здесь честно показан телефон карточки, вторая половина того же назначения
 * («не перепутать тёзок»), которую уже просил владелец 21.08.2026.
 *
 * Второй путь — не «упрощённый», а обычный: сервер по последним девяти цифрам
 * номера сам находит или заводит карточку продавца и связывает её с объектом
 * (см. `sellerName` в propertyCreateSchema и routes/properties/crud.ts). Просить
 * агента сперва завести клиента, а потом объект — лишний экран в квартире.
 *
 * ДУБЛЬ ПО ТЕЛЕФОНУ. Отдельного маршрута проверки в API нет, но поиск по списку
 * (`GET /clients?q=`) ищет и по телефону, и по WhatsApp, и по дополнительным
 * номерам. Совпадение показываем ДО сохранения и предлагаем взять готовую
 * карточку: молча создать вторую было бы хуже всего — потом их сводить вручную.
 */
export function StepSeller({
  values,
  errors,
  requireIntakeAgent,
  onChange,
  onSellerPicked,
}: {
  values: WizardValues;
  errors: Record<string, string>;
  /** Руководителю сервер не подставляет интейкера сам — его надо выбрать. */
  requireIntakeAgent: boolean;
  onChange: (patch: Partial<WizardValues>) => void;
  /**
   * Выбрана СУЩЕСТВУЮЩАЯ карточка продавца (21.09.2026, «объект продавца
   * заполняется сам») — PropertyWizard.tsx подтягивает его факты и фото тем же
   * запросом, что и вход `?fromClient=`, но НЕ затирает уже введённое агентом
   * (заполняются только пустые поля, файлы добавляются к уже загруженным).
   * Необязателен — «Взять готовую карточку» у дубля по телефону использует
   * тот же клиентский id и тоже должен обогатиться, поэтому оба места ниже
   * зовут этот же коллбек.
   */
  onSellerPicked?: (clientId: string) => void;
}) {
  const { data: agents } = useAgents({ enabled: requireIntakeAgent });
  const myAgentId = useAuthStore((s) => s.agent?.id);

  const digits = phoneDigits(values.sellerPhone);
  const lookupEnabled = !values.sellerClientId && digits.length >= 9;
  const { data: found } = useClients({ q: digits.slice(-9), pageSize: 5 }, lookupEnabled);
  const duplicate = lookupEnabled
    ? (found?.items ?? []).find((c) => phoneDigits(c.phone ?? "").slice(-9) === digits.slice(-9))
    : undefined;

  // Список «известных продавцов» — тот же справочник, что раньше открывал
  // SellerPicker внутри SearchableSelect; здесь он развёрнут строками `.sugg`,
  // как в артефакте, и сужается по набранному имени/телефону на лету.
  const { data: sellersData, isLoading: sellersLoading } = useClients(
    { kind: "SELLER", pageSize: 200 },
    !values.sellerClientId
  );
  const sellers = useMemo(() => sellersData?.items ?? [], [sellersData]);
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q
      ? sellers.filter((s) => s.fullName.toLowerCase().includes(q) || (s.phone ?? "").includes(q))
      : sellers;
    return list.slice(0, 8);
  }, [sellers, query]);

  const recentSellers = useRecentSellers(!values.sellerClientId);
  const selectedClient = useClient(values.sellerClientId || undefined);

  /**
   * Карточка, показанная строкой «выбран», ПОСЛЕ выбора (21.09.2026).
   *
   * Прежде «picked» искался только в `sellers` (kind=SELLER, до 200 штук) —
   * достаточно, пока выбор шёл только из этого же списка. Дубль по телефону
   * (ниже) и новый список «Мои недавние продавцы» (может нести dualIntent
   * BUYER — человек мог начинаться покупателем) берут карточку из ДРУГИХ
   * запросов, которых в `sellers` может не быть вовсе — строка «выбран» молча
   * осталась бы пустой. `pickedFallback` — сама карточка на момент клика,
   * запасной источник имени/телефона, когда её нет ни в одном из списков.
   */
  const [pickedFallback, setPickedFallback] = useState<Client | null>(null);
  const picked = values.sellerClientId
    ? (sellers.find((s) => s.id === values.sellerClientId) ??
      recentSellers.items.find((s) => s.id === values.sellerClientId) ??
      (pickedFallback?.id === values.sellerClientId ? pickedFallback : null) ??
      (selectedClient.data?.id === values.sellerClientId ? selectedClient.data : null))
    : null;

  /** Один выбор продавца — из «Моих недавних», из полного списка и из
   *  предложения «Взять готовую карточку» у дубля по телефону: три места
   *  раньше повторяли одну и ту же связку onChange+onSellerPicked. */
  function pickSeller(s: Client) {
    setPickedFallback(s);
    onChange({
      sellerClientId: s.id,
      ...(requireIntakeAgent && s.assignedAgentId ? { intakeAgentId: s.assignedAgentId } : {}),
      sellerName: "",
      sellerPhone: "",
    });
    onSellerPicked?.(s.id);
  }

  /**
   * АВТОВЫБОР «СВЕЖЕГО» ПРОДАВЦА (владелец 21.09.2026: «если последний контакт
   * ≤30 минут назад и продавец ещё не выбран — выбрать его автоматически, с
   * видимым выбором, агент может сменить»). Решение принимается один раз за
   * то время, пока агент ничего не тронул руками (autoPickedRef) — иначе
   * каждое обновление списка («Мои недавние» перечитывается тем же запросом)
   * пыталось бы выбирать заново поверх того, что агент уже поменял сам.
   */
  const autoPickedRef = useRef(false);
  useEffect(() => {
    if (autoPickedRef.current) return;
    if (values.sellerClientId || values.sellerName.trim() || values.sellerPhone.trim()) {
      autoPickedRef.current = true; // агент уже выбирает/вводит сам — не мешаем
      return;
    }
    if (recentSellers.isLoading) return; // данных ещё нет — не решаем на пустом месте
    autoPickedRef.current = true; // решение принято, второй раз не пробуем
    const top = recentSellers.topByRecency;
    if (!top) return;
    if (Date.now() - new Date(top.lastContactAt).getTime() > RECENT_AUTOPICK_MS) return;
    pickSeller(top);
    // pickSeller не входит в deps намеренно — пересоздаётся каждый рендер, а
    // логика ниже и так решает ровно один раз за жизнь эффекта (ref выше).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recentSellers.isLoading, recentSellers.topByRecency, values.sellerClientId, values.sellerName, values.sellerPhone]);

  return (
    <>
      {requireIntakeAgent && (
        <section className="blk">
          <div className="f" aria-invalid={!!errors.intakeAgentId || undefined} aria-describedby={errors.intakeAgentId ? "wizard-intake-error" : undefined}>
            <label>Кто принял объект</label>
            <SearchableSelect
              value={values.intakeAgentId}
              onChange={(id) => onChange({ intakeAgentId: id })}
              options={(agents ?? []).map((a) => ({ value: a.id, label: a.fullName }))}
              placeholder="Выберите сотрудника"
            />
          </div>
          {errors.intakeAgentId && (
            <p id="wizard-intake-error" style={{ marginTop: 8, fontSize: 13, color: "var(--warn)" }}>{errors.intakeAgentId}</p>
          )}
        </section>
      )}

      {values.sellerClientId ? (
        <section className="blk wizard-seller-selected">
          {picked ? (
          <div className="sugg" style={{ margin: 0 }}>
            <div className="wizard-selected-seller-row">
              <span className="tag mine">выбран</span>
              <span className="nm">{picked.fullName}</span>
              <span className="rg">{picked.phone || `ПК-${picked.shortId}`}</span>
            </div>
          </div>
          ) : selectedClient.isError ? <div role="alert"><p>Не удалось загрузить выбранного продавца.</p><button type="button" className="wizard-text-action" onClick={() => void selectedClient.refetch()}>Повторить загрузку продавца</button></div>
            : <p role="status">Загружаю выбранного продавца…</p>}
          <button
            type="button"
            className="chip warn"
            style={{ marginTop: 8 }}
            onClick={() => {
              setPickedFallback(null);
              onChange({ sellerClientId: "" });
            }}
          >
            Сменить продавца
          </button>
        </section>
      ) : (
        <>
          {recentSellers.items.length > 0 && (
            <section className="blk wizard-seller-recent">
              <div className="head">
                <h4>Мои недавние продавцы</h4>
              </div>
              <div className="sugg" style={{ margin: 0, border: 0 }}>
                {recentSellers.items.map((s) => (
                  <button key={s.id} type="button" onClick={() => pickSeller(s)}>
                    <span className={s.assignedAgentId === myAgentId ? "tag mine" : "tag"}>
                      {s.assignedAgentId === myAgentId ? "мой" : "база"}
                    </span>
                    <span className="nm">{s.fullName}</span>
                    <span className="rg">{s.phone || `ПК-${s.shortId}`}</span>
                  </button>
                ))}
              </div>
            </section>
          )}

          <section className="blk wizard-seller-form">
            <div className="f">
              <label htmlFor="seller">Имя</label>
              <input
                id="seller"
                aria-required="true"
                aria-invalid={!!errors.sellerName || undefined}
                aria-describedby={errors.sellerName ? "wizard-seller-name-error" : undefined}
                className="txt"
                value={values.sellerName}
                autoComplete="name"
                placeholder="Как к нему обращаться"
                onChange={(e) => {
                  onChange({ sellerName: e.target.value });
                  setQuery(e.target.value);
                }}
              />
            </div>
            {errors.sellerName && (
              <p id="wizard-seller-name-error" style={{ marginTop: 6, fontSize: 13, color: "var(--warn)" }}>{errors.sellerName}</p>
            )}
            <div style={{ height: 8 }} />
            <div className="f">
              <label htmlFor="phone">Телефон</label>
              <PhoneInput id="phone" value={values.sellerPhone} onChange={(v) => onChange({ sellerPhone: v })} invalid={!!errors.sellerPhone}
                aria-required="true" aria-invalid={!!errors.sellerPhone || undefined} aria-describedby={errors.sellerPhone ? "wizard-seller-phone-error" : undefined} />
            </div>
            {errors.sellerPhone && (
              <p id="wizard-seller-phone-error" style={{ marginTop: 6, fontSize: 13, color: "var(--warn)" }}>{errors.sellerPhone}</p>
            )}
          </section>

          <section className="blk wizard-seller-list">
            <div className="sugg" style={{ margin: 0, border: 0 }}>
              {sellersLoading ? (
                <div className="empty">Загружаю продавцов…</div>
              ) : filtered.length === 0 ? (
                <div className="empty">
                  {sellers.length === 0 ? "Своих продавцов пока нет — заполните поля выше" : "Нет совпадений — заполните поля выше"}
                </div>
              ) : (
                filtered.map((s) => (
                  <button key={s.id} type="button" onClick={() => pickSeller(s)}>
                    <span className={s.assignedAgentId === myAgentId ? "tag mine" : "tag"}>
                      {s.assignedAgentId === myAgentId ? "мой" : "база"}
                    </span>
                    <span className="nm">{s.fullName}</span>
                    <span className="rg">{s.phone || `ПК-${s.shortId}`}</span>
                  </button>
                ))
              )}
            </div>
          </section>
        </>
      )}

      {duplicate && (
        <section className="blk">
          <div className="dup">
            <span className="dot" aria-hidden />
            Такой номер уже есть: ПК-{duplicate.shortId} · {duplicate.fullName || "без имени"}
          </div>
          <button type="button" className="chip warn" style={{ marginTop: 8 }} onClick={() => pickSeller(duplicate)}>
            Взять готовую карточку
          </button>
        </section>
      )}
    </>
  );
}
