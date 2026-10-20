import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { findBlockMatches, findEntities, parseBlocks, type Block, type EntityType, type SearchRange } from "../lib/transcriptBlocks";

/**
 * РАСШИФРОВКА РАЗГОВОРА — ОТДЕЛЬНЫЙ КОМПОНЕНТ (24.09.2026).
 *
 * Раньше сплошной текст лежал в `<p className="said">` (CallDetails.tsx), и у
 * этого класса не было ни одного рабочего правила: в теме `.said` описан
 * только как `.rh2 .scr .player .said` (theme-2026-proto.css), а параграф
 * рос СНАРУЖИ `.player`, внутри `<details>`. Правило не действовало вовсе,
 * текст шёл браузерным дефолтом — тот самый «бардак», который сложно читать
 * на длинном звонке.
 *
 * СВОИХ ИМЁН КЛАССОВ ТЕМА НЕ ЗАВОДИТ (§4 docs/handoff-2026-09-09-theme-port.md):
 * `theme-2026-proto.css` генерируется скриптом `scripts/sync-proto-css.py» из
 * макета и руками не правится, а чата/поиска/двух колонок перевода в макете
 * нет — значит и класса под них взять неоткуда. Поэтому вся разметка ниже —
 * инлайн-стили на токенах темы (`var(--ink)`, `var(--soft)`...), тем же
 * приёмом, что уже применён в константах
 * `RH2_ROW_BUTTON`/`RH2_UNREAD_CHIP` (`components/rh2/Rh2Scope.tsx`).
 *
 * КОМПОНЕНТ ЧИСТО ПРЕДСТАВЛЕНЧЕСКИЙ: сам текст и готовый перевод приходят
 * пропсами, запрос перевода (POST /interactions/:id/translate) и его
 * состояние (грузится/не нужен/ошибка) остаются в `CallDetails.tsx` — там же
 * живёт кнопка «Показать перевод на русский». Сюда `translation` попадает,
 * только когда уже посчитан.
 */

export interface TranscriptViewProps {
  /** Оригинал расшифровки. null — расшифровки нет вовсе. */
  text: string | null;
  /** Готовый перевод (посчитан заранее — см. шапку файла). Пока не готов — null/undefined. */
  translation?: string | null;
  /** Подпись реплик агента вместо родового «Агент», когда известно, кто говорил. */
  agentName?: string | null;
  /** Длительность разговора в секундах — строкой рядом с заголовком. */
  durationSec?: number | null;
  /** Поставить расшифровку в очередь заново. Кнопка скрыта, если не передан. */
  onRetranscribe?: () => void;
  /** Заявка уже отправлена, ждём очередь — кнопка недоступна и подписана иначе. */
  retranscribing?: boolean;
}

/** Тот же расчёт, что formatCallDuration в CallDetails.tsx — не импортируем оттуда
 *  специально: CallDetails сам использует TranscriptView, и обратный импорт
 *  завёл бы цикл модулей ради двух строк форматирования. */
function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** Экран уже/шире порога — тот же приём, что useNarrowScreen.ts, но с двумя
 *  своими порогами (640 — размер и обёртка страницы целиком без прокрутки,
 *  960 — перевод в две колонки), поэтому хук свой, а не переиспользованный. */
function useMatchMedia(query: string): boolean {
  const [matches, setMatches] = useState(() => typeof window !== "undefined" && window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const onChange = (e: MediaQueryListEvent) => setMatches(e.matches);
    setMatches(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}

const ENTITY_STYLE: Record<EntityType, CSSProperties> = {
  phone: { background: "var(--sky)", color: "var(--sky-ink)", borderRadius: 4, padding: "0 2px" },
  price: { background: "var(--lime)", color: "var(--lime-ink)", borderRadius: 4, padding: "0 2px" },
  time: { background: "var(--lav)", color: "var(--lav-ink)", borderRadius: 4, padding: "0 2px" },
  unclear: {
    background: "var(--warn-bg)",
    color: "var(--warn)",
    borderRadius: 4,
    padding: "0 2px",
    textDecoration: "underline dotted",
    cursor: "help",
  },
};

interface Segment {
  key: string;
  text: string;
  entity?: EntityType;
  isSearch?: boolean;
  matchIndex?: number;
}

/** Точки разреза текста блока — границы найденных сущностей и совпадений
 *  поиска, отсортированные по возрастанию; между соседними точками кусок
 *  текста либо весь внутри одной сущности/совпадения, либо вне всех. */
function buildSegments(
  text: string,
  entities: { start: number; end: number; type: EntityType }[],
  searches: { start: number; end: number; globalIndex: number }[]
): Segment[] {
  const points = new Set<number>([0, text.length]);
  entities.forEach((r) => {
    points.add(r.start);
    points.add(r.end);
  });
  searches.forEach((r) => {
    points.add(r.start);
    points.add(r.end);
  });
  const sorted = [...points].sort((a, b) => a - b);
  const segments: Segment[] = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    const start = sorted[i];
    const end = sorted[i + 1];
    if (start >= end) continue;
    const entity = entities.find((r) => r.start <= start && r.end >= end);
    const search = searches.find((r) => r.start <= start && r.end >= end);
    segments.push({
      key: `${start}-${end}`,
      text: text.slice(start, end),
      entity: entity?.type,
      isSearch: !!search,
      matchIndex: search?.globalIndex,
    });
  }
  return segments;
}

function renderSegments(
  segments: Segment[],
  currentMatchIndex: number,
  currentMatchRef: React.MutableRefObject<HTMLElement | null> | undefined
): ReactNode[] {
  return segments.map((seg) => {
    if (seg.isSearch) {
      const isCurrent = seg.matchIndex === currentMatchIndex;
      return (
        <mark
          key={seg.key}
          ref={isCurrent && currentMatchRef ? (el) => { currentMatchRef.current = el; } : undefined}
          style={{
            background: isCurrent ? "#ffb74d" : "#ffe082",
            color: "#3a2e14",
            borderRadius: 3,
            padding: "0 1px",
            boxShadow: isCurrent ? "0 0 0 2px #f57c00" : undefined,
          }}
        >
          {seg.text}
        </mark>
      );
    }
    if (seg.entity) {
      return (
        <mark key={seg.key} title={seg.entity === "unclear" ? "Цифра не разобрана моделью" : undefined} style={ENTITY_STYLE[seg.entity]}>
          {seg.text}
        </mark>
      );
    }
    return <span key={seg.key}>{seg.text}</span>;
  });
}

/* ---------------------------------------------------------------------- */
/* Тело одного текста (оригинал ИЛИ перевод)                               */
/* ---------------------------------------------------------------------- */

function TranscriptBody({
  blocks,
  matches,
  currentMatchIndex,
  currentMatchRef,
  mobile,
}: {
  blocks: Block[];
  /** Совпадения поиска по блокам, в координатах текста блока — пусто, если поиск по нему не ведётся
   *  (правая колонка перевода в режиме «рядом» поиском не охвачена нарочно: две
   *  независимые ленты совпадений хуже одной понятной). */
  matches: SearchRange[][];
  currentMatchIndex: number;
  currentMatchRef?: React.MutableRefObject<HTMLElement | null>;
  mobile: boolean;
}) {

  const containerStyle: CSSProperties = {
    fontSize: mobile ? 16 : "var(--fs-15)",
    lineHeight: mobile ? 1.6 : 1.55,
    color: "var(--body)",
    textWrap: "pretty",
    // Мобильная карточка клиента (раздел «Последние события») задаёт родителю
    // ВЕРХНИЙ РЕГИСТР, разрядку и жирность заголовков — и всё это наследовалось
    // репликами (кадр 25.09.2026: «АССАЛОМУ АЛЕЙКУМ, АГЕНТИИ ROYAL HOME»). Текст
    // разговора — не заголовок: сбрасываем наследование явно, где бы блок ни стоял.
    textTransform: "none",
    letterSpacing: "normal",
    fontWeight: 400,
    textAlign: "left",
    ...(mobile ? {} : { maxHeight: "60vh", overflowY: "auto", paddingRight: 6 }),
  };

  return (
    <div style={containerStyle}>
      {blocks.map((block, i) => {
        const segments = buildSegments(block.text, block.system ? [] : findEntities(block.text), matches[i] ?? []);
        const rendered = renderSegments(segments, currentMatchIndex, currentMatchRef);

        if (block.system) {
          return (
            <p
              key={i}
              style={{ margin: "0 0 10px", textAlign: "center", fontSize: "var(--fs-13)", color: "var(--faint)", whiteSpace: "pre-wrap" }}
            >
              {rendered}
            </p>
          );
        }

        if (block.speakerSide) {
          const mine = block.speakerSide === "agent";
          return (
            <div
              key={i}
              style={{ display: "flex", justifyContent: mine ? "flex-end" : "flex-start", marginBottom: 8 }}
            >
              <div
                style={{
                  // На телефоне лента и так отдаёт репликам узкую колонку (слева
                  // «рельса» хронологии) — пузырь берёт почти всю ширину, иначе
                  // таджикская реплика в три слова растягивается на десять строк.
                  maxWidth: mobile ? "96%" : "82%",
                  padding: "8px 12px",
                  borderRadius: 14,
                  background: mine ? "var(--pill)" : "var(--soft)",
                  color: mine ? "var(--pill-ink)" : "var(--ink)",
                }}
              >
                <div style={{ fontSize: "var(--fs-13)", opacity: 0.7, marginBottom: 2 }}>{block.speakerLabel}</div>
                <div style={{ whiteSpace: "pre-wrap" }}>{rendered}</div>
              </div>
            </div>
          );
        }

        return (
          <p key={i} style={{ margin: "0 0 10px", whiteSpace: "pre-wrap" }}>
            {rendered}
          </p>
        );
      })}
    </div>
  );
}

/* ---------------------------------------------------------------------- */
/* Компонент целиком                                                       */
/* ---------------------------------------------------------------------- */

export function TranscriptView({ text, translation, agentName, durationSec, onRetranscribe, retranscribing }: TranscriptViewProps) {
  const wide = useMatchMedia("(min-width: 960px)");
  const mobile = useMatchMedia("(max-width: 640px)");
  const [mode, setMode] = useState<"original" | "ru">("original");
  const [sideBySide, setSideBySide] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [matchIndex, setMatchIndex] = useState(0);
  const [copied, setCopied] = useState(false);
  const currentMatchRef = useRef<HTMLElement | null>(null);

  // Рядом — только на широком экране: на узком колонки не поместятся, там
  // остаётся прежний переключатель «оригинал/перевод».
  const showSideBySide = sideBySide && wide && !!translation;
  const primaryText = showSideBySide ? text : mode === "ru" && translation ? translation : text;

  const blocks = useMemo(() => parseBlocks(primaryText ?? "", agentName), [primaryText, agentName]);
  const translationBlocks = useMemo(() => (translation ? parseBlocks(translation, agentName) : []), [translation, agentName]);
  const blockMatches = useMemo(() => findBlockMatches(blocks, searchTerm), [blocks, searchTerm]);
  const matches = useMemo(() => blockMatches.flat(), [blockMatches]);

  useEffect(() => {
    setMatchIndex(0);
  }, [searchTerm, primaryText]);

  useEffect(() => {
    if (matches.length === 0) return;
    const clamped = ((matchIndex % matches.length) + matches.length) % matches.length;
    if (clamped !== matchIndex) setMatchIndex(clamped);
  }, [matches.length, matchIndex]);

  useEffect(() => {
    currentMatchRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [matchIndex, searchTerm]);

  async function handleCopy() {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Буфер обмена закрыт настройками браузера — тихо промолчать, текст и
      // так выделяется руками (Ctrl+C работает без кнопки-подтверждения).
    }
  }

  if (!text) {
    return <span style={{ color: "var(--faint)" }}>Расшифровки нет.</span>;
  }

  const inputStyle: CSSProperties = {
    minHeight: 36,
    padding: "0 12px",
    borderRadius: "var(--r-sm)",
    border: "1px solid var(--line)",
    background: "var(--card)",
    color: "var(--ink)",
    fontSize: "var(--fs-13)",
    minWidth: 0,
    flex: "1 1 160px",
  };

  // Кнопки панели — компактные «таблетки» в ряд, не растягиваются на всю ширину
  // (в мобильной карточке клиента родитель делал их блочными столбиком).
  const pillStyle: CSSProperties = { flex: "0 0 auto", whiteSpace: "nowrap", textTransform: "none", letterSpacing: "normal" };

  return (
    // Те же сбросы наследования, что у текста реплик (см. containerStyle):
    // блок стоит внутри чужих секций (карточка, «Звонки», «Надзор»), и их
    // заголовочные стили не должны просачиваться в панель и подписи.
    <div style={{ textTransform: "none", letterSpacing: "normal", fontWeight: 400, textAlign: "left" }}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "var(--s2)", marginBottom: "var(--s2)" }}>
        <div className="sec-t" style={{ margin: 0 }}>
          Расшифровка{typeof durationSec === "number" && durationSec > 0 ? ` · ${formatDuration(durationSec)}` : ""}
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--s2)", marginLeft: "auto" }}>
          <button type="button" className="pill ghost sm" style={pillStyle} onClick={handleCopy}>
            {copied ? "Скопировано" : "Скопировать"}
          </button>
          {translation && wide && (
            <button type="button" className="pill ghost sm" style={pillStyle} onClick={() => setSideBySide((v) => !v)}>
              {showSideBySide ? "Скрыть перевод рядом" : "Перевод рядом"}
            </button>
          )}
          {onRetranscribe && (
            <button type="button" className="pill ghost sm" style={pillStyle} onClick={onRetranscribe} disabled={!!retranscribing}>
              {retranscribing ? "Расшифровываем…" : "Расшифровать заново"}
            </button>
          )}
        </div>
      </div>

      {translation && !showSideBySide && (
        <div className="wrap" style={{ marginBottom: "var(--s2)", padding: 0, maxWidth: "none" }}>
          {(["original", "ru"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              aria-pressed={mode === m}
              className={`pill sm${mode === m ? "" : " ghost"}`}
            >
              {m === "ru" ? "По-русски" : "Как сказал клиент"}
            </button>
          ))}
        </div>
      )}

      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "var(--s2)", marginBottom: "var(--s3)" }}>
        <input
          type="text"
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          placeholder="Найти в тексте…"
          aria-label="Поиск по расшифровке"
          style={inputStyle}
        />
        {searchTerm.trim() && (
          <span className="note">{matches.length ? `${matchIndex + 1} из ${matches.length}` : "Не найдено"}</span>
        )}
        {matches.length > 1 && (
          <>
            <button
              type="button"
              className="pill ghost sm"
              onClick={() => setMatchIndex((i) => (i - 1 + matches.length) % matches.length)}
              aria-label="Предыдущее совпадение"
            >
              Назад
            </button>
            <button
              type="button"
              className="pill ghost sm"
              onClick={() => setMatchIndex((i) => (i + 1) % matches.length)}
              aria-label="Следующее совпадение"
            >
              Далее
            </button>
          </>
        )}
      </div>

      <div style={showSideBySide ? { display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--s4)" } : undefined}>
        <TranscriptBody
          blocks={blocks}
          matches={blockMatches}
          currentMatchIndex={matchIndex}
          currentMatchRef={currentMatchRef}
          mobile={mobile}
        />
        {showSideBySide && translation && (
          <TranscriptBody blocks={translationBlocks} matches={[]} currentMatchIndex={-1} mobile={mobile} />
        )}
      </div>
    </div>
  );
}
