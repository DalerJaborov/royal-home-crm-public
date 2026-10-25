import { workingDaysBetween } from "./alarmCalendar.js";
import { loadCompanyDaysOff } from "./daysOffCalendar.js";
import { prisma } from '../db.js';
import { evaluateExposurePair, type ExposurePairFacts } from './exposurePairPolicy.js';
import { loadTrafficLightSettings } from './inactiveTrafficLight.js';
import { outagesBetween } from './stationOutage.js';

type Message = { role?: string; at?: string; by?: { kind?: string; agentId?: string; id?: string }; content?: string };
/** All observations are local persisted CRM evidence; no provider or model is called. */
export async function loadExposurePairEvidence(exposureId: string, now = new Date(), explained: boolean | null = null) {
  const exposure = await prisma.propertyExposure.findUnique({ where: { id: exposureId }, select: {
    id: true, clientId: true, propertyId: true, sentAt: true, channel: true,
  } });
  if (!exposure?.clientId || !exposure.propertyId) return null;
  const [buyer, property, settings] = await Promise.all([
    prisma.client.findUnique({ where: { id: exposure.clientId }, select: {
      id: true, assignedAt: true, assignedAgentId: true, deletedAt: true, lastClientMessageAt: true,
      assignedAgent: { select: { absenceUntil: true, weeklyDaysOff: true, isActive: true } },
    } }),
    prisma.property.findUnique({ where: { id: exposure.propertyId }, select: {
      id: true, shortId: true, sellerClientId: true, deletedAt: true, status: true,
    } }), loadTrafficLightSettings(),
  ]);
  if (!buyer || buyer.deletedAt || !buyer.assignedAgentId || !property?.sellerClientId) return null;
  const seller = await prisma.client.findUnique({ where: { id: property.sellerClientId }, select: {
    id: true, assignedAt: true, assignedAgentId: true, phone: true, deletedAt: true, lastClientMessageAt: true,
  } });
  if (!seller || seller.deletedAt || seller.id === buyer.id) return null;
  const from = new Date(exposure.sentAt.getTime() - 30 * 86_400_000);
  const clientIds = [buyer.id, seller.id];
  const [deals, withdrawal, calls, conversations, telegram, red, outages] = await Promise.all([
    prisma.deal.count({ where: { propertyId: property.id, stage: { not: 'CANCELLED' } } }),
    prisma.auditLog.findFirst({ where: { entityType: 'Property', entityId: property.id,
      action: 'PROPERTY_STATUS_CHANGED', meta: { path: ['becomes'], equals: property.status } },
      orderBy: { createdAt: 'desc' }, select: { id: true, createdAt: true } }),
    prisma.interaction.findMany({ where: { clientId: { in: clientIds }, investigationOnly: false, type: 'CALL',
      callAttempt: { in: ['TALKED', 'NO_ANSWER', 'CANCELLED'] }, createdAt: { gte: from, lte: now } },
      take: 1001, orderBy: { createdAt: 'desc' }, select: { id: true, clientId: true, agentId: true,
        createdAt: true, callAttempt: true, recordingDurationSec: true, recordingUrl: true } }),
    prisma.botConversation.findMany({ where: { clientId: { in: clientIds } }, take: 101,
      select: { id: true, clientId: true, messages: true } }),
    prisma.telegramConversation.findMany({ where: { clientId: { in: clientIds } }, take: 101,
      select: { id: true, clientId: true, messages: true } }),
    prisma.postShowingCall.count({ where: { agentId: buyer.assignedAgentId, status: 'DONE', quote: { not: null },
      outcome: { in: ['NO_MEETING', 'AGENT_COMPLAINT', 'BYPASS'] },
      talkedAt: { gte: new Date(now.getTime() - 90 * 86_400_000), lte: now } } }),
    outagesBetween(exposure.sentAt, now),
  ]);
  const buyerSpeech: Date[] = [], sellerSpeech: Date[] = [], agentSellerTouches: Date[] = [];
  const sourceIds: string[] = [];
  let coverage = calls.length <= 1000 && conversations.length <= 100 && telegram.length <= 100 && outages.length === 0;
  for (const conversation of [...conversations, ...telegram]) {
    const messages = Array.isArray(conversation.messages) ? conversation.messages as Message[] : [];
    for (const message of messages) {
      if (!message.at) { if (message.role === 'user' && !message.by) coverage = false; continue; }
      const at = new Date(message.at);
      if (!Number.isFinite(at.getTime()) || at < from || at > now) continue;
      if (message.role === 'user' && !message.by) {
        (conversation.clientId === buyer.id ? buyerSpeech : sellerSpeech).push(at);
        sourceIds.push(`message:${conversation.id}:${at.toISOString()}`);
      }
      // An agent-authored persisted message is distinct from bot/manual-manager replies.
      if (conversation.clientId === seller.id && message.by?.kind === 'agent'
        && (message.by.agentId ?? message.by.id) === buyer.assignedAgentId) agentSellerTouches.push(at);
    }
  }
  for (const call of calls) {
    if (call.callAttempt === 'TALKED' && call.recordingUrl
      && (call.recordingDurationSec ?? 0) >= settings.leadCallMinSeconds) {
      (call.clientId === buyer.id ? buyerSpeech : sellerSpeech).push(call.createdAt);
      sourceIds.push(`call:${call.id}`);
    }
    if (call.clientId === seller.id && call.agentId === buyer.assignedAgentId) agentSellerTouches.push(call.createdAt);
  }
  // Server-maintained inbound timestamp may be newer than bounded conversation history.
  if (buyer.lastClientMessageAt) buyerSpeech.push(buyer.lastClientMessageAt);
  if (seller.lastClientMessageAt) sellerSpeech.push(seller.lastClientMessageAt);
  const latest = (dates: Date[]) => dates.length ? new Date(Math.max(...dates.map(at => at.getTime()))) : null;
  const companyDaysOff = await loadCompanyDaysOff();
  const agentAvailable = !!buyer.assignedAgent?.isActive && !buyer.assignedAgent.absenceUntil
    && workingDaysBetween(exposure.sentAt, now, { companyDaysOff, agentDaysOff: buyer.assignedAgent.weeklyDaysOff }) > 0;
  const facts: ExposurePairFacts = {
    exposureId, buyerClientId: buyer.id, propertyId: property.id, sentAt: exposure.sentAt, assignedAt: buyer.assignedAt, now,
    sourceVerified: exposure.sentAt <= now, sourceCoverageKnown: coverage,
    lastBuyerSpeechAt: latest(buyerSpeech), buyerPauseExplained: explained,
    isOffMarket: property.deletedAt !== null || ['WITHDRAWN', 'SOLD'].includes(property.status),
    leftSaleAt: property.deletedAt ?? withdrawal?.createdAt ?? null, hasNonCancelledDeal: deals > 0,
    reserved: property.status === 'RESERVED', sellerSpeechBefore: sellerSpeech.some(at => at <= exposure.sentAt),
    sellerSpeechAfter: coverage ? sellerSpeech.some(at => at > exposure.sentAt) : null,
    agentStationOrDeliveryBefore: agentSellerTouches.some(at => at <= exposure.sentAt),
    agentStationOrDeliveryAfter: coverage ? agentSellerTouches.some(at => at > exposure.sentAt) : null,
    agentHadRedEvidence: red > 0, agentSilenceAvailable: agentAvailable && outages.length === 0,
  };
  return { exposure, buyer, seller, property, facts, decision: evaluateExposurePair(facts), sourceIds,
    withdrawalSourceId: withdrawal?.id ?? null };
}


