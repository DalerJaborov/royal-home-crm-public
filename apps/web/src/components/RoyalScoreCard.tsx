import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { Rh2ScoreRing } from "./rh2/Rh2ScoreRing";

/**
 * Кабинет Royal Score в Профиле: два места, живой счёт, динамика, расшифровка
 * по шести показателям и журнал.
 *
 * Требование спецификации владельца — ОБЪЯСНИМОСТЬ: агент всегда понимает, почему
 * у него такой рейтинг. С 03.08.2026 счёт считается прямо по журналу событий
 * (решение владельца, см. lib/scoreJournal.ts) — поэтому точное объяснение
 * «какое действие» даёт журнал ниже («Что повлияло на счёт»), а расшифровка по
 * шести показателям владельца (продажи/скорость/CRM/объекты/задачи/дисциплина)
 * группирует те же события крупными блоками — «откуда набежало», а не построчно.
 */

interface RoyalScoreView {
  /** Официальный счёт — кэш Agent.kpi, обновляется ночью; то же число видят
   *  распределение лидов и TOP AGENTS. */
  score: number;
  /** Живой счёт с учётом сегодняшних событий — предпросмотр до ночного пересчёта. */
  liveScore: number;
  /** Место среди активных агентов. */
  rank: number;
  totalAgents: number;
  /** Место среди ВСЕХ агентов компании (включая приостановленных/замороженных). */
  companyRank: number;
  totalCompanyAgents: number;
  activeClients: number;
  freeSlots: number | null;
  history: { date: string; score: number }[];
  /** Динамика счёта; null у периода — истории ещё не набралось. */
  dynamics: { day: number | null; week: number | null; month: number | null };
  /** Расшифровка по шести показателям владельца — сумма событий за окно по
   *  категориям (не формула: вес — только подпись, не множитель). */
  categoryBreakdown: Record<string, number>;
  /** Журнал: что и почему повлияло на счёт. Пусто — событий ещё не было. */
  events: ScoreEvent[];
  /** Справочник «действие → баллы» (владелец 03.09.2026): за что какой плюс и
   *  минус — не с чужих слов, а прямо в кабинете агента. */
  pointsGuide: { kind: string; category: string; label: string; points: number }[];
  /** Живой ИИ-совет, кэш на сутки; null — ещё не генерировался или отказ модели. */
  advice: { text: string; updatedAt: string } | null;
}

/** Те же шесть показателей и веса, что в scoreJournal.ts::ROYAL_SCORE_CATEGORIES —
 *  дублируются сознательно (лейбл для интерфейса, сервер остаётся источником
 *  истины по числам). */
const CATEGORY_LABELS: { key: string; label: string; weightPercent: number }[] = [
  { key: "sales", label: "Продажи", weightPercent: 40 },
  { key: "speed", label: "Скорость обработки лидов", weightPercent: 20 },
  { key: "crm", label: "Работа с CRM", weightPercent: 15 },
  { key: "properties", label: "Работа с объектами", weightPercent: 10 },
  { key: "tasks", label: "Выполнение задач", weightPercent: 10 },
  { key: "discipline", label: "Дисциплина", weightPercent: 5 },
];

interface ScoreEvent {
  id: string;
  at: string;
  kind: string;
  delta: number;
  reason: string;
  /** Кто это сделал; null — система. */
  initiator: string | null;
}

export function RoyalScoreCard() {
  const queryClient = useQueryClient();
  const [adviceLoading, setAdviceLoading] = useState(false);
  const [adviceError, setAdviceError] = useState(false);
  /** Справочник «Как считаются баллы» свёрнут по умолчанию — см. ниже. */
  const [guideOpen, setGuideOpen] = useState(false);
  const { data } = useQuery({
    queryKey: ["me", "royal-score"],
    queryFn: () => api<RoyalScoreView>("/me/royal-score"),
    // Живой счёт считается на лету по журналу — раз в минуту достаточно.
    refetchInterval: 60_000,
  });
  if (!data) return null;

  async function refreshAdvice() {
    setAdviceLoading(true);
    setAdviceError(false);
    try {
      const advice = await api<{ text: string; updatedAt: string }>("/me/royal-score/advice", { method: "POST" });
      queryClient.setQueryData<RoyalScoreView>(["me", "royal-score"], (prev) => (prev ? { ...prev, advice } : prev));
    } catch {
      setAdviceError(true);
    } finally {
      setAdviceLoading(false);
    }
  }

  // Мини-график из истории: простые столбики без библиотек — 30 точек не стоят
  // графической зависимости.
  const maxScore = Math.max(...data.history.map((h) => h.score), 100);
  const liveDelta = data.liveScore - data.score;

  return (
    <section className="card">
      <div className="sec-h stack">
        <h2>Мой Royal Score</h2>
        <span className="note">
          в компании {data.companyRank} из {data.totalCompanyAgents}, среди активных {data.rank} из {data.totalAgents}
        </span>
      </div>

      {/* Кольцо с радужными делениями (Salesforce-кейс «AI Scoring 92»,
          бриф цветного слоя): счёт крупно и сразу, до разбора по показателям.
          Показывается ЖИВОЙ счёт — тот, который отвечает на вопрос «сколько у
          меня прямо сейчас»; официальный, обновляемый ночью, остался плиткой
          ниже вместе с объяснением, чем он отличается. */}
      <div style={{ display: "flex", justifyContent: "center", padding: "var(--s4) 0 var(--s2)" }}>
        <Rh2ScoreRing
          score={data.liveScore}
          label={`Royal Score ${data.liveScore}, в компании ${data.companyRank} из ${data.totalCompanyAgents}`}
          /* Подпись внутри кольца ограничена дыркой венца (~97 px при 132):
             «с учётом сегодня» вылезало на деления — замер 11.09. */
          caption="сегодня"
        />
      </div>

      <div className="tiles" style={{ gridTemplateColumns: "1fr 1fr" }}>
        <div className="tile">
          <span className="hd">Счёт сейчас</span>
          <b>{data.score}</b>
          <small>обновляется ночью</small>
        </div>
        <div className="tile">
          <span className="hd">С учётом сегодня</span>
          <b>{data.liveScore}</b>
          <small>{liveDelta === 0 ? "без изменений" : liveDelta > 0 ? `+${liveDelta} за сегодня` : `${liveDelta} за сегодня`}</small>
        </div>
        <div className="tile">
          <span className="hd">Клиентов в работе</span>
          <b>{data.activeClients}</b>
          <small>
            {data.freeSlots === null
              ? "лимит не задан"
              : data.freeSlots === 0
                ? "мест нет, новые лиды не придут"
                : `свободно мест: ${data.freeSlots}`}
          </small>
        </div>
        <div className="tile">
          <span className="hd">Динамика</span>
          <b>{data.dynamics.week === null ? "нет" : data.dynamics.week > 0 ? `+${data.dynamics.week}` : data.dynamics.week}</b>
          <small>за неделю</small>
        </div>
      </div>

      {/* Мини-график из истории: простые столбики без библиотек, 30 точек не
          стоят графической зависимости. Полоса `.prog` из прототипа под ряд
          столбиков не подходит, поэтому столбики нарисованы токенами темы. */}
      {data.history.length > 1 && (
        <div
          style={{ display: "flex", alignItems: "flex-end", gap: 3, height: 40, marginTop: 12 }}
          title="Динамика за последние дни"
        >
          {data.history.map((h) => (
            <span
              key={h.date}
              title={`${h.date}: ${h.score}`}
              style={{
                flex: 1,
                minWidth: 3,
                maxWidth: 14,
                borderRadius: "3px 3px 0 0",
                background: "var(--track)",
                height: `${Math.max(8, (h.score / maxScore) * 100)}%`,
              }}
            />
          ))}
        </div>
      )}

      <p className="state">
        За день:{" "}
        {data.dynamics.day === null ? "нет данных" : data.dynamics.day > 0 ? `+${data.dynamics.day}` : data.dynamics.day}. За
        неделю:{" "}
        {data.dynamics.week === null ? "нет данных" : data.dynamics.week > 0 ? `+${data.dynamics.week}` : data.dynamics.week}.
        За месяц:{" "}
        {data.dynamics.month === null ? "нет данных" : data.dynamics.month > 0 ? `+${data.dynamics.month}` : data.dynamics.month}.
      </p>

      {/* Живой ИИ-совет: персонализированный текст, не жёсткие правила (решение
          владельца 05.08.2026). Кэш на сутки на сервере, кнопка «Обновить»
          обходит его по требованию и не тратит деньги на каждое открытие. */}
      <div className="mod">
        <div className="t">
          <b>Совет, как поднять счёт</b>
          <span>
            {adviceError
              ? "Не получилось получить совет, попробуйте ещё раз."
              : data.advice
                ? data.advice.text
                : "Рекомендации ещё не готовы. Нажмите «Обновить», чтобы получить первую."}
          </span>
          {data.advice && !adviceError && (
            <span>
              Совет от ИИ, не гарантия. Обновлено{" "}
              {new Date(data.advice.updatedAt).toLocaleString("ru-RU", { timeZone: "Asia/Dushanbe",
                day: "numeric",
                month: "short",
                hour: "2-digit",
                minute: "2-digit",
              })}
            </span>
          )}
        </div>
        <div className="acts">
          <button className="pill ghost sm" type="button" onClick={refreshAdvice} disabled={adviceLoading}>
            {adviceLoading ? "Считаем" : "Обновить"}
          </button>
        </div>
      </div>

      {/* РАСШИФРОВКА: шесть показателей владельца, крупными блоками. Ноль по
          категории не прячем: «ничего не произошло» тоже ответ на вопрос
          «откуда набежал счёт». */}
      <div className="sec-t">Из чего складывается счёт</div>
      <div className="list">
        {CATEGORY_LABELS.map(({ key, label, weightPercent }) => {
          const value = data.categoryBreakdown[key] ?? 0;
          return (
            <div className="row" key={key}>
              <div className="t">
                <b>{label}</b>
                <span>вес {weightPercent} %</span>
              </div>
              <span className="meta">{value > 0 ? `+${value}` : value}</span>
            </div>
          );
        })}
      </div>

      {/* СПРАВОЧНИК: полная таблица «действие → баллы», по требованию владельца
          03.09.2026 — «чтобы агенты видели за что какой минус и плюс и как
          вообще работает наша система», не с чужих слов, а прямо в CRM.
          Свёрнуто по умолчанию — справочник, не то, что смотрят каждый день. */}
      {data.pointsGuide.length > 0 && (
        <>
          <button
            type="button"
            className="sec-t lnk"
            onClick={() => setGuideOpen((v) => !v)}
            aria-expanded={guideOpen}
          >
            Как считаются баллы
          </button>
          {guideOpen &&
            CATEGORY_LABELS.map(({ key, label }) => {
              const rows = data.pointsGuide.filter((r) => r.category === key);
              if (rows.length === 0) return null;
              return (
                <div key={key}>
                  <div className="quiet">
                    <span className="txt">{label}</span>
                  </div>
                  <div className="list">
                    {rows.map((r) => (
                      <div className="row" key={r.kind}>
                        <div className="t">
                          <b>{r.label}</b>
                        </div>
                        <span className="meta">{r.points > 0 ? `+${r.points}` : r.points || "0"}</span>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
        </>
      )}

      {/* ЖУРНАЛ: единственное объяснение счёта. Имя того, кто правил счёт вручную,
          показывается всегда, но с 03.08.2026 такой правки быть не может
          (Fair Play, см. scoreJournal.ts): initiator виден только у исторических
          записей, оставшихся от старой модели. */}
      <div className="sec-t">Что повлияло на счёт</div>
      {data.events.length > 0 ? (
        <div className="list">
          {data.events.slice(0, 8).map((e) => (
            <div className="row" key={e.id}>
              <div className="t">
                <b>{e.reason}</b>
                <span>{e.initiator ? e.initiator : "система"}</span>
              </div>
              <span className="meta">{e.delta > 0 ? `+${e.delta}` : e.delta || "0"}</span>
            </div>
          ))}
        </div>
      ) : (
        <p className="state">Пока ничего не повлияло на счёт.</p>
      )}
    </section>
  );
}
