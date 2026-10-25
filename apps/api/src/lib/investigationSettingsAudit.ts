import { prisma } from "../db.js";

export const PRIVATE_SETTINGS_FIELDS = ["postShowingCallEnabled", "investigationCaseConfig", "sellerControlConfig", "postShowingCohortConfig", "buyerSellerAutomationMode"] as const;
const privateFields = new Set<string>(PRIVATE_SETTINGS_FIELDS);
const controlLabels: Record<string, string> = { postShowingCallEnabled: "Опрос после показа", liveVoiceEnabled: "Голосовые проверки", buyerSellerAutomationMode: "Рабочее исполнение проверок", sellerControlConfig: "Контроль работы с продавцом" };
export function isPrivateSettingsField(field: string): boolean { return privateFields.has(field); }
export function disabledInvestigationControls(before: Record<string, unknown> | null, after: Record<string, unknown>): string[] {
  if (!before) return [];
  return [
    ...(before.postShowingCallEnabled === true && after.postShowingCallEnabled === false ? ["postShowingCallEnabled"] : []),
    ...(before.liveVoiceEnabled === true && after.liveVoiceEnabled === false && (before.postShowingCallEnabled === true || before.buyerSellerAutomationMode === "LIVE") ? ["liveVoiceEnabled"] : []),
    ...(before.buyerSellerAutomationMode === "LIVE" && after.buyerSellerAutomationMode !== undefined && after.buyerSellerAutomationMode !== "LIVE" ? ["buyerSellerAutomationMode"] : []),
    ...(before.sellerControlConfig != null && after.sellerControlConfig === null ? ["sellerControlConfig"] : []),
  ];
}
/** One atomic receipt per explicit transition; no startup/backfill scan, push or provider call. */
export async function saveWithInvestigationControlAudit<T>(
  data: Record<string, unknown>, actor: { id: string; name: string },
  save: (db: Pick<typeof prisma, "settings">) => Promise<T>,
): Promise<T> {
  if (![...PRIVATE_SETTINGS_FIELDS, "liveVoiceEnabled"].some(key => key in data)) return save(prisma);
  return prisma.$transaction(async tx => {
    // Serializes both PATCH and restore, including first creation of singleton.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('investigation-settings-transition'))`;
    const before = await tx.settings.findUnique({ where: { id: "singleton" } });
    const saved = await save(tx);
    const controls = disabledInvestigationControls(before as Record<string, unknown> | null, data);
    if (controls.length) await tx.auditLog.create({ data: {
      action: "INVESTIGATION_CONTROL_DISABLED", entityType: "InvestigationControl", entityId: "singleton",
      agentId: actor.id, agentName: actor.name,
      meta: { controls, title: controls.map(control => controlLabels[control] ?? control).join(", "), status: "CLOSED_PREVIEW", externalDelivery: "NOT_REQUESTED" },
    } });
    return saved;
  });
}
