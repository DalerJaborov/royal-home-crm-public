/**
 * ДУБЛИ ПРИ РАЗДАЧЕ — РАЗДЕЛ L (03.09.2026, план вечерней сессии,
 * docs/audit-02-09-2026/19-plan-03-09-evening.md §L).
 *
 * Уровень 1 (уже есть, services/leads/intake.ts) — точное совпадение телефона
 * (или его последних 9 цифр) склеивает карточки ДО создания второй. Здесь —
 * следующая, слабая ступень: имя ПОХОЖЕ и номер ПОХОЖ (не совпадает), например
 * опечатка в середине номера или человек продиктовал его слитно/с ошибкой.
 * Сигнал слабее уровня 1 — по одному этому совпадению карточки НЕ сливаются
 * автоматически, а идут на подтверждение агенту, который ведёт карточку-кандидата.
 *
 * ГЛАВНОЕ ПРАВИЛО (владелец, 03.09.2026 вечером): похожая НОВАЯ заявка не
 * раздаётся другому агенту, пока агент, за которым закреплена существующая
 * карточка, не подтвердит, что это разные люди. Не ответил вовремя — заявка
 * уходит в обычную раздачу как отдельный человек (см. Settings.duplicateReviewTimeoutHours,
 * тот же принцип, что у lostReturnAcceptMinutes/returnAcceptDueAt в
 * services/leads/reassignment.ts::reassignStaleReturns).
 *
 * ПОЧЕМУ АГЕНТ, А НЕ АВТОМАТИКА, РЕШАЕТ. Слабый сигнал (имя+номер похожи, а не
 * совпадают) регулярно ошибается: тёзки с похожими номерами (соседний абонентский
 * блок) существуют. Агент, который уже разговаривал с кандидатом-карточкой,
 * реально знает, тот ли это человек — автоматика не может.
 *
 * ЭТОТ ЖЕ АГЕНТ — ЗАИНТЕРЕСОВАННАЯ СТОРОНА (владелец, важно для контроля). У
 * него есть мотив соврать в обе стороны: откреститься от своего клиента ради
 * нового отдельного лида, или наоборот присвоить чужого. Поэтому ответ
 * «да, мой» не проходит без следа — см. recordDuplicateReviewAnswer ниже,
 * который считает такие подтверждения и сигналит руководителю при аномалии.
 */
import { dushanbeDayKey } from "@royal-home/shared";
import { Prisma, type Client } from "../generated/prisma/client.js";
import { prisma } from "../db.js";
import { toSearchTokens } from "./searchTokens.js";
import { sendPushToAgent, sendPushToAgents } from "../push.js";
import { createNotification, createNotifications } from "./notifications.js";
import { mergeClients } from "./clientMerge.js";
import { logTimeline } from "./timeline.js";
import { isWithinWorkingHours } from "./workingHours.js";
import { dushanbeDateTimeString } from "./dushanbeTime.js";
import { duplicateReviewDueFrom, leadHoursFromSettings } from "./workingDue.js";
import { openMsBetween } from "../services/leads/shared.js";

/** Последние N цифр номера — слабее уровня 1 (там 9): специально мягче, чтобы
 *  ловить опечатку/пропуск в начале номера, а не только полное совпадение. */
const NEAR_PHONE_TAIL_LEN = 7;
/** Кандидатов по номеру в норме 0-1, больше — уже подозрительно частый номер
 *  (общий рабочий телефон офиса и т.п.) — предел на всякий случай. */
const NEAR_PHONE_CANDIDATE_LIMIT = 8;
/** Слова короче этого — предлоги, инициалы, «ака»/«апа» — не считаются
 *  подтверждением совпадения имени сами по себе. */
const MIN_NAME_TOKEN_LEN = 3;

export const DUPLICATE_REVIEW_MATCHED_BY_NAME_PHONE = "NAME_AND_PHONE_TAIL" as const;

function normalizedDigits(phone: string): string {
  return (phone ?? "").replace(/\D/g, "");
}

function nearTail(phone: string): string {
  return normalizedDigits(phone).slice(-NEAR_PHONE_TAIL_LEN);
}

/** Есть ли хотя бы одно общее «настоящее» слово (не предлог/инициал) между
 *  двумя ФИО. Тот же принцип, что фильтрует общий поиск (searchTokens.ts), но
 *  здесь сравниваются между собой ДВЕ строки, а не запрос и поле. */
export function namesShareToken(a: string, b: string): boolean {
  const tokensA = new Set(toSearchTokens(a).filter((t) => t.length >= MIN_NAME_TOKEN_LEN).map((t) => t.toLowerCase()));
  if (tokensA.size === 0) return false;
  return toSearchTokens(b).some((t) => t.length >= MIN_NAME_TOKEN_LEN && tokensA.has(t.toLowerCase()));
}

export interface DuplicateReviewCandidate {
  id: string;
  shortId: number;
  fullName: string;
  assignedAgentId: string | null;
}

/**
 * Кандидат-дубликат для ОДНОЙ новой карточки (интейк, services/leads/intake.ts).
 * Точечный SQL-запрос (не выгрузка всей базы) — вызывается на каждый новый лид,
 * должен быть дешёвым: сначала узкий фильтр по цифрам номера (индекса на выражение
 * нет, но кандидатов на совпадение хвоста всегда единицы), имя проверяется в памяти.
 */
export async function findFuzzyDuplicateCandidate(
  fullName: string,
  phone: string,
  excludeClientId?: string
): Promise<DuplicateReviewCandidate | null> {
  const tail = nearTail(phone);
  if (tail.length < NEAR_PHONE_TAIL_LEN) return null;

  // Prisma.raw для длины хвоста — своя константа, не пользовательский ввод; тот же
  // приём, что в lib/fuzzySearch.ts (SET LOCAL pg_trgm...threshold): передать число
  // параметром-биндом заставляет Postgres видеть bigint там, где right() ждёт
  // integer, и падать с "function right(text, bigint) does not exist".
  const tailLen = Prisma.raw(String(NEAR_PHONE_TAIL_LEN));
  const rows = await prisma.$queryRaw<
    Array<{ id: string; shortId: number; fullName: string; assignedAgentId: string | null }>
  >(Prisma.sql`
    SELECT "id", "shortId", "fullName", "assignedAgentId"
    FROM "Client"
    WHERE "deletedAt" IS NULL
      AND "kind" != 'OTHER'
      AND right(regexp_replace("phone", '[^0-9]', '', 'g'), ${tailLen}) = ${tail}
      ${excludeClientId ? Prisma.sql`AND "id" != ${excludeClientId}` : Prisma.empty}
    ORDER BY "createdAt" ASC
    LIMIT ${NEAR_PHONE_CANDIDATE_LIMIT}
  `);

  return rows.find((r) => namesShareToken(fullName, r.fullName)) ?? null;
}

/** Та же пара сигналов (имя+хвост номера), но по уже загруженному списку клиентов —
 *  используется GET /clients/duplicates (routes/clients/duplicates.ts) и ночным
 *  сканом (см. runDuplicateFuzzyScanTick ниже), чтобы не гонять второй запрос к базе
 *  поверх уже выкачанного списка (тот же список, что и для проверки телефона/Telegram). */
export function findFuzzyDuplicatePairs<T extends { id: string; fullName: string; phone: string }>(
  clients: T[]
): Array<[T, T]> {
  const byTail = new Map<string, T[]>();
  for (const c of clients) {
    const tail = nearTail(c.phone);
    if (tail.length < NEAR_PHONE_TAIL_LEN) continue;
    byTail.set(tail, [...(byTail.get(tail) ?? []), c]);
  }
  const pairs: Array<[T, T]> = [];
  for (const group of byTail.values()) {
    if (group.length < 2) continue;
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        // Полное совпадение номера — не эта ступень, о нём уже сообщает группа
        // "identity" рядом (GET /duplicates); здесь только БЛИЗКИЙ, не идентичный.
        if (normalizedDigits(group[i].phone).slice(-9) === normalizedDigits(group[j].phone).slice(-9)) continue;
        if (namesShareToken(group[i].fullName, group[j].fullName)) pairs.push([group[i], group[j]]);
      }
    }
  }
  return pairs;
}

const DUPLICATE_REVIEW_ASK_NOTE = (candidateName: string, candidatePhone: string) =>
  `Похожая новая заявка (имя и близкий номер похожи на эту карточку): «${candidateName}», ${candidatePhone}. ` +
  `Раздача придержана — подтвердите на карточке, ваш ли это клиент.`;
export const DUPLICATE_REVIEW_CONFIRM_NOTE_PREFIX = "Проверка дубля: подтверждено — карточка объединена";
export const DUPLICATE_REVIEW_DENY_NOTE = "Проверка дубля: агент подтвердил — это разные люди, заявка ушла в обычную раздачу";
export const DUPLICATE_REVIEW_EXPIRED_NOTE_PREFIX = "Проверка дубля просрочена";

/**
 * Придерживает раздачу НОВОЙ карточки (передаётся созданной, но ещё без агента) и
 * спрашивает агента, ведущего карточку-кандидата. true — раздача придержана,
 * вызывающая сторона (createNewChannelLead) не должна назначать агента сейчас.
 * false — спросить некого (у кандидата тоже нет агента) или таймаут выключен
 * (timeoutHours <= 0, аварийный рубильник) — вызывающая сторона продолжает как обычно.
 */
export async function openDuplicateReview(
  newClient: Pick<Client, "id" | "fullName" | "phone">,
  candidate: DuplicateReviewCandidate,
  timeoutHours: number
): Promise<boolean> {
  if (!candidate.assignedAgentId || timeoutHours <= 0) return false;
  const now = new Date();
  // Срок — в рабочих часах (решение владельца 02.10.2026, B4): заявка на проверке
  // с 17:00 не истекает ночью в 23:00, у агента остаются его часы утром.
  const dueAt = await duplicateReviewDueFrom(now, timeoutHours);

  await prisma.$transaction(async (tx) => {
    await tx.client.update({
      where: { id: newClient.id },
      data: {
        duplicateReviewOfClientId: candidate.id,
        duplicateReviewAskedAgentId: candidate.assignedAgentId,
        duplicateReviewAskedAt: now,
        duplicateReviewDueAt: dueAt,
        duplicateReviewMatchedBy: DUPLICATE_REVIEW_MATCHED_BY_NAME_PHONE,
      },
    });
    // Вопрос задаёт система, не агент (П-10, 17.09.2026) — он ещё не ответил.
    await logTimeline({
      clientId: candidate.id,
      actor: { kind: "system", source: "duplicate-review-ask", subjectAgentId: candidate.assignedAgentId },
      type: "SYSTEM",
      notes: DUPLICATE_REVIEW_ASK_NOTE(newClient.fullName, newClient.phone),
      tx,
    });
  });

  await createNotifications([candidate.assignedAgentId], {
    kind: "oversight",
    title: "🔁 Это ваш клиент?",
    body: `Похожая новая заявка: ${newClient.fullName} — подтвердите на карточке №${candidate.shortId}`,
    url: `/clients/${candidate.shortId}`,
    tag: `duplicate-review-ask-${newClient.id}`,
  });
  sendPushToAgent(candidate.assignedAgentId, {
    title: "🔁 Это ваш клиент?",
    body: `Похожая новая заявка: ${newClient.fullName} — не раздаём другому, пока вы не ответите`,
    url: `/clients/${candidate.shortId}`,
    tag: `duplicate-review-ask-${newClient.id}`,
  }).catch((err) => console.error("[push] запрос подтверждения дубля:", err));

  return true;
}

/**
 * Считает недавние подтверждения «да, мой» этого агента и сигналит руководителю,
 * если их подозрительно много (Settings.duplicateClaimAnomalyThreshold, за 30 дней).
 * НЕ обвинение — только повод посмотреть глазами, тот же принцип, что у остальных
 * алармов «Контроля руководителя» (см. lib/buyerNoCallAlarm.ts).
 */
export async function checkDuplicateClaimAnomaly(askedAgentId: string, now: Date = new Date()): Promise<void> {
  const settings = await prisma.settings.findUnique({ where: { id: "singleton" } });
  const threshold = settings?.duplicateClaimAnomalyThreshold ?? 3;
  if (threshold <= 0) return;

  const cutoff = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const count = await prisma.interaction.count({
    where: {
      agentId: askedAgentId,
      type: "SYSTEM",
      notes: { startsWith: DUPLICATE_REVIEW_CONFIRM_NOTE_PREFIX },
      createdAt: { gte: cutoff },
    },
  });
  if (count < threshold) return;

  // Директора не будим ночью — решение владельца 03.09.2026 «3б», тот же приём,
  // что у buyerNoCallAlarm.ts. Счётчик выше не пишется отдельно (это чтение
  // Interaction, не запись) — на следующее подтверждение того же агента (днём
  // или ночью) проверка повторится и досчитает сама, из дедупа по tag не выпадет.
  if (!(await isWithinWorkingHours(now))) return;

  const directorIds = (
    await prisma.agent.findMany({ where: { role: { in: ["DIRECTOR", "ADMIN", "HEAD_OF_SALES"] }, isActive: true }, select: { id: true } })
  ).map((d) => d.id);
  if (directorIds.length === 0) return;

  const agent = await prisma.agent.findUnique({ where: { id: askedAgentId }, select: { fullName: true } });
  // Дедуп по месяцу — не долбить одним и тем же сигналом на каждое новое подтверждение
  // сверх порога, только один раз обновлять счётчик (createNotifications схлопывает по tag).
  // Месяц — по Душанбе, не по UTC (Ф12, 02.10.2026).
  const monthTag = `alarm-duplicate-claim-${askedAgentId}-${dushanbeDayKey(now).slice(0, 7)}`;
  const payload = {
    kind: "oversight" as const,
    title: `🔁 Частые «это мой клиент»: ${agent?.fullName ?? "агент"}`,
    body: `${count} подтверждений «это мой клиент» за 30 дней (на ${dushanbeDateTimeString(now)}) при пороге ${threshold} — стоит присмотреться (не доказательство обмана)`,
    url: `/team`,
    tag: monthTag,
  };
  try {
    await createNotifications(directorIds, payload);
    void sendPushToAgents(directorIds, payload).catch((err) => console.error("[alarm] duplicate-claim push:", err));
  } catch (err) {
    console.error("[alarm] duplicate-claim notification:", err);
  }
}

/**
 * Резолвит открытую проверку: либо сливает карточки (подтверждено), либо снимает
 * придержку и передаёт вызывающей стороне, что раздачу пора продолжить как обычно
 * (releaseForAssignment вызывает вызывающая сторона — см. routes/clients/duplicateReviews.ts
 * и sweepExpiredDuplicateReviews ниже, оба реально назначают агента через
 * services/leads/intake.ts::assignHeldLead, которую нельзя импортировать отсюда без цикла).
 */
export async function denyDuplicateReview(pendingClientId: string, actorAgentId: string): Promise<void> {
  const client = await prisma.client.findUnique({ where: { id: pendingClientId } });
  if (!client?.duplicateReviewOfClientId) return;
  await prisma.$transaction(async (tx) => {
    await tx.client.update({
      where: { id: pendingClientId },
      data: {
        duplicateReviewOfClientId: null,
        duplicateReviewAskedAgentId: null,
        duplicateReviewAskedAt: null,
        duplicateReviewDueAt: null,
        duplicateReviewMatchedBy: null,
      },
    });
    // actorAgentId — реальный человек, подтвердивший «это разные люди» (kind agent).
    await logTimeline({
      clientId: client.duplicateReviewOfClientId!,
      actor: { kind: "agent", agentId: actorAgentId },
      type: "SYSTEM",
      notes: DUPLICATE_REVIEW_DENY_NOTE,
      tx,
    });
  });
}

export async function confirmDuplicateReview(pendingClientId: string, actorAgentId: string): Promise<Client | null> {
  const client = await prisma.client.findUnique({ where: { id: pendingClientId } });
  if (!client?.duplicateReviewOfClientId) return null;
  const primaryId = client.duplicateReviewOfClientId;
  const merged = await mergeClients(
    primaryId,
    pendingClientId,
    actorAgentId,
    `${DUPLICATE_REVIEW_CONFIRM_NOTE_PREFIX} («${client.fullName}», ${client.phone})`
  );
  void checkDuplicateClaimAnomaly(actorAgentId).catch((err) =>
    console.error("[duplicateReview] проверка аномалии подтверждений:", err)
  );
  return merged;
}

/** Тот же потолок полного скана, что у GET /clients/duplicates (routes/clients/duplicates.ts) —
 *  намеренно то же число: обе проверки читают всю живую базу целиком. */
const DUPLICATE_FUZZY_SCAN_LIMIT = 20_000;

/**
 * РАЗДЕЛ L, УРОВЕНЬ 4 (03.09.2026, план вечерней сессии §L) — ежедневный крон-тик:
 * та же проверка «похожее имя + похожий номер», что видит GET /duplicates
 * (reason:"nameAndPhone"), но ПРОАКТИВНО толкает руководителю, а не ждёт, пока
 * кто-то откроет раздел сам. Дедуп — tag на КОНКРЕТНУЮ пару id (отсортированную,
 * чтобы порядок не плодил два тега на одну пару): найдена та же пара второй день
 * подряд — не новое уведомление, а вырос счётчик в уже существующем (upsertByTag,
 * см. lib/notifications.ts), то есть само накопление уже сигнализирует «висит давно».
 */
export async function runDuplicateFuzzyScanTick(now: Date = new Date()): Promise<{ found: number }> {
  // Директора не будим ночью — решение владельца 03.09.2026 «3б». Пары дублей
  // никуда не деваются (это чтение всей базы, не запись) — следующий дневной
  // тик найдёт те же пары и досчитает через тот же tag (upsertByTag, count++).
  if (!(await isWithinWorkingHours(now))) return { found: 0 };

  const scanWhere = { kind: { not: "OTHER" as const }, deletedAt: null };
  const candidateCount = await prisma.client.count({ where: scanWhere });
  // Тот же отказ, что у GET /duplicates при переполнении — не тихо пропускаем.
  if (candidateCount > DUPLICATE_FUZZY_SCAN_LIMIT) return { found: 0 };

  const clients = await prisma.client.findMany({
    where: scanWhere,
    select: { id: true, shortId: true, fullName: true, phone: true },
  });
  const pairs = findFuzzyDuplicatePairs(clients);
  if (pairs.length === 0) return { found: 0 };

  const directorIds = (
    await prisma.agent.findMany({ where: { role: { in: ["DIRECTOR", "ADMIN", "HEAD_OF_SALES"] }, isActive: true }, select: { id: true } })
  ).map((d) => d.id);
  if (directorIds.length === 0) return { found: 0 };

  for (const [a, b] of pairs) {
    const tag = `alarm-duplicate-fuzzy-${[a.id, b.id].sort().join("-")}`;
    const payload = {
      kind: "oversight" as const,
      title: "🔎 Похожие карточки — проверьте",
      body: `Найдено ${dushanbeDateTimeString(now)}: «${a.fullName}» и «${b.fullName}» — похожее имя и похожий (не идентичный) номер. Клиенты → Дубликаты`,
      url: "/clients",
      tag,
    };
    try {
      await createNotifications(directorIds, payload);
      void sendPushToAgents(directorIds, payload).catch((err) => console.error("[alarm] duplicate-fuzzy push:", err));
    } catch (err) {
      console.error("[alarm] duplicate-fuzzy notification:", err);
    }
  }
  return { found: pairs.length };
}

/**
 * ПРЕДУПРЕЖДЕНИЕ ЗА 25% ДО ИСТЕЧЕНИЯ (аудит владения 11.09.2026, дыра №5,
 * `docs/ownership-audit-11-09.md`). Спрошенный агент узнавал, что придержка
 * снята, только постфактум — тем же приёмом, что и у `reactivationOffers`/
 * `reassignStaleReturns`: один пуш на клиента, дедуп по tag.
 */
export async function remindDuplicateReviewsNearingExpiry(now: Date = new Date()): Promise<{ reminded: number }> {
  const settings = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { duplicateReviewTimeoutHours: true },
  });
  const ttlMs = Math.max(1, settings?.duplicateReviewTimeoutHours ?? 6) * 3_600_000;

  const nearing = await prisma.client.findMany({
    where: { duplicateReviewDueAt: { gt: now }, duplicateReviewAskedAt: { not: null }, deletedAt: null },
    select: { id: true, shortId: true, fullName: true, duplicateReviewAskedAgentId: true, duplicateReviewAskedAt: true, duplicateReviewDueAt: true },
    take: 200,
  });

  // Осталось — в рабочих минутах, как и сам срок (решение владельца 02.10.2026, B4).
  const hours = await leadHoursFromSettings();
  let reminded = 0;
  for (const c of nearing) {
    if (!c.duplicateReviewAskedAgentId || !c.duplicateReviewAskedAt || !c.duplicateReviewDueAt) continue;
    const leftMs = openMsBetween(now, c.duplicateReviewDueAt, hours);
    if (leftMs / ttlMs > 0.25) continue; // ещё рано
    const tag = `duplicate-review-warning-${c.id}`;
    const already = await prisma.notification.findFirst({
      where: { agentId: c.duplicateReviewAskedAgentId, tag },
      select: { id: true },
    });
    if (already) continue;
    const minutesLeft = Math.max(1, Math.round(leftMs / 60_000));
    const payload = {
      title: "⏳ Проверка дубля ждёт ответа",
      body: `${c.fullName} — через ~${minutesLeft} мин заявка уйдёт в обычную раздачу, если не ответите «это ваш клиент?»`,
      url: `/clients/${c.shortId}`,
      tag,
      kind: "task" as const,
    };
    await createNotification({ agentId: c.duplicateReviewAskedAgentId, ...payload });
    void sendPushToAgent(c.duplicateReviewAskedAgentId, payload).catch((err) =>
      console.error("[push] предупреждение о проверке дубля:", err)
    );
    reminded++;
  }
  return { reminded };
}

/**
 * Крон-тик: просроченные проверки уходят в обычную раздачу как отдельный человек.
 * `finishHeldLead` — services/leads/intake.ts::assignHeldLead, передаётся аргументом,
 * чтобы избежать цикла импортов (intake.ts уже импортирует этот модуль для openDuplicateReview).
 */
export async function sweepExpiredDuplicateReviews(
  now: Date,
  finishHeldLead: (clientId: string) => Promise<void>
): Promise<{ expired: number }> {
  const due = await prisma.client.findMany({
    where: { duplicateReviewDueAt: { lte: now }, deletedAt: null },
    select: { id: true, duplicateReviewOfClientId: true },
    take: 100,
  });
  if (due.length === 0) return { expired: 0 };

  let expired = 0;
  for (const row of due) {
    if (!row.duplicateReviewOfClientId) continue;
    // Кандидат мог смениться агентом (или уйти в Корзину) за время ожидания —
    // Interaction.agentId обязателен в схеме, писать не в кого — тогда просто
    // снимаем придержку без записи в чужую хронологию.
    const candidate = await prisma.client.findFirst({
      where: { id: row.duplicateReviewOfClientId, deletedAt: null },
      select: { assignedAgentId: true },
    });
    const clearData = {
      duplicateReviewOfClientId: null,
      duplicateReviewAskedAgentId: null,
      duplicateReviewAskedAt: null,
      duplicateReviewDueAt: null,
      duplicateReviewMatchedBy: null,
    };
    if (candidate?.assignedAgentId) {
      await prisma.$transaction(async (tx) => {
        await tx.client.update({ where: { id: row.id }, data: clearData });
        // Крон-таймаут подписывается SYSTEM, не агентом, которого обвиняет
        // «не ответил вовремя» (П-10, 17.09.2026).
        await logTimeline({
          clientId: row.duplicateReviewOfClientId!,
          actor: { kind: "system", source: "duplicate-review-expired", subjectAgentId: candidate.assignedAgentId },
          type: "SYSTEM",
          notes: `${DUPLICATE_REVIEW_EXPIRED_NOTE_PREFIX} — агент не ответил вовремя, заявка ушла в обычную раздачу как отдельный человек`,
          tx,
        });
      });
    } else {
      await prisma.client.update({ where: { id: row.id }, data: clearData });
    }
    await finishHeldLead(row.id);
    expired++;
  }
  return { expired };
}
