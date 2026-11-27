import { useRef, useState, type KeyboardEvent } from "react";
import { ArrowDownUp, SlidersHorizontal, X } from "lucide-react";
import { Rh2Sheet } from "../../rh2/Rh2Sheet";
import { RoyalSection } from "../clients/RoyalSection";
import { RhButton, rhStepByKey } from "../ui";

/**
 * ФИЛЬТРЫ «АНАЛИТИКИ» НА ГЛАВНОЙ (пачка home2, 27.11.2026). Владелец 27.11: серые списки
 * браузера «настолько уродливые». Вместо трёх `<select>` — одна кнопка «Фильтры» со шторкой
 * (варианты таблетками) и выбранные фильтры чипами с крестиком под ней.
 *
 * Состояние фильтров НЕ здесь: значения и сеттеры приходят от экрана дашборда — те же
 * `agentId`, `source`, `kind`, что у прежних списков, поэтому запрос сводки, выгрузка Excel и
 * список за цифрой строятся из тех же полей (тест: «фильтры дают тот же запрос»). Выбор
 * применяется сразу, как у списков; «Готово» только закрывает шторку.
 */
export interface FilterOption { id: string; label: string }
export interface FilterGroup {
  key: "agentId" | "source" | "kind";
  /** Подпись группы в шторке и в чипе: «Менеджер», «Источник», «Клиенты». */
  label: string;
  /** Вариант «все» (пустое значение): «Все менеджеры». */
  allLabel: string;
  value: string;
  options: FilterOption[];
  onChange: (value: string) => void;
  /** Причина, почему вариантов нет (список не загрузился) — показывается в шторке словами. */
  note?: string | null;
}

export function AnalyticsFilters({ groups }: { groups: FilterGroup[] }) {
  const [open, setOpen] = useState(false);
  const active = groups.filter((g) => g.value);
  const reset = () => groups.forEach((g) => g.value && g.onChange(""));
  return (
    <div className="h2-fbar">
      <button type="button" className="h2-fbtn" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}>
        <SlidersHorizontal size={20} aria-hidden="true" />
        Фильтры
        {active.length > 0 && <b className="h2-fbtn-count ry-num" aria-label={`выбрано ${active.length}`}>{active.length}</b>}
      </button>
      {active.map((g) => {
        const option = g.options.find((o) => o.id === g.value);
        const text = `${g.label}: ${option?.label ?? "выбранный"}`;
        return (
          <span key={g.key} className="h2-fchip" data-filter={g.key}>
            <span>{text}</span>
            <button type="button" className="h2-fchip-x" aria-label={`Убрать фильтр «${text}»`} onClick={() => g.onChange("")}>
              <X size={18} aria-hidden="true" />
            </button>
          </span>
        );
      })}
      {open && (
        <RoyalSection name="home2">
          <Rh2Sheet title="Фильтры" onClose={() => setOpen(false)}
            footer={<>
              {active.length > 0 && <RhButton variant="ghost" onClick={reset}>Сбросить</RhButton>}
              <RhButton variant="primary" onClick={() => setOpen(false)}>Готово</RhButton>
            </>}>
            <div className="h2-fsheet">
              {groups.map((g) => (
                <fieldset key={g.key} className="h2-fgroup">
                  <legend>{g.label}</legend>
                  <PillRadios label={g.label} value={g.value} options={[{ id: "", label: g.allLabel }, ...g.options]}
                    onChange={g.onChange} attr={(id) => `${g.key}:${id}`} />
                  {g.note && <p className="h2-quiet" role="status">{g.note}</p>}
                </fieldset>
              ))}
            </div>
          </Rh2Sheet>
        </RoyalSection>
      )}
    </div>
  );
}

/**
 * Варианты таблетками — радиогруппа: стрелки переключают (вверх/вниз и влево/вправо, Home/End),
 * в порядке Tab — одна кнопка (выбранная). Одна на шторки «Фильтры» и «Сортировка».
 */
export function PillRadios({ label, value, options, onChange, attr }: {
  label: string; value: string; options: FilterOption[]; onChange: (id: string) => void; attr?: (id: string) => string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const ids = options.map((o) => o.id);
  const stop = ids.includes(value) ? value : ids[0];
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const next = rhStepByKey(ids, value, event.key);
    if (next === undefined) return;
    event.preventDefault();
    onChange(next);
    [...(ref.current?.querySelectorAll<HTMLButtonElement>("[data-pill]") ?? [])].find((b) => b.dataset.pill === (next || "all"))?.focus();
  };
  return (
    <div ref={ref} className="h2-fopts" role="radiogroup" aria-label={label} onKeyDown={onKeyDown}>
      {options.map((o) => (
        <button key={o.id || "all"} type="button" role="radio" className="h2-fopt" aria-checked={value === o.id}
          tabIndex={o.id === stop ? 0 : -1} data-pill={o.id || "all"} data-filter-option={attr?.(o.id)} onClick={() => onChange(o.id)}>{o.label}</button>
      ))}
    </div>
  );
}

/**
 * Сортировка списка менеджеров на телефоне (пачка home2): вместо серого списка браузера —
 * кнопка «Сортировка: Сделки ↓» со шторкой (столбец таблетками и направление). Те же
 * столбцы и то же правило направления, что у прежнего списка (DirectorBlocks.tsx).
 */
export function SortControl({ columns, value, dir, onChange }: {
  columns: FilterOption[]; value: string; dir: "asc" | "desc"; onChange: (id: string, dir: "asc" | "desc") => void;
}) {
  const [open, setOpen] = useState(false);
  const current = columns.find((c) => c.id === value)?.label ?? value;
  const arrow = dir === "asc" ? "↑" : "↓";
  return (
    <div className="h2-fbar">
      <button type="button" className="h2-fbtn" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}
        aria-label={`Сортировка: ${current}, ${dir === "asc" ? "по возрастанию" : "по убыванию"}`}>
        <ArrowDownUp size={20} aria-hidden="true" />
        Сортировка: {current} <span aria-hidden="true">{arrow}</span>
      </button>
      {open && (
        <RoyalSection name="home2">
          <Rh2Sheet title="Сортировка" onClose={() => setOpen(false)}
            footer={<RhButton variant="primary" onClick={() => setOpen(false)}>Готово</RhButton>}>
            <div className="h2-fsheet">
              <fieldset className="h2-fgroup">
                <legend>По какому столбцу</legend>
                {/* Новый столбец — направление по умолчанию, как у прежнего списка: имя по алфавиту, числа по убыванию. */}
                <PillRadios label="По какому столбцу" value={value} options={columns} onChange={(id) => onChange(id, id === "name" ? "asc" : "desc")} />
              </fieldset>
              <fieldset className="h2-fgroup">
                <legend>Порядок</legend>
                <PillRadios label="Порядок" value={dir} options={[{ id: "desc", label: "По убыванию" }, { id: "asc", label: "По возрастанию" }]}
                  onChange={(next) => onChange(value, next === "asc" ? "asc" : "desc")} />
              </fieldset>
            </div>
          </Rh2Sheet>
        </RoyalSection>
      )}
    </div>
  );
}
