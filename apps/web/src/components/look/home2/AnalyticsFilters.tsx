import { useState } from "react";
import { SlidersHorizontal, X } from "lucide-react";
import { Rh2Sheet } from "../../rh2/Rh2Sheet";
import { RoyalSection } from "../clients/RoyalSection";
import { RhButton } from "../ui";

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
                  <div className="h2-fopts" role="radiogroup" aria-label={g.label}>
                    {[{ id: "", label: g.allLabel }, ...g.options].map((o) => (
                      <button key={o.id || "all"} type="button" role="radio" className="h2-fopt" aria-checked={g.value === o.id}
                        data-filter-option={`${g.key}:${o.id}`} onClick={() => g.onChange(o.id)}>{o.label}</button>
                    ))}
                  </div>
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
