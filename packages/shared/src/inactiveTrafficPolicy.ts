export interface InactiveTrafficPolicy {
  inactiveGreenPingHours: number;
  inactiveGreenMaxAttempts: number;
  inactiveYellowPingHours: number;
  inactiveYellowMaxAttempts: number;
  inactiveRedPingHours: number;
  inactiveRedMaxAttempts: number;
}

export const DEFAULT_INACTIVE_TRAFFIC_POLICY: Readonly<InactiveTrafficPolicy> = {
  inactiveGreenPingHours: 24,
  inactiveGreenMaxAttempts: 5,
  inactiveYellowPingHours: 48,
  inactiveYellowMaxAttempts: 2,
  inactiveRedPingHours: 36,
  inactiveRedMaxAttempts: 2,
};

/**
 * Число проверок по цвету светофора — константа с 01.11.2026 (значения прода),
 * на экране настроек остались только интервалы. Одно место на сервер и экран:
 * экран по нему же показывает срок до потери клиента.
 */
export const INACTIVE_TRAFFIC_MAX_ATTEMPTS: Readonly<Pick<InactiveTrafficPolicy,
  "inactiveGreenMaxAttempts" | "inactiveYellowMaxAttempts" | "inactiveRedMaxAttempts">> = {
  inactiveGreenMaxAttempts: 2,
  inactiveYellowMaxAttempts: 2,
  inactiveRedMaxAttempts: 2,
};

/** The last check is followed by one response interval before loss. */
export function inactiveTrafficHours(policy: InactiveTrafficPolicy, color: "Green" | "Yellow" | "Red"): number {
  return policy[`inactive${color}PingHours`] * (policy[`inactive${color}MaxAttempts`] + 1);
}

/** Repair inverted legacy settings by extending warmer levels only.
 * No current client gets an earlier loss deadline when this policy is loaded.
 * Partial/invalid form values are left for normal input validation.
 */
export function normalizeInactiveTrafficPolicy(policy: InactiveTrafficPolicy): InactiveTrafficPolicy {
  const next: InactiveTrafficPolicy = {
    inactiveGreenPingHours: policy.inactiveGreenPingHours, inactiveGreenMaxAttempts: policy.inactiveGreenMaxAttempts,
    inactiveYellowPingHours: policy.inactiveYellowPingHours, inactiveYellowMaxAttempts: policy.inactiveYellowMaxAttempts,
    inactiveRedPingHours: policy.inactiveRedPingHours, inactiveRedMaxAttempts: policy.inactiveRedMaxAttempts,
  };
  if (!Object.values(next).every((value) => Number.isFinite(value) && value > 0)) return next;
  next.inactiveYellowPingHours = Math.max(next.inactiveYellowPingHours,
    Math.ceil(inactiveTrafficHours(next, "Red") / (next.inactiveYellowMaxAttempts + 1)));
  next.inactiveGreenPingHours = Math.max(next.inactiveGreenPingHours,
    Math.ceil(inactiveTrafficHours(next, "Yellow") / (next.inactiveGreenMaxAttempts + 1)));
  return next;
}
