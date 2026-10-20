import { useCallback, useEffect, useRef, useState } from "react";
import { Activity, CheckCircle2, Instagram, RotateCw } from "lucide-react";
import { useCan } from "../lib/permissions";
import { api } from "../lib/api";
import { exactDateTime } from "../lib/format";
import { SettingsTabs } from "../components/SectionTabs";

interface StuckWorkItem {
  id: string;
  type: string;
  /** Название типа задания по-русски — приходит с сервера (lib/stuckWork.ts). */
  typeLabel?: string;
  status: "GIVEN_UP" | "PENDING" | "RUNNING";
  label: string;
  ownerAgentId: string | null;
  ownerAgentName: string | null;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  runAt: string;
  updatedAt: string;
}

interface StuckInstagramContainer {
  id: string;
  status: "REJECTED" | "EXPIRED";
  kind: string;
  error: string | null;
  createdAt: string;
  propertyShortId: number;
  propertyTitle: string;
}

/** Шаг «Показать ещё» и потолок — те же, что у сервера (lib/stuckWork.ts). */
const GIVEN_UP_STEP = 50;
const GIVEN_UP_MAX = 1000;

interface StuckWorkData {
  givenUp: StuckWorkItem[];
  hanging: StuckWorkItem[];
  counts: { givenUp: number; hanging: number };
  instagramContainers: StuckInstagramContainer[];
}

const STATUS_LABEL: Record<StuckWorkItem["status"], string> = {
  GIVEN_UP: "сдалось",
  PENDING: "висит в очереди",
  RUNNING: "зависло в исполнении",
};

/**
 * «Что не доехало» — экран /stuck-work (владелец 21.09.2026): очередь
 * фоновых заданий (BackgroundJob, jobs/runner.ts) умеет повторять сама, но до
 * этого экрана никто не видел глазами, что именно застряло и что сдалось.
 * Повод — объект №114: ролик принят, но выкат посреди публикации оставил его
 * молча «не опубликован» до утра.
 *
 * ТРИ РАЗНЫХ СПИСКА, НЕ ОДИН (см. lib/stuckWork.ts на сервере):
 *  - «Сдалось» (GIVEN_UP) — попытки исчерпаны, работу нужно либо повторить,
 *    либо решить руками (лестница попыток себя исчерпала не просто так);
 *  - «Висит сейчас» — просроченный PENDING/зависший RUNNING: тик очереди
 *    (раз в минуту) с этим ещё не разобрался, живой признак перегрузки;
 *  - Ролики Instagram, которые Meta не смогла обработать (REJECTED/EXPIRED,
 *    другой механизм — `lib/instagramPendingContainers.ts`, не BackgroundJob) —
 *    отдельной секцией и без кнопки «Повторить»: протухший creation_id Meta
 *    повторно опрашивать бессмысленно, публикация начнётся заново обычным
 *    путём монтажа. Контейнеры, которые Meta ещё обрабатывает (PENDING),
 *    сюда не попадают — это НЕ застрявшая работа, она сама доедет.
 *
 * Право то же, что у «Здоровья системы» (auditLog.view): экран того же
 * назначения — то, что CRM не смогла сделать сама.
 */
export function StuckWork() {
  const can = useCan();
  const allowed = can("auditLog.view");
  const [data, setData] = useState<StuckWorkData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState<string | null>(null);
  /**
   * «ПОКАЗАТЬ ЕЩЁ» У «СДАЛОСЬ» (02.10.2026, владелец: «нет кнопки пагинации»).
   * Сервер отдаёт первые `givenUpLimit` сдавшихся, счётчик — честный COUNT.
   * Кнопка растит предел: список перечитывается целиком, поэтому «Повторить»
   * посреди него не сдвигает и не задваивает строки, как сдвигала бы страница.
   */
  const [givenUpLimit, setGivenUpLimit] = useState(GIVEN_UP_STEP);
  const [loadingMore, setLoadingMore] = useState(false);
  // Ответ на старый предел, пришедший после нового, не должен его затирать.
  const requestSeq = useRef(0);

  const load = useCallback(() => {
    const seq = ++requestSeq.current;
    return api<StuckWorkData>(`/stuck-work?givenUpLimit=${givenUpLimit}`)
      .then((res) => {
        if (seq !== requestSeq.current) return;
        setData(res);
        setLoadError(null);
      })
      .catch((err: unknown) => {
        if (seq !== requestSeq.current) return;
        setLoadError(err instanceof Error ? err.message : "Список не загрузился");
      });
  }, [givenUpLimit]);

  useEffect(() => {
    if (!allowed) return;
    void load().finally(() => setLoadingMore(false));
  }, [allowed, load]);

  async function retry(id: string) {
    setRetrying(id);
    try {
      await api(`/stuck-work/${id}/retry`, { method: "POST" });
      load();
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Не удалось поставить задание обратно в очередь");
    } finally {
      setRetrying(null);
    }
  }

  if (!allowed) {
    return (
      <div className="rh2 screens">
        <div className="scr">
          <div className="pg-h">
            <div>
              <h1>Что не доехало</h1>
            </div>
          </div>
          <div className="card tight">
            <div className="empty">
              <span className="ic">
                <Activity className="i" aria-hidden />
              </span>
              <p>Этот раздел доступен только тем, у кого есть право на журнал ошибок.</p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const givenUp = data?.givenUp ?? [];
  const hanging = data?.hanging ?? [];
  const instagramContainers = data?.instagramContainers ?? [];
  const nothingStuck = data && givenUp.length === 0 && hanging.length === 0 && instagramContainers.length === 0;

  function renderRow(item: StuckWorkItem) {
    return (
      <div className="row wrapt" key={item.id}>
        <span className={`dot ${item.status === "GIVEN_UP" ? "crit" : "warn"}`} aria-hidden="true" />
        <div className="t">
          <b>{item.label}</b>
          <span>
            {item.typeLabel ?? "Фоновое задание"} · {STATUS_LABEL[item.status]} · попытка {item.attempts}/{item.maxAttempts}
            {item.ownerAgentName ? ` · ${item.ownerAgentName}` : ""}
          </span>
          {item.lastError && <span className="quiet crit">{item.lastError}</span>}
        </div>
        <span className="meta">{exactDateTime(item.updatedAt)}</span>
        <button
          className="pill ghost sm"
          type="button"
          disabled={retrying === item.id}
          onClick={() => retry(item.id)}
        >
          <RotateCw className="i" aria-hidden />
          {retrying === item.id ? "Ставлю…" : "Повторить"}
        </button>
      </div>
    );
  }

  return (
    <div className="rh2 screens">
      <div className="scr" data-stagger>
        <div className="pg-h">
          <div>
            <h1>Что не доехало</h1>
            <p className="sub">
              Фоновые задания, которые сдались или зависли, и ролики Instagram, которые Meta не смогла обработать —
              то, что CRM не доделала сама.
            </p>
          </div>
        </div>

        <SettingsTabs />

        {loadError && (
          <div className="card tight">
            <div className="state err">
              <span className="dot crit" /> {loadError}
            </div>
          </div>
        )}

        {!data && !loadError ? (
          <div className="card tight">
            <div className="state">
              <span className="sk w40" /> Загружаем список
            </div>
          </div>
        ) : nothingStuck ? (
          <div className="card tight">
            <div className="quiet">
              <CheckCircle2 className="i" style={{ color: "var(--ok)" }} aria-hidden />
              <span className="txt">Всё доехало — ни одно фоновое задание не сдалось и не висит.</span>
            </div>
          </div>
        ) : (
          <>
            {givenUp.length > 0 && (
              <div className="card tight">
                <div className="sec-h">
                  <h2>Сдалось</h2>
                  <span className="note">{data?.counts.givenUp ?? givenUp.length}</span>
                </div>
                <div className="list">{givenUp.map(renderRow)}</div>
                {data && data.counts.givenUp > givenUp.length && givenUpLimit < GIVEN_UP_MAX && (
                  <div className="flex items-center justify-center px-4 py-3">
                    <button
                      type="button"
                      className="pill ghost sm"
                      disabled={loadingMore}
                      onClick={() => {
                        setLoadingMore(true);
                        setGivenUpLimit((n) => Math.min(n + GIVEN_UP_STEP, GIVEN_UP_MAX));
                      }}
                    >
                      {loadingMore ? "Загружаем…" : `Показать ещё (${data.counts.givenUp - givenUp.length})`}
                    </button>
                  </div>
                )}
              </div>
            )}

            {hanging.length > 0 && (
              <div className="card tight">
                <div className="sec-h">
                  <h2>Висит сейчас</h2>
                  <span className="note">{data?.counts.hanging ?? hanging.length}</span>
                </div>
                <div className="list">{hanging.map(renderRow)}</div>
              </div>
            )}

            {instagramContainers.length > 0 && (
              <div className="card tight">
                <div className="sec-h">
                  <h2>Instagram: ролики не дошли</h2>
                  <span className="note">{instagramContainers.length}</span>
                </div>
                <div className="list">
                  {instagramContainers.map((c) => (
                    <div className="row wrapt" key={c.id}>
                      <span className="ic" style={{ "--c": "var(--crit)" } as React.CSSProperties}>
                        <Instagram className="i" aria-hidden />
                      </span>
                      <div className="t">
                        <b>
                          Объект №{c.propertyShortId} «{c.propertyTitle}»
                        </b>
                        <span>
                          {c.kind === "STORY" ? "история" : "ролик в ленту"} ·{" "}
                          {c.status === "EXPIRED" ? "контейнер протух (сутки)" : "Meta отклонила"}
                        </span>
                        {c.error && <span className="quiet crit">{c.error}</span>}
                      </div>
                      <span className="meta">{exactDateTime(c.createdAt)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

