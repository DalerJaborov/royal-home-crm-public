import { Prisma } from "../generated/prisma/client.js";
import { customerRecruitmentPortfolioSchema } from "@royal-home/shared";
import type { StoredAttachment } from "../ai/client.js";
import { prisma } from "../db.js";
import { customerAgentClaimAcceptsPrincipal, customerAgentClaimCurrentTx, type CustomerAgentClaim } from "./customerAgentClaim.js";
import type { CustomerPrincipal } from "./customerPrincipal.js";
import { lockCustomerStateSnapshot, assertCustomerFence } from "./customerState.js";
import { privateFilePath } from "./privateFiles.js";

/** Files downloaded by the existing bounded loader. Keep them on the actual
 * current user ledger entry, never a model URL, assistant message or old peer. */
export async function recordCustomerRecruitmentAttachments(principal: CustomerPrincipal, claim: CustomerAgentClaim,
  files: StoredAttachment[]): Promise<void> {
  if (!files.length) return;
  if (!customerAgentClaimAcceptsPrincipal(claim, principal)) throw Error("Original media claim required");
  const checked = customerRecruitmentPortfolioSchema.parse(files.map(file => ({ ...file, sourceEventKey: claim.eventKey })));
  if (checked.some(file => !("file" in file) || !privateFilePath(file.file))) throw Error("Actual private file required");
  await prisma.$transaction(async tx => {
    const fence = principal.authority.fence;
    if (!await lockCustomerStateSnapshot(tx, { inquiryId: fence.inquiryId }) ||
        (await assertCustomerFence(tx, fence, "public_read")).status !== "current" ||
        !await customerAgentClaimCurrentTx(tx, claim)) throw Error("Original media controller changed");
    const row = await tx.botConversation.findUniqueOrThrow({ where: { id: principal.scope.conversationId }, select: { messages: true } });
    if (!Array.isArray(row.messages)) throw Error("Original user ledger unavailable");
    const matches = row.messages.filter(message => message && typeof message === "object" && !Array.isArray(message) &&
      message.role === "user" && message.customerPropertyAdmission && typeof message.customerPropertyAdmission === "object" &&
      !Array.isArray(message.customerPropertyAdmission) && message.customerPropertyAdmission.eventKey === claim.eventKey);
    if (matches.length !== 1) throw Error("Exact current user entry required");
    const target = matches[0] as Prisma.JsonObject;
    if (Array.isArray(target.attachments) && target.attachments.length) return; // original saved bytes win
    target.attachments = files as unknown as Prisma.JsonArray;
    await tx.botConversation.update({ where: { id: principal.scope.conversationId }, data: { messages: row.messages as Prisma.InputJsonValue } });
    if (!await customerAgentClaimCurrentTx(tx, claim)) throw Error("Original media claim changed");
  });
}
