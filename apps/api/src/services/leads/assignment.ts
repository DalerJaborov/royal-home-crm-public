import { prisma, type TxClient } from "../../db.js";
import { sendPushToAgents } from "../../push.js";
import { sendLeadPush } from "../../lib/pushLeadActions.js";
import { findAgentsWithPermission } from "../../lib/recipients.js";
import { loadEventPoints, recordScoreEvent, type ScoreEventKind } from "../../lib/scoreJournal.js";
import { findMatchingPropertiesForClient } from "../../routes/matching.js";
import { findAgentByInstagramPost } from "../../lib/instagramPostLead.js";
import { changeClientAgent } from "../../lib/changeClientAgent.js";
import { logTimeline } from "../../lib/timeline.js";
import { notifyFeedOnly } from "../../lib/notifications.js";
import { orderByKpiQueue, pickAgentForLead } from "./selection.js";

/** Почему лид достался агенту. Пишется в Client.assignReason. */
export type { LeadAssignReason, LeadAssignContext, LeadAssignment } from "./assignmentTypes.js";
import type { LeadAssignContext, LeadAssignment } from "./assignmentTypes.js";
import { SALES_AGENT_ROLES } from "@royal-home/shared";

/** Статус агента-хозяина объекта на момент раздачи лида по этому объекту. */
interface OwnerAgentStatus {
  fullName: string;
  frozenAt: Date | null;
  leadsPausedUntil: Date | null;
}

/**
 * Кто из перечисленных агентов-хозяев объектов вправе получить лид по СВОЕМУ
 * объекту прямо сейчас — НЕ то же самое, что общая очередь (acceptingLeadsWhere).
 *
 * Уволенного/деактивированного агента правило не касается вовсе: работать он
 * больше не может, лид уходит обычной очередью. А вот заморозку и паузу оно
 * ПЕРЕЖИВАЕТ (решение владельца 11.09.2026, Пачка 1 п.3: «если заморожен или на
 * паузе — всё равно ему, с пушем руководителю»; «отпуск не отменяет владение»).
 * Поэтому здесь, в отличие от acceptingLeadsWhere, нет ни frozenAt, ни
 * leadsPausedUntil — их читает вызывающий код, чтобы решить, слать ли пуш.
 */
async function ownPropertyAgentStatuses(agentIds: string[], exclude: string[]): Promise<Map<string, OwnerAgentStatus>> {
  if (agentIds.length === 0) return new Map();
  const agents = await prisma.agent.findMany({
    where: {
      role: { in: [...SALES_AGENT_ROLES] }, // владелец объекта — агент или руководитель продаж
      isActive: true,
      id: { in: agentIds, ...(exclude.length ? { notIn: exclude } : {}) },
    },
    select: { id: true, fullName: true, frozenAt: true, leadsPausedUntil: true },
  });
  return new Map(agents.map((a) => [a.id, { fullName: a.fullName, frozenAt: a.frozenAt, leadsPausedUntil: a.leadsPausedUntil }]));
}

/**
 * Пуш руководителю: лид по объекту достался агенту, который прямо сейчас не
 * может сразу ответить (заморожен или на паузе «не принимаю лиды») — решение
 * владельца 11.09.2026: владение объектом сильнее паузы, но руководитель
 * должен знать, что клиент ждёт именно этого человека, а не подхвачен кем-то
 * другим. Fire-and-forget, как и остальные пуши в этом файле: причина
 * назначения важнее уведомления о ней.
 */
function notifyOwnerUnavailable(agentName: string, status: OwnerAgentStatus): void {
  const reason = status.frozenAt ? "заморожен" : "на паузе («не принимаю лиды»)";
  findAgentsWithPermission("clients.assign")
    .then((supervisors) =>
      sendPushToAgents(supervisors, {
        title: "⏸️ Лид по объекту — хозяин недоступен",
        body: `${agentName} ${reason}, но лид всё равно закреплён за ним по своему объекту`,
        url: "/team",
        tag: `own-property-unavailable-${agentName}-${Date.now()}`,
      })
    )
    .catch((err) => console.error("[push] лид хозяину объекта на паузе/заморозке:", err));
}

/**
 * ХОЗЯИН ОБЪЕКТА, КОТОРЫЙ ВПРАВЕ ПОЛУЧИТЬ ЛИД (10.10.2026, аудит
 * docs/audit-bots-2026-10-10-object-routing.md, P0-6).
 *
 * Ступени те же, что у propertyOwnerAgentId (принял → ведёт → завёл), но ступень,
 * на которой стоит уволенный или не агент (директор завёл карточку, интейкер
 * отключён), не обрывает правило, а уступает следующей. Раньше такой лид молча
 * уходил в общую очередь: ни следующего поля, ни сигнала руководителю.
 *
 * Исключённый агент (`exclude` — отказался от лида и т.п.) ступень НЕ уступает:
 * как и раньше, правило «свой объект» для него просто не срабатывает.
 *
 * Не нашлось никого — руководителю в ленту «лид по объекту без хозяина» (без звонка
 * телефона: владелец 20.09.2026 — эскалации только в колокольчик), одна строка на
 * объект: повтор обновляет её (tag), а не множит.
 */
async function eligibleOwner(
  property: { id: string; shortId: number; intakeAgentId: string | null; assignedAgentId: string | null; createdById: string | null },
  exclude: string[]
): Promise<{ agentId: string; status: OwnerAgentStatus } | null> {
  const chain = [...new Set([property.intakeAgentId, property.assignedAgentId, property.createdById].filter((id): id is string => !!id))];
  if (chain.length === 0) return null;
  const statuses = await ownPropertyAgentStatuses(chain, []);
  for (const id of chain) {
    const status = statuses.get(id);
    if (!status) continue;
    if (exclude.includes(id)) return null;
    return { agentId: id, status };
  }
  notifyNoEligibleOwner(property);
  return null;
}

function notifyNoEligibleOwner(property: { id: string; shortId: number }): void {
  findAgentsWithPermission("clients.assign")
    .then((supervisors) =>
      notifyFeedOnly(supervisors, {
        kind: "lead",
        title: "⚠️ Лид по объекту без хозяина",
        body: `Клиент пришёл по объекту №${property.shortId}, но агента у объекта нет (отключён или не агент) — лид ушёл в общую очередь. Передайте объект действующему агенту.`,
        url: `/properties/${property.shortId}`,
        tag: `own-property-no-owner-${property.id}`,
      })
    )
    .catch((err) => console.error("[leads] сигнал «лид по объекту без хозяина» не отправлен:", err));
}

/**
 * Лимита для лида по СВОЕМУ объекту больше нет вообще (решение владельца
 * 11.09.2026, Пачка 1 п.1: «клиент, интересующийся конкретным объектом,
 * безоговорочно уходит агенту этого объекта» — без оговорок значит и без
 * потолка портфеля).
 *
 * Раньше здесь была надбавка `ownPropertyLeadCap` поверх `leadActiveLimit`
 * (решение владельца 13.08.2026, потолок activeLimit+1 = 7 при стандартных 6).
 * Общий лимит по-прежнему действует на ОБЫЧНЫЕ лиды (см. OCCUPIES_SLOT_WHERE и
 * pickAgentForLead в ./selection.ts) — но лида по своему объекту он больше не
 * касается ни в каком виде. `Settings.ownPropertyOverLimitEnabled` и
 * `ownPropertyLeadCap` остаются в схеме и в Zod-валидации настроек ради
 * обратной совместимости (без миграции, которой не просили) — РАЗДАЧА их не
 * читает. Уточнение 28.09.2026: ownPropertyOverLimitEnabled по-прежнему читает
 * ПРИЁМ лида (lib/leadAccept.ts) — вместе с ownPropertyReleaseEnabled он
 * решает, предлагать ли агенту освободить место; экран «Лиды» показывает итог
 * обоих полей одним тумблером. ownPropertyLeadCap не читает никто.
 */

/**
 * КОМУ достаётся лид — с причиной.
 *
 * Надстройка над pickAgentForLead, а не замена: пять существующих точек вызова
 * и их тесты остаются нетронутыми, а очередь по KPI по-прежнему решает всё, где
 * не сработало правило «свой объект».
 *
 * Правило (решение владельца 11.08.2026): агент, который сам съездил к
 * собственнику, отснял фото и видео и завёл объект, получает клиента по ЭТОМУ
 * объекту вне очереди. Он зарабатывает на таком лиде обе половины комиссии —
 * 0.5% интейка и 0.5% за продажу, — и это единственная причина правила: агенту
 * должно быть выгодно приносить объекты.
 *
 * Два шага, в порядке убывания уверенности:
 *
 *  1. БОТ УЖЕ ПОКАЗАЛ КЛИЕНТУ ЭТОТ ОБЪЕКТ — безусловно, без всякого порога.
 *     Клиент смотрит именно эту квартиру; отдать его другому агенту значит
 *     выбросить начатый разговор. Долг по обязательным итогам здесь НЕ
 *     блокирует: правило владельца жёсткое.
 *  2. ЗАПРОС СОВПАЛ С ОБЪЕКТОМ выше порога из Настроек. Спорят несколько
 *     хозяев — выигрывает больший балл, при равенстве обычная очередь по KPI.
 *
 * Всё остальное — pickAgentForLead, как раньше.
 */
export async function assignAgentForLead(
  ctx: LeadAssignContext,
  excludeAgentIds?: string | string[]
): Promise<LeadAssignment> {
  const exclude = excludeAgentIds ? (Array.isArray(excludeAgentIds) ? excludeAgentIds : [excludeAgentIds]) : [];
  const settings = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: {
      ownPropertyPriorityEnabled: true,
      ownPropertyMatchThreshold: true,
      ownPropertyShownExceptionEnabled: true,
      ownPropertyShownWindowDays: true,
      leadDistributionStrategy: true,
    },
  });

  // "manual" — руководитель назначает сам, и обходить это правилом нельзя:
  // владелец выключил автораспределение целиком, а не «кроме своих объектов».
  if (settings?.leadDistributionStrategy === "manual") {
    return { agentId: null, reason: "queue" };
  }

  const explicit = await pickByExplicitProperty(ctx, exclude);
  if (explicit) return explicit;

  const byPost = await pickByInstagramPost(ctx, exclude);
  if (byPost) return byPost;

  const shown = await pickByShownProperty(ctx, exclude, settings);
  if (shown) return shown;

  const matched = await pickByPropertyMatch(ctx, exclude, settings);
  if (matched) return matched;

  return { agentId: await pickAgentForLead(exclude, ctx.kind ?? "BUYER"), reason: "queue" };
}

type OwnPropertySettings = {
  ownPropertyPriorityEnabled: boolean;
  ownPropertyMatchThreshold: number;
  ownPropertyShownExceptionEnabled: boolean;
  ownPropertyShownWindowDays: number;
} | null;

/**
 * Шаг −1: объект назван явно, до входа сюда (Пачка 1 п.5) — ссылка с сайта
 * (`pageUrl`) или объект, распознанный в расшифровке звонка. Выше и поста
 * Instagram, и показа боту: там объект узнаём по следу переписки, здесь он уже
 * найден вызывающим кодом.
 */
async function pickByExplicitProperty(ctx: LeadAssignContext, exclude: string[]): Promise<LeadAssignment | null> {
  if (!ctx.propertyId) return null;
  const property = await prisma.property.findUnique({
    where: { id: ctx.propertyId },
    select: { id: true, deletedAt: true, status: true, shortId: true, intakeAgentId: true, assignedAgentId: true, createdById: true },
  });
  if (!property || property.deletedAt) return null;
  /**
   * П-13 (18.09.2026, `docs/audit/recon-17-09/07-routing-code.md` §E находка #1):
   * раньше здесь проверялся только `deletedAt`, а `pickByInstagramPost` рядом
   * (см. ниже) уже фильтровал `status`. Один и тот же смысл — «объект назван
   * явно» — двумя разными правилами в зависимости от канала. Без этой проверки
   * лид по давно проданному/снятому объекту всё равно безусловно уходил
   * бывшему хозяину.
   */
  if (property.status !== "AVAILABLE" && property.status !== "RESERVED") return null;
  const owner = await eligibleOwner(property, exclude);
  if (!owner) return null;
  const { agentId: ownerId, status } = owner;
  if (status.frozenAt || (status.leadsPausedUntil && status.leadsPausedUntil > new Date())) {
    notifyOwnerUnavailable(status.fullName, status);
  }

  return {
    agentId: ownerId,
    reason: "own_property_explicit",
    propertyId: ctx.propertyId,
    propertyShortId: property.shortId,
  };
}

/**
 * Шаг 0: клиент прислал ссылку на пост объекта — лид агенту этого объекта.
 *
 * Выше правила «свой объект»: то догадка по описанию, а это прямое указание
 * человека. Доступность агента проверяется тем же способом, что и у остальных
 * шагов «свой объект»: уволенного/деактивированного правило не касается вовсе, а
 * заморозку и паузу переживает (см. ownPropertyAgentStatuses).
 */
async function pickByInstagramPost(ctx: LeadAssignContext, exclude: string[]): Promise<LeadAssignment | null> {
  if (!ctx.inquiryText?.trim()) return null;
  const match = await findAgentByInstagramPost(ctx.inquiryText);
  if (!match) return null;

  const statuses = await ownPropertyAgentStatuses([match.agentId], exclude);
  const status = statuses.get(match.agentId);
  if (!status) return null;
  if (status.frozenAt || (status.leadsPausedUntil && status.leadsPausedUntil > new Date())) {
    notifyOwnerUnavailable(status.fullName, status);
  }

  return {
    agentId: match.agentId,
    reason: "instagram_post_link",
    propertyId: match.propertyId,
    propertyShortId: match.propertyShortId,
  };
}

/** Шаг 1: бот уже показывал этому человеку объект — лид хозяину объекта. */
async function pickByShownProperty(
  ctx: LeadAssignContext,
  exclude: string[],
  settings: OwnPropertySettings
): Promise<LeadAssignment | null> {
  if (!(settings?.ownPropertyShownExceptionEnabled ?? true)) return null;
  if (ctx.endpointScopeId === null) return null;
  const hasKey = ctx.clientId || (ctx.channel && ctx.recipientId);
  if (!hasKey) return null;

  const windowDays = settings?.ownPropertyShownWindowDays ?? 30;
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);

  const exposures = await prisma.propertyExposure.findMany({
    where: {
      sentAt: { gte: since },
      ...(ctx.endpointScopeId ? { endpointScopeId: ctx.endpointScopeId } : {}),
      // Клиент И переписка: показы этой переписки могли остаться непривязанными
      // (карточка появилась позже), а к карточке могли прийти показы из другого
      // канала. Нужны оба следа.
      OR: [
        ...(ctx.clientId ? [{ clientId: ctx.clientId }] : []),
        ...(ctx.channel && ctx.recipientId ? [{ channel: ctx.channel, recipientId: ctx.recipientId }] : []),
      ],
      // Хозяин хоть в каком-то из трёх полей (propertyOwnerAgentId, 11.09.2026) —
      // раньше требовался именно intakeAgentId, и показ объекта без интейкера
      // никому лида не приносил.
      property: {
        is: {
          deletedAt: null,
          // Проданный или снятый объект — не повод отдать клиента бывшему агенту
          // (ревизия 02.10.2026): явный шаг и шаг поста статус уже проверяли (П-13).
          status: { in: ["AVAILABLE", "RESERVED"] },
          OR: [{ intakeAgentId: { not: null } }, { assignedAgentId: { not: null } }, { createdById: { not: null } }],
        },
      },
    },
    select: {
      shortId: true,
      propertyId: true,
      kind: true,
      property: { select: { intakeAgentId: true, assignedAgentId: true, createdById: true } },
    },
    // Самый свежий показ первым: если клиенту показывали три квартиры, речь
    // почти наверняка о последней.
    orderBy: { sentAt: "desc" },
    take: 20,
  });
  if (exposures.length === 0) return null;
  /**
   * ТО, ЧТО КЛИЕНТ ПРИСЛАЛ САМ, — ВПЕРЕДИ ПОКАЗАННОГО БОТОМ (02.10.2026, Dan:
   * «любой пересланный пост… своему агенту идти»). Клиент переслал наш пост про
   * объект Умеда, бот в ответ предложил два похожих — и лид уходил агенту
   * последнего ПОКАЗАННОГО, хотя человек пришёл ровно за присланным. Внутри
   * каждой группы порядок прежний — свежий первым (sort устойчив).
   */
  exposures.sort((a, b) => Number(b.kind === "CLIENT_SHARED") - Number(a.kind === "CLIENT_SHARED"));

  // Хозяин — по ступеням eligibleOwner (P0-6, 10.10.2026): уволенный интейкер уступает
  // ведущему агенту, а не обрывает правило молча. Один объект проверяется один раз.
  const seen = new Set<string>();
  for (const exposure of exposures) {
    if (!exposure.property || !exposure.propertyId || seen.has(exposure.propertyId)) continue;
    seen.add(exposure.propertyId);
    const owner = await eligibleOwner({ id: exposure.propertyId, shortId: exposure.shortId, ...exposure.property }, exclude);
    if (!owner) continue;
    const { agentId: ownerId, status } = owner;
    if (status.frozenAt || (status.leadsPausedUntil && status.leadsPausedUntil > new Date())) {
      notifyOwnerUnavailable(status.fullName, status);
    }
    return {
      agentId: ownerId,
      reason: "own_property_shown",
      propertyId: exposure.propertyId ?? undefined,
      propertyShortId: exposure.shortId,
    };
  }
  return null;
}

/** Шаг 2: запрос клиента совпал с объектом агента не ниже порога из Настроек. */
async function pickByPropertyMatch(
  ctx: LeadAssignContext,
  exclude: string[],
  settings: OwnPropertySettings
): Promise<LeadAssignment | null> {
  if (!(settings?.ownPropertyPriorityEnabled ?? true)) return null;
  // Без карточки запрос клиента взять неоткуда: район, комнаты и бюджет живут
  // в ней. Показы выше работают и без карточки — там сравнивать нечего.
  if (!ctx.clientId) return null;
  /**
   * ПРОДАВЕЦ — НЕ ПО ОПИСАНИЮ (24.09.2026, проход по классам после ОБ-000118).
   * Бюджет/район/комнаты продавца — это его СОБСТВЕННОЕ жильё, а не запрос:
   * «совпадение» с чужим объектом в том же доме увело бы его агенту чужого
   * продавца. Прямое указание на объект (шаг выше) продавцу по-прежнему доступно.
   */
  if (ctx.kind === "SELLER") return null;

  const threshold = settings?.ownPropertyMatchThreshold ?? 90;
  const candidates = (await findMatchingPropertiesForClient(ctx.clientId, { requirements: ctx.requirements })).filter(
    (m) => m.score >= threshold
  );
  if (candidates.length === 0) return null;

  // Лучший объект каждого агента: агент с двумя подходящими квартирами не должен
  // получать преимущества дважды — он спорит своим лучшим предложением.
  const bestByAgent = new Map<string, (typeof candidates)[number]>();
  for (const c of candidates) {
    const current = bestByAgent.get(c.intakeAgentId);
    if (!current || c.score > current.score) bestByAgent.set(c.intakeAgentId, c);
  }

  const statuses = await ownPropertyAgentStatuses([...bestByAgent.keys()], exclude);
  const eligible = [...bestByAgent.values()].filter((c) => statuses.has(c.intakeAgentId));
  if (eligible.length === 0) return null;

  const topScore = Math.max(...eligible.map((c) => c.score));
  const tied = eligible.filter((c) => c.score === topScore);
  // Спор решается баллом, а при равенстве — обычной очередью по KPI, а не
  // порядком выборки из базы: иначе один и тот же агент выигрывал бы все ничьи.
  const order = tied.length > 1 ? await orderByKpiQueue(tied.map((c) => c.intakeAgentId)) : [tied[0].intakeAgentId];

  const winnerId = order[0];
  const winner = tied.find((c) => c.intakeAgentId === winnerId)!;
  const status = statuses.get(winnerId)!;
  if (status.frozenAt || (status.leadsPausedUntil && status.leadsPausedUntil > new Date())) {
    notifyOwnerUnavailable(status.fullName, status);
  }
  return {
    agentId: winnerId,
    reason: "own_property_match",
    propertyId: winner.propertyId,
    propertyShortId: winner.shortId,
    score: winner.score,
  };
}

/**
 * Записать в карточку, почему лид ушёл именно сюда.
 *
 * Без этого лид, ушедший мимо очереди, выглядит как сбой распределения — и для
 * агента, которому он достался, и для того, кто его ждал. Запись SYSTEM живёт в
 * хронологии клиента и переживает удаление самого объекта.
 */
export async function recordAssignReasonTx(
  tx: TxClient,
  clientId: string,
  agentId: string,
  assignment: LeadAssignment
): Promise<void> {
  if (assignment.reason === "queue") return;
  /**
   * Названного клиентом агента к «лидам на 1%» не относим: он ничего не приносил
   * в агентство, клиент просто попросил именно его. Поэтому у этой причины своя
   * ветка — без ownPropertyLead и без matchedPropertyId, которые считают комиссию.
   */
  if (assignment.reason === "requested_by_client") {
    await tx.client.update({ where: { id: clientId }, data: { assignReason: assignment.reason } });
    // SYSTEM — это объяснение алгоритма распределения, не действие агента
    // (П-10, 17.09.2026); subjectAgentId — держатель лида ПОСЛЕ назначения.
    await logTimeline({
      clientId,
      actor: { kind: "system", source: "lead-assignment", subjectAgentId: agentId },
      type: "SYSTEM",
      notes: assignment.note ?? "Лид отдан вне очереди: клиент сам назвал этого сотрудника",
      tx,
    });
    return;
  }
  const note =
    assignment.reason === "own_property_explicit"
      ? `Лид отдан вне очереди: клиент интересовался конкретным объектом №${assignment.propertyShortId} этого агента (ссылка с сайта или объект из разговора)`
      : assignment.reason === "instagram_post_link"
        ? `Лид отдан вне очереди: клиент прислал ссылку на пост объекта №${assignment.propertyShortId} этого агента`
        : assignment.reason === "own_property_shown"
          ? `Лид отдан вне очереди: бот показывал клиенту объект №${assignment.propertyShortId} этого агента`
          : `Лид отдан вне очереди: запрос клиента совпал с объектом №${assignment.propertyShortId} этого агента (совпадение ${assignment.score})`;
  await tx.client.update({
    where: { id: clientId },
    data: {
      assignReason: assignment.reason,
      matchedPropertyId: assignment.propertyId ?? null,
      // «Лид на 1%»: агент получит и 0.5% интейка, и 0.5% за продажу.
      ownPropertyLead: true,
    },
  });
  await logTimeline({
    clientId,
    actor: { kind: "system", source: "lead-assignment", subjectAgentId: agentId },
    type: "SYSTEM",
    notes: note,
    tx,
  });
}

/** Legacy callers keep best-effort reason logging. New-only policy can include
 * the strict helper in its actual assignment transaction. */
export async function recordAssignReason(clientId: string, agentId: string, assignment: LeadAssignment): Promise<void> {
  if (assignment.reason === "queue") return;
  try {
    await prisma.$transaction(tx => recordAssignReasonTx(tx, clientId, agentId, assignment));
  } catch (err) {
    // Причина назначения важна, но лид важнее: разрывать распределение из-за
    // непрочитанной строки в хронологии нельзя.
    console.error("[leads] причина назначения не записана:", err instanceof Error ? err.message : err);
  }
}

/**
 * Балл Royal Score за отказ №n подряд. Вызывается ТОЛЬКО после успешного атомарного
 * захвата в declineLead — n там инкрементится ровно раз на отказ, поэтому и балл
 * пишется ровно раз.
 *
 * sourceId — на конкретную выдачу лида (клиент + assignedAt), а не на пару
 * «агент + n» (23.09.2026, проверка раздачи, пункт 13). Принятие лида обнуляет
 * счётчик отказов, и следующая серия снова считает 1, 2, 3… с теми же ключами:
 * дедуп журнала молча выбрасывал каждый штраф второй и последующих серий.
 * Префикс `decline-${agentId}-${n}-` сохранён.
 */
async function recordDeclineScore(
  agentId: string,
  n: number,
  client: { id: string; fullName: string; assignedAt: Date | null }
): Promise<void> {
  const clientName = client.fullName;
  const kind: ScoreEventKind =
    n <= 1 ? "lead_declined_1" : n === 2 ? "lead_declined_2" : n === 3 ? "lead_declined_3" : "lead_declined_4plus";
  const points = await loadEventPoints();
  recordScoreEvent({
    agentId,
    kind,
    delta: points[kind],
    reason: `Отказ от лида подряд №${n}: ${clientName}`,
    sourceId: `decline-${agentId}-${n}-${client.id}-${client.assignedAt?.getTime() ?? 0}`,
  });
}

export type DeclineLeadResult =
  | { ok: true; reassignedTo: string | null; escalated: boolean; lost: boolean; declineCount: number }
  | { ok: false; reason: "not_found" | "not_own" | "already_accepted" };

/**
 * Агент нажал «Отклонить» на непринятом лиде (спецификация 01.08.2026, часть 1:
 * «Получение нового лида» — кнопки ✅ Принять / ❌ Отклонить).
 *
 * Royal Score: 1-й отказ подряд — без штрафа, 2-й/3-й/4-й+ — усиливающийся штраф
 * (см. scoreJournal.ts DEFAULT_EVENT_POINTS.lead_declined_*). Счётчик у АГЕНТА, не
 * у лида — «после успешной обработки любого нового лида счётчик обнуляется» (см.
 * routes/clients.ts POST /:id/accept). Штраф начисляется независимо от того,
 * нашёлся ли следующий агент — сам факт отказа уже произошёл.
 *
 * Передача следующему свободному агенту использует тот же круг переназначения
 * (triedAgentIds), что и reassignStaleLeads: если
 * держать это в двух местах по-разному, они разъедутся и лид либо будет бесконечно
 * кружить, либо потеряется раньше времени.
 *
 * П-3 (17.09.2026, `docs/audit/lead-ownership-17-09.md` §2, §4): «Отклонить»
 * относится ТОЛЬКО к непринятому лиду («получение нового лида», кнопка ❌) —
 * `already_accepted` ниже отбрасывает принятый лид раньше, чем дело дойдёт до
 * карусели, и оба `changeClientAgent` дальше держат `guardWhere: { acceptedAt:
 * null }` — вторая, атомарная проверка того же условия на момент коммита.
 * Отклонить принятый и отработанный лид нельзя — это «отказ от работы»
 * (см. lib/clientRefuse.ts), а не «отклонить»; canAutoTransfer здесь всегда
 * вернул бы allowed:true (acceptedAt=null — условие П-3 не выполнено), явный
 * вызов не добавляет защиты сверх guardWhere и не заводится намеренно.
 */
export async function declineLead(clientId: string, agentId: string): Promise<DeclineLeadResult> {
  const client = await prisma.client.findUnique({ where: { id: clientId } });
  if (!client) return { ok: false, reason: "not_found" };
  if (client.assignedAgentId !== agentId) return { ok: false, reason: "not_own" };
  // Отклонить можно только НЕпринятый лид — после «Принять» это уже не «получение
  // нового лида», а работающий клиент, и его судьба решается отказом (refuse), не отказом от приёма.
  if (client.acceptedAt || client.assignmentRefusedAt || client.assignmentCompletedAt) return { ok: false, reason: "already_accepted" };

  /**
   * ЗАХВАТ — АТОМАРНЫЙ, ВСЁ ОСТАЛЬНОЕ — ТОЛЬКО ПОСЛЕ НЕГО (26.08.2026).
   *
   * Раньше инкремент счётчика отказов, запись балла и переназначение шли тремя
   * независимыми шагами от снимка клиента, прочитанного выше. Двойной клик по
   * «Отклонить» (веб-маршрут, в отличие от push-кнопок, одноразовым маркером не
   * защищён) проходил проверки дважды на одном снимке: счётчик отказов рос на 2
   * (незаслуженный штраф «второй отказ подряд» — sourceId у баллов разный, дедуп
   * не спасал), reassignCount рос на 2 (быстрее срабатывал предел передач), в
   * хронологию ложились две записи, и два агента получали пуш «лид передан вам».
   *
   * Теперь арбитром служит условный updateMany по клиенту (в транзакции каждой
   * ветки ниже): проигравший запрос видит count===0 и уходит как «уже отработано»,
   * не тронув ни счётчик, ни баллы.
   */
  const tried = Array.isArray(client.triedAgentIds) ? (client.triedAgentIds as string[]) : [];
  const triedNow = tried.includes(agentId) ? tried : [...tried, agentId];
  const kind = client.kind === "SELLER" ? "SELLER" : "BUYER";
  /**
   * ОТКАЗ ПОМНИТСЯ ДО КОНЦА ЖИЗНИ ЛИДА (ПР-000477, 25.09.2026, см. шапку
   * `Client.declinedAgentIds` в schema.prisma). Отклонение — самый первый и
   * самый явный источник этого списка: агент нажал «Отклонить», и в отличие от
   * `triedAgentIds`, эта запись не сгорает ни на одном сбросе круга.
   */
  const declinedBefore = Array.isArray(client.declinedAgentIds) ? (client.declinedAgentIds as string[]) : [];
  const declinedNow = declinedBefore.includes(agentId) ? declinedBefore : [...declinedBefore, agentId];
  const withDeclined = (ids: string[]) => [...new Set([...ids, ...declinedNow])];
  // ПРИСУТСТВИЕ (ПР-000477): отказ по кнопке в шторке пуша не проходит через
  // requireAuth (routes/push.ts — единственный маршрут CRM без него), поэтому
  // без явного touch агент, отклонивший лид с экрана блокировки, не считался
  // бы «заходившим сегодня» для pickAgentForLead. Не throttled, как в
  // auth/middleware.ts — отказ не частое действие, лишний UPDATE не страшен.
  void prisma.agent.update({ where: { id: agentId }, data: { lastSeenAt: new Date() } }).catch(() => {});
  /**
   * ЛИД ПО СВОЕМУ ОБЪЕКТУ НЕ УХОДИТ ЧУЖОМУ АГЕНТУ (Пачка 1 п.6, 11.09.2026:
   * «признак не сгорает» — declineLead входит в список мест, где владение
   * объектом обязано пережить круг переназначения). Обычная карусель ниже
   * (`pickAgentForLead`) отдала бы клиента следующему по очереди KPI, у кого с
   * этим объектом никакой связи нет — то самое «ушёл другому агенту без
   * логичной причины». Вместо этого лид уходит в ТОТ ЖЕ путь, что и просрочка
   * (см. reassignStaleLeads): эскалация руководителю, без автопереназначения —
   * решает он один.
   *
   * ОТКАЗ ИДЁТ ТЕМ ЖЕ КРУГОМ, ЧТО И «НЕ ПРИНЯЛ ЗА 15 МИНУТ» (владелец
   * 23.09.2026, разбор раздачи, пункт 6). Раньше после leadEscalateAfter
   * переходов отказ останавливал лид: он оставался у отказавшегося,
   * руководителю приходило «свободных исполнителей не осталось», хотя они
   * были, а по пределу передач карточка уходила в «Неактивные». reassignCount
   * при этом считает и переходы круга по просрочке, так что четвёртый
   * «Отклонить» за вечер хоронил живой лид. Круг по просрочке эти пределы
   * снял 17.09 («пусть крутится, может кто-то да и примет»), здесь они
   * оставались. Теперь: следующий, кого ещё не пробовали; все пробованы —
   * новый круг без отказавшегося (как в reassignStaleLeads с 23.09);
   * руководителю — только если отдать правда некому.
   */
  let nextAgentId: string | null = null;
  if (!client.ownPropertyLead) {
    nextAgentId = await pickAgentForLead(withDeclined(triedNow), kind);
    if (!nextAgentId && triedNow.length > 1) {
      triedNow.length = 0;
      triedNow.push(agentId);
      nextAgentId = await pickAgentForLead(withDeclined(triedNow), kind);
    }
  }

  if (!nextAgentId) {
    /**
     * ДВА РАЗНЫХ ДИАГНОЗА — ДВА РАЗНЫХ ТЕКСТА (ПР-000477, 25.09.2026, тот же
     * приём, что и в reassignment.ts/firstCall.ts). «Других агентов сейчас
     * нет» звучит как авария, хотя чаще это «все, кроме отказавшихся, уже
     * отказались от этого же лида» — разные причины требуют разных действий
     * руководителя.
     */
    const allDeclined =
      !client.ownPropertyLead &&
      declinedNow.length > 0 &&
      !(await pickAgentForLead(withDeclined([agentId]), kind));
    const reason = client.ownPropertyLead
      ? "Лид по объекту агента отклонён — передать другому нельзя, эскалация руководителю"
      : allDeclined
        ? "Лид отклонён — все доступные агенты уже отказались от него, эскалация руководителю"
        : "Лид отклонён — других агентов, принимающих лиды, сейчас нет, эскалация руководителю";
    const n = await prisma.$transaction(async (tx) => {
      // Условие по escalatedAt из снимка — арбитр двойного клика: первый запрос
      // ставит новую отметку, второй по старому значению уже никого не находит.
      const claimed = await changeClientAgent({
        clientId,
        toAgentId: agentId, // агент не меняется — только эскалируем
        reason,
        actorId: null,
        source: "decline.escalate",
        interactionAgentId: agentId,
        guardWhere: { assignedAgentId: agentId, acceptedAt: null, escalatedAt: client.escalatedAt, assignmentRefusedAt: null, assignmentCompletedAt: null },
        data: { escalatedAt: new Date(), triedAgentIds: triedNow, declinedAgentIds: declinedNow },
        tx,
      });
      if (!claimed.ok) return null;
      const agent = await tx.agent.update({
        where: { id: agentId },
        data: { consecutiveLeadDeclines: { increment: 1 } },
        select: { consecutiveLeadDeclines: true },
      });
      return agent.consecutiveLeadDeclines;
    });
    if (n === null) return { ok: false, reason: "not_own" };
    void recordDeclineScore(agentId, n, client);
    const supervisors = await findAgentsWithPermission("clients.assign");
    sendPushToAgents(supervisors, {
      title: "⚠️ Лид отклонён, эскалация",
      body: client.ownPropertyLead
        ? `${client.fullName}: агент объекта отказался — назначьте вручную`
        : allDeclined
          ? `${client.fullName}: все доступные агенты отказались от лида — назначьте вручную`
          : `${client.fullName}: агент отказался, других агентов, принимающих лиды, сейчас нет`,
      url: `/clients/${client.shortId}`,
      tag: `lead-escalated-${clientId}`,
    }).catch((err) => console.error("[push] эскалация после отказа:", err));
    return { ok: true, reassignedTo: null, escalated: true, lost: false, declineCount: n };
  }

  const n = await prisma.$transaction(async (tx) => {
    // Арбитр — assignedAgentId: первый запрос передаёт лида следующему агенту,
    // второй по условию «всё ещё мой и не принят» никого не находит.
    const claimed = await changeClientAgent({
      clientId,
      toAgentId: nextAgentId,
      reason: "Лид переназначен: предыдущий агент отклонил",
      actorId: null,
      source: "decline.reassign",
      interactionAgentId: nextAgentId,
      guardWhere: { assignedAgentId: agentId, acceptedAt: null, assignmentRefusedAt: null, assignmentCompletedAt: null },
      data: {
        assignedAt: new Date(),
        reassignCount: { increment: 1 },
        triedAgentIds: triedNow,
        declinedAgentIds: declinedNow,
      },
      tx,
    });
    if (!claimed.ok) return null;
    const agent = await tx.agent.update({
      where: { id: agentId },
      data: { consecutiveLeadDeclines: { increment: 1 } },
      select: { consecutiveLeadDeclines: true },
    });
    return agent.consecutiveLeadDeclines;
  });
  if (n === null) return { ok: false, reason: "not_own" };
  void recordDeclineScore(agentId, n, client);
  sendLeadPush(nextAgentId, clientId, {
    title: "🔔 Новый лид",
    body: `${client.fullName} — передан вам`,
    url: `/clients/${client.shortId}`,
    tag: `lead-${clientId}`,
  }).catch((err) => console.error("[push] передача после отказа:", err));

  return { ok: true, reassignedTo: nextAgentId, escalated: false, lost: false, declineCount: n };
}
