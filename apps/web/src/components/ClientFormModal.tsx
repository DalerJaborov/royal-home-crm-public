import { useIsReadOnly } from "../lib/permissions";
import { CleanRecordForm, ReadOnlyRecordFields, cleanRecordChoiceProps, focusCleanRecordError } from "./clean/CleanRecordForm";
import { useCleanShell } from "../hooks/useCleanShell";
import { useEffect, useId, useMemo, useState } from "react";
import { useRetryKey } from "../hooks/useRetryKey";
import type { ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import {
  CLIENT_SOURCES,
  PROPERTY_TYPES,
  PROPERTY_TYPE_LABELS,
  isMaskedClientPhone,
  type PropertyType,
} from "@royal-home/shared";
import { useCreateClient, useUpdateClient, type ClientDuplicateWarning } from "../hooks/useClients";
import { useDistricts } from "../hooks/useDistricts";
import { useSettings } from "../hooks/useSettings";
import { ApiError } from "../lib/api";
import { CLIENT_SOURCE_LABELS } from "../lib/clientFormat";
import { formatMoney } from "../lib/format";
import { districtCenter } from "../lib/districtCoords";
import { ConfirmDialog } from "./ConfirmDialog";
import { PhoneInput } from "./FormField";
import { LocationPicker } from "./LocationPicker";
import { Rh2Sheet } from "./rh2/Rh2Sheet";
import { useAuthStore } from "../store/auth";
import { useDraftBeforeUpdate } from "../hooks/useDraftBeforeUpdate";
import { consumeDraftBeforeUpdate } from "../lib/draftBeforeUpdate";
import { clientDraftKind, isClientDraftUnchanged, type ClientFormDraft } from "../lib/clientFormDraft";
import { toast } from "../store/toast";
import type { Client } from "../types";

/** Одно желаемое место поиска в форме — та же форма, что и на сервере
 *  (desiredPlaceSchema, @royal-home/shared), но с label как обычной строкой,
 *  а не optional: пустая строка на экране проще undefined в состоянии формы. */
interface DesiredPlaceForm {
  lat: number;
  lng: number;
  radiusM: number;
  label: string;
}

const DEFAULT_PLACE_RADIUS_M = 1000;
const MIN_PLACE_RADIUS_M = 100;
const MAX_PLACE_RADIUS_M = 10000;
const MAX_DESIRED_PLACES = 5;

/** Clamping on every keystroke turned "2000" into 100 → 1000 → 10000. The text is free
 * while typing; in-range values are committed at once, the rest are clamped on blur. */
function PlaceRadiusInput({ id, value, onCommit }: { id: string; value: number; onCommit: (radiusM: number) => void }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const parsed = Number(text);
  return (
    <input
      id={id}
      type="number"
      inputMode="numeric"
      min={MIN_PLACE_RADIUS_M}
      max={MAX_PLACE_RADIUS_M}
      step={100}
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        const next = Number(e.target.value);
        if (e.target.value !== "" && next >= MIN_PLACE_RADIUS_M && next <= MAX_PLACE_RADIUS_M) onCommit(next);
      }}
      onBlur={() => {
        const next = text === "" || !Number.isFinite(parsed) ? DEFAULT_PLACE_RADIUS_M : Math.min(MAX_PLACE_RADIUS_M, Math.max(MIN_PLACE_RADIUS_M, parsed));
        setText(String(next));
        if (next !== value) onCommit(next);
      }}
    />
  );
}

/** Источники личного лида — владелец 18.08.2026: агент вручную заводит клиента,
 *  которого привёл сам, а не рекламные каналы (их лиды заводит бот автоматически).
 *  Полный список остаётся у руководства — там ручное занесение бывает и для
 *  каналов (перенос из другой системы, коррекция после ошибки бота). */
const AGENT_SOURCES: readonly (typeof CLIENT_SOURCES)[number][] = ["REFERRAL", "PHONE_CALL", "WALK_IN"];

/**
 * Карточка клиента или продавца — пошагово.
 *
 * ЗАЧЕМ ШАГИ. Раньше это была одна простыня из пятнадцати полей: агент открывал её,
 * видел «Площадь от», «Этаж от», «Этажность дома», «Адрес» — и не понимал, описывает
 * он квартиру клиента или ту, которую клиент ищет (замечание владельца 08.08.2026:
 * «выходит как будто это продавец»). Пять коротких шагов отвечают на этот вопрос
 * заголовком: «Что ищет клиент» ни с чем не спутать.
 *
 * Второе: с телефона простыня не заполнялась вовсе — пятнадцать полей подряд на
 * маленьком экране пролистываются, а не заполняются. Шаг помещается в экран целиком.
 *
 * ЧТО НЕ ИЗМЕНИЛОСЬ. Отправляемые данные и права: те же поля, та же схема
 * (clientCreateSchema/clientUpdateSchema), та же проверка на дубликат. Пошаговые
 * проверки, защита от потери данных, скрытый маской телефон, запасные номера,
 * «Всё равно создать» при дубликате — всё на своих местах.
 *
 * ОБЛИК — ШТОРКА ТЕМЫ 2026. Поля собраны прототипными `.fgrid`/`.fld`/`.lab`, а не
 * общими компонентами `FormField`: те живут ещё в шести формах вне этой задачи
 * (вход, объект, команда), и правка их облика затронула бы экраны, к клиентам
 * отношения не имеющие. Исключение — `PhoneInput`: в нём не облик, а поведение
 * (код страны, разбор вставки, защита от задвоения кода), и переписывать его
 * значило бы потерять функцию. Ему передан пустой класс, чтобы поле оформил
 * прототип (`.fld input`).
 *
 * kind=SELLER — та же форма для вкладки «Продавцы»: в базе одна модель Client,
 * различаются только заголовки и подписи (у продавца это его объект, а не запрос).
 */

const EMPTY_FORM = {
  fullName: "",
  lastName: "",
  phone: "",
  /** Запасные номера — с них клиент тоже может позвонить, см. Client.extraPhones. */
  extraPhones: [] as string[],
  source: "PHONE_CALL" as (typeof CLIENT_SOURCES)[number],
  desiredType: "" as PropertyType | "",
  budgetMin: "",
  budgetMax: "",
  currency: "TJS",
  desiredDistrictId: "",
  desiredRooms: "",
  desiredAreaMin: "",
  desiredFloorMin: "",
  desiredFloorMax: "",
  desiredTotalFloors: "",
  address: "",
  /// Несколько желаемых мест поиска (12.09.2026, docs/geo-match-plan-12-09.md) —
  /// начинаем с пустого списка, как и было решено владельцем: точка на карте
  /// появляется только после «добавить место».
  desiredPlaces: [] as DesiredPlaceForm[],
  requirementsNotes: "",
  isPersonalLead: false,
};

type FormState = typeof EMPTY_FORM;

function toForm(client?: Client): FormState {
  if (!client) return EMPTY_FORM;
  return {
    fullName: client.fullName,
    lastName: client.lastName ?? "",
    phone: client.phone,
    extraPhones: client.extraPhones ?? [],
    source: client.source,
    desiredType: client.desiredType ?? "",
    budgetMin: client.budgetMin ?? "",
    budgetMax: client.budgetMax ?? "",
    currency: client.currency ?? "TJS",
    desiredDistrictId: client.desiredDistrictId ?? "",
    desiredRooms: client.desiredRooms ? String(client.desiredRooms) : "",
    desiredAreaMin: client.desiredAreaMin != null ? String(client.desiredAreaMin) : "",
    desiredFloorMin: client.desiredFloorMin != null ? String(client.desiredFloorMin) : "",
    desiredFloorMax: client.desiredFloorMax != null ? String(client.desiredFloorMax) : "",
    desiredTotalFloors: client.desiredTotalFloors != null ? String(client.desiredTotalFloors) : "",
    address: client.address ?? "",
    desiredPlaces: (client.desiredPlaces ?? []).map((p) => ({
      lat: Number(p.lat),
      lng: Number(p.lng),
      radiusM: p.radiusM,
      label: p.label ?? "",
    })),
    requirementsNotes: client.requirementsNotes ?? "",
    isPersonalLead: client.isPersonalLead ?? false,
  };
}

/** Номер считается набранным, когда в нём девять значащих цифр — ровно то же
 *  правило, что на сервере (clientPhoneSchema). Проверяем здесь, чтобы человек
 *  узнал об опечатке на первом шаге, а не после «Создать». */
function phoneDigits(phone: string): number {
  return phone.replace(/\D/g, "").length;
}

/**
 * Поле прототипа: `.fld` + `.lab` + `.msg`, красная рамка через `.fld.bad`.
 *
 * Обёртка, а не голая разметка на каждое поле: подпись обязана быть связана с
 * полем через `htmlFor`, а подсказка и ошибка — через `aria-describedby`, иначе
 * форму не заполнить с экранного диктора. Пятнадцать раз повторить это руками —
 * пятнадцать возможностей забыть.
 */
function Fld({
  label,
  hint,
  error,
  required,
  children,
}: {
  label: string;
  hint?: string;
  /** Показывается вместо подсказки — два сообщения разом только мешают. */
  error?: string;
  required?: boolean;
  children: (props: { id: string; describedBy?: string; invalid?: boolean }) => ReactNode;
}) {
  const id = useId();
  const messageId = `${id}-msg`;
  const describedBy = error || hint ? messageId : undefined;
  return (
    <div className={error ? "fld bad" : "fld"}>
      <label className="lab" htmlFor={id}>
        {label}
        {required && " *"}
      </label>
      {children({ id, describedBy, invalid: !!error })}
      {(error || hint) && (
        <span className="msg" id={messageId} role={error ? "alert" : undefined}>
          {error ?? hint}
        </span>
      )}
    </div>
  );
}

export function ClientFormModal({
  onClose,
  kind = "BUYER",
  client,
  initialPhone,
}: {
  onClose: () => void;
  kind?: "BUYER" | "SELLER";
  client?: Client;
  /**
   * Номер, с которым форму открыли извне: из наборщика по кнопке «нет в базе —
   * создать карточку» (см. DialPad.tsx, `dialNewClient` прототипа). Только для
   * НОВОЙ карточки — у правки номер берётся из самого клиента.
   */
  initialPhone?: string;
}) {
  const clean = useCleanShell();
  const accountReadOnly = useIsReadOnly();
  const cleanFormId = useId();
  const [validationAttempt, setValidationAttempt] = useState(0);
  const isEdit = !!client;
  /**
   * НОВУЮ КАРТОЧКУ МОЖНО ЗАВЕСТИ И ПРОДАВЦОМ (владелец 23.09.2026). Ярлык
   * «Клиент» и наборщик открывают форму без kind, то есть всегда покупателем, и
   * позвонившего продавца агент руками завести не мог. Переключатель — только у
   * новой карточки: у существующей вид задан ею самой.
   */
  const [newKind, setNewKind] = useState<"BUYER" | "SELLER">(kind);
  const isSeller = (client?.kind ?? newKind) === "SELLER";
  const role = useAuthStore((s) => s.agent?.role);
  const createKey = useRetryKey();
  const create = useCreateClient(createKey);
  const update = useUpdateClient(client?.id ?? "");
  const mutation = isEdit ? update : create;
  const { data: districts } = useDistricts();
  // Радиус по умолчанию для НОВОЙ точки — из Настроек («Подбор объектов»,
  // matchDefaultRadiusM), а не зашитое число. Существующие точки не трогает:
  // читается только в addPlace() ниже, в момент добавления.
  const { data: settings } = useSettings();
  const navigate = useNavigate();

  const [step, setStep] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [existingClient, setExistingClient] = useState<{ id: string; shortId: number; fullName: string } | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [confirmClose, setConfirmClose] = useState(false);
  const [initialForm] = useState(() => {
    const base = toForm(client);
    // Подставляем только в пустое поле новой карточки: у правки номер уже свой,
    // и затирать его тем, что оказалось в наборщике, нельзя.
    return !client && initialPhone && !base.phone ? { ...base, phone: initialPhone } : base;
  });
  const [form, setForm] = useState(initialForm);
  /** Ошибки полей показываем только после попытки уйти дальше: подсвечивать
   *  «введите имя» человеку, который ещё не дошёл до поля, — грубо. */
  const [showErrors, setShowErrors] = useState(false);

  // У агента — сокращённый список источников, но если карточка уже стоит на
  // канале (Instagram и т.п. — завёл бот или руководитель), значение остаётся
  // видимым и выбранным, просто не предлагается заново при создании.
  const sourceOptions = useMemo(() => {
    const base = role === "AGENT" ? AGENT_SOURCES : CLIENT_SOURCES;
    const withCurrent = base.includes(initialForm.source) ? base : [...base, initialForm.source];
    return withCurrent.map((s) => ({ value: s, label: CLIENT_SOURCE_LABELS[s] }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [role]);

  const steps = useMemo(
    () => ["Контакты", isSeller ? "Объект" : "Что ищет", isSeller ? "Цена" : "Бюджет", "Подробности", "Проверьте"],
    [isSeller]
  );
  const lastStep = steps.length - 1;

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  // Защита от потери данных: что-то реально изменилось по сравнению со стартовым
  // состоянием — случайный клик мимо окна или Esc не закрывают его молча.
  const dirty = !isClientDraftUnchanged({ form, newKind }, initialForm, kind, isEdit);

  // Черновик карточки переживает принудительную перезагрузку при автообновлении
  // (находка ночной проверки 24.09.2026, №246/К2-4): без этого пятиминутный
  // потолок ожидания (см. UpdatePrompt.tsx) стирал незафиксированную правку.
  // Ключ — id клиента у правки, вид новой карточки у создания: та же форма,
  // открытая заново после перезагрузки, найдёт свой черновик.
  const draftKey = isEdit ? `client:${client!.id}` : `client-new:${kind}`;
  useDraftBeforeUpdate<ClientFormDraft<FormState>>(
    draftKey,
    { version: 1, form, step, newKind },
    (draft) => {
      // A draft saved by the previous build may lack fields added since.
      setForm({ ...initialForm, ...draft.form });
      setStep(Math.max(0, Math.min(lastStep, draft.step)));
      setNewKind(clientDraftKind(draft, kind));
      toast.success("Восстановлен черновик");
    },
    (v) => isClientDraftUnchanged(v, initialForm, kind, isEdit)
  );

  function closeAndClearDraft() {
    consumeDraftBeforeUpdate(draftKey);
    onClose();
  }

  function requestClose() {
    if (dirty) setConfirmClose(true);
    else closeAndClearDraft();
  }

  /**
   * Телефон закрыт маской — сотрудник его не видит и не редактирует.
   *
   * Считаем по СТАРТОВОМУ значению, а не по текущему: иначе агент, стерев поле,
   * снял бы с себя и запрет, и проверку. Для новой карточки маски быть не может —
   * номер набирает сам создатель.
   */
  const phoneHidden = isEdit && isMaskedClientPhone(initialForm.phone);

  // Проверки по шагам. Ключ — номер шага, значение — что не так с каким полем.
  const stepErrors: Record<number, Partial<Record<keyof FormState, string>>> = {
    0: {
      ...(form.fullName.trim().length < 2 ? { fullName: "Впишите имя, хотя бы две буквы" } : {}),
      // Скрытый номер не проверяем: в маске пять цифр, и проверка «девять цифр»
      // намертво запирала форму — сохранить нельзя было ничего.
      ...(!phoneHidden && phoneDigits(form.phone) < 9
        ? { phone: "В номере должно быть девять цифр после кода страны" }
        : {}),
      // Пустая строка — это «агент открыл поле и передумал», её мы просто выбросим
      // при отправке. А вот недобранный номер — опечатка, и молчать о ней нельзя:
      // запасной номер существует ради узнавания входящего, а по огрызку никого
      // не узнать.
      ...(!phoneHidden && form.extraPhones.some((p) => p.trim() !== "" && phoneDigits(p) < 9)
        ? { extraPhones: "В запасном номере тоже должно быть девять цифр" }
        : {}),
    },
    2: {
      ...(form.budgetMin && form.budgetMax && Number(form.budgetMin) > Number(form.budgetMax)
        ? { budgetMax: "«До» не может быть меньше, чем «от»" }
        : {}),
    },
    3: {
      ...(form.desiredFloorMin && form.desiredFloorMax && Number(form.desiredFloorMin) > Number(form.desiredFloorMax)
        ? { desiredFloorMax: "«До» не может быть меньше, чем «от»" }
        : {}),
    },
  };
  const errorsHere = stepErrors[step] ?? {};
  const err = (key: keyof FormState) => (showErrors ? errorsHere[key] : undefined);
  /** Что мешает сохранить с любого шага — проверяем все шаги сразу, иначе на
   *  «Проверьте» можно было бы сохранить карточку с пустым именем. */
  const blocking = Object.values(stepErrors).flatMap((e) => Object.values(e));

  useEffect(() => {
    if (!clean || validationAttempt === 0) return;
    focusCleanRecordError(cleanFormId);
  }, [clean, cleanFormId, validationAttempt, step]);

  function goTo(next: number) {
    // Вперёд — только через проверку текущего шага; назад и на уже пройденное — свободно.
    if (!accountReadOnly && next > step && Object.keys(errorsHere).length > 0) {
      setShowErrors(true);
      setValidationAttempt(attempt => attempt + 1);
      return;
    }
    setShowErrors(false);
    setError(null);
    setStep(Math.max(0, Math.min(next, lastStep)));
  }

  async function submit(force = false) {
    if (accountReadOnly) { setError("Доступ только для просмотра. Изменения не отправлены."); return; }
    if (blocking.length > 0) {
      setShowErrors(true);
      setStep(Object.keys(stepErrors).map(Number).find((s) => Object.keys(stepErrors[s]).length > 0) ?? 0);
      return;
    }
    setError(null);
    setWarning(null);
    setExistingClient(null);
    try {
      // При редактировании пустое поле означает «очистить», а не «не трогать»:
      // иначе убрать однажды заданный район, бюджет или заметки было бы нельзя.
      // При создании пустое поле по-прежнему просто не отправляем.
      const orNull = <T,>(v: T | undefined) => (isEdit ? (v ?? null) : v);
      const payload = {
        // Имя при правке уходит, только если его поменяли: кому номер скрыт, тот
        // видит имя с «•» или подпись «Покупатель ПК-…», и неизменённое имя
        // переписало бы настоящее (аудит 23.09.2026, №67).
        ...(isEdit && form.fullName === initialForm.fullName ? {} : { fullName: form.fullName.trim() }),
        lastName: form.lastName.trim() || orNull(undefined),
        // Скрытый номер не отправляем совсем: в поле лежит маска. Сервер её тоже
        // отвергает (clientPhoneSchema), но отказом на весь запрос — то есть агент
        // снова не сохранил бы ни имя, ни бюджет. Правильный ответ здесь — не слать
        // поле, которого сотрудник не менял и не мог менять.
        ...(phoneHidden ? {} : { phone: form.phone.trim() }),
        // Запасные номера уходят по тем же правилам, что и главный: маска — не
        // номер, и отправлять её нельзя (сервер отвергнет весь запрос). Пустые
        // строки выбрасываем здесь, а не заставляем агента убирать их руками.
        ...(phoneHidden ? {} : { extraPhones: form.extraPhones.map((p) => p.trim()).filter(Boolean) }),
        // kind берём у самого клиента, а не из пропа: карточка открывается как
        // <ClientFormModal client={client} /> без kind, то есть с дефолтом "BUYER" —
        // и сохранение продавца молча переводило его во вкладку «Клиенты».
        kind: client?.kind ?? newKind,
        // Источник, скрытый правом, приходит пустым — пустой не шлём (№68).
        ...(form.source ? { source: form.source } : {}),
        desiredType: (form.desiredType || orNull(undefined)) as PropertyType | null | undefined,
        budgetMin: form.budgetMin ? Number(form.budgetMin) : orNull(undefined),
        budgetMax: form.budgetMax ? Number(form.budgetMax) : orNull(undefined),
        // Без явной валюты сервер ставил сомони: долларовый бюджет занижался
        // примерно в 11 раз, и подбор предлагал совсем другое жильё.
        currency: form.currency as "TJS" | "USD",
        desiredDistrictId: form.desiredDistrictId || orNull(undefined),
        desiredRooms: form.desiredRooms ? Number(form.desiredRooms) : orNull(undefined),
        desiredAreaMin: form.desiredAreaMin ? Number(form.desiredAreaMin) : orNull(undefined),
        desiredFloorMin: form.desiredFloorMin !== "" ? Number(form.desiredFloorMin) : orNull(undefined),
        desiredFloorMax: form.desiredFloorMax !== "" ? Number(form.desiredFloorMax) : orNull(undefined),
        desiredTotalFloors: form.desiredTotalFloors ? Number(form.desiredTotalFloors) : orNull(undefined),
        address: form.address.trim() || orNull(undefined),
        // Список замещается целиком (см. clientUpdateSchema, @royal-home/shared) —
        // отправляем текущее состояние всегда, а не только при правке: пустой
        // массив на редактировании и есть «мест больше нет».
        desiredPlaces: form.desiredPlaces.map((p) => ({
          lat: p.lat,
          lng: p.lng,
          radiusM: p.radiusM,
          label: p.label.trim() || undefined,
        })),
        requirementsNotes: form.requirementsNotes.trim() || orNull(undefined),
        isPersonalLead: form.isPersonalLead,
      };
      // Проверка на дубликат — только при создании; при редактировании нет
      // смысла предупреждать «уже есть» о самой же этой карточке.
      const result = isEdit ? await update.mutateAsync(payload) : await create.mutateAsync({ ...payload, force });
      const isDuplicateWarning = (r: typeof result): r is ClientDuplicateWarning => !!r && "warning" in r;
      if (isDuplicateWarning(result)) {
        setWarning(result.warning);
        setExistingClient({
          id: result.client.id,
          shortId: result.client.shortId,
          fullName: result.client.fullName,
        });
        return;
      }
      closeAndClearDraft();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        const found = (e.data as { client?: { id: string; shortId: number; fullName: string } })?.client;
        setError(e.message);
        if (found) setExistingClient(found);
        return;
      }
      setError(e instanceof Error ? e.message : isEdit ? "Не удалось сохранить" : "Не удалось создать клиента");
    }
  }

  const districtName = districts?.find((d) => d.id === form.desiredDistrictId)?.name ?? "Любой";

  // Желаемые места (12.09.2026, docs/geo-match-plan-12-09.md) — список пуст,
  // пока агент не нажал «Добавить место»; новая точка стартует в центре
  // выбранного района (или города, если район не выбран), а не «нигде».
  function addPlace() {
    const [lat, lng] = districtCenter(districtName);
    // Пока настройки грузятся — те же «±1-2 км», что и заводское значение
    // matchDefaultRadiusM на сервере (routes/settings.ts), а не старое 1000.
    const radiusM = settings?.matchDefaultRadiusM ?? 1500;
    set("desiredPlaces", [...form.desiredPlaces, { lat, lng, radiusM, label: "" }]);
  }
  function updatePlace(idx: number, patch: Partial<DesiredPlaceForm>) {
    set(
      "desiredPlaces",
      form.desiredPlaces.map((p, i) => (i === idx ? { ...p, ...patch } : p))
    );
  }
  function removePlace(idx: number) {
    set(
      "desiredPlaces",
      form.desiredPlaces.filter((_, i) => i !== idx)
    );
  }

  const money = (v: string) => (v ? formatMoney(v, form.currency as "TJS" | "USD") : "не указано");
  const title = isEdit
    ? isSeller
      ? "Изменить продавца"
      : "Изменить клиента"
    : isSeller
      ? "Новый продавец"
      : "Новый клиент";

  const summary: { label: string; value: string; to: number }[] = [
    { label: "Имя", value: [form.fullName, form.lastName].filter(Boolean).join(" ") || "не указано", to: 0 },
    { label: "Телефон", value: form.phone || "не указано", to: 0 },
    { label: "Откуда", value: CLIENT_SOURCE_LABELS[form.source], to: 0 },
    {
      label: isSeller ? "Объект" : "Ищет",
      value:
        [
          form.desiredType ? PROPERTY_TYPE_LABELS[form.desiredType as PropertyType] : null,
          form.desiredRooms ? `${form.desiredRooms}-комн.` : null,
          districtName,
        ]
          .filter(Boolean)
          .join(", ") || "не указано",
      to: 1,
    },
    {
      label: isSeller ? "Цена" : "Бюджет",
      value: form.budgetMin || form.budgetMax ? `от ${money(form.budgetMin)} до ${money(form.budgetMax)}` : "не указано",
      to: 2,
    },
    {
      label: "Этаж и площадь",
      value:
        [
          form.desiredAreaMin ? `от ${form.desiredAreaMin} м²` : null,
          form.desiredFloorMin || form.desiredFloorMax
            ? `этаж от ${form.desiredFloorMin || "?"} до ${form.desiredFloorMax || "?"}`
            : null,
          form.desiredTotalFloors ? `в доме ${form.desiredTotalFloors}` : null,
        ]
          .filter(Boolean)
          .join(", ") || "не указано",
      to: 3,
    },
    ...(isSeller ? [{ label: "Адрес объекта", value: form.address || "не указано", to: 3 }] : []),
    { label: "Заметки", value: form.requirementsNotes || "не указано", to: 3 },
    ...(form.isPersonalLead ? [{ label: "Личный лид", value: "Да", to: 0 }] : []),
  ];

  return (
    <>
      <Rh2Sheet
        title={title}
        wide
        onClose={requestClose}
        // Клик мимо окна не закрывает форму молча — вопрос о потере данных задаёт
        // requestClose, и он же стоит на Esc, смахивании и кнопке «Закрыть».
        closeOnBackdrop={false}
        // Enter в поле = «Дальше», а на последнем шаге — сохранение: ровно так же,
        // как работали кнопки подвала до переноса облика.
        onSubmit={() => (step < lastStep ? goTo(step + 1) : void submit(false))}
        footer={
          <>
            <button type="button" className="pill ghost" onClick={step > 0 ? () => goTo(step - 1) : requestClose}>
              {step > 0 ? "Назад" : "Отмена"}
            </button>
            {/* При правке существующей карточки сохранить можно с любого шага:
                поправили телефон — не идти же ради этого через все пять экранов. */}
            {isEdit && step < lastStep && (
              <button type="button" className="pill ghost" onClick={() => submit(false)} disabled={accountReadOnly || mutation.isPending}>
                {mutation.isPending ? "Сохранение…" : "Сохранить"}
              </button>
            )}
            {step < lastStep ? (
              <button type="submit" className="pill">
                Дальше
              </button>
            ) : (
              <button type="submit" className="pill" disabled={accountReadOnly || mutation.isPending}>
                {mutation.isPending
                  ? isEdit
                    ? "Сохранение…"
                    : "Создание…"
                  : isEdit
                    ? "Сохранить"
                    : isSeller
                      ? "Создать продавца"
                      : "Создать клиента"}
              </button>
            )}
          </>
        }
      >
        <CleanRecordForm enabled={clean} id={cleanFormId}>
        <ReadOnlyRecordFields readOnly={accountReadOnly}>
        {/* Шкала шагов — и указатель «где я», и навигация: на любой пройденный шаг
            можно вернуться нажатием. `.seg`, а не тонкие полоски прежнего облика:
            у капсулы прототипа высота 44 px, то есть в неё попадают пальцем. */}
        <div className="seg" role="group" aria-label="Шаги формы">
          {steps.map((s, i) => (
            <button key={s} type="button" {...cleanRecordChoiceProps(clean, i === step)} onClick={() => goTo(i)}>
              {s}
            </button>
          ))}
        </div>

        {step === 0 && (
          <>
            {!isEdit && (
              <div className="seg" role="group" aria-label="Кто это" style={{ marginTop: "var(--s4)" }}>
                <button type="button" {...cleanRecordChoiceProps(clean, newKind === "BUYER")} onClick={() => setNewKind("BUYER")}>
                  Покупатель
                </button>
                <button type="button" {...cleanRecordChoiceProps(clean, newKind === "SELLER")} onClick={() => setNewKind("SELLER")}>
                  Продавец
                </button>
              </div>
            )}
            <div className="fgrid" style={{ marginTop: "var(--s4)" }}>
              <Fld label="Имя" required error={err("fullName")}>
                {({ id, describedBy, invalid }) => (
                  <input
                    id={id}
                    autoFocus
                    aria-describedby={describedBy}
                      aria-invalid={clean && invalid ? true : undefined}
                    value={form.fullName}
                    onChange={(e) => set("fullName", e.target.value)}
                  />
                )}
              </Fld>
              <Fld label="Фамилия">
                {({ id }) => <input id={id} value={form.lastName} onChange={(e) => set("lastName", e.target.value)} />}
              </Fld>
            </div>

            {/* НОМЕР СКРЫТ — ЗНАЧИТ И НЕ РЕДАКТИРУЕТСЯ.
                Сотруднику без права clients.viewPhone сервер отдаёт маску
                (+992•••••18), и форма подставляла её в поле как обычное значение:
                проверка требовала девять цифр, находила пять и не давала сохранить
                карточку ВООБЩЕ — ни имя, ни бюджет, ни заметки (жалоба владельца
                10.08.2026). Пройди она — в базу ушла бы сама маска вместо номера. */}
            <div style={{ marginTop: "var(--s3)" }}>
              {phoneHidden ? (
                <Fld
                  label="Телефон"
                  hint="Номер скрыт, его видят только руководители. Связь через кнопку «Позвонить»"
                >
                  {({ id, describedBy, invalid }) => (
                    <input id={id} aria-describedby={describedBy}
                      aria-invalid={clean && invalid ? true : undefined} value={form.phone} readOnly disabled />
                  )}
                </Fld>
              ) : (
                <Fld
                  label="Телефон"
                  required
                  error={err("phone")}
                  hint="Код страны подставляется сам, для другой страны сотрите его и наберите свой"
                >
                  {({ id, describedBy, invalid }) => (
                    <PhoneInput
                      id={id}
                      className=""
                      aria-describedby={describedBy}
                      aria-invalid={clean && invalid ? true : undefined}
                      value={form.phone}
                      onChange={(v) => set("phone", v)}
                    />
                  )}
                </Fld>
              )}
            </div>

            {/* ЗАПАСНЫЕ НОМЕРА (18.08.2026). Клиент звонит со второй симки, когда
                на первой кончились деньги, — и без этого списка CRM его не
                узнавала: заводила новую карточку и отдавала другому агенту.
                Показываем только там, где номер вообще редактируется. Звонить
                отсюда нельзя намеренно — кнопка «Позвонить» в карточке всегда
                набирает ГЛАВНЫЙ номер. */}
            {!phoneHidden && (
              <div style={{ marginTop: "var(--s3)" }}>
                <Fld
                  label="Запасные номера"
                  error={err("extraPhones")}
                  hint="Другие номера этого же клиента. Звоним по основному, а эти нужны, чтобы узнать его звонок"
                >
                  {/* id отдаём первому полю (а если номеров ещё нет — кнопке
                      «Добавить»): подпись ссылается на него через htmlFor, и
                      указывать ею на <div> значило бы сломать её для чтения
                      с экрана. */}
                  {({ id, describedBy, invalid }) => (
                    <>
                      {form.extraPhones.map((value, i) => (
                        <div className="pair" key={i} style={{ marginBottom: "var(--s2)" }}>
                          <PhoneInput
                            id={i === 0 ? id : undefined}
                            className=""
                            aria-describedby={i === 0 ? describedBy : undefined}
                            aria-invalid={clean && invalid ? true : undefined}
                            value={value}
                            aria-label={`Запасной номер ${i + 1}`}
                            onChange={(v) => set("extraPhones", form.extraPhones.map((p, j) => (j === i ? v : p)))}
                          />
                          <button
                            type="button"
                            className="pill ghost sm unit"
                            aria-label={`Убрать запасной номер ${i + 1}`}
                            onClick={() => set("extraPhones", form.extraPhones.filter((_, j) => j !== i))}
                          >
                            Убрать
                          </button>
                        </div>
                      ))}
                      {/* Потолок тот же, что в схеме (@royal-home/shared): десять
                          номеров — предохранитель, а не бизнес-правило. */}
                      {form.extraPhones.length < 10 && (
                        <button
                          type="button"
                          className="pill ghost sm"
                          id={form.extraPhones.length === 0 ? id : undefined}
                          aria-describedby={form.extraPhones.length === 0 ? describedBy : undefined}
                          onClick={() => set("extraPhones", [...form.extraPhones, ""])}
                        >
                          Добавить номер
                        </button>
                      )}
                    </>
                  )}
                </Fld>
              </div>
            )}

            <div style={{ marginTop: "var(--s3)" }}>
              <Fld label="Откуда пришёл">
                {({ id }) => (
                  <select
                    id={id}
                    value={form.source}
                    onChange={(e) => set("source", e.target.value as (typeof CLIENT_SOURCES)[number])}
                  >
                    {sourceOptions.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                )}
              </Fld>
            </div>

            <label className="chk">
              <input
                type="checkbox"
                checked={form.isPersonalLead}
                onChange={(e) => set("isPersonalLead", e.target.checked)}
              />
              Личный лид: {isSeller ? "продавца" : "клиента"} привёл я сам
            </label>
            <p className="state">
              Не через каналы компании. За заполненную карточку начисляются баллы KPI.
            </p>
          </>
        )}

        {step === 1 && (
          <>
            <p className="state">
              {isSeller
                ? "Что человек продаёт. По этим данным его объект найдут покупатели."
                : "Что человек ищет. По этим данным CRM подбирает ему объекты, чем точнее, тем меньше пустых показов."}
            </p>

            <div className="sec-t">{isSeller ? "Тип объекта" : "Какое жильё ищет"}</div>
            <div className="seg" role="group" aria-label={isSeller ? "Тип объекта" : "Какое жильё ищет"}>
              {PROPERTY_TYPES.map((t) => (
                <button
                  key={t}
                  type="button"
                  {...cleanRecordChoiceProps(clean, form.desiredType === t)}
                  onClick={() => set("desiredType", form.desiredType === t ? "" : t)}
                >
                  {PROPERTY_TYPE_LABELS[t]}
                </button>
              ))}
            </div>

            <div className="sec-t">Комнат</div>
            <div className="seg" role="group" aria-label="Комнат">
              {[1, 2, 3, 4, 5].map((n) => (
                <button
                  key={n}
                  type="button"
                  {...cleanRecordChoiceProps(clean, form.desiredRooms === String(n))}
                  onClick={() => set("desiredRooms", form.desiredRooms === String(n) ? "" : String(n))}
                >
                  {n === 5 ? "5 и больше" : `${n}-комн.`}
                </button>
              ))}
              <button type="button" {...cleanRecordChoiceProps(clean, form.desiredRooms === "")} onClick={() => set("desiredRooms", "")}>
                Не важно
              </button>
            </div>

            <div style={{ marginTop: "var(--s4)" }} />
            <Fld label={isSeller ? "Район объекта" : "Желаемый район"}>
              {({ id }) => (
                <select
                  id={id}
                  value={form.desiredDistrictId}
                  onChange={(e) => set("desiredDistrictId", e.target.value)}
                >
                  <option value="">Любой</option>
                  {(districts ?? []).map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </select>
              )}
            </Fld>

            {/* Несколько желаемых мест поиска (12.09.2026, docs/geo-match-plan-12-09.md) —
                фундамент под гео-подбор: покупатель часто называет два-три места сразу
                («ищу у ЦУМа или в 82-м микрорайоне»), одна точка с радиусом это не
                покрывает. Список пуст по умолчанию — карта появляется только после
                «Добавить место». */}
            <div className="sec-t" style={{ marginTop: "var(--s4)" }}>
              Где ищет (необязательно)
            </div>
            <p className="state">
              Отметьте на карте одно или несколько мест — позже по ним будут находиться подходящие объекты в радиусе.
            </p>
            {form.desiredPlaces.map((place, idx) => (
              <div className="card" key={idx} style={{ marginTop: 8, padding: 12 }}>
                <div className="pair" style={{ marginBottom: 8 }}>
                  <input
                    className="inp"
                    placeholder={`Название места (например, «ЦУМ»)`}
                    aria-label={`Название места ${idx + 1}`}
                    value={place.label}
                    onChange={(e) => updatePlace(idx, { label: e.target.value })}
                  />
                  <button
                    type="button"
                    className="pill ghost sm unit"
                    aria-label={`Убрать место ${idx + 1}`}
                    onClick={() => removePlace(idx)}
                  >
                    Убрать
                  </button>
                </div>
                <LocationPicker
                  value={{ lat: place.lat, lng: place.lng }}
                  onChange={(coords) => updatePlace(idx, coords)}
                  districtName={districtName}
                  radiusM={place.radiusM}
                />
                <div style={{ marginTop: 8 }}>
                  <Fld label="Радиус поиска, м">
                    {({ id }) => (
                      <PlaceRadiusInput id={id} value={place.radiusM} onCommit={(radiusM) => updatePlace(idx, { radiusM })} />
                    )}
                  </Fld>
                </div>
              </div>
            ))}
            {/* Потолок пять мест (@royal-home/shared, desiredPlaceSchema) — предохранитель,
                не бизнес-правило: столько ориентиров за один разговор клиент называет
                разве что в порядке исключения. */}
            {form.desiredPlaces.length < MAX_DESIRED_PLACES && (
              <button type="button" className="pill ghost sm" style={{ marginTop: 8 }} onClick={addPlace}>
                + Добавить место
              </button>
            )}
          </>
        )}

        {step === 2 && (
          <>
            <div className="sec-t">Валюта</div>
            <div className="seg" role="group" aria-label="Валюта">
              <button type="button" {...cleanRecordChoiceProps(clean, form.currency === "TJS")} onClick={() => set("currency", "TJS")}>
                Сомони
              </button>
              <button type="button" {...cleanRecordChoiceProps(clean, form.currency === "USD")} onClick={() => set("currency", "USD")}>
                Доллары
              </button>
            </div>
            <p className="state">
              По валюте подбираются объекты: долларовая сумма, записанная как сомони, занижается примерно в 11 раз.
            </p>

            <div className="fgrid" style={{ marginTop: "var(--s3)" }}>
              <Fld label={isSeller ? "Цена от" : "Бюджет от"}>
                {({ id }) => (
                  <input
                    id={id}
                    type="number"
                    inputMode="numeric"
                    value={form.budgetMin}
                    onChange={(e) => set("budgetMin", e.target.value)}
                  />
                )}
              </Fld>
              <Fld label={isSeller ? "Цена до" : "Бюджет до"} error={err("budgetMax")}>
                {({ id, describedBy, invalid }) => (
                  <input
                    id={id}
                    type="number"
                    inputMode="numeric"
                    aria-describedby={describedBy}
                      aria-invalid={clean && invalid ? true : undefined}
                    value={form.budgetMax}
                    onChange={(e) => set("budgetMax", e.target.value)}
                  />
                )}
              </Fld>
            </div>
            <p className="state">
              Точная сумма не обязательна, хватит и одной границы. Пустой бюджет тоже допустим: клиент часто называет
              его только на просмотре.
            </p>
          </>
        )}

        {step === 3 && (
          <>
            {/* Площадь и этаж — то, что клиент ИЩЕТ, а не то, чем владеет.
                Именно из-за этих полей форма читалась как карточка продавца
                (замечание владельца 08.08.2026), поэтому здесь они подписаны
                явно и стоят отдельным шагом. */}
            <p className="state">
              {isSeller
                ? "Характеристики его объекта."
                : "Необязательно. Самая частая просьба: «не первый и не последний этаж»."}
            </p>
            <div className="fgrid">
              <Fld label={isSeller ? "Площадь, м²" : "Площадь от, м²"}>
                {({ id }) => (
                  <input
                    id={id}
                    type="number"
                    inputMode="numeric"
                    min={1}
                    value={form.desiredAreaMin}
                    onChange={(e) => set("desiredAreaMin", e.target.value)}
                  />
                )}
              </Fld>
              <Fld label={isSeller ? "Этажей в доме" : "Этажность дома"}>
                {({ id }) => (
                  <input
                    id={id}
                    type="number"
                    inputMode="numeric"
                    min={1}
                    value={form.desiredTotalFloors}
                    onChange={(e) => set("desiredTotalFloors", e.target.value)}
                  />
                )}
              </Fld>
              <Fld label="Этаж от">
                {({ id }) => (
                  <input
                    id={id}
                    type="number"
                    inputMode="numeric"
                    min={0}
                    value={form.desiredFloorMin}
                    onChange={(e) => set("desiredFloorMin", e.target.value)}
                  />
                )}
              </Fld>
              <Fld label="Этаж до" error={err("desiredFloorMax")}>
                {({ id, describedBy, invalid }) => (
                  <input
                    id={id}
                    type="number"
                    inputMode="numeric"
                    min={0}
                    aria-describedby={describedBy}
                      aria-invalid={clean && invalid ? true : undefined}
                    value={form.desiredFloorMax}
                    onChange={(e) => set("desiredFloorMax", e.target.value)}
                  />
                )}
              </Fld>
            </div>

            {/* Адрес — только у продавца: это адрес объекта, который он продаёт,
                без него карточку не свести с покупателем. У покупателя такого поля
                больше нет (владелец 08.08.2026: «странный вопрос, типа предложить
                рядом»). */}
            {isSeller && (
              <div style={{ marginTop: "var(--s3)" }}>
                <Fld label="Адрес объекта" hint="Где находится то, что он продаёт">
                  {({ id, describedBy, invalid }) => (
                    <input
                      id={id}
                      aria-describedby={describedBy}
                      aria-invalid={clean && invalid ? true : undefined}
                      maxLength={300}
                      value={form.address}
                      onChange={(e) => set("address", e.target.value)}
                    />
                  )}
                </Fld>
              </div>
            )}

            <div style={{ marginTop: "var(--s3)" }}>
              <Fld label={isSeller ? "Об объекте" : "Что ещё важно"}>
                {({ id }) => (
                  <textarea
                    id={id}
                    value={form.requirementsNotes}
                    onChange={(e) => set("requirementsNotes", e.target.value)}
                    placeholder={
                      isSeller
                        ? "Состояние, ремонт, документы, срочность…"
                        : "Своими словами: с кем живёт, чего боится, что важно"
                    }
                  />
                )}
              </Fld>
            </div>
          </>
        )}

        {step === 4 && (
          <div className="list">
            {summary.map((r) => (
              <div key={r.label} className="row wrapt">
                <div className="t">
                  <b>{r.value}</b>
                  <span>{r.label}</span>
                </div>
                <div className="act">
                  <button type="button" className="pill ghost sm" onClick={() => goTo(r.to)}>
                    Изменить
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {error && (
          <p className="quiet crit" role="alert">
            <span className="dot crit" />
            <span className="txt">
              {error}
              {/*
                ВТОРАЯ КВАРТИРА ОДНОГО ПРОДАВЦА — ЧАСТЫЙ СЛУЧАЙ, А ВЫГЛЯДЕЛ ТУПИКОМ.
                Продавец приносит второй объект, агент идёт заводить вторую заявку и
                получает «клиент с таким телефоном уже существует» — и понимает это
                как «в CRM нельзя дать продавцу несколько объектов». Можно: объектов
                на карточке сколько угодно, карточка на человека одна (телефон
                уникален глобально — на нём держится склейка переписки, звонков и
                истории). Отказ обязан говорить, что делать дальше.
              */}
              {isSeller && existingClient && (
                <>
                  {" "}
                  Второй и третий объект добавляются на эту же карточку: откройте её и нажмите «Создать объект из
                  заявки»: сколько объектов у продавца, столько раз.
                </>
              )}
            </span>
            {existingClient && (
              <button
                type="button"
                className="pill ghost sm"
                onClick={() => navigate(`/clients/${existingClient.shortId}`)}
              >
                Открыть {existingClient.fullName}
              </button>
            )}
          </p>
        )}

        {warning && (
          <p className="quiet warn">
            <span className="dot warn" />
            <span className="txt">{warning}</span>
            {existingClient && (
              <button
                type="button"
                className="pill ghost sm"
                onClick={() => navigate(`/clients/${existingClient.shortId}`)}
              >
                Открыть карточку
              </button>
            )}
            <button type="button" className="pill ghost sm" onClick={() => submit(true)} disabled={accountReadOnly || mutation.isPending}>
              Всё равно создать
            </button>
          </p>
        )}
        </ReadOnlyRecordFields>
        </CleanRecordForm>
      </Rh2Sheet>

      {confirmClose && (
        <ConfirmDialog
          title="Закрыть без сохранения?"
          description="Введённые данные будут потеряны."
          confirmLabel="Закрыть"
          onConfirm={closeAndClearDraft}
          onCancel={() => setConfirmClose(false)}
        />
      )}
    </>
  );
}
