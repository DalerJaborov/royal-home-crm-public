import { loadPublicCommentSource, readPublicCommentPropertyFacts, readPublicSourceRow, publicCommentOrigin } from "./customerPublicCommentStore.js";
/** Read/proposal identity only; no delivery/moderation/action grant. */
import { customerPropertyFactsSchema, type CustomerPropertyFacts } from "@royal-home/shared";
import { projectPublicCommentCapabilities } from "./publicCommentCapabilities.js";
import { publicSourceRefSchema, serverPublicCommentSnapshotSchema } from "./publicCommentTypes.js";
import type { PublicCommentSourcePort, PublicHeldReason, PublicInstallation, PublicReadContext, PublicResult,
  PublicSourceRef, ServerPublicCommentSnapshot } from "./publicCommentTypes.js";
export { samePublicInstallation, publicCommentSourceDigest } from "./publicCommentSourceIdentity.js";
import { samePublicInstallation, publicCommentSourceDigest } from "./publicCommentSourceIdentity.js";
function validate(row: ServerPublicCommentSnapshot): PublicHeldReason | null {
  if (!["PENDING", "WORKING"].includes(row.status)) return "source_closed";
  if (!row.proof) return "origin_missing";
  const proof = row.proof, installed = row.currentInstallation;
  if (!installed) return "installation_missing";
  if ((row.target.channel === "TELEGRAM") !== (row.source.table === "telegram")) return "unsupported_channel";
  if (proof.source.id !== row.source.id || proof.source.table !== row.source.table ||
      proof.sourceRevision !== row.sourceRevision || proof.policyRevision !== row.settings.policyRevision || proof.digest !== publicCommentSourceDigest(row)) return "origin_changed";
  const expectedOrigin = row.target.channel === "TELEGRAM" ? "telegram_verified_discussion_update"
    : row.target.channel === "YOUTUBE" ? "youtube_own_channel_poll" : "meta_verified_comment";
  if (proof.origin !== expectedOrigin) return "origin_changed";
  if (!samePublicInstallation(proof.installation, installed) || installed.channel !== row.target.channel ||
      installed.resourceId !== row.target.accountExternalId) return "installation_changed";
  if (!projectPublicCommentCapabilities(row.target.channel, row.settings, "current").publicAgentReadReady) return "policy_off";
  return null;
}
function freezeSnapshot(row: ServerPublicCommentSnapshot): ServerPublicCommentSnapshot {
  const copy = structuredClone(row);
  Object.freeze(copy.source); Object.freeze(copy.target); Object.freeze(copy.settings);
  if (copy.currentInstallation) Object.freeze(copy.currentInstallation);
  if (copy.proof) { Object.freeze(copy.proof.source); Object.freeze(copy.proof.installation); Object.freeze(copy.proof); }
  return Object.freeze(copy);
}
function publicContext(row: ServerPublicCommentSnapshot): PublicReadContext {
  return Object.freeze({ source: Object.freeze({ ...row.source }), target: Object.freeze({ ...row.target }), text: row.text });
}
const principalBrand: unique symbol = Symbol("public_comment_principal");
export type PublicCommentPrincipal = Readonly<{ visibility: "public"; privateAuthorization: "none";
  source: PublicSourceRef; sourceRevision: string; installation: PublicInstallation;
  target: PublicReadContext["target"]; policyRevision: string }> & { readonly [principalBrand]: true };
/** Port bound ONCE by server composition; no request/model boolean, no caller-supplied read function. */
export function createPublicCommentSourceIssuer(port: PublicCommentSourcePort) {
  const issued = new WeakMap<object, ServerPublicCommentSnapshot>();
  async function loadRow(ref: PublicSourceRef): Promise<PublicResult<ServerPublicCommentSnapshot>> {
    if (!publicSourceRefSchema.safeParse(ref).success) return { status: "held", reason: "source_missing" };
    let raw: unknown; try { raw = await port.loadFromServer(ref); }
    catch { return { status: "held", reason: "snapshot_unavailable" }; }
    if (raw === null) return { status: "held", reason: "source_missing" };
    const parsed = serverPublicCommentSnapshotSchema.safeParse(raw);
    if (!parsed.success) return { status: "held", reason: "origin_changed" };
    const row = parsed.data;
    if (row.source.id !== ref.id || row.source.table !== ref.table) return { status: "held", reason: "origin_changed" };
    const reason = validate(row); return reason ? { status: "held", reason } : { status: "current", value: freezeSnapshot(row) };
  }
  async function load(ref: PublicSourceRef): Promise<PublicResult<PublicCommentPrincipal>> {
    const result = await loadRow(ref); if (result.status === "held") return result;
    const captured = result.value;
    if (!captured.currentInstallation) return { status: "held", reason: "installation_missing" };
    const principal = Object.freeze({ visibility: "public" as const, privateAuthorization: "none" as const,
      source: Object.freeze({ ...captured.source }), sourceRevision: captured.sourceRevision,
      installation: Object.freeze({ ...captured.currentInstallation }), target: Object.freeze({ ...captured.target }),
      policyRevision: captured.settings.policyRevision, [principalBrand]: true as const });
    issued.set(principal, captured); return { status: "current", value: principal };
  }
  async function revalidate(principal: PublicCommentPrincipal): Promise<PublicResult<PublicReadContext>> {
    const original = issued.get(principal); if (!original) return { status: "held", reason: "principal_unknown" };
    const result = await loadRow(original.source); if (result.status === "held") return result;
    const current = result.value;
    if (!current.currentInstallation || !original.currentInstallation || current.sourceRevision !== original.sourceRevision ||
        current.settings.policyRevision !== original.settings.policyRevision || publicCommentSourceDigest(current) !== publicCommentSourceDigest(original) ||
        !samePublicInstallation(current.currentInstallation, original.currentInstallation)) return { status: "held", reason: "origin_changed" };
    // Never expose the original mutable fence snapshot, and never adopt a newer revision.
    return { status: "current", value: publicContext(original) };
  }
  async function withPublicRead(principal: PublicCommentPrincipal, tool: string): Promise<PublicResult<CustomerPropertyFacts | null>> {
    if (tool !== "get_property_facts") return { status: "held", reason: "tool_denied" };
    const before = await revalidate(principal); if (before.status === "held") return before;
    const raw = await port.readPublicPropertyFacts(before.value);
    const parsed = customerPropertyFactsSchema.nullable().safeParse(raw);
    if (!parsed.success) return { status: "held", reason: "facts_unavailable" };
    const after = await revalidate(principal); if (after.status === "held") return after;
    return { status: "current", value: parsed.data };
  }
  return Object.freeze({ load, revalidate, withPublicRead,
    inspectOriginal: (principal: PublicCommentPrincipal): ServerPublicCommentSnapshot | null => issued.get(principal) ?? null });
}



/** Only this concrete DB-backed issuer may support the future P12 public send adapter.
 * Unit/custom ports do not become bot POST grants. Expired origin is still readable for audit in the store. */
const defaultPublicCommentIssuer = createPublicCommentSourceIssuer({
  loadFromServer: async ref => {
    const row = await readPublicSourceRow(ref); if (!row?.originCiphertext) return loadPublicCommentSource(ref);
    const origin = publicCommentOrigin(row), now = Date.now();
    if (now < origin.originalReceivedAt || now - origin.originalReceivedAt > 15 * 60_000 || now >= origin.agentPin.providerDeadlineAt) return null;
    return loadPublicCommentSource(ref);
  }, readPublicPropertyFacts: readPublicCommentPropertyFacts,
});
export const loadPublicCommentPrincipal = defaultPublicCommentIssuer.load;
export const revalidatePublicCommentPrincipal = defaultPublicCommentIssuer.revalidate;
export const readPublicCommentFacts = (principal: PublicCommentPrincipal) => defaultPublicCommentIssuer.withPublicRead(principal, "get_property_facts");
/** Server-only original snapshot, no model serialization or caller-controlled rebrand. */
export const inspectPublicCommentPrincipal = defaultPublicCommentIssuer.inspectOriginal;
