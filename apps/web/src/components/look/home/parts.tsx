import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import type { PropertyStageState, PropertyStatus } from "@royal-home/shared";
import { useAuthStore } from "../../../store/auth";
import { useUiPrefs } from "../../../store/uiPrefs";
import { dushanbeDate, dushanbeHour } from "../../../lib/date";
import { PROPERTY_STATUS_LABELS, STAGE_OWNER_LABELS } from "../../../lib/format";
import { greetingFor, useMinuteNow } from "./time";
import { RoyalSection } from "../clients/RoyalSection";
import { RoyalIcon } from "../RoyalIcon";
import type { RoyalIconName } from "../royalIconData";
import { RhButton, RhCircle, type RhTone } from "../ui";
import type { PillTone } from "../tileTone";
import { pillTone } from "../tileTone";

/**
 * ГЛАВНАЯ ОСТАЛЬНЫХ РОЛЕЙ В «НОВОМ ВИДЕ» (пачка home, 20.11.2026): общие детали.
 *
 * Монтажёр, маркетинг, служба безопасности, менеджер и акционер получают главную
 * той же семьи, что `pages/TodayRoyal.tsx` (директор, РОП, агент): приветствие,
 * полоса плиток, разделы со строками. Классы раскладки (`ry-today`, `ry-blocks`,
 * `ry-strip`, `ry-col-a/b`) — из основы; своё оформление — только в
 * theme-look-royal-home.css под меткой `data-ry-section="home"`.
 *
 * Корень ставит метку раздела сам и даёт её окнам через RoyalSection: без
 * признака вида этот файл не рисуется вовсе (развилка в pages/Dashboard.tsx).
 */
export function RoyalHomeFrame({ role, children }: { role: string; children: ReactNode }) {
  return (
    <RoyalSection name="home">
      <div className="ry-today ry-home" data-ry-section="home" data-role={role}>
        <RoyalGreeting />
        <div className="ry-blocks">{children}</div>
      </div>
    </RoyalSection>
  );
}

function capitalize(text: string) {
  return text ? text[0].toUpperCase() + text.slice(1) : text;
}

/** Приветствие и дата — тем же правилом, что у главной директора (TodayRoyal). */
function RoyalGreeting() {
  const agent = useAuthStore((s) => s.agent);
  const now = useMinuteNow();
  const firstName = agent?.fullName?.trim().split(/\s+/)[0] ?? "";
  const hello = greetingFor(dushanbeHour(now));
  return (
    <header className="ry-hello">
      <p className="ry-hello-line">{firstName ? `${hello}, ${firstName}` : hello}</p>
      <h1 className="ry-hello-date">{capitalize(dushanbeDate(now, { weekday: "long", day: "numeric", month: "long" }))}</h1>
    </header>
  );
}

export interface HomeQuickItem {
  key: string;
  label: string;
  icon: RoyalIconName;
  to: string;
  tone: RhTone;
  /** Только настоящее число из уже пришедших данных; нет числа — нет значка. */
  count?: number;
}

/** Ряд быстрых переходов (прежний ряд плиток мобильной главной): круг-значок и подпись. */
export function HomeQuick({ items }: { items: HomeQuickItem[] }) {
  if (!items.length) return null;
  return (
    <nav className="ry-home-quick" aria-label="Быстрые переходы">
      {items.map((item) => (
        <Link key={item.key} to={item.to} className="ry-home-q"
          aria-label={typeof item.count === "number" && item.count > 0 ? `${item.label}: ${item.count}` : item.label}>
          <span className="ry-home-q-icon">
            <RhCircle icon={item.icon} tone={item.tone} />
            {typeof item.count === "number" && item.count > 0 && <b className="ry-home-q-count ry-num" aria-hidden="true">{item.count}</b>}
          </span>
          <span className="ry-home-q-label">{item.label}</span>
        </Link>
      ))}
    </nav>
  );
}

/**
 * Подсказка, которую закрывают навсегда — та же запись `dismissedHints`, что у
 * прежней DismissibleHint (переживает перезагрузку и другие устройства), тот же id.
 */
export function HomeHint({ id, children }: { id: string; children: ReactNode }) {
  const dismissed = useUiPrefs((s) => s.dismissedHints.includes(id));
  const dismissHint = useUiPrefs((s) => s.dismissHint);
  if (dismissed) return null;
  return (
    <div className="ry-home-hint">
      <RhCircle icon="lightbulb" tone="a0" size={44} />
      <p>{children}</p>
      <button type="button" className="ry-home-hint-close" onClick={() => dismissHint(id)} aria-label="Скрыть подсказку" title="Больше не показывать">
        <RoyalIcon name="x-circle" size={24} />
      </button>
    </div>
  );
}

/** «Показать ещё (N)» под списком: одна кнопка на всю ширину группы. */
export function HomeMore({ rest, onClick, disabled, label }: { rest: number; onClick: () => void; disabled?: boolean; label?: string }) {
  if (rest <= 0) return null;
  return (
    <div className="ry-home-more">
      <RhButton variant="secondary" onClick={onClick} disabled={disabled}>{label ?? "Показать ещё"} ({rest})</RhButton>
    </div>
  );
}

/**
 * Первые `step` строк, по «Показать ещё» — всё уже пришедшее; если сервер знает
 * больше (`total`), дальше догружается следующая страница (`loadNext`).
 * Так было на телефонной главной монтажёра; на ПК — одна кнопка догрузки.
 */
export function useExpandable<T>(rows: T[], total: number, loadNext?: () => void, step = 5) {
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? rows : rows.slice(0, step);
  const rest = Math.max(0, total - visible.length);
  // Нечего раскрывать на месте (всё пришедшее уже видно) — сразу догружаем следующую страницу.
  const more = () => ((expanded || rows.length <= step) && loadNext ? loadNext() : setExpanded(true));
  return { visible, rest, more };
}

/** Фото объекта в строке или круг-значок, если фото нет. */
export function PropertyLead({ photo, icon, tone }: { photo?: string | null; icon: RoyalIconName; tone: RhTone }) {
  const [broken, setBroken] = useState<string | null>(null);
  if (photo && broken !== photo) {
    return <img className="ry-home-thumb" src={photo} alt="" loading="lazy" decoding="async" onError={() => setBroken(photo)} />;
  }
  return <RhCircle icon={icon} tone={tone} filled={tone === "crit"} />;
}

export function firstPhoto(row: { photos?: { url?: string | null; thumbUrl?: string | null }[] | null }): string | null {
  const photo = row.photos?.[0];
  return photo?.thumbUrl ?? photo?.url ?? null;
}

/**
 * Состояние объекта — словами прежнего значка (StatusBadge): статус, ответственный
 * этапа и дни; просрочку считает сервер (`stage.overdue`).
 */
export function PropertyState({ status, stage }: { status: PropertyStatus; stage?: PropertyStageState | null }) {
  const overdue = stage?.overdue === true;
  const owner = stage?.inPipeline && stage.owner ? STAGE_OWNER_LABELS[stage.owner] ?? stage.owner : null;
  const days = overdue
    ? `просрочено на ${stage!.daysInStage - (stage!.limitDays ?? 0)} дн.`
    : stage?.inPipeline && stage.daysInStage > 0 ? `${stage.daysInStage} дн.` : null;
  return (
    <span className="ry-home-state" data-tone={overdue ? pillTone("overdue") : undefined}>
      <span className="ry-home-chip" data-tone={overdue ? pillTone("overdue") : "info"}>{PROPERTY_STATUS_LABELS[status]}</span>
      {(owner || days) && <span className="ry-home-state-note">{[owner, days].filter(Boolean).join(" · ")}</span>}
    </span>
  );
}

/** Короткая плашка смысла справа в строке; тон — только из `pillTone()` (tileTone.ts): обычное серым, сегодня янтарём, просрочено красным. */
export function HomeChip({ tone, children }: { tone: PillTone; children: ReactNode }) {
  return <span className="ry-home-chip" data-tone={tone}>{children}</span>;
}
