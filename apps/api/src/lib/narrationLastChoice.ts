import type { NarrationConfig } from "@royal-home/shared";
import { prisma } from "../db.js";

/**
 * ПОСЛЕДНИЙ ВЫБОР ОЗВУЧКИ СОТРУДНИКА (12.11.2026, решение владельца). Голос и шаблон, которые
 * агент выбрал сам, запоминаются на нём (Agent.narrationLastChoice). В следующий раз мастер
 * CRM, карточка и Шабнам ставят их заранее с подписью «последний раз выбран». Голос или шаблон
 * убрали из настроек — он просто не отдаётся, и действует общий по умолчанию.
 */
export type NarrationLastChoice = { voiceId?: string; templateId?: string };

export async function rememberNarrationChoice(agentId: string, choice: NarrationLastChoice): Promise<void> {
  if (!agentId || agentId === "system" || (!choice.voiceId && !choice.templateId)) return;
  const agent = await prisma.agent.findUnique({ where: { id: agentId }, select: { narrationLastChoice: true } });
  if (!agent) return;
  const previous = (agent.narrationLastChoice && typeof agent.narrationLastChoice === "object" && !Array.isArray(agent.narrationLastChoice) ? agent.narrationLastChoice : {}) as NarrationLastChoice;
  const next: NarrationLastChoice = { ...previous, ...(choice.voiceId ? { voiceId: choice.voiceId } : {}), ...(choice.templateId ? { templateId: choice.templateId } : {}) };
  if (next.voiceId === previous.voiceId && next.templateId === previous.templateId) return;
  await prisma.agent.update({ where: { id: agentId }, data: { narrationLastChoice: next } });
}

/** Последний выбор, если голос и шаблон всё ещё есть в настройках; иначе пусто (общий по умолчанию). */
export async function narrationLastChoiceFor(agentId: string | null | undefined, config: Pick<NarrationConfig, "voices" | "templates">): Promise<NarrationLastChoice> {
  if (!agentId || agentId === "system") return {};
  const agent = await prisma.agent.findUnique({ where: { id: agentId }, select: { narrationLastChoice: true } });
  const raw = (agent?.narrationLastChoice && typeof agent.narrationLastChoice === "object" && !Array.isArray(agent.narrationLastChoice) ? agent.narrationLastChoice : {}) as NarrationLastChoice;
  return {
    ...(raw.voiceId && config.voices.some((v) => v.id === raw.voiceId) ? { voiceId: raw.voiceId } : {}),
    ...(raw.templateId && (config.templates ?? []).some((t) => t.id === raw.templateId) ? { templateId: raw.templateId } : {}),
  };
}
