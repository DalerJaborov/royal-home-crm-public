import { customerMutationCommandSchema, type CustomerPropertyAdmission } from "@royal-home/shared";
import { prisma } from "../db.js";
import { extractAllPhones, normalizeDigits } from "../ai/leadQualifier.js";
import { stripUntrusted } from "../ai/untrustedContent.js";
import { sanitizeSpokenName } from "./spokenName.js";
import { inspectAuthenticatedCustomerInput, authenticatedInputMatchesFence, readVerifiedCustomerFinalOrigin, type AuthenticatedCustomerInput } from "./customerIngressAuthority.js";
import { loadAcceptedCustomerState, assertCustomerFence, transitionCustomerState, customerActionCapability } from "./customerState.js";
import { customerMutationDigest } from "./customerActionCommand.js";

const canonicalPhone = (value: string) => normalizeDigits(value.replace(/\D/g, ""));
const normalizedName = (value: string) => value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase();
/** Current-IN name requires an explicit self introduction. Bare/guessed names
 * stay clarification until a real delivery-backed name-question witness exists. */
function explicitlyStatedName(text: string, candidate: string): boolean {
  const matches = [...text.matchAll(/(?:^|[.!?\n]\s*)(?:меня\s+зовут|мо[её]\s+имя|номи\s+ман)\s*[:—-]?\s+([^.!?\n,;:\d]{1,160})/giu)];
  if (matches.length !== 1) return false;
  const stated = sanitizeSpokenName(matches[0][1]);
  return !!stated && normalizedName(stated) === normalizedName(candidate) &&
    normalizedName(sanitizeSpokenName(candidate) ?? "") === normalizedName(candidate);
}
const QUOTED_NEGATED_REPORTED_OR_FOREIGN = /[«»"“”]|(?<![\p{L}])(?:не|нет|чуж(?:ой|ого|ая|ие)|нест|намехоҳам|намехохам|нанависед|нагиред|прислал[\p{L}]*|получил[\p{L}]*|переслал[\p{L}]*|сказал[\p{L}]*|написал[\p{L}]*|цитат[\p{L}]*|гуфт(?:анд)?|фиристод(?:анд)?|навишт(?:анд)?|собственник[\p{L}]*|владел[\p{L}]*|агент[\p{L}]*|ри[еэ]лтор[\p{L}]*|мам[\p{L}]*|пап[\p{L}]*|друг[\p{L}]*|подруг[\p{L}]*|брата|сестры|его|е[её]|их|соҳиб[\p{L}]*|дигар[\p{L}]*|вай|ӯ)(?![\p{L}])/iu;
const VOLUNTEER_CONTACT = /(?<![\p{L}])(?:мой\s+(?:номер|телефон)|мои\s+контакты|телефон\s+для\s+связи|запишите|сохраните|рақами\s+ман|раками\s+ман|телефони\s+ман|сабт\s+кунед)(?![\p{L}])/iu;
/** Conservative current-IN statement, not just a phone substring. Failure
 * requests clarification; no model guess/history can make it eligible. */
export function currentInputVolunteersCustomerContact(rawText: string, rawCommand: unknown): boolean {
  const parsed = customerMutationCommandSchema.safeParse(rawCommand);
  if (!parsed.success || parsed.data.name !== "save_contact") return false;
  const text = stripUntrusted(rawText, ["document", "video", "crm_note"]).normalize("NFKC").trim(), command = parsed.data;
  if (!text || text.length > 8000 || QUOTED_NEGATED_REPORTED_OR_FOREIGN.test(text)) return false;
  const phones = [...new Set(extractAllPhones(text).map(canonicalPhone))];
  if (command.args.phone && (phones.length !== 1 || phones[0] !== canonicalPhone(command.args.phone) ||
      !(/^[+\d\s().\-–—]+$/u.test(text) || VOLUNTEER_CONTACT.test(text)))) return false;
  return !command.args.name || explicitlyStatedName(text, command.args.name);
}
/** Narrow dedicated issuer missing from current runtime. It records a contact
 * slot only; executor retains company/retired-number/CRM collision policies.
 * No phone/profile match grants Client/private identity or creates a resource. */
export async function openAuthenticatedCustomerContactIntent(input: AuthenticatedCustomerInput,
  ticket: CustomerPropertyAdmission, rawCommand: unknown): Promise<"opened" | "denied" | "stale" | "unavailable"> {
  const parsed = customerMutationCommandSchema.safeParse(rawCommand), evidence = inspectAuthenticatedCustomerInput(input);
  if (!parsed.success || parsed.data.name !== "save_contact" || !evidence || evidence.provenance !== "meta_signature" ||
      evidence.assurance !== "protected_namespace") return "denied";
  const command = parsed.data;
  if (!currentInputVolunteersCustomerContact(evidence.inputText, command)) return "denied";
  try {
    return await prisma.$transaction(async tx => {
      const accepted = await loadAcceptedCustomerState(ticket, tx);
      if (!accepted || !authenticatedInputMatchesFence(input, accepted.fence) || !customerActionCapability(accepted, "contact") ||
          evidence.channel !== accepted.fence.endpoint.channel || evidence.peer !== accepted.fence.endpoint.peerId ||
          evidence.protectedMetaEndpointScopeId !== accepted.fence.endpoint.endpointScopeId ||
          evidence.protectedMetaAccountId !== accepted.fence.endpoint.accountId) return "denied";
      const current = await assertCustomerFence(tx, accepted.fence, "local_write");
      if (current.status !== "current") return current.status;
      const origin = await readVerifiedCustomerFinalOrigin(tx, ticket.eventKey, true);
      const recorded = await tx.customerPropertyIngressTicket.findUnique({ where: { eventKey: ticket.eventKey }, select: { inputRecordedAt: true, processingState: true } });
      if (!origin || !recorded?.inputRecordedAt || !["RECEIVED", "CLAIMED", "HELD"].includes(recorded.processingState ?? "") ||
          origin.order !== ticket.order || origin.scopeKey !== ticket.scopeKey || origin.originalConversationId !== ticket.conversationId ||
          origin.input.inputText !== evidence.inputText || origin.input.eventId !== evidence.eventId || origin.input.eventKind !== evidence.eventKind ||
          origin.input.issuedAt !== evidence.issuedAt) return "denied";
      const result = await transitionCustomerState(tx, accepted.fence, { type: "intent", kind: "contact", change: "request",
        evidenceRefs: [ticket.eventKey], commandDigest: customerMutationDigest(command) });
      return result.status === "applied" || result.status === "same_event" ? "opened" : result.status;
    }, { maxWait: 3000, timeout: 5000 });
  } catch { return "unavailable"; }
}
