import type { CSSProperties } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { dushanbeDate } from "../lib/date";
import { Rh2Sheet } from "./rh2/Rh2Sheet";

interface MetricScore {
  earned: number;
  max: number;
}

type Breakdown = Partial<Record<string, MetricScore>>;

interface KpiHistory {
  id: string;
  fullName: string;
  kpi: number | null;
  days: { date: string; score: number; breakdown: Breakdown | null }[];
}

/** Метрики честного KPI (см. ТЗ и apps/api/src/kpi.ts) — подписи и веса для людей. */
const METRIC_LABELS: Record<string, { label: string; weight: number; hint: string }> = {
  response: { label: "Скорость ответа на лид", weight: 20, hint: "до 5 минут полный балл, до 15 минут половина" },
  crm: { label: "Работа с CRM", weight: 20, hint: "задачи дня выполнены вовремя" },
  discipline: { label: "Дисциплина", weight: 20, hint: "нет просроченных «хвостов» задач" },
  photo: { label: "Фото объекта", weight: 10, hint: "не меньше 15 фото у опубликованных объектов" },
  video: { label: "Видео объекта", weight: 10, hint: "видео-обзор у опубликованных объектов" },
  contract: { label: "Заключение договора", weight: 20, hint: "закрытая сделка оформлена с комиссией" },
  personalLeads: { label: "Личные лиды", weight: 10, hint: "привёл клиента сам и заполнил карточку" },
  cards: { label: "Заполнение карточек", weight: 10, hint: "бюджет, район и запрос у принятых клиентов" },
};

const METRIC_ORDER = ["response", "crm", "discipline", "photo", "video", "contract", "personalLeads", "cards"];

function dayLabel(iso: string) {
  // Дата KPI-дня — душанбинская полночь (= 19:00 UTC прошлого дня): без timeZone
  // зритель западнее UTC+5 видел подпись на день раньше настоящей.
  return dushanbeDate(iso, { day: "numeric", month: "short" });
}

/**
 * «Из чего сложился KPI»: разбор последнего рассчитанного дня по восьми метрикам
 * (недоступные агенту в тот день метрики исключаются из расчёта и помечаются
 * «не участвовала») + мини-история за 14 дней.
 *
 * ОБЛИК — шторка `.sheet` эталона, разбор строками `.row` с полосой `.prog`
 * (ровно как «Из чего сложился счёт» в прототипе, `screens/team.html`,
 * окно `#sh-dossier`). Ловушка фокуса, Esc, блокировка фона — в `Rh2Sheet`.
 */
export function KpiBreakdownModal({
  agentId,
  onClose,
  onManualEdit,
}: {
  agentId: string;
  onClose: () => void;
  onManualEdit?: () => void;
}) {
  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ["agent-kpi", agentId],
    queryFn: () => api<KpiHistory>(`/agents/${agentId}/kpi`),
  });

  const latest = data?.days[0];
  const breakdown = latest?.breakdown ?? null;

  return (
    <Rh2Sheet
      open
      onClose={onClose}
      title="KPI, из чего сложился"
      ariaLabel="KPI, из чего сложился"
      footer={
        onManualEdit ? (
          <button
            type="button"
            className="pill ghost"
            onClick={() => {
              onClose();
              onManualEdit();
            }}
          >
            Изменить KPI вручную (запишется в журнал)
          </button>
        ) : undefined
      }
    >
      {data && <p className="kvp">{data.fullName}</p>}

      {isLoading ? (
        <p className="state">Считаем разбор…</p>
      ) : isError ? (
        /* Раньше отказ запроса выдавал не просто пустоту, а КОНКРЕТНОЕ ЛОЖНОЕ
           ОБЪЯСНЕНИЕ — «KPI ещё не рассчитывался»: агент верил, что расчёта не
           было, хотя данные просто не приехали (аудит 22.08.2026, раунд 5). */
        <p className="state err">
          <span className="dot crit" />
          {error instanceof Error ? error.message : "Не удалось загрузить разбор KPI"}
          <button type="button" className="lnk" onClick={() => void refetch()}>
            Повторить
          </button>
        </p>
      ) : !latest ? (
        <p className="state">
          KPI ещё не рассчитывался: он считается автоматически каждую ночь за прошедший день.
        </p>
      ) : (
        <>
          <div className="tiles" style={{ gridTemplateColumns: "1fr" }}>
            <div className="tile">
              <span className="hd">Счёт за {dayLabel(latest.date)}</span>
              <b>{latest.score}%</b>
            </div>
          </div>
          <p className="state">
            Считаются только задачи, которые агенту были реально доступны в этот день: недоступные метрики
            не снижают процент, а исключаются из расчёта.
          </p>

          <div className="list">
            {METRIC_ORDER.map((key) => {
              const meta = METRIC_LABELS[key];
              const m = breakdown?.[key];
              return (
                <div key={key} className="row">
                  <div className="t">
                    <b>
                      {meta.label} · вес {meta.weight}
                    </b>
                    <span>{meta.hint}</span>
                    {/* Полоса эталона: заполнение показывается шириной, а не
                        цветом — цветных полос в теме нет (договор §3). */}
                    <span className="prog" style={{ marginTop: 6 }}>
                      <i style={{ "--v": m && m.max ? m.earned / m.max : 0 } as CSSProperties} />
                    </span>
                  </div>
                  <span className="meta">{m ? `${m.earned} из ${m.max}` : "не участвовала"}</span>
                </div>
              );
            })}
          </div>

          {data && data.days.length > 1 && (
            <>
              <div className="sec-t">Последние 14 дней</div>
              <div className="list">
                {[...data.days].reverse().map((d) => (
                  <div key={d.date} className="row">
                    <div className="t">
                      <b>{dayLabel(d.date)}</b>
                      <span className="prog">
                        <i style={{ "--v": Math.max(0.02, d.score / 100) } as CSSProperties} />
                      </span>
                    </div>
                    <span className="meta">{d.score}%</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </>
      )}
    </Rh2Sheet>
  );
}
