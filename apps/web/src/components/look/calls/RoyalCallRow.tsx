import type { ReactNode } from "react";
import { CallIcon, type CallGlyphName } from "./CallIcon";

/**
 * СТРОКА ЗВОНКА «НОВОГО ВИДА» (пачка calls, 18.11.2026) — одна разметка на пять
 * прежних строк: журнал разговоров и журнал входящих на ПК (pages/Calls.tsx),
 * те же два журнала руководителя и лента агента на телефоне
 * (components/mobile/MobileCalls.tsx). Только вид: данные, права и действия
 * приходят готовыми от прежних строк, здесь ни одного запроса.
 *
 * Состав по заданию владельца: значок направления в круге, кто, с кем,
 * длительность, время, ОДНА кнопка справа («Слушать» — раскрыть запись и разбор,
 * или «Перезвонить»). Пропущенный отличается не только цветом: свой значок
 * (трубка с крестиком), сплошной красный круг и красная подпись словом.
 * Ничего из прежней строки не прячется: суть разбора и все пометки (балл, «без
 * договорённости», «никто не перезвонил», «без перезвона N ч» и т. п.) стоят
 * строкой меток и переносятся, а не обрезаются.
 */
export type RoyalCallDir = "out" | "in" | "missed";

const DIR_ICON: Record<RoyalCallDir, CallGlyphName> = {
  out: "phone-outgoing",
  in: "phone-incoming",
  missed: "phone-missed",
};

/** Метка строки: срочно — сплошная красная с пламенем, внимание — янтарная с «!», норма — зелёная. */
export type RoyalCallFlagTone = "crit" | "warn" | "ok" | "mute";

export function RoyalCallFlag({ tone, children }: { tone: RoyalCallFlagTone; children: ReactNode }) {
  return (
    <span className="ry-call-flag" data-tone={tone}>
      {tone === "crit" && <CallIcon name="flame" size={16} />}
      {tone === "warn" && <CallIcon name="circle-alert" size={16} />}
      {children}
    </span>
  );
}

/** Тон балла разбора — тот же порог, что у прежнего `scoreTone` (CallDetails.tsx). */
export function scoreFlagTone(tone: string): RoyalCallFlagTone {
  return tone === "ok" || tone === "warn" || tone === "crit" ? tone : "mute";
}

/**
 * «Слушать»: раскрывает запись, расшифровку и разбор под строкой (то же
 * состояние open, что у прежней кнопки «Открыть разбор»). Длительность — на
 * самой кнопке, как в макете.
 */
export function RoyalCallListen({ open, onToggle, controls, duration, compact = false }: {
  open: boolean; onToggle: () => void; controls: string; duration: string;
  /** Телефон: круг 44 без подписи (длительность — в строке и в aria-label), рядом — круг звонка. */
  compact?: boolean;
}) {
  return (
    <button
      type="button"
      className="ry-call-listen"
      data-compact={compact ? "" : undefined}
      onClick={onToggle}
      aria-expanded={open}
      aria-controls={controls}
      aria-label={open ? `Свернуть разбор, разговор ${duration}` : `Слушать и открыть разбор, разговор ${duration}`}
    >
      <CallIcon name="play" size={20} />
      {!compact && <span className="ry-num">{duration}</span>}
    </button>
  );
}

export function RoyalCallRow({ dir, dirLabel, title, meta, note, flags, action, details }: {
  dir: RoyalCallDir;
  /** Направление словом — для экранного чтеца (значок без подписи). */
  dirLabel: string;
  title: ReactNode;
  /** Кто/с кем/когда/сколько — короткие части через точку. Переносятся целиком. */
  meta: (string | null | undefined | false)[];
  /** Суть разговора (разбор) — отдельной строкой, без обрезки. */
  note?: ReactNode;
  /** Пометки строки (RoyalCallFlag) и редкие действия («Больше не звонить»). */
  flags?: ReactNode;
  /** Одна главная кнопка справа. */
  action?: ReactNode;
  /** Раскрытая запись и разбор под строкой. */
  details?: ReactNode;
}) {
  const parts = meta.filter((part): part is string => typeof part === "string" && part.length > 0);
  return (
    <div className="ry-call" data-dir={dir}>
      <div className="ry-call-row">
        <span className="ry-call-dir" data-dir={dir} role="img" aria-label={dirLabel}>
          <CallIcon name={DIR_ICON[dir]} />
        </span>
        <div className="ry-call-text">
          <span className="ry-call-title">{title}</span>
          {parts.length > 0 && (
            <span className="ry-call-meta" data-tone={dir === "missed" ? "crit" : undefined}>
              {parts.map((part, i) => (
                <span key={i} className="ry-call-part">{part}</span>
              ))}
            </span>
          )}
          {note && <span className="ry-call-note">{note}</span>}
          {flags && <span className="ry-call-flags">{flags}</span>}
        </div>
        {action && <div className="ry-call-action">{action}</div>}
      </div>
      {details}
    </div>
  );
}
