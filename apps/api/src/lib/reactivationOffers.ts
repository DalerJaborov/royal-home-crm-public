/**
 * СНЯТИЕ «ПРЕДЛОЖЕНИЯ РЕАКТИВАЦИИ» С АГЕНТА (07.09.2026, разведка «осиротевшие
 * спутники»).
 *
 * routes/clients/reactivationOffers.ts ставит Client.reactivationOfferedToAgentId
 * и ждёт решения ИМЕННО этого агента (accept/decline) — карточка при этом висит
 * без assignedAgentId, вне обычной очереди лидов, невидимая никому, кроме адресата.
 * До этой правки предложение оставалось закреплённым НАВСЕГДА: ни TTL, ни
 * снятия при заморозке/увольнении/уходе агента не было. Клиент, ушедший в Корзину
 * или Неактивные и написавший снова, мог выпасть из работы бесследно — до
 * первого случайного открытия списка «Предложения реактивации» тем самым агентом,
 * который мог быть уже неактивен.
 *
 * releaseReactivationOffer — общая логика снятия, используется:
 *  - routes/clients/reactivationOffers.ts (decline — агент решил сам);
 *  - expireStaleReactivationOffers (cron, TTL истёк — агент не решил вовсе);
 *  - routes/agents.ts (заморозка/увольнение — решать уже некому).
 *
 * acceptReactivationOffer — общая логика принятия (явного и по факту звонка,
 * см. ниже), используется:
 *  - routes/clients/reactivationOffers.ts (accept — агент нажал кнопку);
 *  - runReactivationOfferReminders (cron — агент уже позвонил клиенту сам).
 *
 * runReactivationOfferReminders (09.09.2026, замена PR #180 — ревью
 * docs/acceptance-08-09/PR180-review.md): PR #180 предлагал СВОЙ параллельный
 * механизм тайм-аута (жёсткие 48ч, отдельный получасовой крон), который решал
 * бы ту же задачу, что и TTL выше, ВТОРЫМ независимым таймером на тех же полях
 * — и не снимал предложение при заморозке/увольнении агента вовсе (регресс).
 * Источник истины по тайм-ауту остаётся ОДИН — reactivationOfferTtlHours и
 * hourly-крон ниже; из PR перенесены только две реально новые вещи (напоминания
 * агенту, авто-принятие по факту звонка), пересчитанные в проценты от TTL и
 * встроенные в тот же почасовой тик — без второго крона.
 */
import { prisma } from "../db.js";
import { logSystemAudit } from "./audit.js";
import { logSystemError } from "./systemError.js";
import { pickAgentForLead } from "../services/leads/selection.js";
import { sendPushToAgent, sendPushToAgents } from "../push.js";
import { findAgentsWithPermission } from "./recipients.js";
import { loadLeadLimits, activeLeadCounts, slotsTaken } from "./leadLimits.js";
import { changeClientAgent } from "./changeClientAgent.js";
import { publishClientUpdated } from "./livePublish.js";
import { loadOwnershipSnapshot, escalateInsteadOfTransfer } from "../services/leads/ownershipLoad.js";
import { hasContactAttempt } from "../services/leads/ownershipPolicy.js";
import { isWithinWorkingHours } from "./workingHours.js";

export type ReactivationReleaseReason = "declined" | "expired" | "agent_unavailable";

const REASON_NOTES: Record<ReactivationReleaseReason, string> = {
  declined: "Агент отклонил предложение реактивации",
  expired: "Предложение реактивации не решено вовремя (истёк срок)",
  agent_unavailable: "Прежний агент недоступен (заморожен/уволен) — предложение снято",
};

/**
 * Снимает предложение с одного клиента и раздаёт его по обычной очереди — та же
 * логика, что раньше жила только в decline-хендлере. `excludeAgentId` не даёт
 * тут же вернуть карточку тому же агенту, у которого её сняли.
 */
export async function releaseReactivationOffer(
  client: { id: string; shortId: number; fullName: string; kind: string },
  excludeAgentId: string,
  reason: ReactivationReleaseReason,
  /**
   * П-3/Р-5 (17.09.2026, `docs/audit/lead-ownership-17-09.md` §4). Заморозка/
   * увольнение — решение человека (руководитель нажал кнопку), не автоматика:
   * actorId идёт в аудит, как у обычного handover, и П-3 (контакт → не
   * передавать) здесь НЕ проверяется — агент больше не работает, держать за
   * ним клиента нельзя независимо от того, был разговор или нет. Для
   * "declined"/"expired" actorId не передают — это решает cron/сам агент.
   */
  actorId: string | null = null
): Promise<{ nextAgentId: string | null }> {
  const now = new Date();

  // «Прочее обращение» (кандидат на вакансию и т.п.) агенту не раздаётся вовсе —
  // ни прежнему, ни по очереди: pickAgentForLead ниже принял бы его за
  // покупателя. Предложение просто гаснет (02.10.2026).
  if (client.kind === "OTHER") {
    await dropOfferOfOtherInquiry(client.id, excludeAgentId);
    return { nextAgentId: null };
  }

  // П-3 (17.09.2026): контакт уже был — клиент НЕ уходит по очереди, остаётся у
  // прежнего держателя (excludeAgentId), решение о дальнейшей передаче — за
  // руководителем. Не проверяем при заморозке/увольнении (actorId задан) —
  // там держателя больше нет физически, это не «автопередача».
  //
  // ПРОДАВЕЦ НЕ УХОДИТ НИКОГДА (24.09.2026, ночная проверка «Владение, К-идея»,
  // решение владельца 16.09.2026 — «Продавец никогда не уходит. Даже если
  // агент в отпуске или на больничном»/«Только я могу передавать продавца или
  // покупателя в таких случаях. А не система», docs/resheniya-vladelca-16-18-09-2026.md
  // §1). Легальных случаев автопередачи всего три (лид не принят за 15 минут,
  // вернувшийся ПОКУПАТЕЛЬ при агенте в отпуске, увольнение) — просроченного/
  // отклонённого предложения реактивации среди них нет, и для продавца это
  // правило безусловное, в отличие от П-3 у покупателя (там нужен предыдущий
  // контакт). До этой правки продавец с непринятым предложением уходил
  // `pickAgentForLead` наравне с покупателем — таким же нарушением закона, как
  // П-3, только без спасающего условия «контакт уже был».
  if (reason !== "agent_unavailable") {
    const isSeller = client.kind === "SELLER";
    const snapshot = isSeller ? null : await loadOwnershipSnapshot(client.id);
    const staysWithHolder = isSeller || (snapshot != null && hasContactAttempt(snapshot));
    if (staysWithHolder) {
      const ruleNo = isSeller ? "продавец-не-уходит" : "П-3";
      const stayReason = isSeller
        ? `${REASON_NOTES[reason]} — продавец не уходит от агента автоматически ни при каких условиях (решение владельца 16.09.2026), клиент остаётся у прежнего агента`
        : `${REASON_NOTES[reason]} — контакт уже был, клиент остаётся у прежнего агента (П-3)`;
      await changeClientAgent({
        clientId: client.id,
        toAgentId: excludeAgentId,
        reason: stayReason,
        actorId: null,
        interactionAgentId: excludeAgentId,
        source: "reactivation.release",
        data: {
          reactivationOfferedToAgentId: null,
          reactivationOfferedAt: null,
          workStatus: "ACTIVE",
          assignedAt: now,
          acceptedAt: now,
        },
      });
      if (isSeller) {
        // Не переиспользуем escalateInsteadOfTransfer — её текст (маркер
        // хронологии и пуш руководству) жёстко называет «закон П-3» и
        // «контакт уже был», что для продавца без контакта было бы неправдой.
        // Само событие уже попало в хронологию через changeClientAgent выше
        // (Interaction с текстом stayReason) — руководству нужен только пуш,
        // что решение о дальнейшей судьбе карточки за ним.
        findAgentsWithPermission("clients.assign")
          .then((supervisors) =>
            sendPushToAgents(supervisors, {
              title: "⚠️ Продавец ждёт решения",
              body: `${client.fullName} — предложение реактивации не решено вовремя, но продавец не передаётся по очереди: решение о дальнейшем — за вами`,
              url: `/clients/${client.shortId}`,
              tag: `law-seller-stays-${client.id}`,
            })
          )
          .catch((err) => console.error("[push] продавец не уходит — уведомление руководству:", err));
      } else {
        await escalateInsteadOfTransfer({
          clientId: client.id,
          mechanism: "reactivation.release",
          reason: `${REASON_NOTES[reason]}: контакт с клиентом уже был, автопередача другому агенту запрещена`,
        });
      }
      logSystemAudit("REACTIVATION_RELEASE", "Client", client.id, {
        shortId: client.shortId,
        fullName: client.fullName,
        reason,
        reassignedTo: excludeAgentId,
        blockedByLaw: ruleNo,
      });
      publishClientUpdated({ clientId: client.id, agentIds: [excludeAgentId] });
      sendPushToAgent(excludeAgentId, {
        title: "🔁 Клиент вернулся к вам",
        body: isSeller
          ? `${client.fullName} — предложение снято по сроку, продавец не уходит от вас автоматически: клиент остаётся у вас`
          : `${client.fullName} — предложение снято по сроку, но контакт уже был: клиент остаётся у вас`,
        url: `/clients/${client.shortId}`,
        tag: `lead-${client.id}`,
      }).catch((err) => console.error("[push] возврат клиента держателю после закона о владении:", err));
      return { nextAgentId: excludeAgentId };
    }
  }

  const nextAgentId = await pickAgentForLead(excludeAgentId, client.kind === "SELLER" ? "SELLER" : "BUYER");

  await changeClientAgent({
    clientId: client.id,
    toAgentId: nextAgentId,
    reason: nextAgentId
      ? `${REASON_NOTES[reason]} — карточка передана по очереди`
      : `${REASON_NOTES[reason]} — свободных агентов не нашлось, ждёт назначения`,
    // agent_unavailable (заморозка/увольнение) — решение человека, actorId идёт
    // в аудит как у обычного handover; declined/expired — авто (cron/сам агент).
    actorId,
    interactionAgentId: nextAgentId ?? excludeAgentId,
    source: "reactivation.release",
    data: {
      reactivationOfferedToAgentId: null,
      reactivationOfferedAt: null,
      workStatus: "ACTIVE",
      assignedAt: now,
      acceptedAt: null,
    },
  });

  logSystemAudit("REACTIVATION_RELEASE", "Client", client.id, {
    shortId: client.shortId,
    fullName: client.fullName,
    reason,
    reassignedTo: nextAgentId,
  });

  // ПОСЛЕ коммита changeClientAgent выше (аудит 11.09.2026, второй заход по
  // осиротевшим спутникам, п.4 задания): предложение снято/передано —
  // прежний адресат должен увидеть, что предложения на его экране больше нет.
  publishClientUpdated({ clientId: client.id, agentIds: [excludeAgentId, nextAgentId] });

  if (nextAgentId) {
    sendPushToAgent(nextAgentId, {
      title: "🔔 Новый лид",
      body: `${client.fullName} — предложение реактивации снято с прежнего агента, лид передан вам`,
      url: `/clients/${client.shortId}`,
      tag: `lead-${client.id}`,
    }).catch((err) => console.error("[push] снятие предложения реактивации — новый агент:", err));
  } else {
    findAgentsWithPermission("clients.assign")
      .then((supervisors) =>
        sendPushToAgents(supervisors, {
          title: "⏳ Лид ждёт назначения",
          body: `${client.fullName} — предложение реактивации снято, назначьте агента вручную`,
          url: `/clients/${client.shortId}`,
          tag: `lead-unassigned-${client.id}`,
        })
      )
      .catch((err) => console.error("[push] снятие предложения реактивации без агента:", err));
  }

  return { nextAgentId };
}

/**
 * ПРЕДЛОЖЕНИЕ ПО «ПРОЧЕМУ ОБРАЩЕНИЮ» ГАСНЕТ, А НЕ ИСПОЛНЯЕТСЯ (02.10.2026).
 *
 * Карточка, ставшая OTHER (чаще всего — кандидат на вакансию,
 * lib/clientToCandidate.ts), агенту не принадлежит. Висевшее на ней предложение
 * реактивации возвращало её агенту двумя путями: кнопкой «Принять» и крон-
 * истечением, которое раздавало её по очереди как покупателя. Снимаем только
 * сами поля предложения — назначение не трогаем (его здесь и нет).
 */
async function dropOfferOfOtherInquiry(clientId: string, agentId: string): Promise<void> {
  await prisma.client.updateMany({
    where: { id: clientId, kind: "OTHER" },
    data: { reactivationOfferedToAgentId: null, reactivationOfferedAt: null },
  });
  logSystemAudit("REACTIVATION_RELEASE", "Client", clientId, { reason: "other_inquiry", agentId });
  publishClientUpdated({ clientId, agentIds: [agentId] });
}

/** Предложение вместе с проверкой, что решает именно адресат. */
export async function loadOwnOffer(clientId: string, agentId: string) {
  const client = await prisma.client.findUnique({ where: { id: clientId } });
  if (!client || client.deletedAt) return { ok: false as const, status: 404 as const, error: "Клиент не найден" };
  if (!client.reactivationOfferedToAgentId || !client.reactivationOfferedAt) {
    return { ok: false as const, status: 409 as const, error: "По этой карточке нет предложения реактивации" };
  }
  if (client.reactivationOfferedToAgentId !== agentId) {
    return { ok: false as const, status: 403 as const, error: "Это предложение адресовано другому агенту" };
  }
  // Второй рубеж: клиент уже у другого агента — предложение устарело, решать нечего.
  if (client.assignedAgentId && client.assignedAgentId !== agentId) {
    return { ok: false as const, status: 409 as const, error: "Клиента уже ведёт другой агент" };
  }
  return { ok: true as const, client };
}

/**
 * Принятие — явное (агент нажал «Принять», routes/clients/reactivationOffers.ts)
 * или фактическое (крон ниже увидел, что агент уже позвонил клиенту сам, не
 * дожидаясь кнопки). assignedAgentId ставим явно, а не полагаемся на то, что
 * он и так уже такой: для ветки «клиент вернулся из Корзины»
 * (services/leads/intake.ts) он был null, пока предложение висело.
 */
export async function acceptReactivationOffer(
  clientId: string,
  agentId: string,
  interactionNote = "Агент принял предложение реактивации — клиент вернулся в работу"
) {
  const outcome = await loadOwnOffer(clientId, agentId);
  if (!outcome.ok) return outcome;
  const { client } = outcome;
  if (client.kind === "OTHER") {
    await dropOfferOfOtherInquiry(client.id, agentId);
    return {
      ok: false as const,
      status: 409 as const,
      error: "Это уже не покупатель и не продавец (например, кандидат на вакансию) — предложение снято",
    };
  }

  const now = new Date();
  await changeClientAgent({
    clientId: client.id,
    toAgentId: agentId,
    reason: interactionNote,
    actorId: agentId,
    source: "reactivation.accept",
    data: {
      workStatus: "ACTIVE",
      assignedAt: now,
      // Явно принят этим же действием — иначе карточка осталась бы с закрытым
      // телефоном/почтой (см. presentClient: pendingAcceptance = acceptedAt===null).
      acceptedAt: client.acceptedAt ?? now,
      reactivationOfferedToAgentId: null,
      reactivationOfferedAt: null,
    },
  });

  // ПОСЛЕ коммита (аудит 11.09.2026, второй заход по осиротевшим спутникам,
  // п.4 задания): клиент принят — экран агента и надзора обновляются сразу.
  publishClientUpdated({ clientId: client.id, agentIds: [agentId] });

  // Тот же контроль портфеля, что у автоматической реактивации (intake.ts) — агент
  // мог согласиться на клиента, который вывел его портфель за лимит; решение о
  // разгрузке принимает руководитель, а не тишина (код-ревью 13.08.2026, тот же приём).
  void (async () => {
    try {
      const limits = await loadLeadLimits();
      if (limits.activeLimit <= 0) return;
      const counts = (await activeLeadCounts([agentId])).get(agentId);
      if (slotsTaken(counts, limits) <= limits.activeLimit) return;
      const supervisors = await findAgentsWithPermission("clients.assign");
      await sendPushToAgents(supervisors, {
        title: "⚠️ Портфель агента сверх лимита",
        body: `Реактивированный клиент №${client.shortId} довёл портфель агента выше настроенного лимита ${limits.activeLimit} — стоит разгрузить.`,
        url: `/clients/${client.shortId}`,
        tag: `over-limit-reactivation-accept-${client.id}`,
      });
    } catch (err) {
      console.error("[leads] уведомление о превышении лимита при реактивации:", err instanceof Error ? err.message : err);
    }
  })();

  return { ok: true as const, client };
}

/**
 * Крон (тот же почасовой тик, что у expireStaleReactivationOffers ниже — см.
 * cron.ts, один вызов сразу за другим): авто-принятие, если агент уже позвонил
 * клиенту сам (Interaction type CALL от этого же агента после
 * reactivationOfferedAt), не дожидаясь кнопки «Принять» — решение владельца,
 * перенесено из PR #180.
 *
 * Напоминание агенту («⏳ Вернувшийся клиент ждёт решения», пуш + строка в
 * ленте) УБРАНО — владелец 02.10.2026: напоминания про вернувшегося клиента не
 * нужны. Само предложение лежит в карточке клиента и в списке дел, срок снимает
 * expireStaleReactivationOffers. `reminded` в ответе оставлен (всегда 0) ради
 * вызывающего кода в cron.ts.
 *
 * Явные Принять/Отклонить сами снимают reactivationOfferedAt — этот тик их не
 * видит. SYSTEM-записи (сам пуш о предложении и т.п.) не считаются звонком.
 */
export async function runReactivationOfferReminders(): Promise<{ accepted: number; reminded: number }> {
  const pending = await prisma.client.findMany({
    // OTHER не напоминаем и не принимаем по звонку: такое предложение гасит
    // expireStaleReactivationOffers ниже (releaseReactivationOffer).
    where: {
      reactivationOfferedToAgentId: { not: null },
      reactivationOfferedAt: { not: null },
      deletedAt: null,
      kind: { not: "OTHER" },
    },
    select: {
      id: true,
      shortId: true,
      fullName: true,
      kind: true,
      reactivationOfferedToAgentId: true,
      reactivationOfferedAt: true,
    },
    take: 200,
  });
  if (pending.length === 0) return { accepted: 0, reminded: 0 };

  let accepted = 0;

  for (const client of pending) {
    const agentId = client.reactivationOfferedToAgentId!;
    const offeredAt = client.reactivationOfferedAt!;

    try {
      const calledByAgent = await prisma.interaction.findFirst({
        where: { clientId: client.id, agentId, type: "CALL", createdAt: { gt: offeredAt } },
        select: { id: true },
      });
      if (calledByAgent) {
        const outcome = await acceptReactivationOffer(
          client.id,
          agentId,
          "Агент уже позвонил клиенту сам — предложение реактивации засчитано принятым автоматически"
        );
        if (outcome.ok) {
          accepted++;
          logSystemAudit("REACTIVATION_AUTO_ACCEPT_CALL", "Client", client.id, {
            shortId: client.shortId,
            fullName: client.fullName,
            agentId,
          });
        }
        continue;
      }
    } catch (err) {
      void logSystemError(
        "api",
        `Авто-принятие предложения реактивации по звонку не выполнено (клиент ${client.shortId ?? client.id}): ${
          err instanceof Error ? err.message : err
        }`
      );
      continue;
    }
  }

  return { accepted, reminded: 0 };
}

/**
 * Крон: непринятые предложения старше reactivationOfferTtlHours снимаются сами.
 * Раз в час — тот же ритм, что у requirePropertySummaries (lib/pendingSummaries.ts),
 * достаточно часто для клиента и дёшево для базы.
 */
export async function expireStaleReactivationOffers(
  now = new Date(),
  /**
   * onlyWorkingHours — снимать только в часы раздачи (B10, 02.10.2026). Крон
   * почасовой и круглосуточный: предложение, истёкшее в 03:12, уходило агенту
   * по очереди ночью непринятым лидом (пуш глушат тихие часы), а в 09:30
   * карусель считала его «не принятым с ночи». Ночью ждём утра — как раздача
   * новых заявок. Крон передаёт true; без флага — прежнее поведение.
   */
  opts: { onlyWorkingHours?: boolean } = {}
): Promise<number> {
  if (opts.onlyWorkingHours && !(await isWithinWorkingHours(now))) return 0;
  const settings = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { reactivationOfferTtlHours: true },
  });
  const ttlHours = Math.max(1, settings?.reactivationOfferTtlHours ?? 24);
  const cutoff = new Date(now.getTime() - ttlHours * 3600_000);

  const stale = await prisma.client.findMany({
    where: { reactivationOfferedToAgentId: { not: null }, reactivationOfferedAt: { lte: cutoff }, deletedAt: null },
    select: { id: true, shortId: true, fullName: true, kind: true, reactivationOfferedToAgentId: true },
    take: 50,
  });

  let released = 0;
  for (const client of stale) {
    try {
      await releaseReactivationOffer(client, client.reactivationOfferedToAgentId!, "expired");
      released++;
    } catch (err) {
      void logSystemError(
        "api",
        `Просроченное предложение реактивации не снято (клиент ${client.shortId ?? client.id}): ${
          err instanceof Error ? err.message : err
        }`
      );
    }
  }
  return released;
}

/**
 * Заморозка/увольнение агента: адресат предложения больше не рабочий. Снимаем
 * СРАЗУ, не дожидаясь TTL — решать за него уже некому.
 */
export async function releaseReactivationOffersOfAgent(
  agentId: string,
  /** Кто заморозил/уволил — идёт в аудит как actorId (handover, не автоматика). */
  actorId: string | null = null
): Promise<number> {
  const offered = await prisma.client.findMany({
    where: { reactivationOfferedToAgentId: agentId, deletedAt: null },
    select: { id: true, shortId: true, fullName: true, kind: true },
  });
  let released = 0;
  for (const client of offered) {
    try {
      await releaseReactivationOffer(client, agentId, "agent_unavailable", actorId);
      released++;
    } catch (err) {
      void logSystemError(
        "api",
        `Предложение реактивации недоступного агента не снято (клиент ${client.shortId ?? client.id}): ${
          err instanceof Error ? err.message : err
        }`
      );
    }
  }
  return released;
}
