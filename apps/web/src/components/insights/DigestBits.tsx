import { Loader2, RefreshCw } from "lucide-react";
import { CASE_KIND_LABEL, formatDayMonth } from "./InsightCaseCard";
import { useGenerateInsightDigest, type InsightCaseView, type InsightDigestSummary } from "../../hooks/useInsights";
import { useCan } from "../../lib/permissions";
import { pluralizeRu } from "../../lib/format";

/**
 * Мелкие общие куски экрана «Инсайты от ИИ» для десктопа и телефона.
 * Облик — тема «Royal Home 2026»: метка выпуска `.chip`, кнопка сборки
 * `.pill.ghost` (в эталоне `screens/insights.html` она стоит в `.pg-h .acts`).
 */

const STATUS_LABEL: Record<InsightDigestSummary["status"], string> = {
  READY: "готов",
  PARTIAL: "частично: не все кейсы разобраны ИИ",
  FAILED: "сборка не удалась",
  GENERATING: "собирается…",
};

export function DigestStatusBadge({ status }: { status: InsightDigestSummary["status"] }) {
  const tone = status === "READY" ? "chip ok" : status === "FAILED" ? "chip crit" : "chip warn";
  return <span className={tone}>{STATUS_LABEL[status]}</span>;
}

export function formatPeriod(d: InsightDigestSummary): string {
  return `${formatDayMonth(d.periodStart)} — ${formatDayMonth(d.periodEnd)}`;
}

export function GenerateDigestButton({ compact }: { compact?: boolean }) {
  const can = useCan();
  const generate = useGenerateInsightDigest();
  if (!can("settings.manage")) return null;
  return (
    <button
      className={compact ? "pill ghost sm" : "pill ghost"}
      type="button"
      onClick={() => generate.mutate()}
      disabled={generate.isPending}
      title="Собрать выпуск за текущие две недели прямо сейчас (обычно это делает крон 15-го и 30-го)"
    >
      {generate.isPending ? <Loader2 className="i" aria-hidden /> : <RefreshCw className="i" aria-hidden />}
      Собрать сейчас
    </button>
  );
}

export function pluralCases(n: number): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return "кейс";
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return "кейса";
  return "кейсов";
}

/**
 * Топ-3 категории кейсов выпуска по числу — честная замена «сводке выпуска».
 *
 * Диджест хранит вердикт ПО КАЖДОМУ кейсу (InsightVerdict.summary), а общую
 * сводку выпуска (три главных темы недели прозой) ничего не считает — ни
 * apps/api, ни модель за это не отвечают, придумывать такой алгоритм значило
 * бы выдать его за «понял ИИ», а это не так. Но кейсы уже размечены категорией
 * (kind, тот же список, что в CASE_KIND_LABEL), и посчитать, каких кейсов в
 * выпуске больше всего, — честные числа, а не текст, поэтому подпись называет
 * их прямо: «по числам кейсов».
 *
 * Считается тут же, из уже загруженного списка кейсов выпуска (GET
 * /insights/:id отдаёт их все, без предела — см. routes/insights.ts): второй
 * запрос ради того же самого был бы лишним походом в базу.
 */
export function topCaseCategories(cases: InsightCaseView[]): { kind: InsightCaseView["kind"]; count: number }[] {
  const counts = new Map<InsightCaseView["kind"], number>();
  for (const c of cases) counts.set(c.kind, (counts.get(c.kind) ?? 0) + 1);
  return [...counts.entries()]
    .map(([kind, count]) => ({ kind, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 3);
}

/**
 * «О чём поговорить с командой» — топ-3 категории кейсов выпуска по числу,
 * честно подписанные «по числам кейсов» (не прозаическая сводка от ИИ, см.
 * topCaseCategories выше). Общий для десктопа (pages/Insights.tsx) и телефона
 * (components/mobile/MobileInsights.tsx) — один и тот же расчёт и разметка.
 */
export function TeamTalkingPoints({ cases }: { cases: InsightCaseView[] }) {
  const top = topCaseCategories(cases);
  return (
    <section className="card">
      <div className="sec-h stack">
        <h2>О чём поговорить с командой</h2>
        <span className="note">Топ-3 темы выпуска — по числам кейсов, не прозой</span>
      </div>
      {top.length === 0 ? (
        <div className="empty">
          <p>В этом выпуске кейсов нет — говорить не о чем.</p>
        </div>
      ) : (
        <div className="list">
          {top.map((row) => (
            <div className="row" key={row.kind}>
              <div className="t">
                <b>{CASE_KIND_LABEL[row.kind]}</b>
              </div>
              <span className="chip">
                {row.count} {pluralizeRu(row.count, ["кейс", "кейса", "кейсов"])}
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
