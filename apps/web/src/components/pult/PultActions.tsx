import { useMemo } from "react";
import { ActionRowList, type ActionRowAvatar, type ActionRowData } from "./ActionRow";
import { ACTION_INVENTORY } from "./ActionInventory";
import { pickLeastLoadedAgent, transferChoice } from "./leastLoadedAgent";
import { api } from "../../lib/api";
import { useIsReadOnly } from "../../lib/permissions";
import { formatMoney } from "../../lib/format";
import {
  useMissionControl,
  useDealsPendingApproval,
  useApproveDeal,
  usePropertiesPendingReview,
  useResolveAllSystemErrors,
  useTransferClient,
  useUndoTransferClient,
  mcOk,
  type McAgent,
} from "../../hooks/useMissionControl";

/**
 * Строки-действия «Решить одной кнопкой» под рядом плиток (спецификация v8
 * §3, слой 2 задача 6). Берёт снимок пульта из `useMissionControl` (уже
 * используется `PultHero`/`PultTiles` — один и тот же опрос 15/60 с, здесь
 * НЕ заводится третий), плюс два лёгких точечных запроса (сделки на подпись,
 * объекты на проверку — реальные существующие роуты, не выдумка mission-control,
 * см. `hooks/useMissionControl.ts`).
 *
 * Каждая строка помечена `data-endpoint` (проверка договора §6.11) внутри
 * `ActionRow`/`ActionRowList` (задача 2) — этот компонент только собирает
 * данные и передаёт `onRun`/`onUndo` по инвентарю `ActionInventory.ts`.
 */
export function PultActions({ enabled = true, onCount }: { enabled?: boolean; onCount?: (n: number) => void }) {
  const rows = usePultActionRows(enabled);
  const status = usePultActionStatus(enabled);
  // Пока ни один из трёх запросов не ответил, блок не рисуется: «Всё решено»
  // до ответа сервера было бы враньём.
  if (rows === null && !status.isError) return null;
  return <>
    {status.isError && <p role="alert">Часть очереди решений не загрузилась. Обновите страницу, чтобы повторить.</p>}
    {rows && (rows.length > 0 || !status.isError) && <ActionRowList rows={rows} onCount={onCount} />}
  </>;
}

export function summarizePultActionStatus(queries: readonly { isLoading: boolean; isError: boolean }[]) {
  return { isLoading: queries.some((query) => query.isLoading), isError: queries.some((query) => query.isError) };
}

/** Grouped decisions must not retain hidden mutation callbacks for observers. */
export function readOnlyPultRows(rows: ActionRowData[]): ActionRowData[] {
  return rows.map((row) => ({ ...row, actions: [], bulkLabel: undefined, bulkEndpoint: undefined, bulkConfirm: undefined,
    choice: undefined, review: undefined, ownerQuestionId: undefined,
    ...(row.members ? { members: readOnlyPultRows(row.members) } : {}),
  }));
}

/** Same cached requests as the queue; failed optional queries must not mean zero decisions. */
export function usePultActionStatus(enabled = true) {
  const readOnly = useIsReadOnly();
  const mission = useMissionControl(enabled);
  const deals = useDealsPendingApproval(enabled && !readOnly);
  const properties = usePropertiesPendingReview(enabled && !readOnly);
  return summarizePultActionStatus([mission, deals, properties]);
}

/** The detail screen checks each material's approval status and actual uploaded files. */
export function propertyReviewActionRow(p: { id: string; shortId: number; title: string }): ActionRowData {
  return {
    id: `property-${p.id}`,
    tone: "warn",
    avatar: { label: String(p.shortId).slice(-2), tone: "pink" },
    title: `ОБ-${String(p.shortId).padStart(6, "0")}: материалы ждут проверки`,
    description: `«${p.title}»`,
    actions: [],
    // Решение принимается на месте (шторка «Проверить материалы»); карточка — вторая кнопка.
    review: { propertyId: p.id, shortId: p.shortId, title: p.title },
    links: [{ label: "Открыть карточку", href: `/properties/${p.shortId}` }],
  };
}

/**
 * Строки решений пульта: сделки на подпись, материалы объектов, клиенты без
 * движения (одинаковые «Передать» свёрнуты в одну строку), ошибки системы и
 * вопросы ИИ к руководителю. `null` — снимок пульта ещё не пришёл.
 */
export function usePultActionRows(enabled = true): ActionRowData[] | null {
  const readOnly = useIsReadOnly();
  const { data } = useMissionControl(enabled);

  const dealsQuery = useDealsPendingApproval(enabled && !readOnly);
  const propsQuery = usePropertiesPendingReview(enabled && !readOnly);

  const approveDeal = useApproveDeal();
  const resolveAllErrors = useResolveAllSystemErrors();
  const transferClient = useTransferClient();
  const undoTransferClient = useUndoTransferClient();

  const { leastLoadedAgent, agentChoice } = useMemo(() => {
    const agents: McAgent[] = data?.team && mcOk(data.team) ? data.team.agents : [];
    return { leastLoadedAgent: pickLeastLoadedAgent(agents), agentChoice: transferChoice(agents) };
  }, [data]);

  const rows = useMemo(() => {
    const out: ActionRowData[] = [];
    const inv = (id: (typeof ACTION_INVENTORY)[number]["id"]) => ACTION_INVENTORY.find((e) => e.id === id)!;

    // 1) Сделки, ждущие одобрения директора.
    const dealRows: ActionRowData[] = [];
    for (const deal of dealsQuery.data ?? []) {
      const entry = inv("deal-approve");
      dealRows.push({
        id: `deal-${deal.id}`,
        tone: "warn",
        avatar: initialsAvatar(deal.client.fullName, "lime"),
        title: `«${deal.property?.title ?? deal.client.fullName}» ждёт вашего одобрения`,
        // Валюта сделки может быть USD, не только TJS (formatMoney — единый
        // источник форматирования денег, lib/format.ts). Цену и комиссию
        // показываем, если их прислал сервер: одобряющему без права на финансы
        // он их тоже отдаёт (C15, 02.10.2026), и одобрять вслепую нельзя.
        description: [
          deal.soldPrice != null ? `цена ${formatMoney(Math.round(deal.soldPrice), deal.currency ?? "TJS")}` : null,
          deal.commissionAmount ? `комиссия ${formatMoney(Math.round(deal.commissionAmount), deal.currency ?? "TJS")}` : null,
          `клиент ${deal.client.fullName}`,
        ]
          .filter(Boolean)
          .join(", "),
        actions: [
          {
            label: "Одобрить",
            endpoint: entry.endpoint,
            onRun: async () => {
              await approveDeal.mutateAsync({ dealId: deal.id, version: deal.version });
              return true;
            },
            // Без «Отменить»: закрытую сделку сервер назад не пускает (409), и
            // кнопка ничего не отменяла, хотя строка показывала «отменено»
            // (аудит 23.09.2026, №36). Вместо отмены после — второй клик до: деньги.
            confirm: "Точно одобрить?",
            doneMessage: "Одобрено",
          },
        ],
      });
    }

    pushGrouped(out, dealRows, "deal-group", "сделок ждут вашего одобрения", "lime");

    // 2) Список не подтверждает наличие/одобрение каждого материала. Решение
    // принимается в карточке: фото и видео проверяются отдельно и не вслепую.
    const propertyRows: ActionRowData[] = [];
    for (const p of propsQuery.data ?? []) {
      propertyRows.push(propertyReviewActionRow(p));
    }

    pushGrouped(out, propertyRows, "property-group", "объектов ждут проверки материалов", "pink");

    // 3) Клиенты, зависшие в воронке 3+ дня (hero.dealsInPipeline.items,
    //    tone=warn — уже приходит с основным снимком, отдельного запроса нет).
    const clientRows: ActionRowData[] = [];
    const heroItems = data?.hero && mcOk(data.hero) ? data.hero.dealsInPipeline.items ?? [] : [];
    for (const item of heroItems.filter((i) => i.tone === "warn")) {
      if (!leastLoadedAgent) continue;
      const entry = inv("client-transfer");
      const shortIdMatch = /\/clients\/(\d+)/.exec(item.href);
      const shortId = shortIdMatch ? Number(shortIdMatch[1]) : null;
      clientRows.push({
        id: `client-${item.id}`,
        tone: "warn",
        avatar: initialsAvatar(item.title, "aqua"),
        title: `${item.title}: клиент без движения`,
        description: item.hint,
        choice: agentChoice ?? undefined,
        actions: [
          {
            label: "Передать",
            endpoint: entry.endpoint,
            onRun: async (choiceId) => {
              const target = agentChoice?.options.find((o) => o.id === choiceId);
              const toAgentId = target ? target.id : leastLoadedAgent.id;
              lastTransferName.set(item.id, target ? target.label.split(" · ")[0] : leastLoadedAgent.fullName);
              // Обратный вызов должен вернуть прежнего агента — assign сам его
              // не возвращает, поэтому запоминаем его ДО передачи (существующий
              // роут карточки клиента, не новый эндпоинт).
              if (!shortId) throw new Error("Не удалось определить клиента. Откройте его карточку для передачи.");
              const card = await api<{ assignedAgent: { id: string } | null }>(`/clients/${shortId}`);
              const prevAgentId = card.assignedAgent?.id;
              if (!prevAgentId) throw new Error("Прежний агент неизвестен. Передайте клиента из его карточки.");
              await transferClient.mutateAsync({ clientId: item.id, toAgentId });
              prevAgentIds.set(item.id, prevAgentId);
              return true;
            },
            // Обратный вызов существует всегда (§3: у «Передать» есть undo) — конкретный
            // прежний агент известен только в момент клика (записан в onRun выше).
            onUndo: async () => {
              const prevAgentId = prevAgentIds.get(item.id);
              if (!prevAgentId) throw new Error("Прежний агент неизвестен. Проверьте назначение в карточке клиента.");
              await undoTransferClient.mutateAsync({ clientId: item.id, toAgentId: prevAgentId });
            },
            doneMessage: () => `Передан ${lastTransferName.get(item.id) ?? leastLoadedAgent.fullName} · отменить 10 с`,
          },
        ],
      });
    }

    // Одинаковые «Передать» сворачиваются: пять строк «передать Мадине» нечитаемы,
    // одна «5 клиентов без движения» с «Передать всех» и «Разобрать» читается за
    // секунду. Группа начинается с двух строк.
    if (clientRows.length >= 2 && leastLoadedAgent) {
      const names = heroItems.filter((i) => i.tone === "warn").map((i) => i.title);
      out.push({
        id: "client-group",
        k: "Клиенты",
        tone: "warn",
        avatar: { label: String(clientRows.length), tone: "aqua" },
        title: `${clientRows.length} ${pluralClients(clientRows.length)} без движения`,
        choice: agentChoice ?? undefined,
        bulkConfirm: (n) => `Передать ${n} ${pluralClientsAcc(n)}?`,
        description: names.length > 3 ? `${names.slice(0, 3).join(", ")} и ещё ${names.length - 3}` : names.join(", "),
        actions: [],
        members: clientRows,
        bulkLabel: "Передать всех",
        bulkEndpoint: inv("client-transfer").endpoint,
      });
    } else {
      out.push(...clientRows);
    }

    // 4) Ошибки системы — массовое действие, без списка (bulk, нет undo).
    const errorsToday = data?.system && mcOk(data.system) ? data.system.errorsToday : 0;
    const unresolvedTotal = data?.system && mcOk(data.system) ? data.system.unresolvedTotal : undefined;
    // Сервер прислал общее число нерешённых — разбираем именно его (scope "all"), иначе только сегодняшние.
    const resolveScope = unresolvedTotal !== undefined ? "all" : "today";
    const resolveCount = unresolvedTotal !== undefined ? unresolvedTotal : errorsToday;
    if (errorsToday > 0 || resolveCount > 0) {
      const entry = inv("system-errors-resolve-all");
      out.push({
        id: "system-errors",
        tone: errorsToday >= 10 ? "crit" : "warn",
        avatar: { label: "СИ", tone: "sky" },
        title: unresolvedTotal !== undefined
          ? `${errorsToday} ${plural(errorsToday)} за сегодня · всего нерешённых ${unresolvedTotal}`
          : `${errorsToday} ${plural(errorsToday)} за сегодня`,
        description: "разобрать все одним нажатием",
        actions: [
          {
            label: "Разобрать все",
            endpoint: entry.endpoint,
            confirm: `Разобрать ${resolveCount} ${plural(resolveCount)}?`,
            onRun: async () => {
              await resolveAllErrors.mutateAsync(resolveScope);
              return true;
            },
            doneMessage: `Разобрано · ${resolveCount}`,
          },
        ],
      });
    }

    // 5) Вопросы ИИ к руководителю («Вопросы ко мне»): ответ даётся в разделе,
    //    поэтому кнопка ведёт туда ссылкой, а не шлёт запрос.
    const firstLine = data?.firstLine && mcOk(data.firstLine) ? data.firstLine.items : [];
    for (const q of firstLine.filter((it) => it.id.startsWith("owner-question-"))) {
      out.push({
        id: `question-${q.id}`,
        k: "Вопрос",
        tone: "warn",
        avatar: { label: "?", tone: "lav" },
        title: q.text,
        actions: [],
        // Ответ вводится в самой строке (CleanDecisionRow); ссылка — запасной путь, пока очередь вопросов грузится.
        ownerQuestionId: q.id.replace(/^owner-question-/, ""),
        links: [{ label: "Открыть вопрос", href: q.href }],
      });
    }

    return readOnly ? readOnlyPultRows(out) : out;
  }, [
    readOnly,
    dealsQuery.data,
    propsQuery.data,
    data,
    leastLoadedAgent,
    approveDeal,
    resolveAllErrors,
    transferClient,
    undoTransferClient,
    agentChoice,
  ]);

  // Пока снимок пульта не пришёл (data нет), «Всё решено» рисовать нельзя.
  return data && !dealsQuery.isLoading && !propsQuery.isLoading ? rows : null;
}

/** Строка-хранилище прежнего агента для отмены передачи — вне React-состояния
 *  намеренно: живёт ровно 10 с окна undo, не переживает перерендер списка. */
const prevAgentIds = new Map<string, string>();
/** Имя агента, которому только что передали клиента (для текста «Передан …»). */
const lastTransferName = new Map<string, string>();

/**
 * Три и больше одинаковых решений сворачиваются в одну строку с «Разобрать»
 * (массовой кнопки у одобрения нет сознательно: одобрять пачку вслепую нельзя);
 * одно или два остаются отдельными строками.
 */
function pushGrouped(
  out: ActionRowData[],
  rows: ActionRowData[],
  id: string,
  noun: string,
  tone: ActionRowAvatar["tone"],
): void {
  if (rows.length < 3) {
    out.push(...rows);
    return;
  }
  out.push({
    id,
    tone: "warn",
    avatar: { label: String(rows.length), tone },
    title: `${rows.length} ${noun}`,
    description: rows
      .slice(0, 3)
      .map((r) => r.title)
      .join("; "),
    actions: [],
    members: rows,
  });
}

function pluralClients(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return "клиент";
  if ([2, 3, 4].includes(mod10) && ![12, 13, 14].includes(mod100)) return "клиента";
  return "клиентов";
}

/** «Передать 1 клиента / 5 клиентов?» — винительный падеж. */
function pluralClientsAcc(n: number): string {
  return n % 10 === 1 && n % 100 !== 11 ? "клиента" : "клиентов";
}

function plural(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return "ошибка";
  if ([2, 3, 4].includes(mod10) && ![12, 13, 14].includes(mod100)) return "ошибки";
  return "ошибок";
}

/** Инициалы для аватар-чипа строки-действия (эталон `.row .av`, задача L5) —
 *  первые буквы двух слов полного имени, как «ФК»/«КЛ» в эталоне. */
function initialsAvatar(fullName: string, tone: ActionRowAvatar["tone"]): ActionRowAvatar {
  const label =
    fullName
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0])
      .join("")
      .toUpperCase() || "•";
  return { label, tone };
}
