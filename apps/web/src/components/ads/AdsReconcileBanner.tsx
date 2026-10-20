import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import type { AdIssue } from "@royal-home/shared";
import { useAdReconcile, type AdPeriodPreset } from "../../hooks/useAds";
import { agoRu, formatPct } from "../../lib/adsView";
import { ApiError } from "../../lib/apiError";
import { formatMoneyExact, pluralizeRu } from "../../lib/format";

/**
 * ПЛАШКА СВЕРКИ — «CRM сходится с кабинетом Meta» (03.10.2026).
 *
 * Зелёная — расхождение в допуске и проблем нет; красная — число проблем и
 * раскрываемый список. Данные `GET /ads/reconcile`, обновляются раз в минуту и по
 * кнопке. Текст «проверено N минут назад» пересчитывается по таймеру, а не
 * только при новом ответе: иначе «только что» висело бы десять минут.
 *
 * `aria-live="polite"` на внешней обёртке: когда сверка позеленела или покраснела,
 * диктор скажет об этом сам, без перехода по странице.
 *
 * НЕ ВРЁМ. Пока ответа нет — скелет, упал запрос — честное «сверка не
 * загрузилась» с повтором (это не «всё сошлось» и не «всё разошлось»). Если
 * Meta не ответила (`metaTotalTjs === null`), зелёным это не называем.
 */
export function AdsReconcileBanner(props: ReconcileProps) {
  // Живая область стоит снаружи и не пересоздаётся: внутри ветки меняются, а
  // диктор объявляет смену именно у уже существующей области.
  return (
    <div aria-live="polite" aria-atomic="true">
      <ReconcileBody {...props} />
    </div>
  );
}

interface ReconcileProps {
  preset: AdPeriodPreset;
  /** Исправить объявление из списка проблем: окно привязки или вкладка с ним. */
  onFixAd: (adId: string) => void;
  /** Проблема без конкретного объявления — к списку «Привязать». */
  onGoUnmatched: () => void;
}

/**
 * РАСКЛАДКА СТРОКИ ПЛАШКИ. `.quiet` — флекс-строка без переноса, а текстовая колонка
 * `.txt` в нём `flex:1; min-width:0`: на 375 px две кнопки справа занимали почти всю
 * ширину, колонка текста схлопывалась до нуля и фраза шла по одной букве в строке
 * (замер 03.10.2026). Теперь строка переносится, у текста своя разумная база
 * (12 rem), а кнопки уходят под него. Инлайн, а не в `theme-2026-*.css`: эти
 * файлы собираются из макета, и правка в них пропадёт при синхронизации.
 */
const ROW_STYLE = { flexWrap: "wrap" } as const;
const TXT_STYLE = { flex: "1 1 12rem", minWidth: 0 } as const;
const ACT_STYLE = { display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, maxWidth: "100%" } as const;

function ReconcileBody({ preset, onFixAd, onGoUnmatched }: ReconcileProps) {
  const q = useAdReconcile(preset);
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(t);
  }, []);

  // Нет права на сверку или сервер её ещё не отдаёт — плашке нечего сказать, и
  // красная «ошибка» там, где человек ничего не может сделать, только пугает.
  if (q.isError && q.error instanceof ApiError && (q.error.status === 403 || q.error.status === 404)) return null;

  const refresh = (
    <button className="pill ghost sm" type="button" onClick={() => void q.refetch()} disabled={q.isFetching}>
      <RefreshCw className="i" aria-hidden /> {q.isFetching ? "Проверяем…" : "Проверить сейчас"}
    </button>
  );

  if (q.isLoading) {
    return (
      <div className="card tight">
        <div className="state">
          <span className="sk w40" />
          <span className="sk w22" /> Сверяем расходы с кабинетом Meta
        </div>
      </div>
    );
  }

  if (q.isError || !q.data) {
    return (
      <div className="card tight">
        <div className="quiet warn" style={ROW_STYLE}>
          <span className="dot warn" />
          <span className="txt" style={TXT_STYLE}>
            Сверка с кабинетом Meta не загрузилась — сходятся ли цифры, сейчас неизвестно.
          </span>
          <div style={ACT_STYLE}>{refresh}</div>
        </div>
      </div>
    );
  }

  const r = q.data;
  const ago = agoRu(r.checkedAt, now);
  const metaSilent = r.metaTotalTjs === null;
  const problems = r.issues.length;
  const good = r.ok && problems === 0 && !metaSilent;

  if (good) {
    return (
      <div className="card tight">
        <div className="quiet" style={ROW_STYLE}>
          <span className="dot ok" />
          <span className="txt" style={TXT_STYLE}>
            CRM сходится с кабинетом Meta
            {r.diffPct !== null ? ` (расхождение ${formatPct(Math.abs(r.diffPct))})` : ""}, проверено {ago}.
          </span>
          <div style={ACT_STYLE}>{refresh}</div>
        </div>
      </div>
    );
  }

  return (
    <div className="card tight">
      <div className="quiet crit" style={ROW_STYLE}>
        <span className="dot crit" />
        <span className="txt" style={TXT_STYLE}>
          {problems > 0 ? (
            <>
              Есть расхождения с кабинетом Meta: {problems} {pluralizeRu(problems, ["проблема", "проблемы", "проблем"])}
              {r.diffPct !== null ? `, по деньгам ${formatPct(Math.abs(r.diffPct))}` : ""}.
            </>
          ) : (
            <>Meta не ответила — сверить деньги не удалось.</>
          )}{" "}
          Проверено {ago}.
        </span>
        <div style={ACT_STYLE}>
          {problems > 0 && (
            <button className="lnk" type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
              {open ? "Скрыть список" : "Показать список"}
            </button>
          )}
          {refresh}
        </div>
      </div>

      {r.metaTotalTjs !== null && (
        <p className="state" style={{ paddingTop: 0 }}>
          В CRM {formatMoneyExact(r.crmTotalTjs, "TJS")}, в кабинете Meta {formatMoneyExact(r.metaTotalTjs, "TJS")}.
        </p>
      )}

      {open && problems > 0 && (
        <div className="list">
          {r.issues.map((issue, i) => (
            <IssueRow key={`${issue.kind}-${issue.adId ?? "all"}-${i}`} issue={issue} onFixAd={onFixAd} onGoUnmatched={onGoUnmatched} />
          ))}
        </div>
      )}
    </div>
  );
}

const FIX_LABEL: Record<AdIssue["kind"], string | null> = {
  NO_OBJECT: "Привязать",
  ASSETS_NOT_LINKED: "Привязать объекты",
  SHARE_SUM_BROKEN: "Поправить доли",
  SPEND_MISMATCH: null,
  STALE_SYNC: null,
  AD_REJECTED: null,
};

function IssueRow({
  issue,
  onFixAd,
  onGoUnmatched,
}: {
  issue: AdIssue;
  onFixAd: (adId: string) => void;
  onGoUnmatched: () => void;
}) {
  const label = FIX_LABEL[issue.kind];
  const action = label
    ? issue.adId
      ? () => onFixAd(issue.adId as string)
      : issue.kind === "NO_OBJECT"
        ? onGoUnmatched
        : null
    : null;
  return (
    <div className="prow wrapt" style={{ minHeight: 0 }}>
      <div className="t">
        <b>{issue.text}</b>
      </div>
      {action && label && (
        <div className="act">
          <button className="pill ghost sm" type="button" onClick={action}>
            {label}
          </button>
        </div>
      )}
    </div>
  );
}
