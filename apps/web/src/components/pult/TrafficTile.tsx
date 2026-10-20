import { Link } from "react-router-dom";
import type { LucideIcon } from "lucide-react";
import type { PultTone } from "@royal-home/shared";
import { CountingNumber } from "../ui/CountingNumber";

export type TrafficTileTone = PultTone | "neutral";

/**
 * Плитка светофора разделов, перенесённая дословно из прототипа темы
 * «Royal Home 2026» (`docs/pult/theme-2026/screens/home-admin.html`, блок
 * «Светофор разделов»):
 *
 *   <div class="tile"><div class="hd">Клиенты<span class="dot"></span></div>
 *     <b>9</b><small class="crit">…</small></div>
 *
 * Отличия от эталонного фрагмента, каждое сохраняет уже работающую функцию:
 *  - плитка это ссылка `<a class="tile">`, а не `<div>`: клик по всей плитке
 *    ведёт в раздел (правило владельца №7 «всё кликабельно насквозь»);
 *  - в `.hd` добавлен значок раздела `<span class="ic">` — это класс самого
 *    прототипа (`_components.css`: `.tile .hd .ic`), не выдуманное имя;
 *  - «нет данных» вместо 0 (`dashWhenZero`) и count-up сумм (`animateBig`)
 *    остались как были.
 *
 * Ширина и высота задаются сеткой `.tiles` (4 в ряд на десктопе, 2 на телефоне),
 * сама плитка размеров не фиксирует.
 */
export function TrafficTile({
  icon: Icon,
  label,
  big,
  numericValue,
  line,
  tone,
  href,
  dashWhenZero = false,
  animateBig = false,
}: {
  icon: LucideIcon;
  label: string;
  /** Готовая строка для крупной цифры (может быть "39 %", "6/8" и т.п.). */
  big: string;
  /** Если задано и `big` — просто число, включает count-up через `CountingNumber` (только для сумм по договору). */
  numericValue?: number;
  line: string;
  tone: TrafficTileTone;
  href: string;
  dashWhenZero?: boolean;
  animateBig?: boolean;
}) {
  const showDash = dashWhenZero && numericValue === 0;
  // `.dot` без модификатора в прототипе — «внимание»; `ok` и `crit` — модификаторы.
  const dotClass = tone === "ok" || tone === "neutral" ? "dot ok" : tone === "crit" ? "dot crit" : "dot";

  return (
    <Link
      to={href}
      className="tile"
      data-tone={tone}
      aria-label={`${label}: ${showDash ? "нет данных" : big}. ${line}`}
    >
      <div className="hd">
        <span className="ic" aria-hidden="true">
          <Icon className="i" strokeWidth={1.5} />
        </span>
        {label}
        <span className={dotClass} aria-hidden="true" />
      </div>
      <b>
        {showDash ? (
          "нет данных"
        ) : animateBig && numericValue !== undefined ? (
          <CountingNumber value={numericValue} />
        ) : (
          big
        )}
      </b>
      <small className={tone === "crit" ? "crit" : undefined}>{line}</small>
    </Link>
  );
}
