import { phoneSafeText } from "./clientPhone.js";
import { prisma, type TxClient } from "../db.js";
import { conductedShowingBaseWhere } from "./conductedShowing.js";
import { hasScenarioCallMark } from "./postShowingCalls.js";

/**
 * ДОСЬЕ К КНОПКЕ «ОДОБРИТЬ» — заявка на удаление объекта (порог 5 воронки,
 * docs/buyer-antifraud-funnel-13-09-2026.md).
 *
 * ДОСЛОВНО ВЛАДЕЛЕЦ (12.09.2026), и это вся причина существования файла: «я могу
 * по ошибке одобрить, не зная всей картины — агент расскажет, я одобрю. А система
 * знает всё, слышит всё и анализирует каждый день».
 *
 * Момент решения у владельца уже есть — очередь заявок в Архиве. Не хватает не
 * кнопки, а знания: объект снимают с продажи ровно там, где кончается след
 * возможной сделки мимо компании, и в эту же секунду человек жмёт «Одобрить»,
 * имея перед глазами только причину, которую написал сам агент.
 *
 * ЭТО НЕ ОБВИНЕНИЕ И НЕ БЛОКИРОВКА. Досье ничего не запрещает и никого не
 * помечает: оно кладёт рядом с заявкой факты, которые в базе и так есть, —
 * кому показывали, молчит ли покупатель после показа, отвечает ли собственник,
 * есть ли сделка. Решение остаётся человеческим.
 *
 * ВСЁ СЧИТАЕТСЯ ПАЧКОЙ, А НЕ ПО ОДНОЙ ЗАЯВКЕ. Очередь заявок — это список, и
 * запрос на каждую строку превратил бы экран в сотни обращений к базе (правило
 * проекта про N+1). Здесь пять запросов на любой размер списка.
 */

export interface PropertyDeleteDossier {
  /** Сколько покупателей реально приводили на объект. */
  showingsCount: number;
  exposuresCount: number;
  exposedBuyersCount: number;
  lastExposureAt: Date | null;
  lastShowingAt: Date | null;
  lastShowingAgentName: string | null;
  lastShowingClientName: string | null;
  lastShowingClientShortId: number | null;
  /** Покупатель после последнего показа так и не заговорил (по записи робозвонка). */
  buyerSilent: boolean;
  /** Собственник отвечал в CRM после последнего показа. null — карточки продавца нет. */
  sellerAnsweredAfterShowing: boolean | null;
  /** По объекту есть живая сделка — круг закрыт. */
  hasDeal: boolean;
  /** Чем кончилась проверка собственника, если она была. */
  sellerProbeOutcome: string | null;
  /** Готовые строки для экрана — по одной мысли в каждой. */
  lines: string[];
  /** Есть ли хоть что-то, из-за чего стоит задуматься перед «Одобрить». */
  hasConcerns: boolean;
}

/** Keep Dates intact while masking response text. */
export function presentPropertyDeleteDossier(dossier: PropertyDeleteDossier | null | undefined, canSeePhone: boolean) {
  if (!dossier) return null;
  return { ...dossier,
    lastShowingAgentName: phoneSafeText(dossier.lastShowingAgentName, canSeePhone),
    lastShowingClientName: phoneSafeText(dossier.lastShowingClientName, canSeePhone),
    sellerProbeOutcome: phoneSafeText(dossier.sellerProbeOutcome, canSeePhone),
    lines: dossier.lines.map(line => phoneSafeText(line, canSeePhone)),
  };
}

const OUTCOME_LABELS: Record<string, string> = {
  STILL_SELLING: "собственник подтвердил, что квартира ещё в продаже",
  SOLD_ELSEWHERE: "собственник сказал, что уже продал",
  OWNER_CHANGED_MIND: "собственник сказал, что передумал продавать",
  REFUSED: "собственник отказался разговаривать",
  UNCLEAR: "разговор с собственником ничего не прояснил",
};

function daysBetween(from: Date, to: Date): number {
  return Math.max(0, Math.floor((to.getTime() - from.getTime()) / 86_400_000));
}

export async function buildPropertyDeleteDossiers(
  propertyIds: string[],
  now: Date = new Date(),
  db: TxClient = prisma
): Promise<Map<string, PropertyDeleteDossier>> {
  const result = new Map<string, PropertyDeleteDossier>();
  if (propertyIds.length === 0) return result;

  const [showings, properties, deals, exposures] = await Promise.all([
    db.interaction.findMany({
      where: { propertyId: { in: propertyIds }, ...conductedShowingBaseWhere(now) },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        propertyId: true,
        nextActionDate: true,
        completedAt: true,
        createdAt: true,
        agent: { select: { fullName: true } },
        client: { select: { fullName: true, shortId: true } },
      },
    }),
    db.property.findMany({
      where: { id: { in: propertyIds } },
      select: { id: true, sellerClientId: true },
    }),
    db.deal.findMany({
      where: { propertyId: { in: propertyIds }, stage: { notIn: ["CANCELLED"] } },
      select: { propertyId: true },
    }),
    db.propertyExposure.findMany({ where: { propertyId: { in: propertyIds }, sentAt: { gte: new Date(now.getTime() - 30 * 86_400_000), lte: now } },
      select: { id: true, propertyId: true, clientId: true, sentAt: true }, orderBy: { sentAt: "desc" } }),
  ]);

  const showingIds = showings.map((s) => s.id);
  // Продавец читается отдельным запросом по строковому полю: внешнего ключа у
  // Property.sellerClientId в схеме нет, include по нему невозможен.
  const sellerIds = properties.map((p) => p.sellerClientId).filter((id): id is string => !!id);

  const [calls, sellers, probes] = await Promise.all([
    showingIds.length
      ? db.postShowingCall.findMany({
          where: { showingId: { in: showingIds } },
          select: { showingId: true, status: true, outcome: true, skipReason: true },
        })
      : Promise.resolve([]),
    sellerIds.length
      ? db.client.findMany({
          where: { id: { in: sellerIds } },
          select: { id: true, lastClientMessageAt: true },
        })
      : Promise.resolve([]),
    db.sellerProbeCall.findMany({
      where: { propertyId: { in: propertyIds }, outcome: { not: null } },
      orderBy: { createdAt: "desc" },
      select: { propertyId: true, outcome: true },
    }),
  ]);

  const callByShowing = new Map(calls.map((c) => [c.showingId, c]));
  const sellerById = new Map(sellers.map((s) => [s.id, s]));
  const sellerIdByProperty = new Map(properties.map((p) => [p.id, p.sellerClientId]));
  const dealProperties = new Set(deals.map((d) => d.propertyId));
  const probeByProperty = new Map<string, string>();
  for (const probe of probes) {
    if (!probeByProperty.has(probe.propertyId) && probe.outcome) probeByProperty.set(probe.propertyId, probe.outcome);
  }

  for (const propertyId of propertyIds) {
    const own = showings.filter((s) => s.propertyId === propertyId);
    const last = own
      .map((s) => ({ ...s, at: s.nextActionDate ?? s.completedAt ?? s.createdAt }))
      .sort((a, b) => b.at.getTime() - a.at.getTime())[0];

    const call = last ? callByShowing.get(last.id) : undefined;
    // «Молчит» — это именно неудавшийся опрос: не взял трубку, отказался или
    // разговор ничего не дал. Клиент, который всё объяснил («не подошла»), молчащим
    // не считается — там ничего не расследуют.
    // GIVEN_UP с пометкой «не тот человек» — не молчание покупателя (третий аудит 02.10.2026, В4).
    const buyerSilent =
      !!call &&
      ((call.status === "GIVEN_UP" && !hasScenarioCallMark(call.skipReason, "wrong_person")) ||
        ["REFUSED", "UNCLEAR"].includes(call.outcome ?? ""));

    const sellerId = sellerIdByProperty.get(propertyId) ?? null;
    const seller = sellerId ? sellerById.get(sellerId) : undefined;
    const sellerAnsweredAfterShowing =
      !seller || !last ? null : !!seller.lastClientMessageAt && seller.lastClientMessageAt > last.at;

    const hasDeal = dealProperties.has(propertyId);
    const sellerProbeOutcome = probeByProperty.get(propertyId) ?? null;

    const sent = exposures.filter(row => row.propertyId === propertyId);
    const exposedBuyersCount = new Set(sent.flatMap(row => row.clientId ? [row.clientId] : [])).size;
    const lines: string[] = [`Отправок за 30 дней: ${sent.length}, известных покупателей: ${exposedBuyersCount}. Отправка не подтверждает просмотр.`];
    if (own.length === 0) {
      lines.push("Показов по объекту не было ни одного.");
    } else {
      lines.push(
        `Показывали ${own.length} ${own.length === 1 ? "покупателю" : "покупателям"}, последний раз ` +
          `${daysBetween(last!.at, now)} дн. назад — вёл ${last!.agent?.fullName ?? "агент неизвестен"}.`
      );
      if (buyerSilent) {
        lines.push(`После того показа покупатель ${last!.client.fullName} так и не вышел на связь.`);
      }
      if (sellerAnsweredAfterShowing === false) {
        lines.push("Собственник после того же показа в CRM тоже не отвечал.");
      }
    }
    lines.push(hasDeal ? "По объекту есть сделка." : "Сделки по объекту нет.");
    if (sellerProbeOutcome) {
      lines.push(`Проверка звонком: ${OUTCOME_LABELS[sellerProbeOutcome] ?? sellerProbeOutcome}.`);
    }

    const hasConcerns =
      !hasDeal && (buyerSilent || sellerAnsweredAfterShowing === false || sellerProbeOutcome === "SOLD_ELSEWHERE");

    result.set(propertyId, {
      showingsCount: own.length,
      exposuresCount: sent.length, exposedBuyersCount, lastExposureAt: sent[0]?.sentAt ?? null,
      lastShowingAt: last?.at ?? null,
      lastShowingAgentName: last?.agent?.fullName ?? null,
      lastShowingClientName: last?.client.fullName ?? null,
      lastShowingClientShortId: last?.client.shortId ?? null,
      buyerSilent,
      sellerAnsweredAfterShowing,
      hasDeal,
      sellerProbeOutcome,
      lines,
      hasConcerns,
    });
  }

  return result;
}
