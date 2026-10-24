import { useMemo, useRef, useState } from "react";
import { useServerSyncedFields } from "../../hooks/useServerSyncedForm";
import { Building2, Pencil, Trash2, Eye, EyeOff, X } from "lucide-react";
import { useDistricts, useCreateDistrict } from "../../hooks/useDistricts";
import { useSettings, useUpdateSettings, useUploadLogo } from "../../hooks/useSettings";
import {
  useLandmarks,
  useCreateLandmark,
  useUpdateLandmark,
  useHideLandmark,
  useShowLandmark,
  useDeleteLandmark,
  useAddLandmarkAlias,
  useRemoveLandmarkAlias,
} from "../../hooks/useLandmarks";
import { useCan } from "../../lib/permissions";
import { useMobileUx } from "../../hooks/useMobileUx";
import { LocationPicker } from "../../components/LocationPicker";
import type { Landmark } from "../../types";
import type { LandmarkUpdateInput } from "@royal-home/shared";
import { landmarkPatchFromForm } from "../../lib/landmarkPatch";
import { Pagination } from "../../components/Pagination";
import { useAccumulatedPages } from "../../hooks/useAccumulatedPages";

/**
 * Вкладка «Агентство»: как агентство называется и выглядит, плюс справочник районов.
 *
 * Разметка — дословно эталон темы «Royal Home 2026»
 * (docs/pult/theme-2026/screens/settings.html, раздел «Агентство»): карточка
 * `.card` с шапкой `.sec-h.stack`, шапка компании `.prof-h`, поля `.fgrid`/`.fld`,
 * районы — чипы `.chip` и строка добавления `.wrap` с `.inp`.
 */

export function CompanySection() {
  const { data: settings } = useSettings();
  const updateSettings = useUpdateSettings();
  const uploadLogo = useUploadLogo();
  const [name, setName] = useState("");
  const [slogan, setSlogan] = useState("");
  const [logoError, setLogoError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useServerSyncedFields(settings && { name: settings.companyName, slogan: settings.companySlogan ?? "" }, {
    name: [name, setName],
    slogan: [slogan, setSlogan],
  }, settings);

  async function handleSaveName(e: React.FormEvent) {
    e.preventDefault();
    /* Оба поля заполняются только внутри `if (settings)`. Без ответа сервера
       слоган пуст, и сохранение имени СТИРАЛО БЫ его (одна мутация пишет оба
       поля сразу) — аудит 22.08.2026, раунд 6. */
    if (!settings) return;
    if (!name.trim()) return;
    await updateSettings.mutateAsync({ companyName: name.trim(), companySlogan: slogan.trim() });
  }

  async function handleLogoChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setLogoError(null);
    try {
      await uploadLogo.mutateAsync(file);
    } catch (err) {
      setLogoError(err instanceof Error ? err.message : "Не удалось загрузить логотип");
    } finally {
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  return (
    <section className="card">
      <div className="sec-h stack">
        <h2>Компания</h2>
        <span className="note">Название и логотип видны клиентам на сайте и в письмах</span>
      </div>

      <div className="prof-h" style={{ alignItems: "flex-start" }}>
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          title="Загрузить логотип"
          aria-label="Загрузить логотип"
          className="av lg"
          style={{
            background: "var(--soft)",
            color: "var(--gold)",
            borderRadius: "var(--r-sm)",
            border: "1px dashed var(--line-strong)",
            overflow: "hidden",
            cursor: "pointer",
            padding: 0,
          }}
        >
          {settings?.companyLogoUrl ? (
            <img
              src={settings.companyLogoUrl}
              alt="Логотип"
              style={{ width: "100%", height: "100%", objectFit: "contain" }}
            />
          ) : (
            <Building2 className="i lg" aria-hidden="true" />
          )}
        </button>
        <input ref={fileRef} type="file" accept="image/*" style={{ display: "none" }} onChange={handleLogoChange} />
        <div className="who">
          <button
            className="pill ghost sm"
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={uploadLogo.isPending}
          >
            {uploadLogo.isPending ? "Загрузка..." : "Загрузить логотип"}
          </button>
          <p className="sub" style={{ marginTop: 8 }}>
            PNG или SVG, квадратный, до 10 МБ
          </p>
          {logoError && (
            <div className="quiet crit" role="alert">
              <span className="dot crit" />
              <span className="txt">{logoError}</span>
            </div>
          )}
        </div>
      </div>

      <form onSubmit={handleSaveName} className="fgrid" style={{ marginTop: 20 }}>
        <label className="fld">
          <span className="lab">Название агентства</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Royal Home" />
        </label>
        <label className="fld">
          <span className="lab">Слоган под названием</span>
          <input
            value={slogan}
            onChange={(e) => setSlogan(e.target.value)}
            placeholder="Агентство недвижимости"
            maxLength={120}
          />
        </label>
        <div className="wide wrap">
          <button className="pill ghost" type="submit" disabled={updateSettings.isPending || !name.trim()}>
            Сохранить
          </button>
          {updateSettings.isSuccess && <span className="saved on">Сохранено</span>}
        </div>
      </form>
    </section>
  );
}

export function DistrictsSection() {
  const { data: districts } = useDistricts();
  const createDistrict = useCreateDistrict();
  const [name, setName] = useState("");

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    await createDistrict.mutateAsync(name.trim());
    setName("");
  }

  return (
    <section className="card">
      <div className="sec-h stack">
        <h2>Районы</h2>
        <span className="note">Справочник для карточек объектов и фильтров</span>
      </div>
      <div className="wrap">
        {districts?.map((d) => (
          <span className="chip" key={d.id}>
            {d.name}
          </span>
        ))}
      </div>
      <form onSubmit={handleAdd} className="wrap" style={{ marginTop: 16 }}>
        <input
          className="inp"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Новый район"
          aria-label="Новый район"
        />
        <button className="pill ghost" type="submit" disabled={createDistrict.isPending}>
          Добавить
        </button>
      </form>
      <div className="quiet" style={{ marginTop: 12 }}>
        <span className="dot" />
        <span className="txt">Район, по которому есть объекты, удалить нельзя: сначала перенесите объекты.</span>
      </div>
    </section>
  );
}

/** Категории, встречающиеся в купленном слое (блок B, docs/geo-match-plan-12-09.md) —
 *  только подсказка для автодополнения, не enum: категория остаётся свободной
 *  строкой (см. докстринг Landmark.category в schema.prisma). Дополняется тем, что
 *  реально пришло с текущей страницей списка. Написание — как в источнике («ВУЗ»,
 *  «Торговый центр»), чтобы новый ориентир агента не заводил вторую категорию;
 *  фильтр и веса и так понимают оба написания (apps/api/src/lib/landmarkCategory.ts). */
const LANDMARK_CATEGORY_HINTS = [
  "Школа",
  "Стадион",
  "ВУЗ",
  "Больница",
  "Госучреждение",
  "Гостиница",
  "Памятник",
  "Базар",
  "Мечеть",
  "Парк",
  "Торговый центр",
  "Театр",
];

interface LandmarkFormValue {
  name: string;
  category: string;
  address: string;
  radiusM: string;
  point: { lat: number; lng: number } | null;
  /** 0/50/100 — «обычный»/«важный»/«очень важный» (дополнение владельца
   *  12.09.2026): решает, какой ОДИН ориентир рядом назвал бы местный (см.
   *  apps/api/src/lib/landmarkPick.ts). */
  weight: 0 | 50 | 100;
  isCityCenter: boolean;
}

/** Подписи значимости — простой выбор вместо произвольного числа (решение
 *  владельца: экран не должен спрашивать очки, только «насколько важно»). */
const LANDMARK_WEIGHT_LABELS: Record<0 | 50 | 100, string> = {
  0: "Обычный",
  50: "Важный",
  100: "Очень важный",
};

function emptyLandmarkForm(): LandmarkFormValue {
  return { name: "", category: "", address: "", radiusM: "", point: null, weight: 0, isCityCenter: false };
}

function landmarkToForm(lm: Landmark): LandmarkFormValue {
  return {
    name: lm.name,
    category: lm.category,
    address: lm.address ?? "",
    radiusM: lm.radiusM != null ? String(lm.radiusM) : "",
    point: { lat: Number(lm.lat), lng: Number(lm.lng) },
    weight: (lm.weight === 50 || lm.weight === 100 ? lm.weight : 0) as 0 | 50 | 100,
    isCityCenter: lm.isCityCenter,
  };
}

/** Поля формы ориентира — общие для «добавить» и «править» (правка названия,
 *  категории, радиуса, точки — булавкой на карте, см. LocationPicker). */
function LandmarkFields({
  value,
  onChange,
}: {
  value: LandmarkFormValue;
  onChange: (patch: Partial<LandmarkFormValue>) => void;
}) {
  return (
    <>
      <label className="fld">
        <span className="lab">Название</span>
        <input
          value={value.name}
          onChange={(e) => onChange({ name: e.target.value })}
          placeholder="ЦУМ"
          maxLength={200}
        />
      </label>
      <label className="fld">
        <span className="lab">Категория</span>
        <input
          className="inp"
          list="landmark-category-hints"
          value={value.category}
          onChange={(e) => onChange({ category: e.target.value })}
          placeholder="Базар"
          maxLength={80}
        />
      </label>
      <label className="fld">
        <span className="lab">Адрес (необязательно)</span>
        <input
          value={value.address}
          onChange={(e) => onChange({ address: e.target.value })}
          placeholder="пр. Рудаки, …"
          maxLength={300}
        />
      </label>
      <label className="fld">
        <span className="lab">Радиус, м (насколько широко люди понимают название)</span>
        <input
          className="inp"
          type="number"
          min={1}
          max={20000}
          value={value.radiusM}
          onChange={(e) => onChange({ radiusM: e.target.value })}
          placeholder="400"
        />
      </label>
      <label className="fld">
        <span className="lab">Значимость (какой ориентир назвал бы местный)</span>
        <select
          className="inp"
          value={value.weight}
          onChange={(e) => onChange({ weight: Number(e.target.value) as 0 | 50 | 100 })}
        >
          {([0, 50, 100] as const).map((w) => (
            <option key={w} value={w}>
              {LANDMARK_WEIGHT_LABELS[w]}
            </option>
          ))}
        </select>
      </label>
      <label className="fld" style={{ flexDirection: "row", alignItems: "center", gap: "var(--s2)" }}>
        <input type="checkbox" checked={value.isCityCenter} onChange={(e) => onChange({ isCityCenter: e.target.checked })} />
        <span className="lab" style={{ margin: 0 }}>
          Центр города
        </span>
      </label>
      <div className="wide fld">
        <span className="lab">Точка на карте — тащите булавку или кликните</span>
        <LocationPicker
          value={value.point}
          onChange={(point) => onChange({ point })}
          radiusM={value.radiusM ? Number(value.radiusM) : null}
        />
      </div>
    </>
  );
}

/** Форма + кнопки сохранить/отмена — тело одинаковое что инлайн (ПК), что в
 *  диалоге (телефон, см. LandmarksSection). */
function LandmarkForm({
  initial,
  submitLabel,
  pending,
  onSubmit,
  onCancel,
}: {
  initial: LandmarkFormValue;
  submitLabel: string;
  pending: boolean;
  onSubmit: (value: LandmarkFormValue) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const canSubmit = value.name.trim().length > 0 && value.category.trim().length > 0 && value.point != null;

  return (
    <div className="fgrid" style={{ marginTop: "var(--s4)" }}>
      <LandmarkFields value={value} onChange={(patch) => setValue((v) => ({ ...v, ...patch }))} />
      <div className="wide wrap">
        <button className="pill" type="button" disabled={pending || !canSubmit} onClick={() => onSubmit(value)}>
          {pending ? "Сохраняю…" : submitLabel}
        </button>
        <button className="pill ghost" type="button" onClick={onCancel}>
          Отмена
        </button>
      </div>
    </div>
  );
}

/** На телефоне форма (особенно с картой) удобнее шторкой во весь экран, чем
 *  вставкой в узкую колонку — та же карточка `.card`, что и остальные окна
 *  CRM (см. RestorePointsSection), `role="dialog"` даёт CSS-поведение шторки
 *  само (правила на `[role="dialog"]`, useMobileUx.ts). */
function LandmarkFormDialog({
  titleId,
  title,
  children,
  onClose,
}: {
  titleId: string;
  title: string;
  children: React.ReactNode;
  onClose: () => void;
}) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 50,
        background: "var(--overlay)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "var(--s4)",
      }}
    >
      <div className="card" style={{ width: "100%", maxWidth: 480, maxHeight: "90vh", overflowY: "auto" }}>
        <div className="sec-h stack">
          <h2 id={titleId}>{title}</h2>
          <button className="pill ghost sm" type="button" onClick={onClose} aria-label="Закрыть">
            <X className="i" aria-hidden="true" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

/** Одна строка списка: название, категория, радиус, синонимы-чипы, действия.
 *  Правка — тем же телом формы, что добавление; на ПК разворачивается прямо
 *  под строкой, на телефоне — тем же диалогом-шторкой (useMobileUx). */
function LandmarkRow({
  landmark,
  canManage,
  mobile,
  editing,
  onToggleEdit,
  onSave,
  savePending,
}: {
  landmark: Landmark;
  canManage: boolean;
  mobile: boolean;
  editing: boolean;
  onToggleEdit: () => void;
  onSave: (patch: LandmarkUpdateInput) => void;
  savePending: boolean;
}) {
  const hideLandmark = useHideLandmark();
  const showLandmark = useShowLandmark();
  const deleteLandmark = useDeleteLandmark();
  const addAlias = useAddLandmarkAlias();
  const removeAlias = useRemoveLandmarkAlias();
  const [aliasText, setAliasText] = useState("");
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  function submitAlias(e: React.FormEvent) {
    e.preventDefault();
    if (!aliasText.trim()) return;
    addAlias.mutate(
      { landmarkId: landmark.id, text: aliasText.trim() },
      { onSuccess: () => setAliasText("") }
    );
  }

  function handleSave(value: LandmarkFormValue) {
    if (!value.point) return;
    onSave(landmarkPatchFromForm({ ...value, point: value.point }));
  }

  const editForm = (
    <LandmarkForm
      initial={landmarkToForm(landmark)}
      submitLabel="Сохранить"
      pending={savePending}
      onSubmit={handleSave}
      onCancel={onToggleEdit}
    />
  );

  return (
    <div>
      <div className="row" style={{ opacity: landmark.enabled ? 1 : 0.55 }}>
        <div className="t">
          <b style={{ display: "flex", alignItems: "center", gap: "var(--s2)", flexWrap: "wrap" }}>
            <span>{landmark.name}</span>
            <span className="chip">{landmark.category}</span>
            {landmark.radiusM != null && <span className="chip">{landmark.radiusM} м</span>}
            {landmark.weight > 0 && (
              <span className="chip">{landmark.weight >= 100 ? "очень важный" : "важный"}</span>
            )}
            {landmark.isCityCenter && <span className="chip">центр города</span>}
            {landmark.mentions > 0 && <span className="chip">упоминаний: {landmark.mentions}</span>}
            {landmark.source === "agent" && <span className="chip ok">добавлено агентом</span>}
            {!landmark.enabled && <span className="chip crit">скрыто</span>}
          </b>
          <span style={{ display: "flex", flexWrap: "wrap", gap: "var(--s1)" }}>
            {landmark.aliases.map((a) => (
              <span className="chip" key={a.id}>
                {a.text}
                <button
                  type="button"
                  aria-label={`Убрать синоним «${a.text}»`}
                  onClick={() => removeAlias.mutate({ landmarkId: landmark.id, aliasId: a.id })}
                  style={{ marginLeft: 4, lineHeight: 0 }}
                >
                  <X className="i" style={{ width: 12, height: 12 }} aria-hidden="true" />
                </button>
              </span>
            ))}
          </span>
        </div>
        <div className="act">
          <button className="pill ghost sm" type="button" title="Править" aria-label="Править" onClick={onToggleEdit}>
            <Pencil className="i" aria-hidden="true" />
          </button>
          {canManage && landmark.enabled && (
            <button
              className="pill ghost sm"
              type="button"
              title="Скрыть"
              aria-label="Скрыть"
              onClick={() => hideLandmark.mutate(landmark.id)}
              disabled={hideLandmark.isPending}
            >
              <EyeOff className="i" aria-hidden="true" />
            </button>
          )}
          {canManage && !landmark.enabled && (
            <button
              className="pill ghost sm"
              type="button"
              title="Вернуть из скрытых"
              aria-label="Вернуть из скрытых"
              onClick={() => showLandmark.mutate(landmark.id)}
              disabled={showLandmark.isPending}
            >
              <Eye className="i" aria-hidden="true" />
            </button>
          )}
          {canManage && landmark.source === "agent" && (
            <button
              className="pill ghost sm"
              type="button"
              title="Удалить"
              aria-label="Удалить"
              onClick={() => setConfirmingDelete(true)}
              disabled={deleteLandmark.isPending}
            >
              <Trash2 className="i" aria-hidden="true" />
            </button>
          )}
        </div>
      </div>

      <form onSubmit={submitAlias} className="wrap" style={{ marginTop: 4, marginLeft: "var(--s2)" }}>
        <input
          className="inp"
          value={aliasText}
          onChange={(e) => setAliasText(e.target.value)}
          placeholder="Добавить синоним («82 мкр»)"
          aria-label={`Добавить синоним для «${landmark.name}»`}
        />
        <button className="pill ghost sm" type="submit" disabled={addAlias.isPending || !aliasText.trim()}>
          Добавить
        </button>
      </form>

      {editing && (mobile ? (
        <LandmarkFormDialog titleId={`landmark-edit-${landmark.id}`} title={`Править «${landmark.name}»`} onClose={onToggleEdit}>
          {editForm}
        </LandmarkFormDialog>
      ) : (
        editForm
      ))}

      {confirmingDelete && (
        <LandmarkFormDialog
          titleId={`landmark-delete-${landmark.id}`}
          title={`Удалить «${landmark.name}»?`}
          onClose={() => setConfirmingDelete(false)}
        >
          <div className="quiet" style={{ marginTop: 8 }}>
            <span className="dot warn" />
            <span className="txt">Отменить нельзя. Синонимы ориентира удалятся вместе с ним.</span>
          </div>
          <div className="wrap" style={{ marginTop: "var(--s4)" }}>
            <button className="pill ghost" type="button" onClick={() => setConfirmingDelete(false)}>
              Отмена
            </button>
            <button
              className="pill"
              type="button"
              disabled={deleteLandmark.isPending}
              onClick={() => deleteLandmark.mutate(landmark.id, { onSuccess: () => setConfirmingDelete(false) })}
            >
              {deleteLandmark.isPending ? "Удаляю…" : "Удалить"}
            </button>
          </div>
        </LandmarkFormDialog>
      )}
    </div>
  );
}

/**
 * СПРАВОЧНИК ОРИЕНТИРОВ — блок J (docs/geo-match-plan-12-09.md, решение
 * владельца 12.09.2026). Купленный слой не знает народных названий («ЦУМ»,
 * «Садбарг», «Овир» — ноль совпадений) и не будет: он institutional по
 * природе. Верхний слой ведут агенты — этот экран им и служит, устройство по
 * образцу DistrictsSection выше (useQuery/useMutation + invalidateQueries).
 *
 * Заводить и править может любой сотрудник — право `landmarks.manage` гейтит
 * только скрытие и удаление (кнопки ниже просто не рисуются без него; сервер
 * проверяет это же право сам, кнопка — не защита).
 */
export function LandmarksSection() {
  const can = useCan();
  const canManage = can("landmarks.manage");
  const mobile = useMobileUx();

  const [q, setQ] = useState("");
  const [category, setCategory] = useState("");
  const [showHidden, setShowHidden] = useState(false);
  /**
   * «ПОКАЗАТЬ ЕЩЁ» (02.10.2026). Сервер и раньше отдавал страницы, а экран брал
   * первые пятьдесят и молчал об остальных. Страница привязана к фильтру
   * (`listKey`): сменили поиск, категорию или «скрытые» — лента с первой
   * страницы, без отдельного сброса в каждом обработчике.
   */
  const filters = { q: q.trim() || undefined, category: category.trim() || undefined, showHidden };
  const listKey = JSON.stringify(filters);
  const [paging, setPaging] = useState({ key: listKey, page: 1 });
  const page = paging.key === listKey ? paging.page : 1;
  const { data, isLoading, isFetching } = useLandmarks({ ...filters, page, pageSize: LANDMARKS_PAGE_SIZE });
  // Свежая первая страница, пока пролистано дальше неё (аудит №38, useAccumulatedPages).
  const { data: headPage } = useLandmarks(
    { ...filters, page: 1, pageSize: LANDMARKS_PAGE_SIZE },
    { enabled: page > 1 }
  );
  const items = useAccumulatedPages(data?.items, page, listKey, headPage?.items);

  const categoryHints = useMemo(() => {
    const seen = new Set<string>(LANDMARK_CATEGORY_HINTS);
    items.forEach((i) => seen.add(i.category));
    return [...seen].sort();
  }, [items]);

  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const createLandmark = useCreateLandmark();
  const updateLandmark = useUpdateLandmark();

  function handleCreate(value: LandmarkFormValue) {
    if (!value.point) return;
    createLandmark.mutate(
      {
        name: value.name.trim(),
        category: value.category.trim(),
        address: value.address.trim() || undefined,
        radiusM: value.radiusM ? Number(value.radiusM) : undefined,
        lat: value.point.lat,
        lng: value.point.lng,
        weight: value.weight,
        isCityCenter: value.isCityCenter,
      },
      { onSuccess: () => setAdding(false) }
    );
  }

  const addForm = (
    <LandmarkForm
      initial={emptyLandmarkForm()}
      submitLabel="Добавить"
      pending={createLandmark.isPending}
      onSubmit={handleCreate}
      onCancel={() => setAdding(false)}
    />
  );

  return (
    <section className="card">
      <div className="sec-h stack">
        <h2>Ориентиры</h2>
        <span className="note">
          Народные названия, которых нет в купленном слое («ЦУМ», «Садбарг», «Овир»). Заводит и правит любой
          сотрудник — синонимы делают справочник рабочим для бота и подбора.
        </span>
      </div>

      <datalist id="landmark-category-hints">
        {categoryHints.map((c) => (
          <option key={c} value={c} />
        ))}
      </datalist>

      <div className="wrap" style={{ marginTop: 8 }}>
        <input
          className="inp"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Поиск по названию или синониму"
          aria-label="Поиск ориентиров"
          style={{ minWidth: 220 }}
        />
        <input
          className="inp"
          list="landmark-category-hints"
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          placeholder="Категория"
          aria-label="Фильтр по категории"
          style={{ maxWidth: 180 }}
        />
        <button
          className="pill ghost sm"
          type="button"
          aria-pressed={showHidden}
          onClick={() => setShowHidden((v) => !v)}
        >
          {showHidden ? <Eye className="i" aria-hidden="true" /> : <EyeOff className="i" aria-hidden="true" />}
          {showHidden ? "Скрытые показаны" : "Показать скрытые"}
        </button>
        <button className="pill ghost sm" type="button" onClick={() => setAdding((v) => !v)}>
          Добавить ориентир
        </button>
      </div>

      {adding &&
        (mobile ? (
          <LandmarkFormDialog titleId="landmark-add-title" title="Новый ориентир" onClose={() => setAdding(false)}>
            {addForm}
          </LandmarkFormDialog>
        ) : (
          addForm
        ))}

      {isLoading && items.length === 0 && <div className="state">Загрузка…</div>}
      {!isLoading && items.length === 0 && <div className="state">Ничего не найдено</div>}

      {items.length > 0 && (
        <div className="list" style={{ marginTop: "var(--s3)" }}>
          {items.map((lm) => (
            <LandmarkRow
              key={lm.id}
              landmark={lm}
              canManage={canManage}
              mobile={mobile}
              editing={editingId === lm.id}
              onToggleEdit={() => setEditingId((id) => (id === lm.id ? null : lm.id))}
              savePending={updateLandmark.isPending}
              onSave={(patch) =>
                updateLandmark.mutate(
                  { id: lm.id, ...patch },
                  { onSuccess: () => setEditingId(null) }
                )
              }
            />
          ))}
        </div>
      )}
      {data && (
        <Pagination
          loading={isFetching}
          variant="loadMore"
          page={page}
          pageSize={LANDMARKS_PAGE_SIZE}
          total={data.total}
          onPageChange={(next) => setPaging({ key: listKey, page: next })}
        />
      )}
    </section>
  );
}

const LANDMARKS_PAGE_SIZE = 50;
