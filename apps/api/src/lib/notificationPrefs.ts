import { ALWAYS_ON_KINDS, PUSH_KINDS, isMutablePushKind, type PushKind } from "@royal-home/shared";
import { prisma } from "../db.js";

/**
 * ЛИЧНЫЕ ОТКЛЮЧЕНИЯ ВИДОВ СООБЩЕНИЙ — ОДНА ДВЕРЬ (владелец 10.11.2026).
 *
 * «Любое сообщение или уведомление… если агент или директор, или ещё кто-то
 * пишет, что не отправляй мне такое, то оно отключается». Отключение одно на
 * человека и на все каналы: push CRM (push.ts::isMuted), сообщения помощницы в
 * Telegram (telegram/staffNotice.ts) и тумблеры профиля (routes/push.ts) читают
 * и пишут ТОЛЬКО через этот модуль — и одно поле `Agent.pushMuted`.
 *
 * Неотключаемые виды (ALWAYS_ON_KINDS, сейчас — безопасность) сюда не
 * записываются никогда: setKindMuted отвечает отказом с причиной, а не молча.
 */

export interface KindPreference {
  key: PushKind;
  label: string;
  hint: string;
  enabled: boolean;
}

export interface PreferencesView {
  kinds: KindPreference[];
  alwaysOn: typeof ALWAYS_ON_KINDS;
}

export function preferencesView(muted: readonly string[]): PreferencesView {
  return {
    kinds: PUSH_KINDS.map((k) => ({ ...k, enabled: !muted.includes(k.key) })),
    alwaysOn: ALWAYS_ON_KINDS,
  };
}

export async function mutedKindsOf(agentId: string): Promise<string[]> {
  const agent = await prisma.agent.findUnique({ where: { id: agentId }, select: { pushMuted: true } });
  return agent?.pushMuted ?? [];
}

/** Выключен ли этот вид у человека. Неотключаемый вид не выключен никогда. */
export function isKindMuted(kind: string | null | undefined, muted: readonly string[] | null | undefined): boolean {
  return Boolean(kind && isMutablePushKind(kind) && muted?.includes(kind));
}

export type SetMutedResult =
  | { ok: true; changed: boolean; view: PreferencesView }
  | { ok: false; reason: "always-on"; why: string; label: string }
  | { ok: false; reason: "unknown" };

/**
 * Выключить или включить вид. Атомарно на уровне строки: массив меняется
 * одним UPDATE с выражением, а не «прочитал — дописал — записал», чтобы
 * нажатие в Telegram и тумблер в профиле в ту же секунду не затёрли друг друга.
 */
export async function setKindMuted(agentId: string, kind: string, muted: boolean): Promise<SetMutedResult> {
  const always = ALWAYS_ON_KINDS.find((k) => k.key === kind);
  if (always) return { ok: false, reason: "always-on", why: always.why, label: always.label };
  if (!isMutablePushKind(kind)) return { ok: false, reason: "unknown" };
  const before = await mutedKindsOf(agentId);
  const had = before.includes(kind);
  if (muted && !had) {
    await prisma.$executeRaw`UPDATE "Agent" SET "pushMuted" = array_append("pushMuted", ${kind}) WHERE "id" = ${agentId} AND NOT (${kind} = ANY("pushMuted"))`;
  } else if (!muted && had) {
    await prisma.$executeRaw`UPDATE "Agent" SET "pushMuted" = array_remove("pushMuted", ${kind}) WHERE "id" = ${agentId}`;
  }
  const after = await mutedKindsOf(agentId);
  return { ok: true, changed: had !== muted, view: preferencesView(after) };
}

export function kindLabel(kind: string): string {
  return PUSH_KINDS.find((k) => k.key === kind)?.label ?? ALWAYS_ON_KINDS.find((k) => k.key === kind)?.label ?? kind;
}
