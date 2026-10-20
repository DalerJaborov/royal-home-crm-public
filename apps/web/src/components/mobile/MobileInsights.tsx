import { useState } from "react";
import { ChevronLeft } from "lucide-react";
import { InsightCaseCard, formatDayMonth } from "../insights/InsightCaseCard";
import { DigestStatusBadge, GenerateDigestButton, TeamTalkingPoints, formatPeriod, pluralCases } from "../insights/DigestBits";
import { useInsightCases, useInsightDigests } from "../../hooks/useInsights";
import { MoneyTabs } from "../SectionTabs";

/**
 * Телефонная версия «Инсайтов от ИИ»: список выпусков → выпуск с кейсами
 * (два экрана вместо двух колонок). Карточка кейса — общая с десктопом.
 *
 * ОБЛИК — тема «Royal Home 2026»: обёртка `.rh2 > .scr`, шапка `.pg-h`,
 * выпуски строками `.row` в `.card.tight` (узкий вариант вкладок эталона),
 * состояния — `.state` и `.empty`.
 */
export function MobileInsights() {
  const digests = useInsightDigests();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const cases = useInsightCases(selectedId);
  const selected = digests.data?.find((d) => d.id === selectedId) ?? null;

  if (selected && selectedId) {
    return (
      <div className="rh2 screens">
        <div className="scr" data-stagger>
          <div className="pg-h">
            <div>
              <button className="lnk" type="button" onClick={() => setSelectedId(null)}>
                <ChevronLeft className="i" aria-hidden /> Все выпуски
              </button>
              <h1>{formatPeriod(selected)}</h1>
              <p className="sub">
                Собрание {formatDayMonth(selected.meetingAt)} · {selected.caseCount}{" "}
                {pluralCases(selected.caseCount)}
              </p>
            </div>
          </div>

          {/* Источники охвата и статус выпуска — на десктопе (pages/Insights.tsx)
              это часть строки `.quiet` под сегментами выпусков; на телефоне
              своего сегмента-переключателя нет (выпуск уже выбран открытием
              строки списка), поэтому тот же честный охват идёт отдельной тихой
              строкой сразу под шапкой — раньше он был виден только на ПК. */}
          <div className="quiet">
            <span className="txt">
              Источники: звонков {selected.coverage.calls}, отобрано {selected.coverage.analyzed}, штрафов{" "}
              {selected.coverage.penalties}.
            </span>
            <DigestStatusBadge status={selected.status} />
          </div>

          {/* Тот же честный блок «сборка прервалась», что и на десктопе
              (pages/Insights.tsx) — без кнопки «Досбирать»: повторный вызов
              generateInsightDigest для того же periodStart идемпотентен и
              ничего не доразбирает (insightDigestRunner.ts). */}
          {selected.status === "PARTIAL" && (
            <div className="card tight">
              <div className="quiet warn">
                <span className="dot warn" />
                <span className="txt">
                  Выпуск собран частично: не все кейсы разобраны ИИ.
                  {selected.coverage.error ? ` Причина: ${selected.coverage.error}.` : ""}
                </span>
              </div>
            </div>
          )}

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
              <div className="state err">
                <span className="dot crit" /> Не удалось загрузить кейсы.{" "}
                <button
                  className="lk"
                  type="button"
                  style={{ color: "inherit", textDecoration: "underline" }}
                  onClick={() => cases.refetch()}
                >
                  Повторить
                </button>
              </div>
            ) : cases.data && cases.data.length > 0 ? (
              cases.data.map((c) => <InsightCaseCard key={c.id} item={c} digestId={selectedId} />)
            ) : (
              <div className="empty">
                <p>В этом выпуске кейсов нет.</p>
              </div>
            )}
          </section>

          {/* «О чём поговорить с командой» — та же честная замена, что на
              десктопе (pages/Insights.tsx): топ-3 категории кейсов выпуска по
              числам вместо прозаической сводки, которую ничего не считает. */}
          {cases.data && <TeamTalkingPoints cases={cases.data} />}
        </div>
      </div>
    );
  }

  return (
    <div className="rh2 screens">
      <div className="scr" data-stagger>
        <div className="pg-h">
          <div>
            <h1>Инсайты от ИИ</h1>
            <p className="sub">Кейсы для собрания 15-го и 30-го числа.</p>
          </div>
          <div className="acts">
            <GenerateDigestButton compact />
          </div>
        </div>

        {/* ВКЛАДКИ РАЗДЕЛА «ДЕНЬГИ» — на телефоне их здесь не было (22.09.2026).
            Финансы, Отчёты и Источники живут одним отзывчивым экраном и показывают
            `MoneyTabs` на обеих ширинах, а у «Инсайтов» телефонная версия своя — и
            получалось, что с трёх экранов в инсайты уйти можно, а обратно нет:
            путь только через меню. Тот же класс, что красные флажки, доехавшие
            когда-то до одного ПК. Ставим там же, где на соседях, — сразу под `.pg-h`.
            В открытом выпуске вкладок нет намеренно: это вложенный экран, из него
            наверх ведёт «Все выпуски». */}
        <MoneyTabs />

        <div className="card tight">
          {digests.isLoading ? (
            <div className="state">
              <span className="sk w40" />
              <span className="sk w22" /> Загружаем выпуски
            </div>
          ) : digests.isError ? (
            <div className="state err">
              <span className="dot crit" /> Выпуски не загрузились.{" "}
              <button
                className="lk"
                type="button"
                style={{ color: "inherit", textDecoration: "underline" }}
                onClick={() => digests.refetch()}
              >
                Повторить
              </button>
            </div>
          ) : !digests.data || digests.data.length === 0 ? (
            <div className="empty">
              <p>Выпусков пока нет.</p>
              <span className="sub">Первый соберётся 15-го или 30-го числа.</span>
            </div>
          ) : (
            <div className="list">
              {digests.data.map((d) => (
                <div
                  className="row"
                  role="button"
                  tabIndex={0}
                  key={d.id}
                  onClick={() => setSelectedId(d.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setSelectedId(d.id);
                    }
                  }}
                >
                  <div className="t">
                    <b>{formatPeriod(d)}</b>
                    <span>
                      Собрание {formatDayMonth(d.meetingAt)} · {d.caseCount} {pluralCases(d.caseCount)}
                    </span>
                  </div>
                  {/* `.meta`, а не `.act`: в узком режиме эталон отдаёт
                      `.row .act` всю ширину, и метка уезжала бы на вторую строку. */}
                  <span className="meta">
                    <DigestStatusBadge status={d.status} />
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
