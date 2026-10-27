import { prisma } from "../../db.js";
export class SomonRecipientError extends Error {}

/** Called only by an authorized settings endpoint. Preserve the explicit order;
 * unlinked agents may be configured but are not eligible until they link Telegram. */
export async function replaceSomonRecipients(agentIds: string[]): Promise<void> {
  if (agentIds.length > 100 || new Set(agentIds).size !== agentIds.length || agentIds.some(id => !id || id.length > 128)) {
    throw new SomonRecipientError("Invalid recipient list");
  }
  await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtext('somon-owner-delivery'))`;
    const count = await tx.agent.count({ where: { id: { in: agentIds }, role: "AGENT", isActive: true } });
    if (count !== agentIds.length) throw new SomonRecipientError("All recipients must be active agents");
    await tx.somonRecipient.deleteMany();
    if (agentIds.length) await tx.somonRecipient.createMany({ data: agentIds.map((agentId, position) => ({ agentId, position })) });
  }, { timeout: 35000 });
}
