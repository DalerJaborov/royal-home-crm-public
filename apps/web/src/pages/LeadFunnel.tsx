import { Link } from "react-router-dom";
import { useAuthStore } from "../store/auth";
import { useClientsSummary } from "../hooks/useClients";
import { Rh2Screen } from "../components/rh2/Rh2Screen";
import { ClientsTabs } from "../components/ClientsTabs";
import { ClientsSectionLane } from "../components/ClientsSectionLane";

/**
 * «Воронка лидов» — экран `/lead-funnel`, макет «Royal Home 2026 · мобильная
 * навигация» (c99db05f), функция `renderFunnel`
 * (`docs/pult/theme-2026/artifact-c99db05f-mobile-nav-14-09.html`, ~строка 1711):
 * четыре строки-счётчика «Новые / В работе / Ждут решения / Закрыты».
 *
 * НЕ ПУТАТЬ с существующим разделом «Воронка» (`pages/Funnel.tsx`, `/funnel`) —
 * там лид-магниты и кампании маркетинга, это раздел трогать нельзя и незачем:
 * совсем другая сущность, совпало только слово в названии макета.
 *
 * ДАННЫЕ ЧЕСТНЫЕ — макет рисовал выдуманные числа (14/22/6/9), здесь стадии
 * посчитаны на сервере из настоящего `ClientStatus` (`GET /clients/summary`,
 * поле `stages`, та же граница прав `scopeToOwnAgent`, что и у счётчиков
 * «Покупатели»/«Продавцы» на той же сводке):
 *   Новые          — NEW
 *   В работе       — CONTACTED + HOT
 *   Ждут решения   — COLD + UNRESPONSIVE
 *   Закрыты        — DEAL_CLOSED + LOST
 *
 * Один экран на компьютер и телефон (правило CLAUDE.md, уже так сделано для
 * Sources/Reports/Profile и др.) — четыре одинаковые строки не расходятся по
 * ширине, отдельный `MobileLeadFunnel.tsx` был бы чистым дублем разметки без
 * своей логики. Переход по строке — только там, где список «Клиенты» реально
 * умеет отфильтровать: `GET /clients` принимает ОДИН статус в `?status=`
 * (`packages/shared/src/querySchemas.ts`), поэтому кликабельна только
 * «Новые» (`status=NEW`); у трёх остальных стадий фильтр состоит из ДВУХ
 * статусов сразу — такого фильтра список не поддерживает, строка честно не
 * кликается, а не ведёт на список, где счётчик и цифра разъедутся.
 */
export function LeadFunnel() {
  // Та же граница, что у пункта меню «Клиенты» (lib/navigation.ts, isSalesRole):
  // маркетинг и редактор не ведут покупателей/продавцов, воронка им не нужна.
  const role = useAuthStore((s) => s.agent?.role);
  const isSalesRole = role !== "MARKETING" && role !== "EDITOR";

  if (!isSalesRole) {
    return (
      <Rh2Screen>
        <div className="pg-h">
          <div>
            <h1>Воронка лидов</h1>
          </div>
        </div>
        <div className="card tight">
          <div className="state">Раздел про покупателей и продавцов недоступен вашей роли.</div>
        </div>
      </Rh2Screen>
    );
  }

  return <LeadFunnelScreen />;
}

const STAGES: {
  key: "new" | "inProgress" | "awaitingDecision" | "closed";
  label: string;
  chip: "mute" | "ok" | "warn";
  /** Только у «Новые» список клиентов умеет отфильтровать по одному статусу. */
  status?: string;
}[] = [
  { key: "new", label: "Новые", chip: "mute", status: "NEW" },
  { key: "inProgress", label: "В работе", chip: "ok" },
  { key: "awaitingDecision", label: "Ждут решения", chip: "warn" },
  { key: "closed", label: "Закрыты", chip: "mute" },
];

function LeadFunnelScreen() {
  const { data, isLoading, error, refetch } = useClientsSummary();

  return (
    <Rh2Screen>
      <div className="pg-h">
        <div>
          <h1>Воронка лидов</h1>
          <p className="sub">Покупатели и продавцы по стадиям — из карточек клиентов, без выдуманных цифр.</p>
        </div>
      </div>

      <div className="card">
        {/* Та же лента вкладок, что у «Клиентов»/«Сделок» (перенос из меню
            15.09.2026, components/ClientsTabs.tsx) — воронка тоже срез общего
            списка, а не отдельная сущность. */}
        <ClientsTabs
          counts={data ? { clients: data.buyers, sellers: data.sellers, other: data.other, lost: data.lost } : undefined}
        />
        <ClientsSectionLane section="BUYER" />

        {error && (
          <div className="state err">
            <span className="dot crit" />
            Список не загрузился.
            <button
              className="lk"
              type="button"
              style={{ color: "inherit", textDecoration: "underline" }}
              onClick={() => refetch()}
            >
              Повторить
            </button>
          </div>
        )}

        {isLoading && !error && (
          <div className="state">
            <span className="sk w40" />
            <span className="sk w22" />
            Загружаем
          </div>
        )}

        {!isLoading && !error && (
          <div className="list" style={{ marginTop: 8 }}>
            {STAGES.map((stage) => {
              const count = data?.stages[stage.key] ?? 0;
              const row = (
                <>
                  <div className="t">
                    <b>{stage.label}</b>
                  </div>
                  <span className={`chip ${stage.chip}`}>{count}</span>
                </>
              );
              return stage.status ? (
                // kind=all: число в строке считает покупателей и продавцов вместе (WEB-PAGES06).
                <Link key={stage.key} className="row" to={`/clients?status=${stage.status}&kind=all`}>
                  {row}
                </Link>
              ) : (
                <div key={stage.key} className="row">
                  {row}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </Rh2Screen>
  );
}
