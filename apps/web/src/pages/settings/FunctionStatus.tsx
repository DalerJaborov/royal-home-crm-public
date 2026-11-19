import { useState } from "react";
import { Link } from "react-router-dom";
import {
  FUNCTION_GROUPS,
  FUNCTION_STATE_LABELS,
  canViewFunctionStatus,
  type FunctionCron,
  type FunctionState,
  type FunctionStatusItem,
} from "@royal-home/shared";
import { useAuthStore } from "../../store/auth";
import { useFunctionStatus } from "../../hooks/useFunctionStatus";
import { exactDateTime } from "../../lib/format";
import { SETTINGS_TABS } from "../../lib/settingsTabs";
import { Rh2ErrorState } from "../../components/rh2/Rh2ErrorState";
import { Skeleton } from "../../components/rh2/Skeleton";
import { scrollableRegion } from "../../lib/a11y";
import { useRoyalLook } from "../../hooks/useRoyalLook";
import { AdminRoot } from "../../components/look/admin/AdminRoot";
import { RhCircle } from "../../components/look/ui";
import type { RoyalIconName } from "../../components/look/royalIconData";

/**
 * «Состояние функций» (14.11.2026): один экран про все скрытые рубильники CRM — что работает, что идёт
 * «только для проверки» (клиенту и наружу ничего не уходит), что выключено и ПОЧЕМУ. Данные считает
 * сервер по реестру packages/shared/src/functionStatus.ts. Один адаптивный экран для ПК и телефона.
 * Видят только директор и администратор: имена серверных переменных — мелким шрифтом, значения не показываются.
 */

const STATE_CHIP: Record<FunctionState, string> = { working: "chip ok", preview: "chip warn", off: "chip mute" };
const STATE_DOT: Record<FunctionState, string> = { working: "dot ok", preview: "dot warn", off: "dot" };
/** Новый вид: круг 48 по смыслу — норма зелёная, «только проверка» янтарная, выключено спокойное;
 *  «Обратите внимание» — сплошной красный с пламенем (яркость и значок, не только оттенок). */
const STATE_CIRCLE: Record<FunctionState, { icon: RoyalIconName; tone: "ok" | "warn" | "a0" }> = {
  working: { icon: "list-checks", tone: "ok" },
  preview: { icon: "eye", tone: "warn" },
  off: { icon: "x-circle", tone: "a0" },
};

const CRON_HEALTH_TEXT: Record<FunctionCron["health"], { label: string; chip: string }> = {
  ok: { label: "в порядке", chip: "chip ok" },
  failing: { label: "последний запуск упал", chip: "chip crit" },
  stale: { label: "давно не запускалась", chip: "chip warn" },
  never: { label: "ещё не запускалась", chip: "chip mute" },
};

/** Человеческая подпись фоновой задачи: имя на латинице остаётся мелко, рядом — понятное слово. */
const CRON_TITLES: Record<string, string> = {
  "bot-pause-watch": "Сторож пауз бота",
  "seller-control-episodes": "Контроль продавцов и кандидатов",
  "narration-auto-flow": "Автоозвучка",
  "narration-version-delivery": "Отправка озвучки монтажёру",
  "owner-report-delivery": "Отправка отчётов собственникам",
  "owner-report-monthly-preview": "Подготовка месячных отчётов",
  "market-weekly-crawl": "Сбор Somon, раз в неделю",
  "market-paydo-daily": "Сбор Paydo, ночной",
  "market-paydo-incremental": "Сбор Paydo, свежее",
  "market-somon-incremental": "Сбор Somon, свежее",
  "market-own-match": "Сопоставление рынка с нашими объектами",
  "director-alert-queue-flush": "Доставка тревог руководству",
  "somon-owner-leads": "Заявки с Somon собственникам",
  "somon-owner-leads-silence": "Сторож тишины заявок Somon",
  "live-voice-spend-ceiling": "Потолок минут робота",
  "live-voice-orphan-sweep": "Уборка зависших звонков робота",
  "live-calls-sweep": "Досчёт живых звонков",
  "post-showing-call": "Опрос после показа",
  "seller-probe-call": "Проверка продавца звонком",
  "interview-invite-call": "Приглашение на собеседование",
  "owner-exposure-verification-preview": "Проверка собственников (план)",
  "approved-owner-verification": "Проверка собственников (утверждённые)",
};

function when(iso: string | null): string {
  return iso ? exactDateTime(iso) : "ещё не было";
}

function tabLabel(id: string): string {
  return SETTINGS_TABS.find((t) => t.id === id)?.label ?? "Настройки";
}

function CronLine({ cron }: { cron: FunctionCron }) {
  const h = CRON_HEALTH_TEXT[cron.health];
  return (
    <li className="fs-cron">
      <span className="fs-cron-name">
        {CRON_TITLES[cron.name] ?? cron.name}
        {CRON_TITLES[cron.name] ? <code className="fs-code"> {cron.name}</code> : null}
      </span>
      <span className="fs-cron-when">последний запуск: {when(cron.lastRunAt)}</span>
      <span className={h.chip}>{h.label}</span>
      {cron.lastError ? <span className="fs-err">Ошибка: {cron.lastError}</span> : null}
    </li>
  );
}

function FunctionRow({ item, royal }: { item: FunctionStatusItem; royal: boolean }) {
  return (
    <div className="row fs-item" data-state={item.state}>
      {royal ? (
        item.attention ? <RhCircle icon="flame" tone="crit" /> : <RhCircle icon={STATE_CIRCLE[item.state].icon} tone={STATE_CIRCLE[item.state].tone} />
      ) : (
        <span className={STATE_DOT[item.state]} aria-hidden="true" />
      )}
      <div className="t fs-body">
        <b>{item.title}</b>
        <div className="fs-chips">
          <span className={STATE_CHIP[item.state]}>{FUNCTION_STATE_LABELS[item.state]}</span>
          {item.attention ? <span className="chip crit">Обратите внимание</span> : null}
        </div>
        <p className="fs-what">{item.what}</p>
        <p className="fs-reason">{item.reason}</p>
        {item.detail ? <p className="fs-detail">{item.detail}</p> : null}
        {item.crons.length > 0 ? (
          <ul className="fs-crons" aria-label={`Фоновые задачи: ${item.title}`}>
            {item.crons.map((c) => (
              <CronLine key={c.name} cron={c} />
            ))}
          </ul>
        ) : null}
        {item.lastError ? (
          <p className="fs-err">
            Последняя ошибка ({exactDateTime(item.lastError.at)}): {item.lastError.message}
          </p>
        ) : null}
        <div className="fs-foot">
          {item.envNames.length > 0 ? (
            <span className="fs-env">
              Управляет сервер: {item.envNames.map((n) => (
                <code className="fs-code" key={n}>
                  {n}
                </code>
              ))}
            </span>
          ) : null}
          {item.settingsTab ? (
            <Link className="lnk" to={`/settings?tab=${item.settingsTab}`}>
              Открыть: Настройки, «{tabLabel(item.settingsTab)}»
            </Link>
          ) : null}
        </div>
      </div>
    </div>
  );
}

type Filter = "all" | "attention" | FunctionState;

export function FunctionStatus() {
  const agent = useAuthStore((s) => s.agent);
  const allowed = canViewFunctionStatus(agent?.role);
  const query = useFunctionStatus(allowed);
  const [filter, setFilter] = useState<Filter>("all");
  const royal = useRoyalLook();

  if (!allowed) {
    return (
      <AdminRoot royal={royal} title="Состояние функций">
        <div className="scr">
          <div className="pg-h">
            <div>
              <h1>Состояние функций</h1>
              <p className="sub">Раздел доступен только директору и администратору.</p>
            </div>
          </div>
        </div>
      </AdminRoot>
    );
  }

  const data = query.data;
  const visible = (data?.items ?? []).filter((i) =>
    filter === "all" ? true : filter === "attention" ? i.attention : i.state === filter,
  );
  const filters: { id: Filter; label: string; n: number }[] = data
    ? [
        { id: "all", label: "Все", n: data.items.length },
        { id: "attention", label: "Внимание", n: data.summary.attention },
        { id: "working", label: "Работают", n: data.summary.working },
        { id: "preview", label: "Только проверка", n: data.summary.preview },
        { id: "off", label: "Выключены", n: data.summary.off },
      ]
    : [];

  return (
    <AdminRoot royal={royal} title="Состояние функций">
      <div className="scr">
        <div className="pg-h">
          <div>
            <Link className="lnk" to="/settings?tab=system" style={{ paddingLeft: 0 }}>
              <svg className="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 6 }}>
                <path d="M15 6l-6 6 6 6" />
              </svg>
              Настройки
            </Link>
            <h1 style={{ marginTop: 4 }}>Состояние функций</h1>
            <p className="sub">
              Что в CRM включено по-настоящему, что идёт только «для проверки» (клиентам и наружу ничего не уходит), а что
              выключено, и почему. Если функция не работает, а тумблер в Настройках включён, причина будет написана здесь.
            </p>
          </div>
        </div>

        {query.isLoading ? (
          <div className="card" role="status" aria-label="Загрузка">
            <Skeleton kind="tile" className="h-16" />
            <Skeleton kind="tile" className="mt-3 h-16" />
            <Skeleton kind="tile" className="mt-3 h-16" />
          </div>
        ) : query.isError || !data ? (
          <div className="card">
            <Rh2ErrorState message="Не удалось загрузить состояние функций. Попробуйте ещё раз." onRetry={() => void query.refetch()} retrying={query.isFetching} />
          </div>
        ) : (
          <>
            <div className="card">
              <div className="fs-filters" role="group" aria-label="Показать функции">
                {filters.map((f) => (
                  <button
                    key={f.id}
                    type="button"
                    className={`chip fs-filter${filter === f.id ? " on" : ""}`}
                    aria-pressed={filter === f.id}
                    onClick={() => setFilter(f.id)}
                  >
                    {f.label} · {f.n}
                  </button>
                ))}
              </div>
              <p className="quiet">
                <span className="dot" />
                <span className="txt">Обновлено {exactDateTime(data.generatedAt)}. Значения серверных переменных не показываются.</span>
              </p>
            </div>

            {visible.length === 0 ? (
              <div className="card">
                <p className="quiet">
                  <span className="dot ok" />
                  <span className="txt">В этом списке ничего нет.</span>
                </p>
              </div>
            ) : (
              FUNCTION_GROUPS.map((g) => {
                const rows = visible.filter((i) => i.group === g.id);
                if (rows.length === 0) return null;
                return (
                  <section key={g.id} aria-label={g.title}>
                    <div className="sec-t">{g.title}</div>
                    <div className="card tight">
                      <div className="list">
                        {rows.map((i) => (
                          <FunctionRow key={i.key} item={i} royal={royal} />
                        ))}
                      </div>
                    </div>
                  </section>
                );
              })
            )}

            <section aria-label="Все фоновые задачи">
              <div className="sec-t">Все фоновые задачи · {data.crons.length}</div>
              <div className="card tight">
                {data.crons.length === 0 ? (
                  <p className="quiet">
                    <span className="dot" />
                    <span className="txt">Ни одна фоновая задача ещё не отметилась: сервер задач, видимо, только что запущен.</span>
                  </p>
                ) : (
                  <details className="fs-all">
                    <summary>
                      Показать список ({data.crons.filter((c) => c.health === "failing" || c.health === "stale").length} требуют внимания)
                    </summary>
                    <div {...scrollableRegion("Фоновые задачи и их последний запуск")}>
                      <ul className="fs-crons fs-crons-all">
                        {data.crons.map((c) => (
                          <CronLine key={c.name} cron={c} />
                        ))}
                      </ul>
                    </div>
                  </details>
                )}
              </div>
            </section>
          </>
        )}
      </div>
    </AdminRoot>
  );
}

/** Вход на экран: карточка на вкладке «Данные и система» (видна директору и администратору). */
export function FunctionStatusEntry() {
  const agent = useAuthStore((s) => s.agent);
  const allowed = canViewFunctionStatus(agent?.role);
  const query = useFunctionStatus(allowed);
  if (!allowed) return null;
  const s = query.data?.summary;
  return (
    <div className="quiet fs-entry">
      <span className={s && s.attention > 0 ? "dot warn" : "dot ok"} />
      <span className="txt">
        <b>Состояние функций.</b>{" "}
        {s
          ? `Работают ${s.working}, только проверка ${s.preview}, выключены ${s.off}${s.attention > 0 ? `; требуют внимания: ${s.attention}` : ""}.`
          : "Что включено, что работает только для проверки и почему."}
      </span>
      <Link className="pill ghost" to="/settings/functions">
        Открыть
      </Link>
    </div>
  );
}
