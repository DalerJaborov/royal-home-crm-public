import { Router } from "express";
import { Prisma } from "../generated/prisma/client.js";
import { prisma } from "../db.js";
import { findPostShowingCallFeedRow, listPostShowingCallFeed } from "../lib/postShowingCallFeed.js";
import { loadHotScoreThreshold } from "../lib/hotScoreThreshold.js";
import { requireAuth, requirePermission } from "../auth/middleware.js";
import { TASK_WHERE } from "../lib/tasks.js";
import { NO_LEADS, OCCUPIES_SLOT_WHERE, activeLeadCounts, loadLeadLimits, slotsTaken } from "../lib/leadLimits.js";
import { isConductedShowing } from "../lib/conductedShowing.js";
import { clientNamePhoneSafe, phoneSafeText } from "../lib/clientPhone.js";
import { findSellerPropertyMissing } from "../lib/sellerPropertyMissingAntifraud.js";
import { runLimited } from "../lib/concurrency.js";
import type { InactiveLevel } from "../lib/inactiveTrafficLight.js";
import { r2PresignDownloadUrl } from "../lib/r2Client.js";
import { RATED_ROLES } from "@royal-home/shared";

/**
 * «Контроль руководителя» (ТЗ «Путь покупателя», п. 32) — сводный экран для
 * директора/руководителя по данным, которые CRM и так копит по ходу работы:
 * просроченные задачи, агенты у лимита лидов, зависшие горячие клиенты,
 * переводы в «Неактивные» и передачи между агентами. Ни одного нового поля —
 * только чтение уже существующих моделей, поэтому весь роут — GET.
 *
 * Право — dashboard.analytics: тот же, что закрывает остальные общекомандные
 * графики дашборда (routes/dashboard.ts), и в пресетах ролей стоит ровно у
 * DIRECTOR/ADMIN/MANAGER — то есть у руководства, не у рядового агента.
 */
export const oversightRouter = Router();

oversightRouter.use(requireAuth, requirePermission("dashboard.analytics"));

const MAX_PAGE_SIZE = 50;
const DEFAULT_PAGE_SIZE = 20;

function parsePage(req: { query: Record<string, unknown> }): { page: number; pageSize: number } {
  const page = Math.max(Math.trunc(Number(req.query.page)) || 1, 1);
  const pageSizeRaw = Math.trunc(Number(req.query.pageSize)) || DEFAULT_PAGE_SIZE;
  const pageSize = Math.min(Math.max(pageSizeRaw, 1), MAX_PAGE_SIZE);
  return { page, pageSize };
}

// «Без прогресса» у клиента с высоким скорингом — контакта не было дольше этого
// срока. Короче, чем общий порог «забытых клиентов» (10 дней, computeForgottenClients
// в routes/ai.ts): чем ближе клиент к сделке, тем дороже каждый день молчания.
const STALE_CONTACT_DAYS = 3;
const STALE_CONTACT_MS = STALE_CONTACT_DAYS * 24 * 60 * 60 * 1000;
// Окно «недавних» событий для плиток сводки (переводы в Неактивные, передачи).
// Экспортировано: карточка сотрудника (routes/team.ts) использует то же окно
// для findRefusedHighScore по одному агенту — второго числа не заводим.
export const RECENT_EVENTS_DAYS = 14;
export const RECENT_EVENTS_MS = RECENT_EVENTS_DAYS * 24 * 60 * 60 * 1000;

const clientRefSelect = {
  select: { id: true, shortId: true, fullName: true, workStatus: true },
} satisfies { select: Prisma.ClientSelect };

const agentRefSelect = {
  select: { id: true, fullName: true, avatarUrl: true },
} satisfies { select: Prisma.AgentSelect };

/**
 * НАДЗОРНЫЙ ЭКРАН ТОЖЕ ЗАКРЫВАЕТ НОМЕР (22.09.2026, ночной обход по классу
 * «номер уходит мимо прав»). Роутер висит на `dashboard.analytics`, а это право
 * есть у менеджера, у которого `clients.viewPhone` нет. Два соседних роута тут
 * уже делали это правильно (stalled-clients, refused-high-score), а остальные —
 * нет: `notes`, `nextAction`, имя карточки, дословная цитата и сводка разбора
 * уходили сырыми. Правило — то же, что в lib/clientPhone.ts, здесь только
 * применяется. `subjectName` PendingSummary — снимок имени клиента, закрывается
 * тем же `clientNamePhoneSafe`.
 */
function maskClientRef<T extends { fullName: string } | null | undefined>(client: T, canSeePhone: boolean): T {
  if (!client || canSeePhone) return client;
  return { ...client, fullName: clientNamePhoneSafe(client.fullName, false) };
}

function maskInteractionRow<
  T extends {
    notes?: string | null;
    nextAction?: string | null;
    client?: { fullName: string } | null;
  },
>(row: T, canSeePhone: boolean): T {
  if (canSeePhone) return row;
  return {
    ...row,
    ...(typeof row.notes === "string" ? { notes: phoneSafeText(row.notes, false) } : {}),
    ...(typeof row.nextAction === "string" ? { nextAction: phoneSafeText(row.nextAction, false) } : {}),
    ...(row.client ? { client: maskClientRef(row.client, false) } : {}),
  };
}

// Экспортированы для карточки сотрудника (routes/team.ts, GET /agents/:id/overview,
// раздел «Проблемы»): те же условия, что красят строки в «Контроле руководителя»,
// только сузены на agentId этого сотрудника — второй копии логики не заводим (тот
// же приём, что уже применён к findSilentAfterShowing/findEndlessNegotiations/
// findAgentLossSeries ниже).
export function overdueTasksWhere(now: Date): Prisma.InteractionWhereInput {
  return { ...TASK_WHERE, completedAt: null, nextActionDate: { lt: now } };
}

export function stalledClientsWhere(now: Date, hotScoreThreshold: number): Prisma.ClientWhereInput {
  return {
    ...OCCUPIES_SLOT_WHERE,
    deletedAt: null,
    aiScore: { gte: hotScoreThreshold },
    lastContactAt: { lt: new Date(now.getTime() - STALE_CONTACT_MS) },
  };
}

// «Переведён в Неактивные» пишется одной строкой из lib/clientWorkStatus.ts
// (deactivateClient) — структурной колонки с причиной нет (ТЗ п. 22 хранит её
// только текстом в хронологии), поэтому событие ищем по этому тексту.
function inactiveEventsWhere(): Prisma.InteractionWhereInput {
  return {
    type: "SYSTEM",
    notes: { contains: "переведён в Неактивные" },
    client: { deletedAt: null },
  };
}

// Передача между агентами (lib/clientTransfer.ts, transferClientByAgent) и
// передача дел уходящего сотрудника (lib/agentHandover.ts) — обе пишут
// заметку с этим текстом. Автоматическое переназначение непринятого лида
// (leads.ts, «Лид переназначен…») сюда намеренно не входит: это ещё нераспределённая
// заявка, а не уход клиента от уже работавшего с ним агента.
function transferEventsWhere(): Prisma.InteractionWhereInput {
  return {
    type: "SYSTEM",
    OR: [{ notes: { contains: "Передан другому агенту" } }, { notes: { contains: "передан из дел уходящего" } }],
    client: { deletedAt: null },
  };
}

/**
 * Отказ клиента (POST /clients/:id/refuse, routes/clients.ts) пишет одну SYSTEM-
 * запись с этим текстом первым словом заметки — структурной колонки «дата отказа»
 * в схеме нет (сам факт отказа виден по Client.refusalReason), поэтому момент
 * отказа для окна «за последние N дней» ищем тем же приёмом, что и переводы в
 * Неактивные/передачи выше.
 */
function refusalEventsWhere(): Prisma.InteractionWhereInput {
  return {
    type: "SYSTEM",
    notes: { contains: "Клиент отказался" },
    client: { deletedAt: null },
  };
}

// «Серия у одного агента» (Settings.agentLossSeriesThreshold) — своё окно, а
// не общий RECENT_EVENTS_DAYS (14): владелец просил именно 7 дней — серия
// смотрит на СВЕЖЕЕ поведение конкретного агента, а не на тот же долгий срок,
// которым меряются общекомандные плитки «В Неактивные»/«Передачи».
export const AGENT_LOSS_SERIES_WINDOW_DAYS = 7;
export const AGENT_LOSS_SERIES_WINDOW_MS = AGENT_LOSS_SERIES_WINDOW_DAYS * 24 * 60 * 60 * 1000;

async function loadSellerSilenceDays(): Promise<number> {
  const s = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { sellerSilenceAfterShowingDays: true } });
  return s?.sellerSilenceAfterShowingDays ?? 7;
}


/**
 * Сигнал «Тишина после показа» (антифрод, мозговой штурм владельца 20-21.08.2026):
 * у клиента был проведённый показ (см. lib/conductedShowing.ts) больше
 * Settings.sellerSilenceAfterShowingDays дней назад, а после него — ни одного
 * НОВОГО касания через CRM (звонок/сообщение/показ), и карточка ещё не закрыта
 * (не LOST/DEAL_CLOSED).
 *
 * Приём: сперва сужаем клиентов по lastContactAt (дешёвый индексированный фильтр —
 * lastContactAt читает КАЖДЫЙ живой человеческий контакт, включая сам показ), а
 * затем одним запросом с `distinct` достаём ПОСЛЕДНЕЕ не-SYSTEM взаимодействие
 * каждого кандидата и проверяем, что это и есть показ, и что он проведён. Если
 * после показа было хоть одно новое человеческое действие — lastContactAt сдвинулся
 * бы вперёд, кандидат сюда вообще не попал бы.
 */
// Экспортирована для mission-control (routes/dashboardMissionControl.ts) — «первая
// линия» переиспользует тот же сигнал, второй копии логики не заводим.
export async function findSilentAfterShowing(now: Date) {
  const days = await loadSellerSilenceDays();
  const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

  const candidates = await prisma.client.findMany({
    where: {
      deletedAt: null,
      status: { notIn: ["LOST", "DEAL_CLOSED"] },
      lastContactAt: { lt: cutoff },
    },
    orderBy: { lastContactAt: "asc" },
    take: 500,
    select: { id: true, shortId: true, fullName: true, workStatus: true, lastContactAt: true, assignedAgent: agentRefSelect },
  });
  if (candidates.length === 0) return { days, items: [] as typeof candidates };

  const lastTouches = await prisma.interaction.findMany({
    where: { clientId: { in: candidates.map((c) => c.id) }, type: { not: "SYSTEM" } },
    orderBy: [{ clientId: "asc" }, { createdAt: "desc" }],
    distinct: ["clientId"],
    select: { clientId: true, type: true, completedAt: true, nextActionDate: true, declinedAt: true, createdAt: true },
    // Потолок — строки, а не id клиентов: distinct уже держит по одной строке на
    // клиента, но потолок здесь пишем явно (22.09.2026, класс «Пагинация»), чтобы
    // граница не зависела от того, что distinct не уберут при следующей правке.
    take: candidates.length,
  });
  const touchByClient = new Map(lastTouches.map((t) => [t.clientId, t]));

  const items = candidates.filter((c) => {
    const touch = touchByClient.get(c.id);
    return touch ? isConductedShowing(touch, now) : false;
  });
  return { days, items };
}

/**
 * Сигнал «Отказ при хорошем скоринге» (антифрод): клиент отказался
 * (REFUSAL, см. refusalEventsWhere), пока ИИ-скоринг был не ниже
 * Settings.hotScoreThreshold, а служба безопасности эту карточку ЕЩЁ НЕ увидела
 * (Client.securityReview пуст — часть причин отказа сама уводит карточку в СБ,
 * см. REASONS_REQUIRING_SECURITY_REVIEW в packages/shared; дублировать тот
 * список здесь не нужно, читаем итоговое состояние поля).
 */
export async function findRefusedHighScore(since: Date) {
  const threshold = await loadHotScoreThreshold();
  // 0 в этом поле — по его собственному смыслу (routes/settings.ts) означает
  // «автопередача по скорингу выключена», то есть порог не назначен вовсе;
  // считать отказом ЛЮБОГО клиента (aiScore >= 0 всегда истинно) было бы шумом,
  // а не сигналом.
  if (threshold <= 0) return { threshold, items: [] as Awaited<ReturnType<typeof loadRefusalRows>> };
  const rows = await loadRefusalRows(since);
  const items = rows.filter((r) => r.client && r.client.securityReview === null && (r.client.aiScore ?? -1) >= threshold);
  return { threshold, items };
}

function loadRefusalRows(since: Date) {
  return prisma.interaction.findMany({
    where: { ...refusalEventsWhere(), createdAt: { gte: since } },
    orderBy: { createdAt: "desc" },
    take: 500,
    select: {
      id: true,
      createdAt: true,
      agent: agentRefSelect,
      client: {
        select: {
          id: true,
          shortId: true,
          fullName: true,
          status: true,
          aiScore: true,
          aiScoreReason: true,
          refusalReason: true,
          securityReview: true,
        },
      },
    },
  });
}

async function loadSellerNegotiationMaxRounds(): Promise<number> {
  const s = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { sellerNegotiationMaxRounds: true } });
  return s?.sellerNegotiationMaxRounds ?? 3;
}

async function loadAgentLossSeriesThreshold(): Promise<number> {
  const s = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { agentLossSeriesThreshold: true } });
  return s?.agentLossSeriesThreshold ?? 3;
}

// Заметка, которой completeSellerShowingSummary (routes/me.ts, ветка NEGOTIATION)
// помечает каждый круг «Итога приёмки» — то же начало строки, что и там.
const NEGOTIATION_NOTE_MARKER = "Итог приёмки: Переговоры";

/**
 * Сигнал «Вечные переговоры» (антифрод, владелец 01.09.2026): ветка «Переговоры»
 * окна «Итог приёмки» (kind="seller_showing", см. completeSellerShowingSummary,
 * routes/me.ts) НЕ закрывает требование — переносит dueAt на 24 часа вперёд и
 * заводит SYSTEM-запись с меткой NEGOTIATION_NOTE_MARKER, повторяя цикл, пока
 * агент не выберет другую ветку («Добавить объект»/«Назначить съёмку»/«Отказ»).
 * Отдельного счётчика циклов на PendingSummary нет (снooseCount считает ДРУГОЕ —
 * отсрочки самого показа окна, см. lib/pendingSummaries.ts), поэтому число кругов
 * считаем по количеству таких SYSTEM-записей, созданных для клиента ПОСЛЕ того,
 * как открылась ТЕКУЩАЯ встреча (subjectId — id именно этой записи-встречи,
 * см. комментарий у completeSellerShowingSummary): «Назначить съёмку» заводит
 * НОВУЮ запись встречи с новым subjectId, и счётчик у неё честно начинается
 * заново — переговоры до переноса на новую встречу в новый круг не переносятся.
 *
 * Смотрим только СЕЙЧАС ОТКРЫТЫЕ требования (doneAt/dismissedAt пусты) — ветка
 * «Переговоры» единственная, что держит kind="seller_showing" открытым бесконечно;
 * если требование закрыто, значит агент из круга уже вышел.
 */
export async function findEndlessNegotiations(now: Date) {
  const maxRounds = await loadSellerNegotiationMaxRounds();

  const summaries = await prisma.pendingSummary.findMany({
    where: { kind: "seller_showing", doneAt: null, dismissedAt: null },
    orderBy: { dueAt: "asc" },
    take: 500,
    select: { id: true, subjectId: true, subjectName: true, dueAt: true, agent: agentRefSelect },
  });
  if (summaries.length === 0) return { maxRounds, items: [] as EndlessNegotiationItem[] };

  const meetings = await prisma.interaction.findMany({
    where: { id: { in: summaries.map((s) => s.subjectId) } },
    select: { id: true, clientId: true, createdAt: true },
    // Потолок — строки, а не id: findMany по id уникальных PK уже не может вернуть
    // больше, чем передано id, но пишем явно (22.09.2026, класс «Пагинация»).
    take: summaries.length,
  });
  const meetingById = new Map(meetings.map((m) => [m.id, m]));
  const clientIds = [...new Set(meetings.map((m) => m.clientId))];
  if (clientIds.length === 0) return { maxRounds, items: [] as EndlessNegotiationItem[] };

  /** Потолок «кругов переговоров» на клиента: NEGOTIATION_NOTE_MARKER пишется на
   *  каждый отказ агента закрыть требование, без верхней границы по времени —
   *  теоретически может расти годами у одного упрямого клиента. Строки, не id
   *  (клиентов уже ≤ clientIds.length). 200 на клиента с большим запасом. */
  const NEGOTIATION_NOTES_PER_CLIENT_CAP = 200;

  const [clients, negotiationNotes] = await Promise.all([
    prisma.client.findMany({
      where: { id: { in: clientIds } },
      select: { id: true, shortId: true, fullName: true, workStatus: true },
      take: clientIds.length,
    }),
    prisma.interaction.findMany({
      where: { type: "SYSTEM", notes: { contains: NEGOTIATION_NOTE_MARKER }, clientId: { in: clientIds } },
      orderBy: { createdAt: "asc" },
      select: { clientId: true, createdAt: true },
      take: clientIds.length * NEGOTIATION_NOTES_PER_CLIENT_CAP,
    }),
  ]);
  const clientById = new Map(clients.map((c) => [c.id, c]));
  const notesByClient = new Map<string, Date[]>();
  for (const n of negotiationNotes) {
    const arr = notesByClient.get(n.clientId);
    if (arr) arr.push(n.createdAt);
    else notesByClient.set(n.clientId, [n.createdAt]);
  }

  const items: EndlessNegotiationItem[] = [];
  for (const s of summaries) {
    const meeting = meetingById.get(s.subjectId);
    if (!meeting) continue;
    const client = clientById.get(meeting.clientId);
    if (!client) continue;
    const notes = notesByClient.get(meeting.clientId) ?? [];
    const rounds = notes.filter((d) => d.getTime() >= meeting.createdAt.getTime()).length;
    if (rounds < maxRounds) continue;
    items.push({ id: s.id, subjectName: s.subjectName, dueAt: s.dueAt, agent: s.agent, rounds, client });
  }
  items.sort((a, b) => b.rounds - a.rounds);
  return { maxRounds, items };
}

interface EndlessNegotiationItem {
  id: string;
  subjectName: string;
  dueAt: Date;
  agent: { id: string; fullName: string; avatarUrl: string | null };
  rounds: number;
  client: { id: string; shortId: number; fullName: string; workStatus: string };
}

/**
 * Сигнал «Серия у одного агента» (антифрод, владелец 01.09.2026): 3+
 * (Settings.agentLossSeriesThreshold) переводов в «Неактивные» ИЛИ прямых
 * потерь (Client.status=LOST) у ОДНОГО агента за последние
 * AGENT_LOSS_SERIES_WINDOW_DAYS дней — не общая цифра по компании (та уже
 * есть плитками recentInactive/recentTransfers), а разбивка по конкретному
 * исполнителю: три случая подряд у новичка — возможно, ему нужна помощь; у
 * опытного — стоит присмотреться.
 *
 * «Неактивные» считаем тем же событием, что и общая плитка (inactiveEventsWhere,
 * agentId — кто выполнил перевод). «Потеря» — по Client.status=LOST/lostAt
 * (schema.prisma: ставится во ВСЕХ трёх местах, где карточка уходит в LOST —
 * ручной отказ, эскалация передач, светофор неактивных), ответственный агент —
 * lastAgentId (переживает и уход в INACTIVE, и в LOST — см. схему), а если он
 * почему-то пуст (клиент был потерян, ни разу не побывав в Неактивных) —
 * запасной вариант assignedAgentId, каким он был на момент выборки.
 */
export async function findAgentLossSeries(since: Date) {
  const threshold = await loadAgentLossSeriesThreshold();

  // groupBy, а не findMany: ниже от обеих выборок берутся ТОЛЬКО счётчики по
  // агентам, а сами строки в память тащились целиком и без потолка — соседние
  // помощники в этом файле потолок имеют (take: 500), здесь его просто забыли.
  // Клиентов приходится группировать по паре полей: ответственный — lastAgentId,
  // а если он пуст, запасной вариант assignedAgentId (см. doc-comment выше).
  const [inactiveEvents, lostClients] = await Promise.all([
    prisma.interaction.groupBy({
      by: ["agentId"],
      where: { ...inactiveEventsWhere(), createdAt: { gte: since } },
      _count: { _all: true },
    }),
    prisma.client.groupBy({
      by: ["lastAgentId", "assignedAgentId"],
      where: { status: "LOST", lostAt: { gte: since }, deletedAt: null },
      _count: { _all: true },
    }),
  ]);

  const counts = new Map<string, number>();
  // Строки теперь сгруппированы, поэтому прибавляется размер группы, а не единица.
  for (const e of inactiveEvents) if (e.agentId) counts.set(e.agentId, (counts.get(e.agentId) ?? 0) + e._count._all);
  for (const c of lostClients) {
    const agentId = c.lastAgentId ?? c.assignedAgentId;
    if (!agentId) continue;
    counts.set(agentId, (counts.get(agentId) ?? 0) + c._count._all);
  }

  const flaggedIds = [...counts.entries()].filter(([, count]) => count >= threshold).map(([id]) => id);
  if (flaggedIds.length === 0) {
    return { threshold, windowDays: AGENT_LOSS_SERIES_WINDOW_DAYS, items: [] as AgentLossSeriesItem[] };
  }

  const agents = await prisma.agent.findMany({ where: { id: { in: flaggedIds } }, select: { id: true, fullName: true, avatarUrl: true } });
  const agentById = new Map(agents.map((a) => [a.id, a]));
  const items: AgentLossSeriesItem[] = flaggedIds
    .map((id) => ({
      agentId: id,
      agentName: agentById.get(id)?.fullName ?? "Неизвестно",
      avatarUrl: agentById.get(id)?.avatarUrl ?? null,
      count: counts.get(id)!,
    }))
    .sort((a, b) => b.count - a.count);

  return { threshold, windowDays: AGENT_LOSS_SERIES_WINDOW_DAYS, items };
}

interface AgentLossSeriesItem {
  agentId: string;
  agentName: string;
  avatarUrl: string | null;
  count: number;
}

/**
 * Снимок данных не персонален (одни и те же цифры видит любой директор/
 * руководитель — право на роут уже общее), поэтому кэш — один слот на
 * процесс, а не по пользователю. TTL 30 с: приёмка 08.09.2026 показала, что
 * несколько руководителей, открывших раздел одновременно (или один, часто
 * обновляющий вкладку), сами по себе создают всплеск параллельных запросов
 * к БД — кэш гасит повторные заходы, а не только один browser tick.
 */
const SUMMARY_CACHE_TTL_MS = 30_000;
let summaryCache: { expiresAt: number; value: unknown } | null = null;
let summaryInFlight: Promise<unknown> | null = null;

/**
 * Параллелизм задач БД в снимке — раньше голый `Promise.all` из 11 веток (часть
 * из которых сама делает 2-3 запроса) при нескольких одновременных заходах
 * исчерпывала пул соединений Prisma (приёмка 08.09.2026, лимит 13 — таймаут
 * «Timed out fetching a new connection from the pool»). 4 — компромисс между
 * временем ответа и тем, сколько соединений раздел вправе занять одновременно
 * с остальной CRM.
 */
const SUMMARY_QUERY_CONCURRENCY = 4;

interface TrafficLightAgentRow {
  agentId: string;
  agentName: string;
  avatarUrl: string | null;
  red: number;
  yellow: number;
  green: number;
  total: number;
}

/**
 * «Светофор неактивных — сейчас» (аудит 03.09.2026 ночь, п. 7): у директора не
 * было ни одного экрана «весь светофор одним взглядом» — сколько клиентов
 * сейчас в каждом цвете, по каждому агенту. Один `groupBy` по уже готовым
 * колонкам (`Client.workStatus`+`inactiveLevel`, тот же составной индекс, что
 * у крона светофора — см. schema.prisma) — цвет НЕ пересчитывается заново
 * (это делает classifyInactiveLevelByDepth в lib/inactiveTrafficLight.ts в
 * момент перевода в Неактивные и держит в актуальном состоянии крон раз в
 * час), здесь только чтение уже посчитанного поля.
 *
 * Карточки, у которых предел попыток светофора исчерпан, уходят в LOST, но
 * остаются workStatus=INACTIVE и (с 11.09.2026) сохраняют агента — показывать
 * их директору в портфеле агента как неактивных нечестно, их отсекает
 * `status: { not: "LOST" }`. `assignedAgentId: { not: null }` — карточки без
 * агента в матрицу агент×цвет не ложатся вовсе.
 */
export async function findTrafficLightSummary(): Promise<{
  totals: { red: number; yellow: number; green: number };
  agents: TrafficLightAgentRow[];
}> {
  const rows = await prisma.client.groupBy({
    by: ["assignedAgentId", "inactiveLevel"],
    /**
     * status не LOST (23.09.2026): с 11.09.2026 предел попыток переводит в
     * «Потерянные» с сохранением агента и workStatus=INACTIVE (markClientLost),
     * так что фильтр по агенту ниже потерянных больше не отсекает — они
     * копились в светофоре директора как «неактивные в работе у агента».
     */
    where: { workStatus: "INACTIVE", kind: { not: "OTHER" }, status: { notIn: ["LOST", "ARCHIVED", "DEAL_CLOSED"] }, deletedAt: null, assignedAgentId: { not: null } },
    _count: { _all: true },
  });

  const totals = { RED: 0, YELLOW: 0, GREEN: 0 } as Record<InactiveLevel, number>;
  const byAgent = new Map<string, Record<InactiveLevel, number>>();
  for (const r of rows) {
    // inactiveLevel пуст только у карточек, переведённых в Неактивные ДО
    // 03.09.2026 (переделка светофора «по глубине») и ни разу не тронутых
    // краном с тех пор — не считаем их ни одним цветом, а не роняем запрос.
    if (!r.inactiveLevel || !r.assignedAgentId) continue;
    const count = r._count._all;
    totals[r.inactiveLevel] += count;
    const entry = byAgent.get(r.assignedAgentId) ?? { RED: 0, YELLOW: 0, GREEN: 0 };
    entry[r.inactiveLevel] += count;
    byAgent.set(r.assignedAgentId, entry);
  }

  const agentIds = [...byAgent.keys()];
  const agentRows =
    agentIds.length > 0
      ? await prisma.agent.findMany({ where: { id: { in: agentIds } }, select: { id: true, fullName: true, avatarUrl: true } })
      : [];
  const agentById = new Map(agentRows.map((a) => [a.id, a]));

  const agents: TrafficLightAgentRow[] = agentIds
    .map((id) => {
      const counts = byAgent.get(id)!;
      const agent = agentById.get(id);
      return {
        agentId: id,
        agentName: agent?.fullName ?? "Неизвестно",
        avatarUrl: agent?.avatarUrl ?? null,
        red: counts.RED,
        yellow: counts.YELLOW,
        green: counts.GREEN,
        total: counts.RED + counts.YELLOW + counts.GREEN,
      };
    })
    // Сначала у кого больше всего красных (меньше всего работы уже вложено —
    // самый срочный взгляд руководителя), затем по общему числу.
    .sort((a, b) => b.red - a.red || b.total - a.total);

  return {
    totals: { red: totals.RED, yellow: totals.YELLOW, green: totals.GREEN },
    agents,
  };
}

/**
 * GET /oversight/traffic-light-summary — см. findTrafficLightSummary выше.
 * Без пагинации: агентов в штате десятки, не тысячи, вся сводка — одна
 * компактная таблица.
 */
oversightRouter.get("/traffic-light-summary", async (_req, res) => {
  res.json(await findTrafficLightSummary());
});

async function buildOversightSummary() {
  const now = new Date();
  const recentSince = new Date(now.getTime() - RECENT_EVENTS_MS);

  const [
    limits,
    agents,
    overdueTasks,
    staleHotClients,
    recentInactive,
    recentTransfers,
    silentAfterShowing,
    refusedHighScore,
    sellerPropertyMissing,
    endlessNegotiations,
    agentLossSeries,
  ] = await runLimited(
    [
      () => loadLeadLimits(),
      () => prisma.agent.findMany({ where: { role: { in: [...RATED_ROLES] }, isActive: true }, select: { id: true } }),
      () => prisma.interaction.count({ where: overdueTasksWhere(now) }),
      () => loadHotScoreThreshold().then((t) => prisma.client.count({ where: stalledClientsWhere(now, t) })),
      () => prisma.interaction.count({ where: { ...inactiveEventsWhere(), createdAt: { gte: recentSince } } }),
      () => prisma.interaction.count({ where: { ...transferEventsWhere(), createdAt: { gte: recentSince } } }),
      () => findSilentAfterShowing(now),
      () => findRefusedHighScore(recentSince),
      () => findSellerPropertyMissing(now),
      () => findEndlessNegotiations(now),
      () => findAgentLossSeries(new Date(now.getTime() - AGENT_LOSS_SERIES_WINDOW_MS)),
    ],
    SUMMARY_QUERY_CONCURRENCY
  );

  // Лимит выключен (0) — «агентов у лимита» бессмысленная цифра, не считаем.
  let agentsAtLimit = 0;
  if (limits.activeLimit > 0 && agents.length > 0) {
    const counts = await activeLeadCounts(agents.map((a) => a.id));
    for (const c of counts.values()) {
      if (slotsTaken(c, limits) >= limits.activeLimit) agentsAtLimit++;
    }
  }

  return {
    overdueTasks,
    agentsAtLimit,
    staleHotClients,
    recentInactive,
    recentTransfers,
    silentAfterShowing: silentAfterShowing.items.length,
    silentAfterShowingDays: silentAfterShowing.days,
    refusedHighScore: refusedHighScore.items.length,
    sellerPropertyMissingWarn: sellerPropertyMissing.items.filter((i) => i.level === "WARN").length,
    sellerPropertyMissingCritical: sellerPropertyMissing.items.filter((i) => i.level === "CRITICAL").length,
    sellerPropertyMissingWarnDays: sellerPropertyMissing.warnDays,
    sellerPropertyMissingCriticalDays: sellerPropertyMissing.criticalDays,
    endlessNegotiations: endlessNegotiations.items.length,
    sellerNegotiationMaxRounds: endlessNegotiations.maxRounds,
    agentLossSeries: agentLossSeries.items.length,
    agentLossSeriesThreshold: agentLossSeries.threshold,
    agentLossSeriesWindowDays: agentLossSeries.windowDays,
    leadLimit: limits.activeLimit,
    recentWindowDays: RECENT_EVENTS_DAYS,
  };
}

/**
 * Снимок за 30 с плюс совместный in-flight промис: два запроса, пришедшие
 * ПОКА кэш ещё пуст (например, два директора одновременно открыли раздел),
 * не должны каждый заново гонять 11 запросов — второй ждёт результат первого.
 */
async function getOversightSummaryCached() {
  const now = Date.now();
  if (summaryCache && summaryCache.expiresAt > now) return summaryCache.value;
  if (summaryInFlight) return summaryInFlight;

  summaryInFlight = buildOversightSummary()
    .then((value) => {
      summaryCache = { expiresAt: Date.now() + SUMMARY_CACHE_TTL_MS, value };
      return value;
    })
    .finally(() => {
      summaryInFlight = null;
    });
  return summaryInFlight;
}

/** GET /oversight/summary — числа для плиток наверху экрана. */
oversightRouter.get("/summary", async (_req, res) => {
  res.json(await getOversightSummaryCached());
});

/**
 * GET /oversight/agents-at-limit — агенты, чей активный портфель достиг лимита
 * (Settings.leadActiveLimit, по умолчанию 6 — см. lib/leadLimits.ts). Список
 * ограничен ролью AGENT и активными учётками; take — потолок на случай очень
 * большого штата, отдельной пагинации не требует (это не журнал событий).
 */
oversightRouter.get("/agents-at-limit", async (_req, res) => {
  const limits = await loadLeadLimits();
  if (limits.activeLimit <= 0) {
    return res.json({ items: [], limit: limits.activeLimit });
  }

  const agents = await prisma.agent.findMany({
    where: { role: { in: [...RATED_ROLES] }, isActive: true },
    select: { id: true, fullName: true, avatarUrl: true, frozenAt: true },
    orderBy: { fullName: "asc" },
    take: 200,
  });
  const counts = await activeLeadCounts(agents.map((a) => a.id));

  const items = agents
    .map((a) => {
      const c = counts.get(a.id) ?? NO_LEADS;
      return {
        id: a.id,
        fullName: a.fullName,
        avatarUrl: a.avatarUrl,
        frozen: a.frozenAt !== null,
        total: c.total,
        own: c.own,
        regular: c.regular,
        /**
         * Сколько СЛОТОВ занято — дробное, когда включены веса (Настройки →
         * «Взвешенные слоты»). Отдаём рядом с total, а не вместо него: список
         * называется «агенты у лимита», и отбор обязан идти по тому же числу,
         * по какому лимит упирается при раздаче, иначе руководитель видит
         * восемь карточек у человека, которому CRM продолжает давать лиды, и
         * не понимает, почему. Пока веса выключены, slotsUsed === total.
         */
        slotsUsed: slotsTaken(c, limits),
      };
    })
    .filter((a) => a.slotsUsed >= limits.activeLimit)
    .sort((a, b) => b.slotsUsed - a.slotsUsed);

  res.json({ items, limit: limits.activeLimit });
});

/** GET /oversight/overdue-tasks — задачи (Interaction.nextAction), срок которых
 *  прошёл, а выполненными не отмечены. Тот же TASK_WHERE, что и везде в CRM
 *  (lib/tasks.ts) — одно определение задачи на всю систему. */
oversightRouter.get("/overdue-tasks", async (req, res) => {
  const { page, pageSize } = parsePage(req);
  const now = new Date();
  const where = overdueTasksWhere(now);

  const [rows, total] = await Promise.all([
    prisma.interaction.findMany({
      where,
      orderBy: [{ nextActionDate: "asc" }, { id: "asc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        notes: true,
        nextAction: true,
        nextActionDate: true,
        client: clientRefSelect,
        agent: agentRefSelect,
      },
    }),
    prisma.interaction.count({ where }),
  ]);

  const canSeePhone = req.agent!.can("clients.viewPhone");
  res.json({ items: rows.map((r) => maskInteractionRow(r, canSeePhone)), total, page, pageSize });
});

/** GET /oversight/stalled-clients — клиенты с высоким ИИ-скорингом (см.
 *  ai/scoring.ts, автозапуск — lib/clientAutopilot.ts), которые всё ещё в
 *  активном портфеле агента, но без контакта дольше STALE_CONTACT_DAYS. */
oversightRouter.get("/stalled-clients", async (req, res) => {
  const { page, pageSize } = parsePage(req);
  const now = new Date();
  const where = stalledClientsWhere(now, await loadHotScoreThreshold());

  const [rows, total] = await Promise.all([
    prisma.client.findMany({
      where,
      orderBy: [{ aiScore: "desc" }, { id: "desc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        shortId: true,
        fullName: true,
        status: true,
        aiScore: true,
        aiScoreReason: true,
        lastContactAt: true,
        assignedAgent: agentRefSelect,
      },
    }),
    prisma.client.count({ where }),
  ]);

  const canSeePhone = req.agent!.can("clients.viewPhone");
  res.json({
    // Тот же обход presentClient, что и в /refused-high-score выше: сводка причины
    // от ИИ несёт номер, продиктованный клиентом, а право на номер отдельное.
    items: rows.map((c) => ({
      ...c,
      fullName: clientNamePhoneSafe(c.fullName, canSeePhone),
      aiScoreReason: phoneSafeText(c.aiScoreReason, canSeePhone),
    })),
    total,
    page,
    pageSize,
  });
});

/** GET /oversight/inactive-clients — журнал переводов в «Неактивные» (ТЗ п. 22),
 *  новые сверху. Причина — тем же текстом, что видит агент в хронологии
 *  клиента (структурной колонки с причиной нет, см. inactiveEventsWhere). */
oversightRouter.get("/inactive-clients", async (req, res) => {
  const { page, pageSize } = parsePage(req);
  const where = inactiveEventsWhere();

  const [rows, total] = await Promise.all([
    prisma.interaction.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        notes: true,
        createdAt: true,
        client: clientRefSelect,
        agent: agentRefSelect,
      },
    }),
    prisma.interaction.count({ where }),
  ]);

  const canSeePhone = req.agent!.can("clients.viewPhone");
  res.json({ items: rows.map((r) => maskInteractionRow(r, canSeePhone)), total, page, pageSize });
});

/** GET /oversight/lead-transfers — журнал передач клиента другому агенту
 *  (lib/clientTransfer.ts + офбординг lib/agentHandover.ts), новые сверху. */
oversightRouter.get("/lead-transfers", async (req, res) => {
  const { page, pageSize } = parsePage(req);
  const where = transferEventsWhere();

  const [rows, total] = await Promise.all([
    prisma.interaction.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        notes: true,
        createdAt: true,
        client: clientRefSelect,
        agent: agentRefSelect,
      },
    }),
    prisma.interaction.count({ where }),
  ]);

  const canSeePhone = req.agent!.can("clients.viewPhone");
  res.json({ items: rows.map((r) => maskInteractionRow(r, canSeePhone)), total, page, pageSize });
});

/**
 * GET /oversight/silent-after-showing — красный флаг «Тишина после показа»
 * (см. findSilentAfterShowing выше). Пагинация — в памяти, на уже отфильтрованном
 * списке: кандидатов ограничивает take(500) в самом поиске, второй проход по базе
 * ради count() того же условия был бы дороже, чем просто отдать длину массива.
 */
oversightRouter.get("/silent-after-showing", async (req, res) => {
  const { page, pageSize } = parsePage(req);
  const { days, items } = await findSilentAfterShowing(new Date());
  const canSeePhone = req.agent!.can("clients.viewPhone");
  const start = (page - 1) * pageSize;
  res.json({
    items: items.slice(start, start + pageSize).map((c) => maskClientRef(c, canSeePhone)),
    total: items.length,
    page,
    pageSize,
    days,
  });
});

/**
 * GET /oversight/refused-high-score — красный флаг «Отказ при хорошем скоринге»
 * (см. findRefusedHighScore выше).
 */
oversightRouter.get("/refused-high-score", async (req, res) => {
  const { page, pageSize } = parsePage(req);
  const { threshold, items } = await findRefusedHighScore(new Date(Date.now() - RECENT_EVENTS_MS));
  const canSeePhone = req.agent!.can("clients.viewPhone");
  const start = (page - 1) * pageSize;
  res.json({
    items: items.slice(start, start + pageSize).map((r) => ({
      id: r.id,
      createdAt: r.createdAt,
      agent: r.agent,
      // Карточка отдаётся МИМО presentClient, где живёт правило телефона: причина
      // оценки — пересказ переписки от модели, и номер попадает в неё словами
      // клиента (см. ai/scoring.ts). Экран открыт правом dashboard.analytics, а
      // номер — отдельное clients.viewPhone, и совпадают они не всегда: у службы
      // безопасности первое есть, второго может не быть (30.08.2026).
      client: r.client
        ? {
            ...r.client,
            fullName: clientNamePhoneSafe(r.client.fullName, canSeePhone),
            aiScoreReason: phoneSafeText(r.client.aiScoreReason, canSeePhone),
          }
        : r.client,
    })),
    total: items.length,
    page,
    pageSize,
    threshold,
    windowDays: RECENT_EVENTS_DAYS,
  });
});

/**
 * GET /oversight/transfer-pairs — красный флаг «Маршруты передач между агентами»
 * (антифрод, мозговой штурм владельца 20-21.08.2026): топ-10 пар «от кого →
 * кому» за последние 30 дней, отсортированные по частоте. Это НЕ вывод, что пара
 * подозрительна — просто список, часто повторяющаяся пара помечена `frequent`
 * для глаза руководителя, решение остаётся за человеком.
 *
 * Структурного поля «от какого агента» у передачи нет (см. lib/clientTransfer.ts —
 * Interaction хранит только НОВОГО agentId), поэтому «от кого» восстанавливается
 * по цепочке: агент последней записи ЭТОГО клиента, сделанной строго до передачи,
 * — тот, кто вёл клиента перед ней. Best-effort, как и восстановление «инициатора»
 * в routes/security.ts: если у клиента до передачи вовсе не было записей (первая
 * же запись — сама передача), пара пропускается — восстанавливать «от кого» не из чего.
 */
const TRANSFER_PAIRS_WINDOW_DAYS = 30;
const TRANSFER_PAIRS_WINDOW_MS = TRANSFER_PAIRS_WINDOW_DAYS * 24 * 60 * 60 * 1000;
const TRANSFER_PAIRS_FREQUENT_THRESHOLD = 3;

oversightRouter.get("/transfer-pairs", async (_req, res) => {
  const since = new Date(Date.now() - TRANSFER_PAIRS_WINDOW_MS);
  const transfers = await prisma.interaction.findMany({
    where: { ...transferEventsWhere(), createdAt: { gte: since } },
    orderBy: { createdAt: "asc" },
    take: 1000,
    select: { id: true, clientId: true, agentId: true, createdAt: true },
  });

  if (transfers.length === 0) {
    return res.json({ pairs: [], windowDays: TRANSFER_PAIRS_WINDOW_DAYS, frequentThreshold: TRANSFER_PAIRS_FREQUENT_THRESHOLD });
  }

  const clientIds = [...new Set(transfers.map((t) => t.clientId))];
  // Вся хронология этих клиентов, не только передачи — «от кого» вычисляется по
  // ЛЮБОЙ предыдущей записи (звонок, показ, служебная), а не только по передачам.
  const history = await prisma.interaction.findMany({
    where: { clientId: { in: clientIds } },
    orderBy: { createdAt: "asc" },
    take: 5000,
    select: { id: true, clientId: true, agentId: true, createdAt: true },
  });
  const byClient = new Map<string, typeof history>();
  for (const row of history) {
    const arr = byClient.get(row.clientId);
    if (arr) arr.push(row);
    else byClient.set(row.clientId, [row]);
  }

  const pairCounts = new Map<string, { fromId: string; toId: string; count: number }>();
  for (const t of transfers) {
    if (!t.agentId) continue; // передача без явного нового агента — восстановить пару не из чего
    const list = byClient.get(t.clientId) ?? [];
    // Последняя запись строго до этой передачи (по времени, не считая её саму) —
    // список уже отсортирован по возрастанию createdAt, поэтому это последний
    // элемент, прошедший фильтр. Записи без агента (SYSTEM/AI, П-10) пропускаем —
    // «от кого» нужен живой человек.
    let prevAgentId: string | null = null;
    for (const row of list) {
      if (row.id === t.id) break;
      if (row.createdAt.getTime() >= t.createdAt.getTime()) break;
      if (row.agentId) prevAgentId = row.agentId;
    }
    if (!prevAgentId || prevAgentId === t.agentId) continue;
    const key = `${prevAgentId}->${t.agentId}`;
    const existing = pairCounts.get(key);
    if (existing) existing.count++;
    else pairCounts.set(key, { fromId: prevAgentId, toId: t.agentId, count: 1 });
  }

  const involvedAgentIds = new Set<string>();
  for (const p of pairCounts.values()) {
    involvedAgentIds.add(p.fromId);
    involvedAgentIds.add(p.toId);
  }
  const agentRows =
    involvedAgentIds.size > 0
      ? await prisma.agent.findMany({ where: { id: { in: [...involvedAgentIds] } }, select: { id: true, fullName: true, avatarUrl: true } })
      : [];
  const agentById = new Map(agentRows.map((a) => [a.id, a]));
  const unknownAgent = (id: string) => agentById.get(id) ?? { id, fullName: "Неизвестно", avatarUrl: null };

  const pairs = [...pairCounts.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, 10)
    .map((p) => ({
      from: unknownAgent(p.fromId),
      to: unknownAgent(p.toId),
      count: p.count,
      frequent: p.count >= TRANSFER_PAIRS_FREQUENT_THRESHOLD,
    }));

  res.json({ pairs, windowDays: TRANSFER_PAIRS_WINDOW_DAYS, frequentThreshold: TRANSFER_PAIRS_FREQUENT_THRESHOLD });
});

/**
 * GET /oversight/seller-property-missing — жёлтый/красный флаг «Продавец без
 * объекта» (см. lib/sellerPropertyMissingAntifraud.ts). Пагинация — в памяти,
 * тем же приёмом, что и /silent-after-showing: кандидатов уже ограничивает
 * take(500) внутри поиска.
 */
oversightRouter.get("/seller-property-missing", async (req, res) => {
  const { page, pageSize } = parsePage(req);
  const { warnDays, criticalDays, items } = await findSellerPropertyMissing(new Date());
  const canSeePhone = req.agent!.can("clients.viewPhone");
  const start = (page - 1) * pageSize;
  res.json({
    items: items.slice(start, start + pageSize).map((c) => maskClientRef(c, canSeePhone)),
    total: items.length,
    page,
    pageSize,
    warnDays,
    criticalDays,
  });
});

/**
 * GET /oversight/endless-negotiations — красный флаг «Вечные переговоры»
 * (см. findEndlessNegotiations выше). Пагинация — в памяти, тем же приёмом,
 * что и /silent-after-showing: кандидатов уже ограничивает take(500) внутри поиска.
 */
oversightRouter.get("/endless-negotiations", async (req, res) => {
  const { page, pageSize } = parsePage(req);
  const { maxRounds, items } = await findEndlessNegotiations(new Date());
  const canSeePhone = req.agent!.can("clients.viewPhone");
  const start = (page - 1) * pageSize;
  res.json({
    // subjectName — снимок имени клиента, client.fullName — он же в связанной
    // карточке: оба через ту же маску.
    items: items.slice(start, start + pageSize).map((it) => ({
      ...it,
      subjectName: canSeePhone ? it.subjectName : clientNamePhoneSafe(it.subjectName, false),
      client: maskClientRef(it.client, canSeePhone),
    })),
    total: items.length,
    page,
    pageSize,
    maxRounds,
  });
});

/**
 * GET /oversight/agent-loss-series — красный флаг «Серия у одного агента»
 * (см. findAgentLossSeries выше). Список короткий (штат агентов), без пагинации —
 * тем же приёмом, что и /transfer-pairs.
 */
oversightRouter.get("/agent-loss-series", async (_req, res) => {
  const since = new Date(Date.now() - AGENT_LOSS_SERIES_WINDOW_MS);
  const { threshold, windowDays, items } = await findAgentLossSeries(since);
  res.json({ items, threshold, windowDays });
});

/**
 * GET /oversight/showing-survey-calls — ЗВОНКИ-ОПРОСЫ ПОСЛЕ ПОКАЗА (антифрод).
 *
 * ИСТОЧНИК СМЕНИЛСЯ 17.09.2026, ПУТЬ И ФОРМА ОТВЕТА — НЕТ. Читаем `PostShowingCall`
 * (см. lib/postShowingCallFeed.ts): владелец 16.09 выбрал один механизм из двух,
 * и это он — с окном 09:00–19:00, звонком только туда, где клиент сам ничего не
 * сказал, двумя попытками и разбором с обязательной цитатой. Экран при этом
 * остался прежним: «внедрять мягко, не портя что построено».
 *
 * До сих пор результат этих звонков было видно ТОЛЬКО пуш-уведомлением при
 * найденном красном флаге, указывающим на карточку клиента — а сама карточка
 * клиенту НЕ показывает эту проверку (секретность по дизайну, см. докстринг
 * модели PostShowingCall в schema.prisma). Разбора всех звонков — включая
 * те, где флагов не нашлось, — не было нигде: этот список — то самое место.
 *
 * ?onlyFlagged=1 — только звонки с находками (быстрый фильтр для директора,
 * которому не всегда нужны все прозвоны, а именно тревожные).
 */
oversightRouter.get("/showing-survey-calls", async (req, res) => {
  const { page, pageSize } = parsePage(req);
  const onlyFlagged = req.query.onlyFlagged === "1" || req.query.onlyFlagged === "true";
  const { items, total } = await listPostShowingCallFeed({ page, pageSize, onlyFlagged });

  const agentIds = [...new Set(items.map((r) => r.agentId))];
  const clientIds = [...new Set(items.map((r) => r.clientId))];
  const propertyIds = [...new Set(items.map((r) => r.propertyId).filter((id): id is string => !!id))];
  const [agents, clients, properties] = await Promise.all([
    agentIds.length ? prisma.agent.findMany({ where: { id: { in: agentIds } }, select: { id: true, fullName: true } }) : [],
    clientIds.length
      ? prisma.client.findMany({ where: { id: { in: clientIds } }, select: { id: true, fullName: true, shortId: true } })
      : [],
    propertyIds.length
      ? prisma.property.findMany({ where: { id: { in: propertyIds } }, select: { id: true, title: true, shortId: true } })
      : [],
  ]);
  const agentById = new Map(agents.map((a) => [a.id, a]));
  const clientById = new Map(clients.map((c) => [c.id, c]));
  const propertyById = new Map(properties.map((p) => [p.id, p]));

  // Разговор-опрос идёт клиенту, и клиент диктует в него номер: превью, цитата,
  // сводка и находки — свободный текст, закрываем правом на телефон (22.09.2026).
  const canSeePhone = req.agent!.can("clients.viewPhone");
  const canHear = req.agent!.can("calls.hearRecording");
  const safeText = <T extends string | null>(t: T): T => (canSeePhone ? t : phoneSafeText(t, false));
  res.json({
    items: items.map((r) => ({
      id: r.id,
      agent: agentById.get(r.agentId) ?? null,
      client: maskClientRef(clientById.get(r.clientId) ?? null, canSeePhone),
      property: r.propertyId ? (propertyById.get(r.propertyId) ?? null) : null,
      calledAt: r.calledAt,
      createdAt: r.createdAt,
      // Превью, а не весь текст — список не должен весить мегабайт (тот же приём,
      // что у /settings/live-voice/sessions).
      transcriptPreview: r.transcript ? safeText(r.transcript.slice(0, 300)) : null,
      hasRecording: !!r.recordingUrl && canHear,
      redFlags: canSeePhone ? r.redFlags : r.redFlags.map((f) => ({ ...f, detail: phoneSafeText(f.detail, false) })),
      escalatedAt: r.escalatedAt,
      // Новое с 17.09.2026: исход разбора и дословная фраза. Старый фронт эти
      // поля просто не читает, поэтому добавление ничего не ломает.
      outcome: r.outcome,
      outcomeLabel: r.outcomeLabel,
      quote: safeText(r.quote),
      summary: safeText(r.summary),
    })),
    total,
    page,
    pageSize,
  });
});

/** Полная расшифровка одного звонка-опроса — отдельным запросом, не в списке
 *  (список отдаёт только превью, см. выше). */
oversightRouter.get("/showing-survey-calls/:id", async (req, res) => {
  const row = await findPostShowingCallFeedRow(req.params.id);
  if (!row) return res.status(404).json({ error: "Звонок не найден" });
  const [agent, client, property] = await Promise.all([
    prisma.agent.findUnique({ where: { id: row.agentId }, select: { id: true, fullName: true } }),
    prisma.client.findUnique({ where: { id: row.clientId }, select: { id: true, fullName: true, shortId: true } }),
    row.propertyId
      ? prisma.property.findUnique({ where: { id: row.propertyId }, select: { id: true, title: true, shortId: true } })
      : null,
  ]);
  const canSeePhone = req.agent!.can("clients.viewPhone");
  const safeText = <T extends string | null>(t: T): T => (canSeePhone ? t : phoneSafeText(t, false));
  res.json({
    id: row.id,
    agent,
    client: maskClientRef(client, canSeePhone),
    property,
    calledAt: row.calledAt,
    createdAt: row.createdAt,
    transcript: safeText(row.transcript),
    // Кнопка «Прослушать» — только тем, кому звук открыт (аудит 23.09.2026, №45).
    hasRecording: !!row.recordingUrl && req.agent!.can("calls.hearRecording"),
    redFlags: canSeePhone ? row.redFlags : row.redFlags.map((f) => ({ ...f, detail: phoneSafeText(f.detail, false) })),
    escalatedAt: row.escalatedAt,
    outcome: row.outcome,
    outcomeLabel: row.outcomeLabel,
    quote: safeText(row.quote),
    summary: safeText(row.summary),
  });
});

/** Presigned-ссылка на запись звонка-опроса — тот же приём (10 минут), что у
 *  /settings/live-voice/sessions/:id/recording. */
oversightRouter.get("/showing-survey-calls/:id/recording", requirePermission("calls.hearRecording"), async (req, res) => {
  const row = await findPostShowingCallFeedRow(req.params.id);
  if (!row?.recordingUrl) return res.status(404).json({ error: "Записи нет" });
  const url = await r2PresignDownloadUrl(row.recordingUrl);
  if (!url) return res.status(502).json({ error: "R2 не настроен или не ответил" });
  res.json({ url });
});
