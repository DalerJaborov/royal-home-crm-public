import { useEffect, useMemo, useState } from "react";
import { useCanViewInvestigations } from "../lib/permissions";
import { ShieldAlert } from "lucide-react";
import { exactDateTime } from "../lib/format";
import { ConfirmDialog } from "./ConfirmDialog";
import { SettingsSection } from "./settings/SettingsSection";
import { useAccumulatedPages } from "../hooks/useAccumulatedPages";
import {
  loadMoreAuditGroups,
  loadMoreGroupExamples,
  useBotAuditList,
  useResolveAllAuditFindings,
  useResolveAuditFinding,
  useResolveAuditGroup,
  useRunBotAudit,
  type AuditFinding,
  type AuditGroup,
} from "../hooks/useBotAudit";

const FINDING_TYPE_LABEL: Record<string, string> = {
  price: "Цена",
  links_phone: "Ссылка/номер",
  context_loss: "Потеря контекста",
  repetition: "Повтор",
  tone: "Тон",
  ignored_question: "Проигнорировал вопрос",
  self_disclosed_bot: "Признался, что он бот",
  invented_fact: "Выдумал факт",
  commission_first: "Полез с комиссией",
  agent_bypassed_crm: "Подозрение на увод сделки",
  other: "Другое",
};

/**
 * Аудит бота — судья вычитывает недавние переписки против реальных правил бота
 * (18.08.2026, просьба владельца: не узнавать о нарушениях правил из скриншотов
 * клиентов). Серверная часть — apps/api/src/ai/botAudit.ts, данные и мутации —
 * hooks/useBotAudit.ts.
 *
 * Живёт в «Обучении бота», а не в «Здоровье системы» (20.08.2026, просьба
 * владельца): здоровье — про сбои техники, а это проверка того, как бот
 * соблюдает свои же правила, то есть соседний вопрос к «чему бот научился».
 *
 * СВЁРНУТА ПО УМОЛЧАНИЮ (17.09.2026, «порядок на странице»): складка
 * `SettingsSection`, тот же приём, что у остальных секций «Обучения бота» —
 * счётчик неразобранных в шапке, разворачивать нужно только чтобы разобрать.
 *
 * Находки сгруппированы: не диалог за диалогом, а «эта проблема встретилась
 * N раз», СТРАНИЦАМИ по группам (17.09.2026) — а внутри группы «показать ещё»
 * цитат вместо трёх примеров сразу. У группы — действия на всю группу: «Бот
 * ошибся — учесть» заводит ОДИН урок на группу, «Бот прав» закрывает все её
 * находки И запоминает класс — судья больше не заведёт по нему находку заново
 * (владелец 17.09.2026, «повторы исключить полностью»).
 */
function severityChipTone(severity: string): string {
  if (severity === "high") return "chip crit";
  if (severity === "medium") return "chip warn";
  return "chip";
}

/** Один пример-цитата внутри группы + её собственные кнопки «Бот ошибся»/«Бот
 *  прав» — оставлены рядом с групповыми: иногда среди N одинаковых находок
 *  одна на самом деле другая, и разбирать ровно её по одной не хочется терять. */
function AuditExampleRow({
  example,
  busy,
  onResolve,
}: {
  example: AuditFinding;
  busy: boolean;
  onResolve: (id: string, verdict?: "bot_right" | "bot_error") => void;
}) {
  return (
    <div style={{ marginTop: 8 }}>
      <p className="lastl">«{example.quote}»</p>
      <p className="when2">
        {exactDateTime(example.createdAt)}
        {" · "}
        <button
          type="button"
          className="pill sm"
          onClick={() => onResolve(example.id, "bot_error")}
          disabled={busy}
        >
          Бот ошибся, учесть
        </button>{" "}
        <button
          type="button"
          className="pill ghost sm"
          onClick={() => onResolve(example.id, "bot_right")}
          disabled={busy}
        >
          Бот прав
        </button>
      </p>
    </div>
  );
}

interface ExpandedState {
  items: AuditFinding[];
  cursor: string | null;
  loading: boolean;
}

export function BotAuditSection() {
  const investigations = useCanViewInvestigations();
  const { data, isLoading, isError, refetch } = useBotAuditList();
  const run = useRunBotAudit();
  const resolveOne = useResolveAuditFinding();
  const resolveGroup = useResolveAuditGroup();
  const resolveAll = useResolveAllAuditFindings();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [busyGroup, setBusyGroup] = useState<string | null>(null);
  const [confirmingResolveAll, setConfirmingResolveAll] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, ExpandedState>>({});

  // «Показать ещё» ГРУПП — тем же общим хуком useAccumulatedPages, что и три
  // ленты «Обучение бота» (17.09.2026, «страницы по группам»). Смещение вместо
  // курсора: группа — не строка таблицы, а результат группировки на сервере.
  // useMemo — без него `?? []` создавал бы новый массив на каждый рендер, и
  // эффект сброса ниже (по ссылке) гонялся бы на каждый чих, не только на
  // приход свежей первой страницы.
  const baseGroups = useMemo(() => data?.groups ?? [], [data?.groups]);
  const [page, setPage] = useState(1);
  const [pageDelta, setPageDelta] = useState<AuditGroup[]>([]);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [loadingMoreGroups, setLoadingMoreGroups] = useState(false);
  useEffect(() => {
    setPage(1);
    setPageDelta([]);
    setNextOffset(null);
  }, [baseGroups]);
  const groups = useAccumulatedPages(page <= 1 ? baseGroups : pageDelta, page, baseGroups);
  const offsetForMore = page <= 1 ? (data?.groupsNextOffset ?? null) : nextOffset;

  async function loadMoreGroups() {
    if (offsetForMore == null) return;
    setLoadingMoreGroups(true);
    setLoadError(null);
    try {
      const res = await loadMoreAuditGroups(offsetForMore);
      setPageDelta(res.groups);
      setNextOffset(res.groupsNextOffset);
      setPage((p) => p + 1);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Не удалось загрузить ещё");
    } finally {
      setLoadingMoreGroups(false);
    }
  }

  function groupKeyOf(g: AuditGroup): string {
    return `${g.type}::${g.why}`;
  }

  async function showMoreQuotes(g: AuditGroup) {
    const key = groupKeyOf(g);
    const current = expanded[key] ?? { items: [], cursor: g.examples[g.examples.length - 1]?.id ?? null, loading: false };
    if (current.cursor === null) return;
    setExpanded((prev) => ({ ...prev, [key]: { ...current, loading: true } }));
    try {
      const res = await loadMoreGroupExamples(g.type, g.why, current.cursor);
      setExpanded((prev) => ({
        ...prev,
        [key]: { items: [...current.items, ...res.items], cursor: res.nextCursor, loading: false },
      }));
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Не удалось загрузить ещё цитаты");
      setExpanded((prev) => ({ ...prev, [key]: { ...current, loading: false } }));
    }
  }

  async function resolveExample(id: string, verdict?: "bot_right" | "bot_error") {
    setBusyId(id);
    setLoadError(null);
    try {
      await resolveOne.mutateAsync({ id, verdict });
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Не удалось отметить разобранной");
    } finally {
      setBusyId(null);
    }
  }

  async function resolveWholeGroup(g: AuditGroup, verdict: "bot_right" | "bot_error") {
    const key = groupKeyOf(g);
    setBusyGroup(key);
    setLoadError(null);
    try {
      await resolveGroup.mutateAsync({ type: g.type, why: g.why, verdict });
      setExpanded((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Не удалось разобрать группу");
    } finally {
      setBusyGroup(null);
    }
  }

  async function handleResolveAll() {
    setLoadError(null);
    try {
      await resolveAll.mutateAsync();
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Не удалось разобрать все находки");
    }
  }

  async function handleRun() {
    setLoadError(null);
    try {
      await run.mutateAsync();
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Не удалось запустить проверку");
    }
  }

  return (
    <SettingsSection
      icon={ShieldAlert}
      title="Где бот нарушил свои правила"
      badge={data && data.unresolvedTotal > 0 ? data.unresolvedTotal : undefined}
    >
      <div className="sec-h stack" style={{ padding: 0 }}>
        <span className="note">
          {data
            ? `Не разобрано ${data.unresolvedTotal} из ${data.unresolvedTotal + data.resolvedTotal}. Проверка берёт случайные переписки за месяц`
            : "Проверка берёт случайные переписки за месяц"}
        </span>
      </div>

      {confirmingResolveAll && (
        <ConfirmDialog
          title="Разобрать все находки?"
          description={`Все ${data?.unresolvedTotal ?? 0} неразобранных находок будут сняты с учёта без вердикта — так же, как «Бот прав» у каждой по отдельности. Бота это ничему не учит, отменить массово нельзя.`}
          confirmLabel="Разобрать все"
          onConfirm={() => {
            setConfirmingResolveAll(false);
            void handleResolveAll();
          }}
          onCancel={() => setConfirmingResolveAll(false)}
        />
      )}

      <div className="filters" style={{ marginBottom: 12 }}>
        <button type="button" className="pill ghost" onClick={() => void handleRun()} disabled={run.isPending}>
          {run.isPending ? "Проверяю диалоги…" : "Проверить диалоги бота"}
        </button>
        {data && data.unresolvedTotal > 0 && (
          <button
            type="button"
            className="lnk"
            onClick={() => setConfirmingResolveAll(true)}
            disabled={resolveAll.isPending}
          >
            {resolveAll.isPending ? "Разбираем…" : "Разобрать все"}
          </button>
        )}
        <span className="spacer" />
        {/* «Проверить» берёт СЛУЧАЙНЫЕ переписки бота за последний месяц, те, которых ещё не
            проверял, и сверяет их с его промтом: выдуманная цена или факт, запрещённая ссылка,
            забытый контекст, дословный повтор, проигнорированный вопрос, разговор о комиссии не к
            месту и признание «я бот». Разобранное убирайте из списка: так видно, что осталось.
            Макет здесь показывает «Проверено 140 диалогов» — сквозного счётчика
            проверенных диалогов сервер не хранит (только количество НАХОДОК),
            поэтому честно показываем находки, а не выдуманное число диалогов. */}
        {data && (
          <span className="note" style={{ fontSize: "var(--fs-13)", color: "var(--faint)" }}>
            Находок всего: {data.unresolvedTotal + data.resolvedTotal}
          </span>
        )}
      </div>

      {(run.data || run.isError) && (
        <div className={`quiet${run.isError ? " crit" : ""}`} style={{ marginBottom: 12 }}>
          <span className={`dot${run.isError ? " crit" : run.data && run.data.findingsCreated > 0 ? " warn" : " ok"}`} />
          <span className="txt">
            {run.isError
              ? loadError ?? "Не удалось запустить проверку"
              : run.data && (
                  <>
                    Проверено диалогов: {run.data.conversationsChecked}.{" "}
                    {run.data.findingsCreated > 0
                      ? `Найдено нарушений: ${run.data.findingsCreated}.`
                      : "Нарушений не найдено."}
                  </>
                )}
          </span>
          <button type="button" className="lnk" onClick={() => run.reset()}>
            Понятно
          </button>
        </div>
      )}

      {isError ? (
        <div className="state err">
          <span className="dot crit" />
          {loadError ?? "Не удалось загрузить находки"}{" "}
          <button
            className="lk"
            type="button"
            style={{ color: "inherit", textDecoration: "underline" }}
            onClick={() => refetch()}
          >
            Повторить
          </button>
        </div>
      ) : isLoading || data === undefined ? (
        <div className="state">
          <span className="sk w40" />
          <span className="sk w22" />
          Загружаем находки
        </div>
      ) : groups.length === 0 ? (
        <div className="empty">
          <p>Неразобранных нарушений нет.</p>
          <span className="sub">
            {data.resolvedTotal > 0
              ? `Всё разобрано: ${data.resolvedTotal} ${data.resolvedTotal === 1 ? "находка закрыта" : "находок закрыто"}. Сюда попадёт то, что найдёт следующая проверка.`
              : "Бот держится своих правил. Сюда попадёт то, что проверка найдёт в случайных переписках."}
          </span>
        </div>
      ) : (
        <>
          {groups.filter(g => investigations || g.type !== "agent_bypassed_crm").map((g) => {
            const key = groupKeyOf(g);
            const extra = expanded[key];
            const examples = [...g.examples, ...(extra?.items ?? [])];
            const hasMoreQuotes = extra ? extra.cursor !== null : g.count > g.examples.length;
            const groupBusy = busyGroup === key;
            return (
              <div className="jrn" key={key}>
                <div className="hd">
                  <b>{g.why}</b>
                  <span className={severityChipTone(g.severity)}>{FINDING_TYPE_LABEL[g.type] ?? g.type}</span>
                  <span className="cnt">{g.count} раз</span>
                </div>
                {/* Действия на ВСЮ группу (17.09.2026): «Бот ошибся» заводит один
                    урок на группу и закрывает все её находки, «Бот прав» закрывает
                    все и запоминает класс — судья не заведёт его заново. */}
                <p className="when2">
                  <button
                    type="button"
                    className="pill sm"
                    onClick={() => void resolveWholeGroup(g, "bot_error")}
                    disabled={groupBusy}
                  >
                    Бот ошибся — учесть всю группу
                  </button>{" "}
                  <button
                    type="button"
                    className="pill ghost sm"
                    onClick={() => void resolveWholeGroup(g, "bot_right")}
                    disabled={groupBusy}
                  >
                    Бот прав — закрыть группу
                  </button>
                </p>
                {examples.map((ex) => (
                  <AuditExampleRow key={ex.id} example={ex} busy={busyId === ex.id} onResolve={resolveExample} />
                ))}
                {hasMoreQuotes && (
                  <div className="wrap" style={{ marginTop: 8 }}>
                    <button
                      type="button"
                      className="pill ghost sm"
                      onClick={() => void showMoreQuotes(g)}
                      disabled={extra?.loading}
                    >
                      {extra?.loading ? "Загружаем…" : "Показать ещё цитат"}
                    </button>
                  </div>
                )}
              </div>
            );
          })}
          {offsetForMore != null && (
            <div className="pager" style={{ marginTop: 12 }}>
              <button type="button" className="pill ghost sm" onClick={() => void loadMoreGroups()} disabled={loadingMoreGroups}>
                {loadingMoreGroups ? "Загружаем…" : "Показать ещё группы"}
              </button>
            </div>
          )}
          {data.groupsTotal > 0 && (
            <div className="pager" style={{ marginTop: 12 }}>
              <span className="info">
                Показаны {groups.length} групп из {data.groupsTotal}
              </span>
            </div>
          )}
        </>
      )}
      {loadError && (
        <div className="quiet crit" role="alert" style={{ marginTop: 12 }}>
          <span className="dot crit" />
          <span className="txt">{loadError}</span>
        </div>
      )}
    </SettingsSection>
  );
}
