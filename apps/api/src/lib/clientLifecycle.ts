/**
 * Единая функция возврата клиента из LOST/INACTIVE (аудит 02.09.2026,
 * docs/audit-02-09-2026/01-lifecycle.md, баг B3).
 *
 * До этого момента клиент уходил в LOST тремя разными путями (светофор
 * неактивных, отказ с исчерпанным лимитом передач, передача с исчерпанным
 * лимитом), и каждый путь по-разному отвечал на вопрос «кому возвращается
 * клиент». Звонком LOST не снимался вовсе. Три разных куска кода с разной
 * логикой замены статуса — теперь один.
 */
import { prisma } from "../db.js";
import { decideReturningClient, preferredReturningOwnerId } from "./returningClientRouting.js";
import { logSystemError } from "./systemError.js";
import { logTimeline } from "./timeline.js";
import { changeClientAgent, type ChangeClientAgentResult, type Tx } from "./changeClientAgent.js";
import { closeOwnershipSatellites } from "./ownershipSatellites.js";
import { publishClientUpdated } from "./livePublish.js";
import { sendPushToAgent } from "../push.js";
import { returnAcceptDueFromNow } from "./workingDue.js";
import { inactiveExitData } from "./clientContact.js";
export { inactiveExitData } from "./clientContact.js";

export interface ReactivateClientInput {
  clientId: string;
  /** Человекочитаемая причина реактивации (для хронологии и журнала). */
  reason: string;
  /** Если указан — назначаем этому агенту; если нет — возвращаем в очередь
   *  руководителя (assignedAgentId=null, escalatedAt=now). */
  agentId?: string;
  /** true — агент уже принял клиента самим действием (снял трубку): acceptedAt=now,
   *  без ожидания принятия. Только вместе с agentId. */
  accept?: boolean;
  /**
   * Клиент вернулся САМ, но не голосом агенту (написал в уже привязанную
   * переписку): ставим отметку «клиент вернулся» (returnedAt), таймер возврата
   * Р-5 (returnAcceptDueAt — напоминание прежнему агенту, затем руководителю) и
   * шлём агенту пуш «ваш клиент снова обратился» — тот же исход, что у заявки
   * через services/leads/intake.ts. Только вместе с agentId (B1, 02.10.2026).
   */
  returnTimer?: boolean;
}

export interface ReactivateClientResult {
  ok: boolean;
  /** Обновлённый клиент (при успехе). */
  client?: {
    id: string;
    status: string;
    workStatus: string;
    assignedAgentId: string | null;
  };
}

/**
 * Поля, которые обязан сбросить ЛЮБОЙ путь возврата клиента в работу — и
 * reactivateClientFromLost ниже, и ручное назначение руководителем
 * (routes/clients/lifecycle.ts, POST /:id/assign). Ревью 03.09.2026: без
 * refusalCount=0 вернувшийся клиент после первого же отказа снова улетал в
 * LOST (лимит передач «исчерпан» с прошлой жизни карточки); без сброса полей
 * светофора они лежали мёртвым грузом до следующего перевода в неактивные.
 */
export function reactivationResetData(client: { status: string; workStatus: string }): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  if (client.status === "LOST") {
    data.status = "NEW";
    data.lostAt = null;
    data.refusalCount = 0;
  }
  if (client.workStatus === "INACTIVE" || client.status === "LOST") Object.assign(data, inactiveExitData());
  return data;
}

/**
 * Выход из Неактивных без смены status — только рабочий статус и поля
 * светофора. Отдельно от reactivationResetData для путей, которые не решают
 * судьбу LOST (клиент позвонил сам — lib/telephony/autoLeadFromCall.ts), но
 * обязаны гасить светофор так же, как обычный возврат: иначе уровень,
 * счётчик попыток и точка отсчёта прошлого цикла остаются висеть на
 * активной карточке.
 */
/**
 * Снимает флаги LOST/INACTIVE и либо назначает агенту, либо возвращает в
 * очередь руководителя. Логирует через logSystemError с тегом [lifecycle].
 *
 * НЕ трогает lastAgentId — его уже поставил deactivateClient/promoteToLost,
 * и именно по нему клиент, написавший сам, по-прежнему предлагается СНАЧАЛА
 * этому же агенту (Settings.lostReturnAcceptMinutes).
 */
export async function reactivateClientFromLost(
  input: ReactivateClientInput
): Promise<ReactivateClientResult> {
  const client = await prisma.client.findFirst({
    where: { id: input.clientId, deletedAt: null },
    select: { id: true, kind: true, status: true, workStatus: true, assignedAgentId: true, lastAgentId: true,
      assignedAt: true, assignmentRefusedAt: true, assignmentCompletedAt: true },
  });
  if (!client) return { ok: false };
  if (client.assignmentRefusedAt || client.assignmentCompletedAt) return { ok: false };

  // Уже активен и не потерян — ничего делать не нужно.
  if (client.status !== "LOST" && client.workStatus === "ACTIVE") {
    return {
      ok: true,
      client: {
        id: client.id,
        status: client.status,
        workStatus: client.workStatus,
        assignedAgentId: client.assignedAgentId,
      },
    };
  }

  /**
   * АКТОР — КЛИЕНТ, НЕ АГЕНТ (доведено до конца заданием Б1, 17.09.2026, П-10).
   *
   * Единственный вызывающий (lib/telephony/inboundRouting.ts) реактивирует
   * карточку потому, что клиент САМ позвонил/написал — агент (`input.agentId`,
   * на самом деле НОВЫЙ держатель, а не тот, кто действовал) к реактивации не
   * притрагивался. До этой правки Interaction.agentId было обязательным полем,
   * и запись без человека подписывалась ПЕРВЫМ АКТИВНЫМ ДИРЕКТОРОМ — в
   * хронологии выходило, будто клиента вернул в работу директор лично.
   *
   * subjectAgentId — держатель ПОСЛЕ реактивации (новый агент либо последний
   * исторический), чтобы запись оставалась видна в его работе с клиентом.
   */
  const previous = await preferredReturningOwnerId(client.assignedAgentId, client.lastAgentId);
  const route = await decideReturningClient({ clientId: client.id, kind: client.kind, lastAgentId: previous });
  const targetAgentId = route.kind === "queue" ? null : route.agentId;
  const subjectAgentId = targetAgentId;

  const now = new Date();
  const data = reactivationResetData(client);
  data.returnedAt = now;

  // Владелец записывается ниже через changeClientAgent в одной транзакции
  // с историей возврата. Без доступного прежнего — обычная AUTO-очередь.
  if (targetAgentId) {
    data.assignedAt = now;
    data.acceptedAt = input.accept ? now : null;
    data.escalatedAt = null;
    if (input.returnTimer) {
      data.returnedAt = now;
      // Срок — в рабочих минутах (решение владельца 02.10.2026, B4).
      data.returnAcceptDueAt = await returnAcceptDueFromNow(now);
    }
  } else {
    // Обычная очередь раздачи без ручной эскалации. OTHER остаётся
    // отдельным обращением руководству и не назначается торговому агенту.
    data.escalatedAt = client.kind === "OTHER" ? now : null;
    data.acceptedAt = null;
    data.assignedAt = now;
    data.triedAgentIds = [];
    data.reassignCount = 0;
  }

  try {
    // П-1/П-10 (17.09.2026, `docs/audit/lead-ownership-17-09.md` §2, §4):
    // раньше assignedAgentId писался прямым tx.client.update, мимо
    // changeClientAgent — единственной точки записи, и смена владельца при
    // возврате из LOST/INACTIVE была не видна в AuditLog (Х3 из
    // `docs/audit/recon-17-09/02-auto-transfer-mechanisms.md`). source
    // "lifecycle" даёт тот же текст Interaction, что и раньше (`[lifecycle]
    // ${reason}`) — тесты на формат записи не трогаются.
    //
    // skipInteraction: true — актор здесь КЛИЕНТ (звонок/сообщение САМОГО
    // клиента, см. комментарий "АКТОР — КЛИЕНТ, НЕ АГЕНТ" выше), а
    // changeClientAgent умеет писать хронологию только как "agent" (явный
    // interactionAgentId/actorId) или "system" — kind: "client" пишем сами,
    // той же транзакцией, сразу после успешной смены владельца (П-10,
    // доведено заданием Б1). Если политика П-3 отказала в передаче
    // (result.ok === false), changeClientAgent уже сам вызвал
    // escalateInsteadOfTransfer — вторую запись не пишем.
    const changed = await prisma.$transaction((tx) =>
      changeClientAgent({
        clientId: client.id,
        toAgentId: targetAgentId,
        reason: input.reason,
        actorId: null, // автоматика/клиент — источник, не человек-агент
        source: "lifecycle",
        guardWhere: { assignedAgentId: client.assignedAgentId, assignedAt: client.assignedAt,
          status: client.status, workStatus: client.workStatus, assignmentRefusedAt: null, assignmentCompletedAt: null },
        data,
        skipInteraction: true,
        tx,
      }).then(async (result) => {
        if (result.ok) {
          await logTimeline({
            clientId: client.id,
            actor: { kind: "client", source: "lifecycle", subjectAgentId },
            type: "SYSTEM",
            // Префикс восстановлен явно (auto-add убран из lib/timeline.ts, 17.09.2026,
            // регресс на своём же коде) — client-lifecycle-reactivate.test.ts и
            // прочий код ищут ровно этот тег.
            notes: `[lifecycle] ${input.reason}`,
            tx,
          });
        }
        return result;
      })
    );
    if (!changed.ok || !changed.client) return { ok: false };
    // changeClientAgent возвращает только id/assignedAgentId/lastAgentId/shortId —
    // status/workStatus нужны вызывающим (см. ReactivateClientResult), берём
    // их отдельным чтением уже после коммита.
    const updated = await prisma.client.findUniqueOrThrow({
      where: { id: changed.client.id },
      select: { id: true, shortId: true, fullName: true, status: true, workStatus: true, assignedAgentId: true },
    });

    // СЛЕД ШТАТНОГО СОБЫТИЯ — НЕ ОШИБКА (13.09.2026). Раньше успешная
    // реактивация писалась в журнал ошибок тем же вызовом, что и настоящий
    // сбой ниже (catch) — утренний отчёт директору считал штатную
    // реактивацию клиента «пойманной ошибкой». След уже есть в хронологии
    // клиента (Interaction «SYSTEM» выше), второй записи не нужно.

    // Живое обновление ПОСЛЕ коммита (аудит 11.09.2026, второй заход по
    // осиротевшим спутникам, п.4 задания: inboundRouting.ts::reactivateClientFromLost
    // не публиковала вовсе) — оба возможных исполнителя видят карточку живьём.
    publishClientUpdated({ clientId: updated.id, agentIds: [client.assignedAgentId, updated.assignedAgentId] });

    // Агент узнаёт о возврате сразу, а не через три четверти таймера (B1, 02.10.2026):
    // без пуша карточка тихо оживала у него, и первым сигналом было «скоро срок».
    if (input.returnTimer && updated.assignedAgentId) {
      void sendPushToAgent(updated.assignedAgentId, {
        title: "🔔 Ваш клиент снова обратился",
        body: `${updated.fullName} — был в «Потерянных», написал сам и снова у вас в работе`,
        url: `/clients/${updated.shortId}`,
        tag: `repeat-contact-${updated.id}`,
      }).catch((err) => console.error("[push] возврат из Потерянных:", err));
    }

    return {
      ok: true,
      client: {
        id: updated.id,
        status: updated.status,
        workStatus: updated.workStatus,
        assignedAgentId: updated.assignedAgentId,
      },
    };
  } catch (err) {
    void logSystemError("api", `[lifecycle] Ошибка реактивации клиента ${client.id}: ${err instanceof Error ? err.message : String(err)}`);
    return { ok: false };
  }
}

export interface MarkClientLostInput {
  clientId: string;
  /** Человекочитаемая причина — идёт в Interaction и AuditLog. */
  reason: string;
  /** Кто перевёл клиента в Потерянные; null/не передан — автоматика. */
  actorId?: string | null;
  /** Короткий тег механизма: lost.promote / lost.refuse / lost.transfer. */
  source: string;
  guardWhere?: Record<string, unknown>;
  tx?: Tx;
}

/**
 * Единый переход в LOST (аудит владения 11.09.2026, дыра №2: три места —
 * светофор неактивных, отказ с исчерпанным лимитом передач, передача с
 * исчерпанным лимитом — по-разному решали, что делать с `assignedAgentId`).
 *
 * РЕШЕНИЕ ВЛАДЕЛЬЦА (11.09.2026): LOST не занимает слот в портфеле
 * (`lib/leadLimits.ts::TERMINAL_STATUSES`), поэтому агент клиента НЕ теряет —
 * `assignedAgentId` сохраняется как есть. `lastAgentId` при этом всё равно
 * проставляется в того же агента: так формы возврата (реактивация,
 * `lostReturnAcceptMinutes`) читают одно и то же поле независимо от того,
 * менялся ли `assignedAgentId` фактически.
 */
export async function markClientLost(input: MarkClientLostInput): Promise<ChangeClientAgentResult> {
  const run = async (tx: Tx) => {
    const before = await tx.client.findUnique({
      where: { id: input.clientId },
      select: { id: true, assignedAgentId: true },
    });
    if (!before) return { ok: false as const };

    // skipSatellites: true — агент здесь НЕ меняется (toAgentId === прежний
    // assignedAgentId), поэтому автоматический вызов closeOwnershipSatellites
    // внутри changeClientAgent молчит (fromAgentId === toAgentId, гасить
    // требования/заявку/задачи некому и незачем). Но пуш «новый лид», строка в
    // колокольчике и живое обновление экрана всё равно устарели — клиент ушёл
    // в LOST, предложение принять его больше не актуально. Гасим их ниже сами
    // (см. Пачка 15, п.2 задания: «markClientLost — гасить push и уведомления
    // «лид», публиковать live»), уже ПОСЛЕ коммита этой транзакции.
    return changeClientAgent({
      clientId: input.clientId,
      toAgentId: before.assignedAgentId,
      reason: input.reason,
      actorId: input.actorId ?? null,
      source: input.source,
      guardWhere: input.guardWhere,
      setLastAgentId: false,
      skipSatellites: true,
      data: {
        status: "LOST",
        lostAt: new Date(),
        ...(before.assignedAgentId ? { lastAgentId: before.assignedAgentId } : {}),
      },
      tx,
    });
  };

  const result = input.tx ? await run(input.tx) : await prisma.$transaction(run);

  if (result.ok && result.client?.assignedAgentId) {
    await closeOwnershipSatellites({
      clientId: input.clientId,
      clientShortId: result.client.shortId ?? null,
      fromAgentId: result.client.assignedAgentId,
      toAgentId: result.client.assignedAgentId,
      reason: `[${input.source}] ${input.reason}`,
    });
  }

  return result;
}
