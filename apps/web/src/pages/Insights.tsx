import { useEffect, useState } from "react";
import { Sparkles, FileSearch } from "lucide-react";
import { MobileInsights } from "../components/mobile/MobileInsights";
import { InsightCaseCard, formatDayMonth } from "../components/insights/InsightCaseCard";
import { DigestStatusBadge, GenerateDigestButton, TeamTalkingPoints, formatPeriod, pluralCases } from "../components/insights/DigestBits";
import { useInsightCases, useInsightDigests } from "../hooks/useInsights";
import { useMobileUx } from "../hooks/useMobileUx";
import { MoneyTabs } from "../components/SectionTabs";
import { Rh2ErrorState } from "../components/rh2/Rh2ErrorState";
import { Rh2EmptyState } from "../components/rh2/Rh2EmptyState";

/**
 * «Инсайты от ИИ» — тема «Royal Home 2026», эталон `screens/insights.html`.
 *
 * Порядок блоков и разметка из макета: шапка `.pg-h` с кнопкой «Собрать
 * сейчас» в `.acts`, секция «Выпуски» — сегмент `.seg` в `.hscroll` (в макете
 * выпуски переключаются вкладками, а не левой колонкой), охват выпуска тихой
 * строкой `.quiet`, секция «Кейсы выпуска» и состояния `.empty` / `.state`.
 *
 * Заголовок оставлен продуктовым — «Инсайты от ИИ», как в меню
 * (`lib/navigation.ts`). В эталоне он переименован в «Разбор к собранию» по
 * правилу владельца §6.3 («ИИ» не выносим в заголовок); переименование
 * затрагивает и пункт меню, поэтому вынесено решением владельца, а не сделано
 * молча в переносе облика.
 */
export function Insights() {
  const mobile = useMobileUx();
  if (mobile) return <MobileInsights />;
  return <DesktopInsights />;
}

function DesktopInsights() {
  const digests = useInsightDigests();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  useEffect(() => {
    if (!selectedId && digests.data?.[0]) setSelectedId(digests.data[0].id);
  }, [digests.data, selectedId]);
  const cases = useInsightCases(selectedId);
  const selected = digests.data?.find((d) => d.id === selectedId) ?? null;

  return (
    <div className="rh2 screens">
      <div className="scr">
        <div className="pg-h">
          <div>
            <h1>Инсайты от ИИ</h1>
            <p className="sub">
              Кейсы «клиент и агент» к собраниям 15-го и 30-го числа: что было сказано не так, как надо
              было, и запись разговора рядом.
            </p>
          </div>
          <div className="acts">
            <GenerateDigestButton />
          </div>
        </div>

        <MoneyTabs />

        {digests.isLoading ? (
          <div className="card tight">
            <div className="state">
              <span className="sk w40" />
              <span className="sk w22" /> Загружаем выпуски
            </div>
          </div>
        ) : digests.isError ? (
          <div className="card tight">
            <Rh2ErrorState
              message="Не удалось загрузить выпуски. Попробуйте ещё раз."
              onRetry={() => digests.refetch()}
              retrying={digests.isRefetching}
            />
          </div>
        ) : !digests.data || digests.data.length === 0 ? (
          <div className="card tight">
            <Rh2EmptyState
              icon={Sparkles}
              title="Выпусков пока нет."
              hint="Первый соберётся 15-го или 30-го числа, либо соберите сейчас."
              action={<GenerateDigestButton />}
            />
          </div>
        ) : (
          <>
            <section className="card">
              <div className="sec-h stack">
                <h2>Выпуски</h2>
                <span className="note">Собираются сами 15-го и 30-го числа</span>
              </div>
              <div className="hscroll">
                <div className="seg" role="tablist" aria-label="Выпуски">
                  {digests.data.map((d) => (
                    <button
                      key={d.id}
                      type="button"
                      role="tab"
                      aria-selected={selectedId === d.id}
                      onClick={() => setSelectedId(d.id)}
                    >
                      {formatPeriod(d)} <span className="n">{d.caseCount}</span>
                    </button>
                  ))}
                </div>
              </div>

              {selected && (
                <div className="quiet" style={{ marginTop: 12 }}>
                  <span className={`dot ${selected.status === "READY" ? "ok" : selected.status === "FAILED" ? "crit" : "warn"}`} />
                  <span className="txt">
                    Собрание {formatDayMonth(selected.meetingAt)}, {selected.caseCount}{" "}
                    {pluralCases(selected.caseCount)}. Источники: звонков {selected.coverage.calls}, отобрано{" "}
                    {selected.coverage.analyzed}, штрафов {selected.coverage.penalties}.
                  </span>
                  <DigestStatusBadge status={selected.status} />
                </div>
              )}
              {/* Второй предупреждающий блок макета («сборка прервалась,
                  Досбирать») — без кнопки: generateInsightDigest идемпотентен
                  по periodStart (apps/api/src/lib/insightDigestRunner.ts) —
                  если выпуск за этот период уже создан (в любом статусе,
                  включая PARTIAL), повторный вызов вернёт тот же id и не
                  доразберёт ни одного кейса. Кнопка «Досбирать» без рабочего
                  ретрая была бы честнее не рисовать, чем рисовать нерабочей. */}
              {selected?.status === "PARTIAL" && (
                <div className="quiet warn">
                  <span className="dot warn" />
                  <span className="txt">
                    Выпуск собран частично: не все кейсы разобраны ИИ.
                    {selected.coverage.error ? ` Причина: ${selected.coverage.error}.` : ""}
                  </span>
                </div>
              )}
            </section>

            <section className="card">
              <div className="sec-h stack">
                <h2>Кейсы выпуска</h2>
                <span className="note">Каждый кейс: что сказано, как надо было, запись</span>
              </div>
              {cases.isLoading ? (
                <div className="state">
                  <span className="sk w40" />
                  <span className="sk w22" /> Загружаем кейсы
                </div>
              ) : cases.isError ? (
                <Rh2ErrorState
                  message="Не удалось загрузить кейсы. Попробуйте ещё раз."
                  onRetry={() => cases.refetch()}
                  retrying={cases.isRefetching}
                />
              ) : cases.data && cases.data.length > 0 && selectedId ? (
                cases.data.map((c) => <InsightCaseCard key={c.id} item={c} digestId={selectedId} />)
              ) : (
                <Rh2EmptyState icon={FileSearch} title="В этом выпуске кейсов нет." />
              )}
            </section>

            {/* «О чём поговорить с командой»: прозаической сводки выпуска
                (три главных темы недели текстом) наш диджест не считает —
                вердикт есть ПО КАЖДОМУ кейсу отдельно (InsightVerdict.summary),
                а обобщение значило бы придумать алгоритм, которого нет в
                apps/api, и выдать его за «понял ИИ». Честная замена — топ-3
                категории уже загруженных кейсов ПО ЧИСЛАМ (topCaseCategories,
                DigestBits.tsx), подписанная прямо как счёт, а не пересказ. */}
            {selected && cases.data && <TeamTalkingPoints cases={cases.data} />}
          </>
        )}
      </div>
    </div>
  );
}
