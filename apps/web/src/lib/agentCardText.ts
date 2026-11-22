import { daysOffSentenceRu } from "@royal-home/shared";
import type { AgentLive, AgentOverview } from "../hooks/useAgentOverview";
import type { TeamMember } from "../hooks/useTeam";
import { INTERACTION_TYPE_LABELS } from "./clientFormat";
import { absenceLabel } from "./absenceLabel";
import { relativeTime } from "./format";
import { dushanbeDateTime, dushanbeDayKey, dushanbeTime, dushanbeTodayKey } from "./date";
import { formatCallDuration } from "../components/CallDetails";

/**
 * ТЕКСТЫ КАРТОЧКИ СОТРУДНИКА — ОДНО МЕСТО (22.11.2026). Раньше жили внутри
 * pages/TeamMemberDetail.tsx; вынесены, чтобы старый вид страницы и «Новый вид»
 * (components/look/team/RoyalAgentCard.tsx) говорили одинаково и не делали цикл импортов.
 */
/** «с телефона»/«с компьютера» — сервер отдаёт `now.device` человекочитаемой
 *  строкой («Chrome · Windows», «Safari · iOS», см. apps/api/src/lib/device.ts),
 *  не литералом «MOBILE»/«DESKTOP»: различаем по ОС внутри строки. */
export function deviceKindLabel(device: string | null): string | null {
  if (!device) return null;
  return /ios|android/i.test(device) ? "с телефона" : "с компьютера";
}

/** Строка под именем в шапке: роль · онлайн/был(а) в сети · устройство ·
 *  отсутствие. Общая для ПК и телефона — блок 1 задания. */
export function headerSubtitle(roleLabel: string, live: AgentLive | undefined, member: TeamMember | undefined): string {
  const parts = [roleLabel];
  if (live) {
    parts.push(
      live.now.online
        ? "в сети"
        : live.now.lastSeenAt
          ? `был(а) в сети ${relativeTime(live.now.lastSeenAt)}`
          : "не в сети"
    );
    const device = deviceKindLabel(live.now.device);
    if (device) parts.push(device);
  }
  if (member?.frozen) parts.push(absenceLabel(member));
  else if (member && leadsPaused(member)) parts.push(`пауза заявок до ${dushanbeDateTime(member.leadsPausedUntil!)}`);
  // Личные выходные (11.10.2026) — одной строкой и на ПК, и на телефоне (подзаголовок общий).
  if (member?.weeklyDaysOff?.length) parts.push(daysOffSentenceRu(member.weeklyDaysOff));
  return parts.join(" · ");
}

/** Действующая пауза приёма лидов (своя или от руководителя), 24.09.2026. */
export function leadsPaused(member: TeamMember): boolean {
  return !!member.leadsPausedUntil && new Date(member.leadsPausedUntil).getTime() > Date.now();
}

/** Кнопку паузы видит руководитель у работающего агента: замороженному лиды и так не идут. */
export function canPauseLeads(member: TeamMember): boolean {
  return member.role === "AGENT" && member.isActive && !member.frozen;
}

export function elapsedLabel(fromIso: string | null): string {
  if (!fromIso) return "";
  const mins = Math.max(0, Math.round((Date.now() - new Date(fromIso).getTime()) / 60000));
  return mins < 1 ? "меньше минуты" : `${mins} мин`;
}

/** Блок «Сейчас», строка звонка. Живой звонок — ИЗ ПАМЯТИ (`now.call`):
 *  `null` значит «не на звонке прямо сейчас через CRM», а не «звонков не
 *  было» — эту разницу нельзя стирать (см. задание, 2.4, «Честность обязательна»). */
export function callHeadline(call: AgentLive["now"]["call"]): { text: string; clientShortId: number | null } | null {
  if (!call) return null;
  const name = call.clientName ?? "клиентом";
  const text = call.state === "talking" ? `Говорит с ${name} · ${elapsedLabel(call.answeredAt)}` : `Набирает ${name}`;
  return { text, clientShortId: call.clientShortId };
}

export function whenLabel(at: string): string {
  return dushanbeDayKey(at) === dushanbeTodayKey() ? `сегодня в ${dushanbeTime(at)}` : dushanbeDateTime(at);
}

export function nextTaskText(task: NonNullable<AgentLive["now"]["nextTask"]>): string {
  const title = task.title ?? INTERACTION_TYPE_LABELS[task.type] ?? "задача";
  return `Ближайшее: ${title} ${whenLabel(task.at)} — ${task.client.fullName}`;
}

export function lastActionText(i: AgentOverview["activity"]["recentInteractions"][number]): string {
  return `Последнее действие: ${INTERACTION_TYPE_LABELS[i.type] ?? i.type} · ${i.client.fullName} · ${relativeTime(i.createdAt)}`;
}

/** «Ждёт ответа»/«ответил бот»/ничего — чип строки переписки, блок 5. */
export function chatChip(lastFrom: "client" | "agent" | "bot"): { text: string; crit: boolean } | null {
  if (lastFrom === "client") return { text: "ждёт ответа", crit: true };
  if (lastFrom === "bot") return { text: "ответил бот", crit: false };
  return null;
}

export function callAttemptText(c: { callAttempt: string; durationSec: number | null }): string {
  if (c.callAttempt === "TALKED") return `поговорили ${formatCallDuration(c.durationSec)}`;
  if (c.callAttempt === "NO_ANSWER") return "клиент не ответил";
  if (c.callAttempt === "AGENT_NO_PICKUP") return "сам не снял трубку";
  if (c.callAttempt === "CANCELLED") return "звонок отменён";
  return "";
}

export function weekScoreTone(score: number): "ok" | "warn" | "crit" {
  if (score >= 70) return "ok";
  if (score >= 40) return "warn";
  return "crit";
}

/** `state`, который несут ссылки на карточку клиента: «назад» возвращает
 *  СЮДА, на карточку сотрудника, а не в общий список (блок 8-10 задания). */
export function backState(id: string, fullName: string) {
  return { from: `/team/${id}`, fromLabel: fullName };
}

