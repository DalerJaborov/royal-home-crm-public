import { prisma } from "../db.js";
import { sendPushToAgent } from "../push.js";
import { findUnacceptedLeadsOfAgent, releaseLeadsToQueue, type ReleasableLead } from "./agentLeadRelease.js";
import { dushanbeWallClock } from "./dushanbeTime.js";

/**
 * ПАУЗА ПРИЁМА ЛИДОВ — одно место для обоих путей: агент сам в профиле
 * (routes/me.ts, POST /me/lead-pause) и руководитель в карточке сотрудника
 * (routes/agents.ts, POST /agents/:id/lead-pause, 24.09.2026, владелец:
 * «админу и директору тоже кнопку… чтобы отдохнуть в тот день»).
 *
 * Чем пауза отличается от заморозки — см. шапку lib/agentAvailability.ts:
 * агент на месте, текущие клиенты и звонки остаются у него, KPI идёт как
 * обычно; закрывается только вход новых лидов.
 *
 * НЕПРИНЯТЫЕ ЛИДЫ ВОЗВРАЩАЮТСЯ В РАЗДАЧУ (24.09.2026). До этого включённая пауза
 * останавливала только НОВЫЕ назначения, а лиды, выданные за минуту до неё и ещё
 * не принятые, висели на человеке, который сегодня к ним не подойдёт, — пока круг
 * «не принял» не уводил их по одному. Это то же правило, что у заморозки и
 * отключения учётки (lib/agentLeadRelease.ts), с одним исключением: лид по
 * СВОЕМУ объекту остаётся — правило «свой объект» паузу переживает
 * (services/leads/assignment.ts).
 *
 * КТО СНИМАЕТ. Свою паузу агент снимает сам. Паузу руководителя — только
 * руководитель (leadsPausedById), иначе кнопка руководителя ничего бы не значила.
 */

export interface StartPauseInput {
  agentId: string;
  until: Date;
  /** Кто ставит: сам агент или руководитель. */
  actor: { id: string; fullName: string };
  /** true — ставит руководитель; пауза запоминает его и причину. */
  bySupervisor: boolean;
  reason?: string | null;
}

export async function startLeadPause(input: StartPauseInput): Promise<{ released: number }> {
  const toRelease = await findUnacceptedLeadsOfAgent(input.agentId, "Пауза приёма лидов", { keepOwnProperty: true });
  const reason = input.reason?.trim() || null;
  const why = input.bySupervisor
    ? `Руководитель ${input.actor.fullName} поставил агенту паузу приёма лидов${reason ? `: «${reason}»` : ""} — лид возвращён в очередь`
    : "Агент включил паузу приёма лидов — непринятый лид возвращён в очередь";

  let released: ReleasableLead[] = [];
  await prisma.$transaction(async (tx) => {
    await tx.agent.update({
      where: { id: input.agentId },
      data: {
        leadsPausedUntil: input.until,
        leadsPausedById: input.bySupervisor ? input.actor.id : null,
        leadsPausedReason: input.bySupervisor ? reason : null,
      },
    });
    released = await releaseLeadsToQueue(tx, toRelease, {
      agentId: input.agentId,
      actorId: input.actor.id,
      actorName: input.actor.fullName,
      reason: why,
      source: "lead-pause",
    });
  });
  return { released: released.length };
}

/**
 * Снять паузу раньше срока. «Остыть» (leadsPausedEndedAt) отсчитывается только
 * от СВОЕЙ паузы агента: пауза руководителя — не просьба агента, и запрещать ему
 * после неё сутки брать собственную паузу было бы наказанием за чужое решение.
 */
export async function endLeadPause(agent: { id: string; leadsPausedById: string | null }): Promise<void> {
  await prisma.agent.update({
    where: { id: agent.id },
    data: {
      leadsPausedUntil: null,
      leadsPausedById: null,
      leadsPausedReason: null,
      ...(agent.leadsPausedById ? {} : { leadsPausedEndedAt: new Date() }),
    },
  });
}

/** «25.09 в 18:00» по Душанбе — для пуша агенту. Год добавляется, только если не текущий. */
export function pauseUntilLabel(until: Date, now = new Date()): string {
  const w = dushanbeWallClock(until);
  const pad = (n: number) => String(n).padStart(2, "0");
  const sameYear = w.getUTCFullYear() === dushanbeWallClock(now).getUTCFullYear();
  const date = `${pad(w.getUTCDate())}.${pad(w.getUTCMonth() + 1)}${sameYear ? "" : `.${w.getUTCFullYear()}`}`;
  return `${date} в ${pad(w.getUTCHours())}:${pad(w.getUTCMinutes())}`;
}

/** Агенту — что руководитель сделал с его приёмом лидов. Отказ пуша не роняет действие. */
export function notifyAgentAboutSupervisorPause(
  agentId: string,
  actorName: string,
  pause: { until: Date; reason?: string | null } | null
): void {
  const payload = pause
    ? {
        title: "Новые лиды вам временно не выдаются",
        body: `${actorName} поставил паузу до ${pauseUntilLabel(pause.until)}.${pause.reason?.trim() ? ` Причина: ${pause.reason.trim()}.` : ""} Текущие клиенты остаются у вас.`,
      }
    : { title: "Вы снова в раздаче лидов", body: `${actorName} снял паузу: новые лиды снова идут к вам.` };
  void sendPushToAgent(agentId, { ...payload, url: "/profile", tag: `lead-pause-${agentId}` }).catch((err) =>
    console.error("[lead-pause] пуш агенту не отправлен:", err)
  );
}
