import { AsyncLocalStorage } from "node:async_hooks";
import { canViewInvestigations } from "@royal-home/shared";
import type { Prisma } from "../generated/prisma/client.js";

/** Producer identities, not a keyword search over customer/error narrative. */
export const PRIVATE_CRON_NAMES = [
  "post-showing-call", "seller-probe-call", "owner-exposure-verification-preview",
  "approved-owner-verification", "weekly-security-review-digest",
  "agent-off-crm-alarm", "seller-property-missing", "seller-control-episodes",
] as const;
const privateNames = new Set<string>(PRIVATE_CRON_NAMES);
const operationContext = new AsyncLocalStorage<boolean>();
export function isPrivateCron(name: string): boolean { return privateNames.has(name); }
export function withInvestigationPrivacy<T>(privateOperation: boolean, work: () => T): T {
  // A nested generic operation cannot declassify its private parent.
  return operationContext.run(privateOperation || isPrivateOperation(), work);
}
export function withCronPrivacy<T>(name: string, work: () => T): T {
  return withInvestigationPrivacy(isPrivateCron(name), work);
}
export function isPrivateOperation(): boolean { return operationContext.getStore() === true; }
export function visibleCronWhere(role?: string | null): Prisma.CronHeartbeatWhereInput {
  return canViewInvestigations(role) ? {} : { name: { notIn: [...PRIVATE_CRON_NAMES] } };
}
/** Also scopes historical errors produced by the exact cron wrapper signatures. */
export function visibleSystemErrorWhere(role?: string | null): Prisma.ErrorLogWhereInput {
  if (canViewInvestigations(role)) return {};
  return { NOT: { OR: [
    { source: "investigation" },
    { AND: [{ dedupKey: { not: null } }, { dedupKey: { in: ["seller-probe-originate", "post-showing-originate"] } }] },
    { source: "telephony", message: { startsWith: "Проверка продавца: станция не приняла набор" } },
    { source: "telephony", message: { startsWith: "Опрос после показа: станция не приняла набор" } },
    { source: "ai", message: { startsWith: "Проверка СБ по находке аудита (клиент " } },
    ...PRIVATE_CRON_NAMES.flatMap((name) => [
      { source: "cron", message: { startsWith: `Крон «${name}»` } },
      { source: "cron", message: { startsWith: `Крон-тик «${name}»` } },
      { source: "cron", AND: [{ dedupKey: { not: null } }, { dedupKey: { startsWith: `cron-row:${name}:` } }] },
    ]),
  ] } };
}
