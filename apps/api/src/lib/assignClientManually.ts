import { canViewInvestigations } from "@royal-home/shared";
import { prisma } from "../db.js";
import { Prisma, type Client } from "../generated/prisma/client.js";
import { closeLeadPushNotification, closeLeadPushNotifications, sendPushToAgent } from "../push.js";
import { logAgentAudit } from "./audit.js";
import { changeClientAgent } from "./changeClientAgent.js";
import { reactivationResetData } from "./clientLifecycle.js";
import { SUPERVISOR_ASSIGN_REASON } from "./leadReason.js";
import { publishClientUpdated, publishLeadAccepted } from "./livePublish.js";
import { checkManualAssignTarget } from "./manualAssignTarget.js";
import { findAgentsWithPermission } from "./recipients.js";

/**
 * РУЧНОЕ НАЗНАЧЕНИЕ КЛИЕНТА РУКОВОДИТЕЛЕМ — ОДНА РЕАЛИЗАЦИЯ НА ВСЕ ВХОДЫ
 * (31.10.2026, внутренний ИИ-помощник П3, задача 3.4,
 * docs/design/internal-assistant-architecture-2026-10-31.md §3 change_client_agent).
 *
 * Раньше всё это жило прямо в обработчике `POST /clients/:id/assign`
 * (routes/clients/lifecycle.ts): проверки (Корзина, «прочее обращение», отказ
 * без права расследований, получатель — `checkManualAssignTarget`), запись через
 * `changeClientAgent` по снимку и то, что делается после (пуш назначенному,
 * гашение пушей прежнего и эскалаций у руководителей, живые события, AuditLog
 * LEAD_ASSIGN). Помощник обязан делать РОВНО то же — две копии разошлись бы на
 * первой же правке. Теперь маршрут и помощник зовут эту функцию; маршрут только
 * переводит исход в HTTP.
 *
 * Право `clients.assign` проверяет вызывающий (у маршрута — `requirePermission`,
 * у помощника — исполнитель действия): функция не знает, откуда пришёл запрос.
 *
 * Единственный писатель `Client.assignedAgentId` по-прежнему `changeClientAgent`
 * (закон о владении клиентом, docs/law/lead-ownership.md П-1/П-5): источник
 * записи — `lifecycle.assign` и у помощника, потому что это то же самое решение
 * руководителя, и на этом источнике держатся проверка открытой сделки, сброс
 * отметок отказа (lib/assignmentCompletion.ts), требование актора (П-5) и строка
 * «Вам назначил руководитель» на Главной (routes/dashboard.ts). Вход помощника
 * виден по хвосту причины и по `via` в AuditLog.
 */

export interface ManualAssignActor {
  id: string;
  /** Роль нажавшего — от неё зависит, можно ли назначать после отказа. */
  role: string | null | undefined;
}

export type ManualAssignFailure = {
  ok: false;
  status: 400 | 403 | 404 | 409;
  /** Машинный код — помощнику, чтобы отличить «устарело» от прочих отказов. */
  code: "NOT_FOUND" | "REFUSED_NEEDS_ADMIN" | "IN_TRASH" | "OTHER_KIND" | "TARGET" | "OPEN_DEAL" | "RACE" | "STALE";
  error: string;
};

export type ManualAssignOutcome =
  | {
      ok: true;
      client: Client;
      target: { id: string; fullName: string; role: string };
      notAgent: boolean;
      toSelf: boolean;
      previousAgentId: string | null;
    }
  | ManualAssignFailure;

/** Поля, по которым запись идёт условно: «заявка всё ещё в том состоянии, что видел разбирающий». */
export const MANUAL_ASSIGN_GUARD_FIELDS = [
  "assignedAgentId",
  "acceptedAt",
  "escalatedAt",
  "assignmentRefusedAt",
  "assignmentCompletedAt",
] as const;

type GuardRow = Pick<Client, (typeof MANUAL_ASSIGN_GUARD_FIELDS)[number]>;

/**
 * Проверки ДО записи, которые не зависят от получателя. Ничего не пишут.
 * Порядок и тексты — те же, что отдавал маршрут.
 */
export function manualAssignPreconditions(
  client: Pick<Client, "kind" | "deletedAt" | "assignmentRefusedAt" | "assignmentCompletedAt"> | null,
  actorRole: string | null | undefined
): ManualAssignFailure | null {
  if (!client) return { ok: false, status: 404, code: "NOT_FOUND", error: "Клиент не найден" };
  if ((client.assignmentRefusedAt || client.assignmentCompletedAt) && !canViewInvestigations(actorRole)) {
    return {
      ok: false,
      status: 403,
      code: "REFUSED_NEEDS_ADMIN",
      error: "После отказа новое назначение доступно только администратору или директору",
    };
  }
  // Карточка в Корзине не назначается — ни одна точка чтения такую карточку
  // никому не покажет (routes/clients/list.ts, card.ts), а без этой проверки
  // /assign «успешно» отдавал удалённого клиента: агент видел «принято», а
  // карточки не было нигде (живой случай 15.09.2026 — 30+ клиентов из Корзины).
  if (client.deletedAt) {
    return {
      ok: false,
      status: 400,
      code: "IN_TRASH",
      error: "Карточка в Корзине — сначала восстановите её, назначать пока нечего",
    };
  }
  /**
   * «ПРОЧЕЕ ОБРАЩЕНИЕ» АГЕНТУ НЕ НАЗНАЧАЕТСЯ (разбор 30.08.2026).
   *
   * OTHER — это карточка, которую CRM намеренно держит вне раздачи: аренда,
   * работа, чужой город, реклама конкурентов (см. services/leads/intake.ts).
   * Ручное назначение этого не проверяло вовсе и было прямой дверью мимо
   * правила: два клика — и электрик у агента в портфеле, вместе с лимитом,
   * таймером принятия и KPI.
   *
   * Отказ с ВИДИМЫМ ТЕКСТОМ причины, а не молча: руководителю надо сказать, что
   * делать дальше — сменить тип карточки, если человек всё-таки покупатель.
   */
  if (client.kind === "OTHER") {
    return {
      ok: false,
      status: 400,
      code: "OTHER_KIND",
      error:
        "Это «прочее обращение» (аренда, работа, другой город и т.п.) — агентам такие карточки не раздаются. " +
        "Если человек всё-таки покупатель или продавец, сначала смените тип клиента в карточке.",
    };
  }
  return null;
}

export interface AssignClientManuallyInput {
  clientId: string;
  toAgentId: string;
  /** «Взять себе и принять» — то же, что назначить себе. */
  accept?: boolean;
  actor: ManualAssignActor;
  /** Откуда нажали. Помощник — `assistant`: хвост причины и поле `via` в AuditLog. */
  via?: "rest" | "assistant";
  /**
   * Состояние, которое видел человек, подтверждая действие (снимок превью
   * помощника). Задано — запись идёт ТОЛЬКО если карточка всё ещё в нём:
   * расхождение до записи — `STALE`, гонка между чтением и записью — `RACE`
   * (оба 409). Сверяются поля условия записи и `extra` — тип и статусы, от
   * которых зависят проверки и сброс «Потерянных» (их меняет запись).
   */
  expected?: Partial<Record<keyof Client, unknown>>;
}

/** Нормализация значения поля для сравнения со снимком (даты — ISO-строкой, как в JSON). */
function comparable(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  return value ?? null;
}

/**
 * Назначить клиента сотруднику вручную. Делает всё, что делал маршрут
 * `POST /clients/:id/assign`, включая пуши и живые события; HTTP не знает.
 */
export async function assignClientManually(input: AssignClientManuallyInput): Promise<ManualAssignOutcome> {
  const { toAgentId, accept, actor } = input;
  const client = await prisma.client.findUnique({ where: { id: input.clientId } });
  const pre = manualAssignPreconditions(client, actor.role);
  if (pre) return pre;
  const row = client!;

  if (input.expected) {
    for (const [field, value] of Object.entries(input.expected)) {
      if (comparable(row[field as keyof Client]) !== comparable(value)) {
        return { ok: false, status: 409, code: "STALE", error: "Карточку успели изменить — проверьте ещё раз" };
      }
    }
  }

  // Получатель (B13, решение владельца 02.10.2026): отключённому или
  // замороженному — нельзя, с понятной причиной; не агенту (директору) — можно,
  // экран предупреждает перед нажатием (lib/manualAssignTarget.ts).
  const [checked, supervisor] = await Promise.all([
    checkManualAssignTarget(toAgentId),
    prisma.agent.findUnique({ where: { id: actor.id }, select: { fullName: true } }),
  ]);
  if (!checked.ok) return { ok: false, status: checked.status, code: "TARGET", error: checked.error };
  const target = checked.agent;

  const now = new Date();
  /**
   * ЗАХВАТ ПО СНИМКУ СОСТОЯНИЯ, А НЕ БЕЗУСЛОВНАЯ ЗАПИСЬ (найдено 07.09.2026 —
   * жалоба владельца: лид, уже принятый Нозой, «сам» уехал другому агенту).
   *
   * Сценарий: руководитель А уже разобрал эскалацию и назначил лид Нозе, она
   * приняла; руководитель Б — с ещё не погашенным уведомлением или просто с
   * открытой старой вкладкой — жмёт «Взять себе»/«Назначить», и прежний код
   * молча переписывал assignedAgentId поверх уже принятого лида. where сверяет
   * ровно те поля, что определяют «эта заявка ещё в том состоянии, которое видел
   * разбирающий» — count=0 значит гонка, ответ 409. У помощника к ним добавлены
   * поля его снимка (`expected`): между подтверждением и записью их тоже могли
   * поменять.
   */
  const guardWhere: Record<string, unknown> = {};
  for (const field of MANUAL_ASSIGN_GUARD_FIELDS) guardWhere[field] = (row as GuardRow)[field];
  if (input.expected) {
    for (const field of Object.keys(input.expected)) {
      if (!(field in guardWhere)) guardWhere[field] = row[field as keyof Client];
    }
  }

  const toSelf = toAgentId === actor.id;
  const supervisorName = supervisor?.fullName ?? "Руководитель";
  const viaSuffix = input.via === "assistant" ? " (через ИИ-помощника)" : "";
  const assignReason =
    (accept || toSelf
      ? `${supervisorName} забрал(а) заявку себе и принял(а) её`
      : `${supervisorName} вручную назначил(а) заявку агенту ${target.fullName} — принята автоматически`) + viaSuffix;
  const claimResult = await changeClientAgent({
    clientId: row.id,
    toAgentId,
    reason: assignReason,
    actorId: actor.id,
    source: "lifecycle.assign",
    guardWhere,
    // Свежий старт: новый агент, обнулённый счётчик кругов, снятая эскалация.
    // Принято сразу — и «Взять себе», и назначение другому (см. шапку маршрута).
    data: {
      assignedAt: now,
      reassignCount: 0,
      triedAgentIds: [],
      escalatedAt: null,
      acceptedAt: now,
      // Причина «почему лид ваш» — назначил руководитель, а не очередь или объект.
      // Пометки «свой объект» снимаются: решение руководителя их отменяет, иначе
      // на новом агенте лид пошёл бы по ветке «напоминание хозяину объекта».
      ...(toSelf ? {} : { assignReason: SUPERVISOR_ASSIGN_REASON }),
      ownPropertyLead: false,
      ownPropertyReminderSentAt: null,
      /**
       * СНИМАЕМ ЗАМОРОЗКУ (найдено 20.08.2026 на живом случае: руководитель
       * разобрал эскалацию и назначил агента, агент два дня реально вёл
       * клиента, а карточка так и провисела LOST — звонок клиента продолжал
       * падать мимо нового агента в очередь, потому что inboundRouting.ts не
       * переводит LOST/INACTIVE напрямую, см. decideRoute). Разбор эскалации —
       * это и есть решение «клиент снова в работе». Набор сбрасываемых полей —
       * общий с lib/clientLifecycle.ts (B3).
       */
      ...reactivationResetData(row),
    },
  });

  if (!claimResult.ok) {
    if (claimResult.reason === "deleted") {
      return {
        ok: false,
        status: 409,
        code: "RACE",
        error: "Клиент перемещён в Корзину, пока вы смотрели карточку — назначить его нельзя.",
      };
    }
    // ОТКРЫТАЯ СДЕЛКА (ночная проверка 24.09.2026, находка №208/С2-4): смена
    // владельца заблокирована в changeClientAgent — см. комментарий там.
    if (claimResult.reason === "open_deal") {
      return { ok: false, status: 409, code: "OPEN_DEAL", error: "У клиента открытая сделка — сначала закройте или отмените её." };
    }
    const current = await prisma.client.findUnique({
      where: { id: row.id },
      select: { acceptedAt: true, assignedAgent: { select: { fullName: true } } },
    });
    return {
      ok: false,
      status: 409,
      code: "RACE",
      error: current?.assignedAgent
        ? `Заявку уже разобрали, пока вы смотрели карточку — сейчас она у ${current.assignedAgent.fullName}${current.acceptedAt ? " (принята)" : ""}. Обновите страницу.`
        : "Заявку уже разобрали, пока вы смотрели карточку — обновите страницу.",
    };
  }
  const updated = (await prisma.client.findUnique({ where: { id: row.id } })) ?? row;

  logAgentAudit(actor.id, "LEAD_ASSIGN", "Client", row.id, {
    shortId: row.shortId,
    fullName: row.fullName,
    toAgentId,
    toAgentName: target.fullName,
    accepted: true,
    previousAgentId: row.assignedAgentId,
    ...(input.via === "assistant" ? { via: "assistant" } : {}),
  });

  // Назначенному агенту нужен push — его никто не спрашивал, лид «прилетел» вручную.
  // kind "lead" — та же строка ложится в колокольчик, и агент увидит её и без
  // подписки на уведомления. Спутники смены владельца (задачи, заявки, пуши
  // прежнего) закрывает сам changeClientAgent.
  if (!toSelf) {
    sendPushToAgent(toAgentId, {
      kind: "lead",
      title: "📌 Вам назначили клиента",
      body: `${supervisorName} назначил(а) вам ${row.fullName} — заявка уже ваша, позвоните клиенту`,
      url: `/clients/${row.shortId}`,
      tag: `lead-${row.id}`,
    }).catch((err) => console.error("[push] ручное назначение лида:", err));
  }
  publishLeadAccepted(row.id, toAgentId);
  // Прежний держатель заявки (если был и это не тот же агент) не должен видеть
  // у себя в шторке «🔔 Новый лид» по карточке, которую руководитель только что
  // забрал/передал дальше — владелец 19.08.2026.
  if (row.assignedAgentId && row.assignedAgentId !== toAgentId) {
    closeLeadPushNotification(row.assignedAgentId, `lead-${row.id}`).catch((err) =>
      console.error("[push] закрытие уведомления после ручного назначения:", err)
    );
  }
  // Руководитель только что вручную решил вопрос назначения — у ОСТАЛЬНЫХ
  // руководителей ни один из «требует внимания» пушей по этой карточке больше
  // не актуален (владелец 19.08.2026 завёл первые два; шесть остальных
  // добавлены 07.09.2026). lead-unassigned-*/repeat-contact-*/lead-call-escalated-* —
  // три разных повода, у которых один и тот же способ решения: назначить агента
  // вручную, то есть именно эта функция.
  void (async () => {
    const supervisors = await findAgentsWithPermission("clients.assign");
    await closeLeadPushNotifications(
      supervisors.flatMap((id) => [
        { agentId: id, tag: `transfer-pending-${row.id}` },
        { agentId: id, tag: `transfer-exhausted-${row.id}` },
        { agentId: id, tag: `lead-escalated-${row.id}` },
        { agentId: id, tag: `refusal-escalated-${row.id}` },
        { agentId: id, tag: `transfer-conflict-${row.id}` },
        { agentId: id, tag: `lead-unassigned-${row.id}` },
        { agentId: id, tag: `repeat-contact-${row.id}` },
        { agentId: id, tag: `lead-call-escalated-${row.id}` },
      ])
    );
  })().catch((err) => console.error("[push] закрытие эскалаций после назначения:", err));

  // Надзор назначил лид вручную: списки и окно приёма протухли у назначенного.
  publishClientUpdated({ clientId: row.id, agentIds: [updated.assignedAgentId], actorId: actor.id });

  return { ok: true, client: updated, target, notAgent: checked.notAgent, toSelf, previousAgentId: row.assignedAgentId };
}

/**
 * ПОЛЯ, КОТОРЫЕ МЕНЯЕТ РУЧНОЕ НАЗНАЧЕНИЕ, — для отката помощника.
 *
 * Список собран по `data` выше, по `reactivationResetData`/`inactiveExitData`
 * и по тому, что сама дописывает `changeClientAgent` (lastAgentId, отметки
 * отказа, предложение реактивации, пометки «свой объект»). Поменяется запись
 * выше — список обязан поменяться вместе с ней: тест
 * `assistant-change-client-agent.test.ts` откатывает назначение LOST-клиента из
 * очереди и сверяет ВСЕ поля с исходными.
 */
export const MANUAL_ASSIGN_WRITTEN_FIELDS = [
  "assignedAgentId",
  "assignedAt",
  "acceptedAt",
  "escalatedAt",
  "reassignCount",
  "triedAgentIds",
  "assignReason",
  "ownPropertyLead",
  "ownPropertyReminderSentAt",
  "status",
  "lostAt",
  "refusalCount",
  "workStatus",
  "inactiveLevel",
  "inactiveReasonKey",
  "inactiveSince",
  "inactiveEnteredAt",
  "inactivePingCount",
  "assignmentRefusedAt",
  "assignmentRefusedByAgentId",
  "assignmentCompletedAt",
  "lastAgentId",
  "reactivationOfferedToAgentId",
  "reactivationOfferedAt",
] as const satisfies readonly (keyof Client)[];

export type ManualAssignWrittenField = (typeof MANUAL_ASSIGN_WRITTEN_FIELDS)[number];
/** `select` Prisma на все эти поля — чтобы снимок читал ровно то, что откат вернёт. */
export const MANUAL_ASSIGN_WRITTEN_SELECT = Object.fromEntries(MANUAL_ASSIGN_WRITTEN_FIELDS.map((field) => [field, true])) as {
  [K in ManualAssignWrittenField]: true;
};
/** Значения полей в JSON-виде (даты — ISO-строкой), как их хранит снимок помощника. */
export type ManualAssignFieldValues = Record<ManualAssignWrittenField, unknown>;

const DATE_FIELDS = new Set<ManualAssignWrittenField>([
  "assignedAt",
  "acceptedAt",
  "escalatedAt",
  "ownPropertyReminderSentAt",
  "lostAt",
  "inactiveSince",
  "inactiveEnteredAt",
  "assignmentRefusedAt",
  "assignmentCompletedAt",
  "reactivationOfferedAt",
]);

/** Снять значения полей с карточки в JSON-виде. */
export function manualAssignFieldValues(client: Pick<Client, ManualAssignWrittenField>): ManualAssignFieldValues {
  const out = {} as ManualAssignFieldValues;
  for (const field of MANUAL_ASSIGN_WRITTEN_FIELDS) out[field] = comparable(client[field]);
  return out;
}

function toDbValue(field: ManualAssignWrittenField, value: unknown): unknown {
  if (value === null || value === undefined) return field === "triedAgentIds" ? Prisma.DbNull : null;
  if (DATE_FIELDS.has(field)) return new Date(String(value));
  return value;
}

/**
 * ОТКАТ РУЧНОГО НАЗНАЧЕНИЯ, СДЕЛАННОГО ПОМОЩНИКОМ (кнопка «Отменить», 15 минут).
 *
 * Возвращает карточку к тем значениям полей, что были до назначения, ТЕМ ЖЕ
 * писателем (`changeClientAgent`, источник `assistant.undo`, актор — нажавший):
 * хронология, AuditLog, спутники (задачи нового агента — обратно прежнему) и
 * объекты продавца идут его обычным путём. Запись условная: карточка должна быть
 * ровно в состоянии «после назначения» (`after`), иначе `false` — откат затёр бы
 * чужую правку.
 *
 * Чего откат НЕ возвращает (необратимые спутники прямой записи): погашенные
 * уведомления и пуши прежнего агента, снятая заявка на удаление клиента, пуш
 * «Вам назначили клиента» новому агенту. Карточка из очереди возвращается в
 * очередь — объекты продавца при этом остаются у нового агента (снятие в очередь
 * их не трогает, см. changeClientAgent).
 */
/**
 * Откат вернёт ВСЕ поля? Нет, если до назначения на карточке стояли отметки
 * отказа/завершения при живом владельце: `changeClientAgent` при передаче
 * агенту сам их снимает (lib/assignmentCompletion.ts), и восстановить их тем же
 * писателем нельзя. Такое назначение помощник помечает необратимым.
 */
export function manualAssignRevertible(before: ManualAssignFieldValues): boolean {
  return !(before.assignedAgentId && (before.assignmentRefusedAt || before.assignmentCompletedAt));
}

export async function revertManualAssign(input: {
  clientId: string;
  actorId: string;
  before: ManualAssignFieldValues;
  after: ManualAssignFieldValues;
  reason: string;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  const { before, after } = input;
  const data: Record<string, unknown> = {};
  for (const field of MANUAL_ASSIGN_WRITTEN_FIELDS) {
    if (field === "assignedAgentId") continue;
    data[field] = toDbValue(field, before[field]);
  }
  const toAgentId = (before.assignedAgentId as string | null) ?? null;
  const result = await changeClientAgent({
    clientId: input.clientId,
    toAgentId,
    reason: input.reason,
    actorId: input.actorId,
    source: "assistant.undo",
    setLastAgentId: false,
    // «Стало» ровно таким, каким его оставило назначение: владелец, отметка
    // времени назначения (ставится этой записью — уникальна) и принятие.
    guardWhere: {
      assignedAgentId: after.assignedAgentId,
      assignedAt: toDbValue("assignedAt", after.assignedAt),
      acceptedAt: toDbValue("acceptedAt", after.acceptedAt),
      escalatedAt: toDbValue("escalatedAt", after.escalatedAt),
      status: after.status,
      workStatus: after.workStatus,
      // Сделку успели открыть у нового агента — откат увёл бы клиента от его
      // же сделки (тот же запрет, что у передачи кнопкой, changeClientAgent).
      // Условие в WHERE самой записи, а не отдельным чтением: без гонки.
      deals: { none: { stage: { notIn: ["COMPLETED", "CANCELLED"] } } },
    },
    data,
  });
  if (result.ok) return { ok: true };
  return { ok: false, reason: result.reason ?? "race" };
}
