import { prisma } from "../db.js";
import { canViewInvestigations } from "@royal-home/shared";

/** Scenario classification is stored by the owning job, not LiveVoiceSession. */
export async function investigationCallChannelIds(): Promise<string[]> {
  const [buyers, sellers, legacy] = await Promise.all([
    prisma.postShowingCall.findMany({ where: { channelId: { not: null } }, select: { channelId: true } }),
    prisma.sellerProbeCall.findMany({ where: { channelId: { not: null } }, select: { channelId: true } }),
    prisma.showingSurveyCall.findMany({ where: { channelId: { not: null } }, select: { channelId: true } }),
  ]);
  return [...new Set([...buyers, ...sellers, ...legacy].flatMap((r) => r.channelId ? [r.channelId] : []))];
}

export async function isInvestigationCallChannel(channelId: string): Promise<boolean> {
  const rows = await Promise.all([
    prisma.postShowingCall.findFirst({ where: { channelId }, select: { id: true } }),
    prisma.sellerProbeCall.findFirst({ where: { channelId }, select: { id: true } }),
    prisma.showingSurveyCall.findFirst({ where: { channelId }, select: { id: true } }),
  ]);
  return rows.some(Boolean);
}

export async function mayReadLiveVoiceSession(role: string | null | undefined, session: { channelId: string; investigationOnly: boolean }): Promise<boolean> {
  if (canViewInvestigations(role)) return true;
  if (session.investigationOnly) return false;
  return !(await isInvestigationCallChannel(session.channelId));
}
