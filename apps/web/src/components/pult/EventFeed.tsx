import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Link } from "react-router-dom";
import { exactDateTime } from "../../lib/format";
import { usePultEventSound, type PultSoundEvent } from "../../lib/pultSound";
import { AREA_ICON } from "./pultTheme";

/**
 * «Сейчас в компании» — живая лента пульта, `section.card.lf` артефакта
 * «Единый пульт директора» (модуль `ticker` в `pultModules.ts`). Разметка
 * дословно по артефакту: `.lfwrap > section.card.lf` с шапкой `.lf-head`
 * (заголовок и строка «Пока вас не было»), сторис агентов и объектов
 * `.lf-stories > ul.lf-srow.nowc-row`, чипами фильтра `.lf-chips`, кнопкой
 * новых строк `.lf-newbar > .lf-new`, списком `ul.lf-feed > li.lf-row`
 * (значок `.lf-ic`, текст `.lf-body > .lf-txt`, время `.lf-side > .lf-time`),
 * кнопкой «Показать ещё» `.lf-morebar` и пустым состоянием `.lf-empty`.
 *
 * Данные те же, что и раньше: `useMissionControlTicker()` (страница передаёт
 * события и решает, включён ли модуль), сторис — агенты и объекты из снимка
 * пульта. Оверлей истории агента (`.lf-story`) артефакта не перенесён: его
 * данных (события по агенту за день) на сервере нет; клик по сторис ведёт в
 * карточку раздела.
 *
 * Правило v8 §6 «как обновлять без дёрганья»: новые строки НЕ вставляются под
 * курсором/при активном чтении — вместо этого кнопка «↑ N новых» (`.lf-new.on`),
 * клик по которой вливает их с анимацией (`.lf-in`). Один компонент на десктоп
 * и телефон — узкую раскладку дают медиазапросы артефакта.
 */

export type EventFeedKind = PultSoundEvent["kind"] | "audit" | "interaction" | "lead" | "other";

export interface EventFeedItem {
  id: string;
  kind: EventFeedKind;
  text: string;
  href: string | null;
  /** ISO. Показывается точным временем (exactDateTime) — правило владельца 20.08.2026:
   *  никаких «N минут назад» нигде в CRM. */
  createdAt: string;
}

/** Сторис агента над лентой (`.lf-st.nowc`). */
export interface EventFeedAgent {
  id: string;
  name: string;
  /** В сети сейчас (точка `.nowc-pres.on`). */
  on: boolean;
  /** Подпись «чем занят» / «тихо N мин» (`.lf-sub`). */
  status?: string;
  href: string;
  /** Фото сотрудника (`Agent.avatarUrl`), если он его загрузил. */
  avatarUrl?: string | null;
}

/** Сторис объекта над лентой (`.lf-st.nowc.obj`). */
export interface EventFeedObject {
  id: string;
  title: string;
  hint?: string;
  href: string;
}

/** Сколько px от верхнего края ленты считается «пользователь ещё читает верх». */
const READING_SCROLL_THRESHOLD_PX = 24;

/** Сколько строк видно до «Показать ещё» — `KEEP=6` в скрипте артефакта. */
const KEEP = 6;

const KIND_LABEL: Record<string, string> = {
  lead: "Клиенты",
  interaction: "Звонки и чаты",
  audit: "Система",
  awaitsYou: "Ждут вас",
  question: "Вопросы",
  other: "Прочее",
};

const KIND_ICON: Record<string, { icon: (typeof AREA_ICON)[keyof typeof AREA_ICON]["icon"]; c: string; ci: string }> = {
  lead: { icon: AREA_ICON.clients.icon, c: "var(--aqua)", ci: "var(--aqua-ink)" },
  interaction: { icon: AREA_ICON.calls.icon, c: "var(--lime)", ci: "var(--lime-ink)" },
  audit: { icon: AREA_ICON.system.icon, c: "var(--sky)", ci: "var(--sky-ink)" },
  awaitsYou: { icon: AREA_ICON.deals.icon, c: "var(--warn-bg)", ci: "var(--warn)" },
  question: { icon: AREA_ICON.bot.icon, c: "var(--lav)", ci: "var(--lav-ink)" },
  other: { icon: AREA_ICON.system.icon, c: "var(--soft)", ci: "var(--muted)" },
};

const NOWC_TONES: [string, string][] = [
  ["var(--lime)", "var(--lime-ink)"],
  ["var(--aqua)", "var(--aqua-ink)"],
  ["var(--lav)", "var(--lav-ink)"],
  ["var(--pink)", "var(--pink-ink)"],
  ["var(--sky)", "var(--sky-ink)"],
];

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

function initial(name: string): string {
  return name.trim().split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase() || "•";
}

function plural(n: number, one: string, few: string, many: string): string {
  const abs = Math.abs(n) % 100;
  const last = abs % 10;
  if (abs > 10 && abs < 20) return many;
  if (last > 1 && last < 5) return few;
  if (last === 1) return one;
  return many;
}

export function EventFeed({
  events,
  soundEnabled = false,
  agents = [],
  objects = [],
  emptyHint = "В этом разделе сегодня тихо.",
  title = "Сейчас в компании",
  className = "",
}: {
  events: EventFeedItem[];
  /** Тумблер `sound` из «Настроить пульт» — звук на события «ждёт вас»/«вопрос
   *  ко мне» (§7); тумблер самой ленты (`ticker`) решает страница. */
  soundEnabled?: boolean;
  agents?: EventFeedAgent[];
  objects?: EventFeedObject[];
  emptyHint?: string;
  title?: string;
  className?: string;
}) {
  usePultEventSound(events, soundEnabled);

  const listRef = useRef<HTMLUListElement | null>(null);
  const [visible, setVisible] = useState<EventFeedItem[]>(events);
  const [pending, setPending] = useState<EventFeedItem[]>([]);
  const [enteringIds, setEnteringIds] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState<string>("all");
  const [expanded, setExpanded] = useState(false);
  const isReading = useRef(false);

  // Новые события: если пользователь у самого верха ленты — вливаем сразу
  // (с анимацией появления), иначе копим в `pending` и показываем кнопку.
  useEffect(() => {
    const knownIds = new Set(visible.concat(pending).map((e) => e.id));
    const incoming = events.filter((e) => !knownIds.has(e.id));
    if (incoming.length === 0) {
      const stillThere = new Set(events.map((e) => e.id));
      setVisible((v) => v.filter((e) => stillThere.has(e.id)));
      setPending((p) => p.filter((e) => stillThere.has(e.id)));
      return;
    }
    if (!isReading.current) {
      const reduced = prefersReducedMotion();
      if (!reduced) setEnteringIds(new Set(incoming.map((e) => e.id)));
      setVisible((v) => [...incoming, ...v]);
      if (!reduced) {
        const t = setTimeout(() => setEnteringIds(new Set()), 220);
        return () => clearTimeout(t);
      }
    } else {
      setPending((p) => [...incoming, ...p]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events]);

  function handleScroll() {
    const el = listRef.current;
    if (!el) return;
    isReading.current = el.scrollTop > READING_SCROLL_THRESHOLD_PX;
  }

  function mergePending() {
    if (pending.length === 0) return;
    const reduced = prefersReducedMotion();
    if (!reduced) setEnteringIds(new Set(pending.map((e) => e.id)));
    setVisible((v) => [...pending, ...v]);
    setPending([]);
    isReading.current = false;
    listRef.current?.scrollTo({ top: 0, behavior: reduced ? "auto" : "smooth" });
    if (!reduced) setTimeout(() => setEnteringIds(new Set()), 220);
  }

  const kinds = useMemo(() => Array.from(new Set(visible.map((e) => e.kind))), [visible]);
  const rows = useMemo(() => (filter === "all" ? visible : visible.filter((e) => e.kind === filter)), [visible, filter]);
  const shown = expanded ? rows : rows.slice(0, KEEP);
  const hiddenCount = rows.length - shown.length;

  return (
    <div className="lfwrap">
      <section className={`card lf ${className}`.trim()} id="live-feed" aria-labelledby="lf-title">
        <div className="lf-head">
          <h2 id="lf-title">{title}</h2>
          {pending.length > 0 && (
            <p className="lf-since">
              Пока вы читали:{" "}
              <button type="button" onClick={mergePending}>
                {pending.length} {plural(pending.length, "новое событие", "новых события", "новых событий")}
              </button>
            </p>
          )}
        </div>

        {(agents.length > 0 || objects.length > 0) && (
          <div className="lf-stories">
            {agents.length > 0 && (
              <ul className="lf-srow nowc-row" id="lf-agents" aria-label="Агенты сегодня">
                {agents.map((a, i) => {
                  const [c, ci] = NOWC_TONES[i % NOWC_TONES.length];
                  return (
                    <li key={a.id}>
                      <Link className={`lf-st nowc${a.on ? "" : " off"}`} to={a.href} aria-label={`${a.name}${a.status ? `, ${a.status}` : ""}. Открыть команду`}>
                        <span className="nowc-ph" style={{ "--c": c, "--ci": ci } as CSSProperties} aria-hidden="true">
                          {/* Фото, если сотрудник его загрузил, иначе инициал на
                              пастельном кружке — плейсхолдер тоном, не серый
                              прямоугольник (12.09.2026). */}
                          {a.avatarUrl ? <img className="nowc-img" src={a.avatarUrl} alt="" loading="lazy" decoding="async" /> : <span className="nowc-ini">{initial(a.name)}</span>}
                          <i className={`nowc-pres${a.on ? " on" : ""}`} />
                        </span>
                        <b className="lf-nm">{a.name.split(" ")[0]}</b>
                        {a.status && <span className={`lf-sub${a.on ? " busy" : ""}`}>{a.status}</span>}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
            {objects.length > 0 && (
              <>
                <p className="lf-srow-lbl" id="lf-objects-lbl">
                  {objects.length} {plural(objects.length, "объект", "объекта", "объектов")} в работе сегодня
                </p>
                <ul className="lf-srow nowc-row" id="lf-objects" aria-labelledby="lf-objects-lbl">
                  {objects.map((o, i) => {
                    const [c, ci] = NOWC_TONES[(i + 2) % NOWC_TONES.length];
                    return (
                      <li key={o.id}>
                        <Link className="lf-st nowc obj" to={o.href} aria-label={`${o.title}. Открыть объект`}>
                          <span className="nowc-ph" style={{ "--c": c, "--ci": ci } as CSSProperties} aria-hidden="true">
                            <span className="nowc-ini">{initial(o.title)}</span>
                          </span>
                          <b className="lf-nm">{o.title}</b>
                          {o.hint && <span className="lf-sub">{o.hint}</span>}
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              </>
            )}
          </div>
        )}

        <div className="lf-chips" id="lf-chips" role="group" aria-label="Фильтр ленты">
          <button type="button" className="lf-chip" data-filter="all" aria-pressed={filter === "all"} onClick={() => setFilter("all")}>
            Всё
          </button>
          {kinds.map((k) => (
            <button key={k} type="button" className="lf-chip" data-filter={k} aria-pressed={filter === k} onClick={() => setFilter(k)}>
              {KIND_LABEL[k] ?? k}
            </button>
          ))}
        </div>

        <div className="lf-newbar">
          <button type="button" className={`lf-new${pending.length > 0 ? " on" : ""}`} id="lf-new" aria-live="polite" onClick={mergePending}>
            {pending.length > 0 ? `↑ ${pending.length} ${plural(pending.length, "новое", "новых", "новых")}` : ""}
          </button>
        </div>

        <ul className={`lf-feed${hiddenCount > 0 ? " lf-cut" : ""}`} id="lf-feed" ref={listRef} onScroll={handleScroll}>
          {shown.map((e) => (
            <EventFeedRow key={e.id} item={e} entering={enteringIds.has(e.id)} />
          ))}
        </ul>

        <div className="lf-morebar">
          {(hiddenCount > 0 || expanded) && rows.length > KEEP && (
            <button type="button" className="lf-more-btn" id="lf-more" aria-controls="lf-feed" aria-expanded={expanded} onClick={() => setExpanded((v) => !v)}>
              {expanded ? "Свернуть" : `Показать ещё (${hiddenCount})`}
            </button>
          )}
        </div>

        {rows.length === 0 && (
          <p className="lf-empty" id="lf-empty">
            {emptyHint}
          </p>
        )}
      </section>
    </div>
  );
}

function EventFeedRow({ item, entering }: { item: EventFeedItem; entering: boolean }) {
  const ic = KIND_ICON[item.kind] ?? KIND_ICON.other;
  const Icon = ic.icon;
  return (
    <li className={`lf-row${entering ? " lf-in" : ""}`} data-kind={item.kind} data-id={item.id}>
      <span className="lf-ic" style={{ "--c": ic.c, "--ci": ic.ci } as CSSProperties} aria-hidden="true">
        <Icon className="lf-i" />
      </span>
      <div className="lf-body">
        <div className="lf-txt">{item.href ? <Link to={item.href}>{item.text}</Link> : item.text}</div>
      </div>
      <div className="lf-side">
        <time dateTime={item.createdAt} className="lf-time">
          {exactDateTime(item.createdAt)}
        </time>
      </div>
    </li>
  );
}
