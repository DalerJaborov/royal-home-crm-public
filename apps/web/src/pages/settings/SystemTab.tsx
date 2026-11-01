import { useEffect, useRef, useState, useCallback } from "react";
import { useServerSyncedFields } from "../../hooks/useServerSyncedForm";
import { Link } from "react-router-dom";
import { Activity, Bot, CheckCircle2, ClipboardList, Compass, Fingerprint, History, KeyRound, OctagonAlert, RotateCw, UploadCloud } from "lucide-react";
import { api } from "../../lib/api";
import { downloadFromApi } from "../../lib/downloadFile";
import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { useAgents } from "../../hooks/useAgents";
import { useCan } from "../../lib/permissions";
import { useAuditLog } from "../../hooks/useAuditLog";
import { AUDIT_ACTION_LABELS, AUDIT_ENTITY_LABELS, auditEntityLink, auditEntityName } from "../../lib/audit";
import { relativeTime } from "../../lib/format";
import { SwitchRow } from "../../components/Switch";
import { SettingsSection } from "../../components/settings/SettingsSection";
import { Rh2ErrorState } from "../../components/rh2/Rh2ErrorState";
import { Rh2EmptyState } from "../../components/rh2/Rh2EmptyState";
import { Pagination } from "../../components/Pagination";
import { createLatestRequest } from "../../lib/latestRequest";

/** Вкладка «Данные и система»: импорт из файла, здоровье системы, админка сайта.
 *
 *  Разметка — эталон темы «Royal Home 2026» (screens/settings.html, раздел
 *  «Данные и система»): каждый раздел — раскрывающийся `.acc` (SettingsSection),
 *  внутри строки `.mod`, списки `.list`/`.row` и тихие строки `.quiet`. */

export function ImportSection() {
  const [result, setResult] = useState<{ kind: string; created: number; skipped: { row: number; error: string }[] } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const clientsRef = useRef<HTMLInputElement>(null);
  const propertiesRef = useRef<HTMLInputElement>(null);

  /** Шаблон CSV для заполнения. Отказ показываем той же строкой ошибки, что и у
   *  импорта: молчаливое «ничего не произошло» — ровно та поломка, из-за
   *  которой кнопка и переписана. */
  async function downloadTemplate(kind: "clients" | "properties") {
    setError(null);
    try {
      await downloadFromApi(`/import/${kind}/template`, `royal-home-${kind}-template.csv`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось скачать шаблон");
    }
  }

  async function handleUpload(kind: "clients" | "properties", file: File | undefined) {
    if (!file) return;
    setBusy(kind);
    setError(null);
    setResult(null);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await api<{ created: number; skipped: { row: number; error: string }[] }>(`/import/${kind}`, {
        method: "POST",
        body: form,
        isForm: true,
      });
      setResult({ kind: kind === "clients" ? "клиентов" : "объектов", ...res });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось импортировать файл");
    } finally {
      setBusy(null);
      if (clientsRef.current) clientsRef.current.value = "";
      if (propertiesRef.current) propertiesRef.current.value = "";
    }
  }

  return (
    <SettingsSection icon={UploadCloud} title="Импорт данных">
      <div className="quiet">
        <span className="dot" />
        <span className="txt">
          Перенесите существующую базу из Excel: скачайте шаблон, заполните и загрузите. Файлы CSV (Excel:
          «Сохранить как → CSV UTF-8»). Дубликаты по телефону пропускаются автоматически.
        </span>
      </div>
      <input
        ref={clientsRef}
        type="file"
        accept=".csv,text/csv"
        style={{ display: "none" }}
        onChange={(e) => handleUpload("clients", e.target.files?.[0])}
      />
      <input
        ref={propertiesRef}
        type="file"
        accept=".csv,text/csv"
        style={{ display: "none" }}
        onChange={(e) => handleUpload("properties", e.target.files?.[0])}
      />
      <div className="wrap" style={{ marginTop: "var(--s3)" }}>
        <button className="pill ghost sm" type="button" onClick={() => clientsRef.current?.click()} disabled={busy !== null}>
          <UploadCloud className="i" aria-hidden="true" />
          {busy === "clients" ? "Импорт..." : "Импорт клиентов"}
        </button>
        <button
          className="pill ghost sm"
          type="button"
          onClick={() => propertiesRef.current?.click()}
          disabled={busy !== null}
        >
          <UploadCloud className="i" aria-hidden="true" />
          {busy === "properties" ? "Импорт..." : "Импорт объектов"}
        </button>
        {/* Кнопки, а не ссылки: адрес шаблона закрыт правом import.run, и
            обычная ссылка браузера уходит туда без заголовка авторизации —
            сервер отвечает 401, а человек видит, что «ничего не скачалось»
            (поймано 19.09.2026). Файл забирается через api(), см.
            lib/downloadFile.ts. */}
        <button className="lk" type="button" onClick={() => downloadTemplate("clients")}>
          шаблон клиентов
        </button>
        <button className="lk" type="button" onClick={() => downloadTemplate("properties")}>
          шаблон объектов
        </button>
      </div>

      <details className="mod" style={{ display: "block" }}>
        <summary style={{ cursor: "pointer" }}>
          <b>Какие столбцы нужны для клиентов?</b>
        </summary>
        <ul style={{ margin: "var(--s2) 0 0", paddingLeft: "1.2em", color: "var(--muted)" }}>
          <li>
            <b>Имя</b> — обязательно
          </li>
          <li>
            <b>Телефон</b> — обязательно, в формате +992…
          </li>
          <li>Email — необязательно</li>
          <li>Источник — например Instagram, Сайт, Рекомендация (можно оставить пустым)</li>
          <li>Бюджет от / Бюджет до — числом, без пробелов и валюты</li>
          <li>Комнаты — числом</li>
          <li>Заметки — любой текст</li>
        </ul>
      </details>
      <details className="mod" style={{ display: "block" }}>
        <summary style={{ cursor: "pointer" }}>
          <b>Какие столбцы нужны для объектов?</b>
        </summary>
        <ul style={{ margin: "var(--s2) 0 0", paddingLeft: "1.2em", color: "var(--muted)" }}>
          <li>
            <b>Название</b>, <b>Район</b>, <b>Адрес</b>, <b>Площадь</b>, <b>Цена</b>, <b>Контакт владельца</b> — обязательно
          </li>
          <li>Тип — Квартира / Дом / Коммерческое / Участок</li>
          <li>
            <b>Комнаты</b>, <b>Этаж</b>, <b>Этажей всего</b>, <b>Окна</b> — числом, обязательно для всех, кроме участка
          </li>
          <li>Валюта — TJS или USD (по умолчанию TJS)</li>
          <li>Состояние — Требует ремонта / Хорошее / Отличное / Новостройка</li>
          <li>Район, которого ещё нет в базе — создастся автоматически</li>
        </ul>
      </details>

      {error && (
        <div className="quiet crit" role="alert">
          <span className="dot crit" />
          <span className="txt">{error}</span>
        </div>
      )}
      {result && (
        <div style={{ marginTop: "var(--s3)" }}>
          <div className="quiet">
            <span className="dot ok" />
            <span className="txt">
              Импортировано {result.kind}: {result.created}.
              {result.skipped.length > 0 && ` Пропущено строк: ${result.skipped.length}.`}
            </span>
          </div>
          {result.skipped.length > 0 && (
            <div className="list" style={{ maxHeight: 160, overflowY: "auto" }}>
              {result.skipped.slice(0, 20).map((s) => (
                <div className="row" key={s.row}>
                  <div className="t">
                    <span>
                      строка {s.row}: {s.error}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </SettingsSection>
  );
}

export function SystemHealthSection() {
  const [data, setData] = useState<HealthData | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [showResolved, setShowResolved] = useState(false);
  /**
   * ЭКСПЛУАТАЦИОННЫЙ ШУМ СКРЫТ ПО УМОЛЧАНИЮ (аудит 03.09.2026, разделы 4-5):
   * «Gemini ответил на резервной модели», «повтор помог» — CRM справилась сама,
   * человеку решать нечего. Сервер размечает каждую строку `priority`
   * (lib/errorLogClassify.ts) и по `?priority=actionable` отдаёт только то, что
   * реально ждёт решения. Полный список — один флажок.
   */
  const [showOperational, setShowOperational] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  // Экран, который существует ради показа поломок, обязан показывать и свою
  // собственную. Раньше отказ загрузки глотался пустым catch: журнал не
  // приходил, раздел выглядел просто пустым, и это читалось как «ошибок нет».
  const [loadError, setLoadError] = useState<string | null>(null);

  /**
   * «ПОКАЗАТЬ ЕЩЁ» (02.10.2026): журнал кончался на пятидесяти свежих, и
   * дальше смотреть было нечем. Страницы копятся в `data.recent`; `pages` —
   * сколько уже загружено. После отметки «Разобрался» перечитываются все
   * загруженные страницы разом: строка уходит, соседние сдвигаются, и
   * перечитать только одну значило бы потерять или задвоить строку на стыке.
   */
  const [pages, setPages] = useState(1);
  // Ответы приходят не в том порядке, в каком ушли (WEB-PAGES10): поздний ответ
  // по старому фильтру не должен ни дописаться в новый список, ни подменить его.
  // `load` берёт новый номер и держит его в `epoch`; «Показать ещё» запоминает
  // `epoch` на старте и отбрасывает ответ, если за это время начался новый `load`.
  const fence = useRef(createLatestRequest());
  const epoch = useRef(0);
  const load = useCallback((withResolved: boolean, withOperational: boolean, upTo = 1) => {
    const requestId = fence.current.next();
    epoch.current = requestId;
    const params = new URLSearchParams();
    if (withResolved) params.set("includeResolved", "true");
    if (!withOperational) params.set("priority", "actionable");
    params.set("pageSize", String(ERROR_LOG_PAGE_SIZE));
    const fetchPage = (p: number) => {
      params.set("page", String(p));
      return api<HealthData>(`/errors?${params.toString()}`);
    };
    Promise.all(Array.from({ length: upTo }, (_, i) => fetchPage(i + 1)))
      .then((all) => {
        if (!fence.current.isLatest(requestId)) return;
        const seen = new Set<string>();
        const recent = all.flatMap((r) => r.recent).filter((e) => !seen.has(e.id) && !!seen.add(e.id));
        setData({ ...all[0], recent });
        setPages(upTo);
        setLoadError(null);
      })
      .catch((err: unknown) => {
        if (!fence.current.isLatest(requestId)) return;
        setLoadError(err instanceof Error ? err.message : "Не удалось загрузить журнал ошибок");
      });
  }, []);

  useEffect(() => {
    load(showResolved, showOperational);
  }, [load, showResolved, showOperational]);

  /** Следующая страница дописывается в конец, уже показанное не перечитывается. */
  function loadMore(next: number) {
    const params = new URLSearchParams();
    if (showResolved) params.set("includeResolved", "true");
    if (!showOperational) params.set("priority", "actionable");
    params.set("page", String(next));
    params.set("pageSize", String(ERROR_LOG_PAGE_SIZE));
    const startedAt = epoch.current;
    api<HealthData>(`/errors?${params.toString()}`)
      .then((res) => {
        if (!fence.current.isLatest(startedAt)) return;
        setData((prev) => {
          if (!prev) return res;
          const seen = new Set(prev.recent.map((e) => e.id));
          return { ...res, recent: [...prev.recent, ...res.recent.filter((e) => !seen.has(e.id))] };
        });
        setPages(next);
        setLoadError(null);
      })
      .catch((err: unknown) => {
        if (!fence.current.isLatest(startedAt)) return;
        setLoadError(err instanceof Error ? err.message : "Не удалось загрузить журнал ошибок");
      });
  }

  async function toggleResolved(entry: ErrorLogEntry) {
    setBusyId(entry.id);
    try {
      await api(`/errors/${entry.id}/${entry.resolvedAt ? "reopen" : "resolve"}`, { method: "POST" });
      load(showResolved, showOperational, pages);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Не удалось изменить отметку");
    } finally {
      setBusyId(null);
    }
  }

  async function resolveAll() {
    setBusyId("all");
    try {
      await api("/errors/resolve-all", { method: "POST" });
      load(showResolved, showOperational);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Не удалось отметить все разобранными");
    } finally {
      setBusyId(null);
    }
  }

  const healthy = (data?.count7d ?? 0) === 0;
  const badge =
    loadError && !data
      ? "не загрузился"
      : data
        ? healthy
          ? "всё разобрано"
          : `${data.count24h} за сутки · ${data.count7d} за неделю`
        : undefined;

  return (
    // Раскрыта сама — раз есть неразобранные ошибки, это самое важное на вкладке,
    // прятать за лишним касанием нельзя (то же для сбоя загрузки журнала).
    <SettingsSection
      // key: данные о здоровье приходят асинхронно, а useState читает defaultOpen
      // только при первом монтировании — без key карточка навсегда запомнила бы
      // «свёрнуто», решённое ещё до того, как пришёл ответ сервера. Ключ меняется
      // ровно один раз (или при смене статуса) — пересоздаёт карточку с верным
      // стартовым состоянием, не трогая её, если человек уже сам её открыл/закрыл
      // в рамках того же статуса.
      key={!data && !loadError ? "loading" : loadError && !data ? "error" : healthy ? "ok" : "bad"}
      icon={Activity}
      title="Здоровье системы"
      badge={badge}
      defaultOpen={!healthy || (!!loadError && !data)}
    >
      <div className="quiet">
        <span className="dot" />
        <span className="txt">
          CRM сама ловит свои ошибки — и на сервере, и в браузерах сотрудников — и складывает сюда.
          Разобрались с ошибкой — нажмите «Разобрался»: она уйдёт из счётчика и перестанет попадать в
          утреннее уведомление директора, но останется в журнале. Журнал чистится автоматически через 90
          дней; журнал действий сотрудников при этом не удаляется никогда. Эксплуатационные сбои
          ИИ-конвейера (резерв ответил, повтор справился сам) в счётчик и список ниже по умолчанию не
          входят — их видно отдельным флажком «Показать эксплуатационные».
        </span>
      </div>
      {loadError && (
        <Rh2ErrorState
          message="Не удалось загрузить журнал ошибок. Пустой список ниже не значит, что ошибок нет — попробуйте ещё раз."
          onRetry={() => load(showResolved, showOperational)}
        />
      )}
      {data && data.recent.length > 0 && (
        <>
          <div className="wrap" style={{ marginTop: "var(--s3)" }}>
            <button className="pill ghost sm" type="button" onClick={() => setExpanded((v) => !v)} aria-expanded={expanded}>
              {expanded ? "Скрыть" : `Показать последние ошибки (${data.total ?? data.recent.length})`}
            </button>
            {expanded && data.count7d > 0 && (
              <button className="lnk" type="button" onClick={resolveAll} disabled={busyId === "all"}>
                {busyId === "all" ? "Отмечаем…" : "Разобрался со всеми"}
              </button>
            )}
            {expanded && (data.resolvedCount > 0 || showResolved) && (
              <label className="wrap" style={{ gap: 6, cursor: "pointer", color: "var(--muted)" }}>
                <input
                  type="checkbox"
                  checked={showResolved}
                  onChange={(ev) => setShowResolved(ev.target.checked)}
                />
                Показать разобранные ({data.resolvedCount})
              </label>
            )}
            {expanded && (data.operationalUnresolvedCount > 0 || showOperational) && (
              <label className="wrap" style={{ gap: 6, cursor: "pointer", color: "var(--muted)" }}>
                <input
                  type="checkbox"
                  checked={showOperational}
                  onChange={(ev) => setShowOperational(ev.target.checked)}
                />
                Показать эксплуатационные ({data.operationalUnresolvedCount})
              </label>
            )}
          </div>
          {expanded && (
            <div className="list" style={{ maxHeight: 288, overflowY: "auto" }}>
              {data.recent.map((e) => (
                <div className={`row${e.resolvedAt ? " done" : ""}`} key={e.id}>
                  {/* Иконка «разобрана / нет» — чтобы искать глазами настоящие
                      сбои, не читая каждую строку (владелец 19.08.2026). */}
                  {e.resolvedAt ? (
                    <CheckCircle2 className="i" style={{ color: "var(--ok)" }} aria-hidden="true" />
                  ) : (
                    <OctagonAlert className="i" style={{ color: "var(--crit)" }} aria-hidden="true" />
                  )}
                  <div className="t">
                    <b>{e.message}</b>
                    <span>
                      {e.source === "web" ? "Браузер" : "Сервер"}
                      {e.priority === "operational" && <span className="chip"> эксплуатационная</span>} ·{" "}
                      {new Date(e.createdAt).toLocaleString("ru-RU", { timeZone: "Asia/Dushanbe" })}
                      {e.url &&
                        // Внутренняя ссылка (напр. на зависший диалог — MAX_PHONE_ASKS
                        // в conversation.ts) — ведёт прямо туда, а не заставляет искать
                        // диалог руками среди сотен переписок. Внешние ссылки (репост
                        // Instagram и т.п.) как были текстом, так и остаются.
                        (e.url.startsWith("/") ? (
                          <>
                            {" · "}
                            <Link className="lk" to={e.url}>
                              Открыть диалог
                            </Link>
                          </>
                        ) : (
                          ` · ${e.url}`
                        ))}
                    </span>
                  </div>
                  <div className="act">
                    <button
                      className="lnk"
                      type="button"
                      onClick={() => toggleResolved(e)}
                      disabled={busyId === e.id}
                      title={e.resolvedAt ? "Вернуть в работу" : "Отметить разобранной"}
                    >
                      {e.resolvedAt ? "Вернуть" : "Разобрался"}
                    </button>
                  </div>
                </div>
              ))}
              {data.recent.length === 0 && <div className="state">Неразобранных ошибок нет.</div>}
              {data.total !== undefined && (
                <Pagination
                  variant="loadMore"
                  page={pages}
                  pageSize={ERROR_LOG_PAGE_SIZE}
                  total={data.total}
                  // Назад Pagination зовёт только когда список ужался (разобрали
                  // строки) — тогда просто считаем загруженное заново, не дочитывая.
                  onPageChange={(p) => (p > pages ? loadMore(p) : setPages(p))}
                />
              )}
            </div>
          )}
        </>
      )}
    </SettingsSection>
  );
}

interface AssistantAuditItem {
  id: string;
  createdAt: string;
  tool: string;
  argsSummary: string | null;
  resultCount: number | null;
  agent: { id: string; fullName: string };
  client: { id: string; shortId: string; fullName: string } | null;
}
interface AssistantAuditPage {
  items: AssistantAuditItem[];
  total: number;
  page: number;
  pageSize: number;
}

/**
 * Журнал обращений к ИИ-ассистенту CRM (lib/aiAssistantAudit.ts, модель
 * AiAssistantAuditLog) — запись велась с самого начала (один вызов на каждый
 * инструмент внутри runAssistant, ai/assistant.ts), но ни один экран её не
 * читал (найдено 13.09.2026). Не механизм защиты данных — её роль играет
 * `ownScope` внутри runTool на каждом инструменте, — а прослеживаемость: если
 * возникнет подозрение, что кто-то использует ассистента для сбора чужих
 * данных, здесь видно, кто, каким инструментом и по какому клиенту пользовался.
 *
 * ДОСТУП — то же право, что у «Здоровья системы» и аудита бота выше на этой же
 * вкладке (`auditLog.view`, GET /ai/assistant-audit): это тот же служебный
 * раздел «журналы», отдельное право под один экран не заводим. Сервер и так
 * отклонит запрос без него — компонент просто не рисуется вовсе, чтобы не
 * показывать карточку с одной ошибкой 403 тем, кому сюда нельзя.
 *
 * clientId для колонки «Клиент» вытащен из argsSummary (JSON аргументов
 * вызова) лучшим усилием на сервере — отдельного поля в модели нет и заводить
 * под один столбец интерфейса миграцию незачем.
 */
export function AssistantAuditSection() {
  const can = useCan();
  const canView = can("auditLog.view");
  const { data: agents } = useAgents({ enabled: canView });
  const [agentId, setAgentId] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<AssistantAuditPage | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (!canView) return;
    // Ответ на уже сменённые страницу или фильтр отбрасывается (аудит
    // 02.10.2026): при быстром листании запоздавший старый ответ иначе
    // перезаписывал свежий, и под фильтром «Иванов» стояли строки «Все».
    let stale = false;
    const params = new URLSearchParams({ page: String(page) });
    if (agentId) params.set("agentId", agentId);
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    api<AssistantAuditPage>(`/ai/assistant-audit?${params.toString()}`)
      .then((res) => {
        if (stale) return;
        setData(res);
        setLoadError(null);
      })
      .catch((err: unknown) => {
        if (stale) return;
        setLoadError(err instanceof Error ? err.message : "Не удалось загрузить журнал ассистента");
      });
    return () => {
      stale = true;
    };
  }, [canView, agentId, from, to, page]);

  if (!canView) return null;

  return (
    <SettingsSection icon={Bot} title="Журнал ИИ-ассистента" badge={data ? `${data.total}` : undefined}>
      <div className="quiet">
        <span className="dot" />
        <span className="txt">
          Каждое обращение сотрудника к ИИ-ассистенту CRM: какой инструмент вызван, по какому клиенту и когда.
          Доступ ассистент получает под правами вызвавшего — это журнал прослеживаемости, а не единственная
          защита данных.
        </span>
      </div>

      {loadError && (
        <div className="quiet crit" role="alert">
          <span className="dot crit" />
          <span className="txt">{loadError}. Пустой список ниже не означает, что обращений не было.</span>
        </div>
      )}

      <div className="filters" style={{ marginTop: "var(--s3)" }}>
        <label className="field">
          <span className="lab">Сотрудник</span>
          <select
            className="inp"
            value={agentId}
            onChange={(e) => {
              setAgentId(e.target.value);
              setPage(1);
            }}
          >
            <option value="">Все сотрудники</option>
            {agents?.map((a) => (
              <option key={a.id} value={a.id}>
                {a.fullName}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="lab">Период с</span>
          <input
            className="inp"
            type="date"
            value={from}
            onChange={(e) => {
              setFrom(e.target.value);
              setPage(1);
            }}
          />
        </label>
        <label className="field">
          <span className="lab">по</span>
          <input
            className="inp"
            type="date"
            value={to}
            onChange={(e) => {
              setTo(e.target.value);
              setPage(1);
            }}
          />
        </label>
      </div>

      <div className="list" style={{ marginTop: "var(--s3)" }}>
        {data && data.items.length === 0 && <div className="state">За выбранный период обращений нет.</div>}
        {data?.items.map((row) => (
          <div className="row" key={row.id}>
            <Bot className="i" aria-hidden="true" />
            <div className="t">
              <b>{row.tool}</b>
              <span>
                {row.agent.fullName} · {new Date(row.createdAt).toLocaleString("ru-RU", { timeZone: "Asia/Dushanbe" })}
                {row.client && (
                  <>
                    {" · "}
                    <Link className="lk" to={`/clients/${row.client.shortId}`}>
                      {row.client.fullName}
                    </Link>
                  </>
                )}
                {typeof row.resultCount === "number" && <span className="chip"> {row.resultCount} записей</span>}
              </span>
              {row.argsSummary && (
                <span style={{ color: "var(--faint)", fontSize: "var(--fs-12)" }}>{row.argsSummary}</span>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Общий пейджер вместо своей копии: он сам возвращает с опустевшей
          последней страницы на последнюю живую — своя копия при одной
          оставшейся странице пряталась и оставляла на пустой. */}
      {data && (
        <div style={{ marginTop: 12 }}>
          <Pagination variant="rh2" page={data.page} pageSize={data.pageSize} total={data.total} onPageChange={setPage} />
        </div>
      )}
    </SettingsSection>
  );
}

interface StuckItem {
  id: string;
  channel: string | null;
  name: string | null;
  lastMessageAt: string;
}
interface StuckData {
  count: number;
  /** Достигли предела выборки на сервере — реальных диалогов может быть больше. */
  limited: boolean;
  items: StuckItem[];
}

/**
 * ДИАЛОГИ БЕЗ ОТВЕТА СЕГОДНЯ (18.08.2026, жалоба владельца: «ИИ сегодня многим
 * не ответил, замолчал»).
 *
 * При сбое ИИ клиент не получает вообще никакого сообщения — бот молча
 * пытается ответить в фоне часами, а если не вышло, диалог остаётся без
 * ответа до следующего сообщения клиента (решение владельца 03.08.2026). Эта
 * карточка находит такие диалоги за сегодня и позволяет проиграть их заново
 * одной кнопкой — не дожидаясь, пока клиент напишет снова сам.
 *
 * Карточка не показывается, когда чинить нечего: пустой список ничего не
 * говорит директору и только занимает место на экране, который и так призван
 * выглядеть тревожно ровно тогда, когда есть повод.
 */
export function StuckConversationsSection() {
  const [data, setData] = useState<StuckData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [queued, setQueued] = useState<number | null>(null);

  const load = useCallback(() => {
    api<StuckData>("/errors/stuck-conversations")
      .then((res) => {
        setData(res);
        setLoadError(null);
      })
      .catch((err: unknown) =>
        setLoadError(err instanceof Error ? err.message : "Не удалось проверить диалоги без ответа")
      );
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function retryAll() {
    if (!data || data.count === 0) return;
    if (
      !window.confirm(
        `Отправить ответ всем ${data.count}${data.limited ? "+" : ""} диалогам без ответа сегодня? ` +
          `Клиенты получат настоящие сообщения от бота.`
      )
    )
      return;
    setBusy(true);
    setQueued(null);
    try {
      const res = await api<{ queued: number }>("/errors/stuck-conversations/retry", { method: "POST" });
      setQueued(res.queued);
      // Отправка идёт в фоне на сервере (диалогов может быть много, каждый —
      // отдельный вызов ИИ) — обновляем список с паузой, чтобы увидеть результат,
      // а не «ноль изменений» сразу же после нажатия.
      setTimeout(load, 5000);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Не удалось запустить повтор");
    } finally {
      setBusy(false);
    }
  }

  // Тихо молчим при сбое загрузки и при пустом списке — это необязательная
  // диагностика поверх «Здоровья системы», а не отдельный источник тревоги.
  if (loadError && !data) return null;
  if (data && data.count === 0 && queued === null) return null;

  return (
    // Открыта сама — карточка и так показывается только когда есть что чинить
    // (см. проверки выше), скрывать её содержимое за ещё одним касанием незачем.
    <SettingsSection
      icon={RotateCw}
      title="Диалоги без ответа сегодня"
      badge={data && data.count > 0 ? `${data.count}${data.limited ? "+" : ""}` : undefined}
      defaultOpen
    >
      <div className="quiet">
        <span className="dot warn" />
        <span className="txt">
          Клиент написал сегодня, а ответа бота на это сообщение в переписке ещё нет: либо ИИ ещё пробует в
          фоне (это нормально, ждёт до ~13 часов), либо уже не смог и сдался. Кнопка проигрывает каждый такой
          диалог заново на его собственной истории — реплика клиента не дублируется, уходит только новый
          ответ.
        </span>
      </div>
      {loadError && data && (
        <Rh2ErrorState message="Не удалось запустить повтор. Попробуйте ещё раз." onRetry={retryAll} />
      )}
      {data && data.count > 0 && (
        <div className="wrap" style={{ marginTop: "var(--s3)" }}>
          <button className="pill" type="button" onClick={retryAll} disabled={busy}>
            <RotateCw className="i" aria-hidden="true" />
            {busy ? "Запускаем…" : `Повторить всем (${data.count}${data.limited ? "+" : ""})`}
          </button>
        </div>
      )}
      {queued !== null && (
        <div className="quiet" role="status">
          <span className="dot ok" />
          <span className="txt">
            Запущено для {queued} диалогов. Отправка идёт постепенно в фоне — список выше обновится сам через
            несколько секунд.
          </span>
        </div>
      )}
    </SettingsSection>
  );
}

/**
 * ЖУРНАЛ ДЕЙСТВИЙ — кто и когда менял карточки (сверка мобильного макета
 * c99db05f, экран «health», 14.09.2026): та же лента, что в Архиве
 * («История действий», `useAuditLog`), вынесена сюда вторым разделом раздела
 * «Здоровье», потому что «Здоровье системы» показывает только сбои техники, а
 * не действия людей — их раньше нужно было искать отдельно в Архиве.
 * Собственная страница под это не заводится (решение уже принято): раздел
 * живёт здесь и на десктопе, и в мобильном облике Health.tsx.
 */
export function AuditLogSection() {
  const [page, setPage] = useState(1);
  const { data, isLoading, isError, refetch } = useAuditLog(page);

  return (
    <SettingsSection icon={History} title="Журнал действий" badge={data ? data.total : undefined}>
      <div className="quiet">
        <span className="dot" />
        <span className="txt">Кто и что менял в карточках клиентов, объектов, сделок и сотрудников. Журнал не чистится никогда.</span>
      </div>

      {isLoading && (
        <div className="state">
          <span className="sk w40" />
          <span className="sk w22" /> Загружаем журнал
        </div>
      )}

      {/* Без права запрос не уходит вовсе — isError означает отказ сети или
          сервера, а не отсутствие права. */}
      {isError && (
        <Rh2ErrorState
          message="Не удалось загрузить журнал действий. Попробуйте ещё раз."
          onRetry={() => refetch()}
        />
      )}

      {!isLoading && !isError && data?.items.length === 0 && (
        <Rh2EmptyState icon={ClipboardList} title="Записей пока нет." />
      )}

      {data && data.items.length > 0 && (
        <div className="list">
          {data.items.map((entry) => {
            const name = auditEntityName(entry.meta);
            const link = auditEntityLink(entry.entityType, entry.meta);
            return (
              <div className="row" key={entry.id}>
                <div className="t">
                  <b>
                    {entry.agentName}, {(AUDIT_ACTION_LABELS[entry.action] ?? entry.action).toLowerCase()}:{" "}
                    {AUDIT_ENTITY_LABELS[entry.entityType] ?? entry.entityType}
                  </b>
                  <span>
                    {name && link ? (
                      <Link className="lk mut" to={link}>
                        {name}
                      </Link>
                    ) : (
                      name
                    )}
                    {entry.meta && typeof entry.meta === "object" && "amount" in entry.meta
                      ? `, ${String((entry.meta as Record<string, unknown>).amount)}`
                      : ""}
                  </span>
                </div>
                <span className="meta only-wide">{relativeTime(entry.createdAt)}</span>
              </div>
            );
          })}
        </div>
      )}

      {data && data.total > data.pageSize && (
        <div className="wrap" style={{ marginTop: "var(--s3)", justifyContent: "space-between" }}>
          <span className="meta">
            Страница {data.page} из {Math.max(1, Math.ceil(data.total / data.pageSize))}
          </span>
          <div className="wrap" style={{ gap: 8 }}>
            <button className="pill ghost sm" type="button" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
              Назад
            </button>
            <button
              className="pill ghost sm"
              type="button"
              disabled={page >= Math.ceil(data.total / data.pageSize)}
              onClick={() => setPage((p) => p + 1)}
            >
              Вперёд
            </button>
          </div>
        </div>
      )}
    </SettingsSection>
  );
}

/**
 * РАЗБОР ПРОБЛЕМНЫХ МЕСТ — два выключателя (решение владельца 11.08.2026).
 *
 * Порознь, а не одним рубильником: недельный нужен, чтобы чинить по ходу, месячный —
 * чтобы видеть, стало ли лучше; выключить обычно хочется ровно один из двух.
 *
 * Подпись описывает ТЕКУЩЕЕ положение тумблера, а не одно из двух (правило от
 * 11.08.2026), и тумблер здесь общий `SwitchRow`, а не своя копия.
 */
const PROBLEM_REPORT_TOGGLES = [
  {
    field: "problemReportWeeklyEnabled",
    title: "Еженедельный разбор",
    onHint:
      "Каждый понедельник утром CRM собирает разбор за прошедшие семь дней и присылает директорам пуш с главным выводом.",
    offHint: "Недельный разбор не собирается — за неделю никто не увидит, где именно потеряли клиентов.",
  },
  {
    field: "problemReportMonthlyEnabled",
    title: "Ежемесячный разбор",
    onHint: "1-го числа собирается такой же разбор за прошедший месяц — по нему видно, стало лучше или хуже.",
    offHint: "Месячный разбор не собирается — сравнивать месяцы между собой будет нечем.",
  },
] as const;

export function ProblemReportsSection() {
  const { data: settings } = useSettings();
  const save = useUpdateSettings();

  return (
    <SettingsSection icon={Compass} title="Разбор проблемных мест">
      <div className="quiet">
        <span className="dot" />
        <span className="txt">
          Отдельный отчёт о том, где агентство теряет: оборванные диалоги, непринятые лиды, просроченные
          обязательные окна, пропущенные звонки и застрявшие объекты. Сам отчёт живёт в разделе «Отчёты», с
          историей и заметками; директорам приходит пуш «разбор готов» с главным выводом.
        </span>
      </div>
      {PROBLEM_REPORT_TOGGLES.map(({ field, title, onHint, offHint }) => {
        const on = settings?.[field] ?? true;
        return (
          <SwitchRow
            key={field}
            title={title}
            on={on}
            hint={on ? onHint : offHint}
            onToggle={() => save.mutate({ [field]: !on })}
          />
        );
      })}
    </SettingsSection>
  );
}

// «Сколько держать раздел открытым» (stepUpMinutes) убран с экрана 01.11.2026:
// срок подтверждения личности — константа STEP_UP_MINUTES на сервере
// (apps/api/src/lib/settingsConstants.ts), значение прода — 4 часа.

/**
 * ВХОД ПО ОТПЕЧАТКУ ИЛИ ЛИЦУ — общий рубильник.
 *
 * Выключено здесь — сервер отказывает и входу, и привязке новых устройств, не только
 * прячется кнопка. Уже привязанные устройства не пропадают: включили обратно — и они
 * снова работают без повторной привязки.
 */
export function PasskeyToggleSection() {
  const { data: settings } = useSettings();
  const save = useUpdateSettings();
  const on = settings?.passkeyLoginEnabled ?? true;

  return (
    <SettingsSection
      // key: settings грузятся асинхронно — без него карточка запомнила бы «свёрнуто»
      // из первого рендера, до прихода реального значения тумблера.
      key={settings ? String(on) : "loading"}
      icon={Fingerprint}
      title="Вход по отпечатку или лицу"
      defaultOpen={!on}
    >
      <SwitchRow
        title="Разрешить вход по отпечатку и лицу"
        on={on}
        hint={
          on
            ? "Сотрудники привязывают свои устройства в «Мой профиль» и входят без кода из СМС."
            : "Сервер отказывает и входу по ключу, и привязке новых устройств. Уже привязанные не удалены — включите обратно, и они снова заработают."
        }
        onToggle={() => save.mutate({ passkeyLoginEnabled: !on })}
      />
    </SettingsSection>
  );
}

/** Сброс пароля админки сайта royalhome.tj — только владельцу компании. */

export function SiteAdminSection() {
  const [resetTotp, setResetTotp] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ email: string; password: string } | null>(null);
  const [copied, setCopied] = useState(false);

  async function handleReset() {
    if (!window.confirm("Сбросить пароль админки сайта royalhome.tj? Старый пароль перестанет работать сразу.")) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ email: string; password: string }>("/settings/site-admin-reset", {
        method: "POST",
        body: { resetTotp },
      });
      setResult(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось сбросить пароль");
    } finally {
      setBusy(false);
    }
  }

  return (
    <SettingsSection icon={KeyRound} title="Админка сайта royalhome.tj">
      <div className="quiet">
        <span className="dot" />
        <span className="txt">
          Если пароль от админки сайта утерян — сбросьте его отсюда. Новый пароль появится ниже <b>один
          раз</b>: сохраните его в надёжном месте. На самом сайте формы восстановления нет — это защита от
          взлома.
        </span>
      </div>
      {result ? (
        <>
          <div className="key-row">
            <div className="t">
              <b>Логин</b>
              <span>Учётная запись админки сайта</span>
            </div>
            <span className="msk">{result.email}</span>
          </div>
          <div className="key-row">
            <div className="t">
              <b>Новый пароль</b>
              <span>Показывается один раз — больше нигде не хранится</span>
            </div>
            <span className="msk" style={{ userSelect: "all", wordBreak: "break-all" }}>
              {result.password}
            </span>
            <button
              className="pill ghost sm"
              type="button"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(result.password);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 2000);
                } catch {
                  // Буфер обмена закрыт настройками браузера — пароль остаётся в поле,
                  // его выделяют руками (см. PropertyDetail.tsx: та же обработка).
                }
              }}
            >
              {copied ? "Скопировано" : "Копировать"}
            </button>
          </div>
          <div className="quiet warn">
            <span className="dot warn" />
            <span className="txt">
              Это сообщение исчезнет при уходе со страницы — пароль больше нигде не хранится.
            </span>
          </div>
        </>
      ) : (
        <>
          <div className="mod">
            <div className="t">
              <b>Также отключить двухфакторную защиту</b>
              <span>Если потерян и телефон с Google Authenticator.</span>
            </div>
            <div className="acts">
              <label className="tgl">
                <input
                  type="checkbox"
                  checked={resetTotp}
                  onChange={(e) => setResetTotp(e.target.checked)}
                  aria-label="Также отключить двухфакторную защиту"
                />
                <i />
              </label>
            </div>
          </div>
          {error && (
            <div className="quiet crit" role="alert">
              <span className="dot crit" />
              <span className="txt">{error}</span>
            </div>
          )}
          <div className="wrap" style={{ marginTop: "var(--s3)" }}>
            <button className="pill" type="button" onClick={handleReset} disabled={busy}>
              <KeyRound className="i" aria-hidden="true" />
              {busy ? "Сбрасываю…" : "Сбросить пароль админки сайта"}
            </button>
          </div>
        </>
      )}
    </SettingsSection>
  );
}

interface ErrorLogEntry {
  id: string;
  source: string;
  message: string;
  url: string | null;
  createdAt: string;
  resolvedAt: string | null;
  /** Разметка сервера (lib/errorLogClassify.ts): «эксплуатационный шум ИИ-конвейера»
   *  против «ждёт решения человека». */
  priority?: "operational" | "actionable";
}

/** Страница журнала ошибок (routes/errorLog.ts GET /). */
const ERROR_LOG_PAGE_SIZE = 50;

interface HealthData {
  recent: ErrorLogEntry[];
  /** Сколько строк под тем же отбором всего — для «Показать ещё». */
  total?: number;
  count24h: number;
  count7d: number;
  resolvedCount: number;
  /** Сколько неразобранного эксплуатационного шума скрыто из списка выше. */
  operationalUnresolvedCount: number;
}

/** Автоматически пойманные ошибки сервера и браузера — самодиагностика CRM.
 * Если за сутки были ошибки, директор получает пометку в утреннем push-дайджесте. */
