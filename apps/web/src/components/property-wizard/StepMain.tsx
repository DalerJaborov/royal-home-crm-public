import { useId } from "react";
import {
  CURRENCIES,
  NEW_BUILD_PHASES,
  PROPERTY_CONDITION_LABELS,
  SECONDARY_CONDITIONS,
  PROPERTY_DETAIL_KEYS,
  PROPERTY_DETAIL_LABELS,
  PROPERTY_DETAIL_OPTIONS,
  PROPERTY_TYPES,
  PROPERTY_TYPE_LABELS,
  type Currency,
  fieldsForNewBuildPhase,
  marketSideOf,
  newBuildPhaseOf,
  type NewBuildPhase,
  type PropertyCondition,
  type PropertyMarketSide,
  type PropertyType,
  type PropertyDetailKey,
  propertyDetailShown,
  propertyFieldShown,
  propertyHasCondition,
  propertyHasMarket,
  propertyTypeFields,
} from "@royal-home/shared";
import { DETAIL_NOT_SET, DOCUMENT_PRESETS, needsLandArea, needsRooms, valuesForTypeChange, type WizardValues } from "./types";

/**
 * ШАГ 2 — ГЛАВНОЕ. Переодет в облик артефакта владельца (15.09.2026):
 * `.segs` для типа объекта, `.grid2` c полями `.f`, цена отдельной строкой, под
 * ней `.calc` — цена за м² (за сотку у участка) СЧИТАЕТСЯ НА ЛЕТУ, ниже `.segs`
 * для состояния. Классы приходят из сгенерированного theme-2026-wizard.css
 * (область `.rh2 .wiz`) — файл темы руками не трогать.
 *
 * Состав ОБЯЗАТЕЛЬНЫХ полей взят из `propertyCreateSchema`, а не придуман: тип,
 * площадь, цена, валюта и состояние — всегда; комнаты, этаж, этажность и окна —
 * для всего, кроме участка. Окна выглядят мелочью, но без них POST возвращает
 * 400, а «мастер, который в конце отказывает» хуже длинной формы.
 *
 * ДОБАВЛЕНО ПОВЕРХ АРТЕФАКТА (решения владельца 15.09.2026, docs/TASKS.md) —
 * этого в макете нет вовсе, но сервер уже принимает:
 *   — 13 характеристик (details): «свёрнутый блок характеристик не должен
 *     отличаться от его других полей вообще никак» — теми же `.f`/`.segs`/
 *     `.grid2`, без своей рамки и заголовка. Ключи и опции — из
 *     PropertyFormModal.tsx (PROPERTY_DETAIL_OPTIONS), второй раз не
 *     выдумываются.
 *   — Документы (тип): «это только для самого риелтора, чтобы знать, что
 *     говорить клиенту; информация только для агентов и директора» — пресет
 *     плюс своя строка на «Другое», как в старой форме.
 *   — Стадия строительства: только когда выбрана «Новостройка» (marketType).
 *   — «Срочное объявление» СЮДА НЕ ДОБАВЛЕНО — владелец запретил прямо.
 *
 * ПРОДАЖА/АРЕНДА СЮДА НЕ ПОПАЛА. Такого поля в системе нет ни в модели, ни в
 * схемах: аренда фигурирует ровно один раз — причиной отказа клиенту. Вместо
 * него — существующая ось «Новостройка / Вторичка» (marketType).
 */
export function StepMain({
  values,
  errors,
  onChange,
}: {
  values: WizardValues;
  errors: Record<string, string>;
  onChange: (patch: Partial<WizardValues>) => void;
}) {
  // Какие поля есть у типа — одна таблица (packages/shared/src/propertyTypeFields.ts):
  // у дома нет этажа и «новостройки», у участка — комнат, этажей, окон и состояния.
  const rooms = needsRooms(values.type);
  const landArea = needsLandArea(values.type);
  const rules = propertyTypeFields(values.type);
  const perUnit = calcPerUnit(values);
  const detailKeys = PROPERTY_DETAIL_KEYS.filter((key) => propertyDetailShown(values.type, key));
  const changeDetail = (key: PropertyDetailKey, selected: string, toggle = false) => onChange({
    details: { ...values.details, [key]: toggle && values.details[key] === selected ? DETAIL_NOT_SET : selected },
  });

  return (
    <>
      <section className="blk wizard-type-group">
        <h3 className="wizard-desktop-heading">Вид объекта</h3>
        <Segs<PropertyType>
          label="Вид объекта"
          value={values.type}
          options={PROPERTY_TYPES.map((t) => ({ value: t, label: PROPERTY_TYPE_LABELS[t] }))}
          // Смена типа сразу очищает поля, которых у нового типа нет.
          onChange={(v) => onChange(valuesForTypeChange(values, v as PropertyType))}
        />
      </section>

      <section className="blk wizard-parameters-group">
        <h3 className="wizard-desktop-heading">Параметры и цена</h3>
        <div className="grid2 wizard-numeric-row" data-property-type={values.type}>
          {rooms && (
            <Field label={rules.labels.rooms} value={values.rooms} error={errors.rooms} onChange={(v) => onChange({ rooms: v })} />
          )}
          {/* У участка площадь — это сотки (поле ниже), м² сервер считает сам.
              Раньше здесь стояло «Участок, соток», а число уходило в поле м²:
              участок 6 соток выходил на сайт и в подпись как «6 м²». */}
          {values.type !== "LAND" && (
            <Field className="wizard-area-field" label="Площадь, м²" value={values.areaSqm} error={errors.areaSqm} onChange={(v) => onChange({ areaSqm: v })} />
          )}
          {/* Сотки — отдельное поле, только у ДОМА и УЧАСТКА (владелец
              21.09.2026: «сотки» — отдельная цифра, как в договоре, м² строения
              её не заменяет). Необязательное — сервер (propertyCreateSchema)
              его тоже не требует. */}
          {landArea && (
            <Field
              className="wizard-area-field"
              label={values.type === "LAND" ? "Участок, соток" : "Сотки"}
              value={values.landAreaSotka}
              error={errors.landAreaSotka}
              onChange={(v) => onChange({ landAreaSotka: v })}
            />
          )}
          {propertyFieldShown(values.type, "floor") && (
            <Field label="Этаж" value={values.floor} error={errors.floor} onChange={(v) => onChange({ floor: v })} />
          )}
          {propertyFieldShown(values.type, "totalFloors") && (
            <Field
              label={rules.labels.totalFloors}
              value={values.totalFloors}
              error={errors.totalFloors}
              onChange={(v) => onChange({ totalFloors: v })}
            />
          )}
          {propertyFieldShown(values.type, "windowCount") && (
            <Field
              label="Окон"
              value={values.windowCount}
              error={errors.windowCount}
              onChange={(v) => onChange({ windowCount: v })}
            />
          )}
        </div>

        <div className="wizard-price-row">
        <div className="wizard-mobile-spacer" style={{ height: 8 }} />
        <Field label="Цена" value={values.price} error={errors.price} whole onChange={(v) => onChange({ price: v })} />
        {perUnit && <div className="calc">{perUnit}</div>}

        <div className="wizard-mobile-spacer" style={{ height: 8 }} />
        <div className="wizard-price-currency">
        <span className="wizard-desktop-field-label">Валюта</span>
        <Segs<Currency>
          label="Валюта"
          value={values.currency}
          options={CURRENCIES.map((c) => ({ value: c, label: c === "TJS" ? "Сомони" : "Доллары" }))}
          onChange={(v) => onChange({ currency: v as Currency })}
        />
        </div>
        </div>
      </section>

      {/* У участка нет ни «новостройки», ни состояния ремонта. */}
      {(propertyHasMarket(values.type) || propertyHasCondition(values.type)) && (
        <PropertyFinishSegs values={values} onChange={onChange} />
      )}

      {/* Документы — только для сотрудников, чтобы знать, что говорить клиенту
          (владелец 15.09.2026). Пресеты и своя строка — дословно из
          PropertyFormModal.tsx. */}
      <section className="blk wizard-documents-group">
        <div className="f">
          <label>Документы (только для сотрудников)</label>
        </div>
        <Segs<(typeof DOCUMENT_PRESETS)[number] | "" | "Другое">
          value={values.documentsPreset}
          options={[
            { value: "", label: "Не указано" },
            ...DOCUMENT_PRESETS.map((d) => ({ value: d, label: d })),
            { value: "Другое", label: "Другое" },
          ]}
          onChange={(v) => onChange({ documentsPreset: v as WizardValues["documentsPreset"] })}
        />
        {values.documentsPreset === "Другое" && (
          <div style={{ marginTop: 8 }}>
            <Field label="Какой документ" value={values.documentsOther} onChange={(v) => onChange({ documentsOther: v })} text />
          </div>
        )}
      </section>

      {/* 13 характеристик — те же `.f`/`.segs`, без своей рамки и заголовка
          (владелец 15.09.2026: «не должен отличаться от его других полей
          вообще никак»). Каждая характеристика — свой `.blk`, как остальные
          поля шага, а не один общий блок со списком внутри. */}
      {detailKeys.length > 0 && <div className="wizard-details-group">
        <h3 className="wizard-desktop-heading">Характеристики</h3>
        {detailKeys.map((key) => (
          <DetailField key={key} detailKey={key} value={values.details[key]} onChange={(selected, toggle) => changeDetail(key, selected, toggle)} />
        ))}
      </div>}
    </>
  );
}

/** The same stored value and clear behavior serve both presentations. */
function DetailField({ detailKey, value, onChange }: {
  detailKey: PropertyDetailKey;
  value: string;
  onChange: (selected: string, toggle?: boolean) => void;
}) {
  const id = useId();
  const options: readonly string[] = PROPERTY_DETAIL_OPTIONS[detailKey];
  const label = PROPERTY_DETAIL_LABELS[detailKey];
  return <section className="blk wizard-detail-field">
    <div className="f"><label htmlFor={id}>{label}</label></div>
    <select className="wizard-desktop-control wizard-detail-select" data-detail-key={detailKey} id={id} value={options.includes(value) ? value : DETAIL_NOT_SET}
      onChange={(event) => onChange(event.target.value)}>
      <option value={DETAIL_NOT_SET}>Не указано</option>
      {options.map((option) => <option key={option} value={option}>{option}</option>)}
    </select>
    <div className="wizard-mobile-control">
      <Segs<string> label={label} value={value} options={options.map((option) => ({ value: option, label: option }))}
        onChange={(selected) => onChange(selected, true)} />
    </div>
  </section>;
}

/** Цена за м² (за сотку у участка) — считается на лету, как `perM2()` в
 *  артефакте. Пусто, если цену или площадь ещё не ввели. */
function calcPerUnit(v: WizardValues): string {
  const price = Number(v.price);
  if (!Number.isFinite(price) || price <= 0) return "";
  const area = Number(v.type === "LAND" ? v.landAreaSotka : v.areaSqm);
  if (!Number.isFinite(area) || area <= 0) return "";
  const perUnit = Math.round(price / area);
  const currency = v.currency === "TJS" ? "с." : "$";
  return v.type === "LAND" ? `${perUnit.toLocaleString("ru-RU")} ${currency} за сотку` : `${perUnit.toLocaleString("ru-RU")} ${currency} за м²`;
}

/** Приводит ввод числового поля к однозначному виду: только цифры и одна точка.
 *
 * Запятая всегда становится точкой (десятичный разделитель), а всё, что не
 * цифра и не точка, отбрасывается на лету — иначе «1,200» (тысяча двести у
 * агента) превращалось бы в 1.2 без единой ошибки валидации (см. историю
 * бага ниже, сохранена дословно из прежней версии файла).
 *
 * Решение — не гадать, где запятая разделитель тысяч, а где дробная часть
 * (для ru/tj это неоднозначно в обе стороны), а не давать вводу породить эту
 * двусмысленность вообще.
 */
function sanitizeNumericInput(raw: string): string {
  let s = raw.replace(/,/g, ".").replace(/[^\d.]/g, "");
  const firstDot = s.indexOf(".");
  if (firstDot !== -1) {
    s = s.slice(0, firstDot + 1) + s.slice(firstDot + 1).replace(/\./g, "");
  }
  return s;
}

/** Поле `.f` артефакта — подпись-заголовок сверху, ввод снизу. `text` — как
 *  `input.txt` темы (обычный шрифт, а не цифровой моноширинный). */
function Field({
  label,
  value,
  error,
  text,
  whole,
  className,
  onChange,
}: {
  label: string;
  value: string;
  error?: string;
  text?: boolean;
  /** Целое число (цена): запятая и пробел — разделители тысяч, а не дробь.
   *  Иначе «250,000» превращалось в 250.000, то есть в 250. */
  whole?: boolean;
  className?: string;
  onChange: (value: string) => void;
}) {
  const id = useId();
  return (
    <div className={className ? `f ${className}` : "f"}>
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        className={text ? "txt" : undefined}
        value={value}
        inputMode={text ? undefined : whole ? "numeric" : "decimal"}
        type="text"
        autoComplete="off"
        onChange={(e) =>
          onChange(text ? e.target.value : whole ? e.target.value.replace(/\D/g, "") : sanitizeNumericInput(e.target.value))
        }
        style={error ? { borderColor: "var(--warn)" } : undefined}
      />
      {error && (
        <span className="sub" style={{ color: "var(--warn)" }}>
          {error}
        </span>
      )}
    </div>
  );
}

/** Ряд пилюль `.segs` артефакта — замена SegChoice.tsx на этом шаге (тот же
 *  принцип, класс из темы вместо своего). */
/**
 * «Вторичка / Новостройка» и одна фаза у новостройки вместо трёх рядов с
 * повторами (владелец 23.09.2026). Раскладка в поля базы — одна таблица в
 * packages/shared/src/propertyFinish.ts, форма правки зовёт её же.
 */
function PropertyFinishSegs({
  values,
  onChange,
}: {
  values: WizardValues;
  onChange: (patch: Partial<WizardValues>) => void;
}) {
  // У дома «новостройки/вторички» нет (владелец 08.10.2026) — только состояние.
  const hasMarket = propertyHasMarket(values.type);
  const side = hasMarket ? marketSideOf(values) : "SECONDARY";
  const phase = newBuildPhaseOf(values);
  return (
    <div className="wizard-finish-group">
      {hasMarket && (
        <section className="blk">
        <span className="wizard-desktop-field-label">Рынок</span>
        <Segs<PropertyMarketSide | "">
          label="Рынок"
          value={side ?? ""}
          options={[
            { value: "SECONDARY", label: "Вторичка" },
            { value: "NEW", label: "Новостройка" },
          ]}
          onChange={(v) =>
            onChange(
              v === "NEW"
                ? // Фазу агент выберет следующим рядом; до выбора — «строится» не
                  // подставляем, а честно ставим новостройку без фазы.
                  { marketType: "NEW_BUILD", stage: "", condition: "NEW_BUILDING" }
                : { marketType: "SECONDARY", stage: "", condition: values.condition === "NEW_BUILDING" ? "GOOD" : values.condition }
            )
          }
        />
        </section>
      )}

      {side === "NEW" ? (
        <section className="blk">
          <div className="f">
            <label>Стадия и отделка</label>
          </div>
          <Segs<NewBuildPhase | "">
            value={phase ?? ""}
            options={NEW_BUILD_PHASES.map((p) => ({ value: p.key, label: p.label }))}
            onChange={(v) => v && onChange(fieldsForNewBuildPhase(v as NewBuildPhase))}
          />
        </section>
      ) : (
        <section className="blk">
          <div className="f">
            <label>Состояние</label>
          </div>
          <Segs<PropertyCondition>
            value={values.condition}
            options={SECONDARY_CONDITIONS.map((c) => ({ value: c, label: PROPERTY_CONDITION_LABELS[c] }))}
            onChange={(v) => onChange({ condition: v as PropertyCondition })}
          />
        </section>
      )}
    </div>
  );
}

function Segs<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
  label?: string;
}) {
  return (
    <div className="segs" role={label ? "group" : undefined} aria-label={label}>
      {options.map((opt) => (
        <button
          key={opt.value || "__empty__"}
          type="button"
          aria-pressed={opt.value === value}
          onClick={() => onChange(opt.value)}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
