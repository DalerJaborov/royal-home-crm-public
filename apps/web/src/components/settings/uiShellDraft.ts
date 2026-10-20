import { uiShellRolloutSchema, type UiShellRollout } from "@royal-home/shared";

export interface ShellDraft { baseline: UiShellRollout; value: UiShellRollout }
const PREFIX = "rh-shell-rollout-draft:";
const key = (actorId: string, epoch: number) => `${PREFIX}${encodeURIComponent(actorId)}:${epoch}`;

/** Account/session scoped: survives a gate remount, never becomes server authority. */
export function readShellDraft(actorId: string, epoch: number): ShellDraft | undefined {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(key(actorId, epoch)) ?? "null");
    const baseline = uiShellRolloutSchema.safeParse(parsed?.baseline);
    const value = uiShellRolloutSchema.safeParse(parsed?.value);
    return baseline.success && value.success ? { baseline: baseline.data, value: value.data } : undefined;
  } catch { return undefined; } // Storage can be disabled; the mounted form still works.
}

export function writeShellDraft(actorId: string, epoch: number, draft?: ShellDraft): void {
  try {
    const ownKey = key(actorId, epoch);
    // Remove drafts belonging to a previous login on this shared browser tab.
    for (let i = sessionStorage.length - 1; i >= 0; i--) {
      const storedKey = sessionStorage.key(i);
      if (storedKey?.startsWith(PREFIX) && storedKey !== ownKey) sessionStorage.removeItem(storedKey);
    }
    if (draft) sessionStorage.setItem(ownKey, JSON.stringify(draft));
    else sessionStorage.removeItem(ownKey);
  } catch { /* No storage permission: retain React state without bypassing step-up. */ }
}

/** Apply only locally changed fields/memberships to the newest server baseline. */
export function rebaseShellDraft(draft: ShellDraft, current: UiShellRollout): UiShellRollout {
  const membership = <T extends string>(before: T[], edited: T[], latest: T[]): T[] => {
    const removed = new Set(before.filter((item) => !edited.includes(item)));
    return [...new Set([...latest.filter((item) => !removed.has(item)), ...edited.filter((item) => !before.includes(item))])];
  };
  return {
    enabled: draft.value.enabled === draft.baseline.enabled ? current.enabled : draft.value.enabled,
    agentIds: membership(draft.baseline.agentIds, draft.value.agentIds, current.agentIds),
    roles: membership(draft.baseline.roles, draft.value.roles, current.roles),
  };
}
