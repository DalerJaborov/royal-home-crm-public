// Prepared, not run on prod (13.11.2026): the relabel script marks ONLY old
// CORE-pinned rows whose decrypted payload is our echo, writes the backup
// first, never touches the revision or in-flight rows, and can be undone.
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { encryptSecret } from "../src/crypto.js";
import { ensureCustomerEndpoint } from "../src/lib/customerConversationScope.js";
import { encryptCustomerIngressPayload, customerIngressPayloadHash, type CustomerNormalizedIngressInput } from "../src/lib/customerIngressPayload.js";
import { customerPropertyEventKey, customerPropertyScopeKey } from "../src/lib/customerPropertyScope.js";
import { createCustomerAgentProviderSnapshot } from "../src/ai/customerAgentProviderConfig.js";
import { registerCurrentCustomerAgentRevision } from "../src/lib/customerAgentRegistration.js";
import { relabelHistoricalEchoTickets, restoreHistoricalEchoTickets } from "../src/ops/relabelHistoricalEchoTickets.js";

const tag = `echo-relabel-${randomUUID()}`, accountId = randomUUID(), externalId = `${tag}-installation`, peer = `${tag}-peer`;
let scopeId = "", revisionId = "";
const keys: Record<"echo" | "customer" | "inflight", string> = { echo: "", customer: "", inflight: "" };

async function pinnedRow(kind: keyof typeof keys, providerEcho: boolean, processingState: string, errorCode: string | null) {
  const eventId = `${tag}-${kind}`;
  const scopeKey = customerPropertyScopeKey("INSTAGRAM", peer, accountId, scopeId);
  const eventKey = customerPropertyEventKey(scopeKey, "message", eventId);
  const payload: CustomerNormalizedIngressInput = { version: 1, channel: "INSTAGRAM", peer, accountExternalId: externalId, eventKind: "message",
    eventId, inputText: providerEcho ? "Мы написали первыми" : "Клиент спрашивает", source: { path: "$.entry[0].messaging[0]",
      frameHash: createHash("sha256").update(eventId).digest("hex") },
    observations: { providerEcho, referralOnly: false, classifier: { version: 1, bareTemplateEcho: false } }, media: [], propertyEvidence: [] };
  const payloadHash = customerIngressPayloadHash(payload);
  // Payload and order are immutable after insert (trigger), so they are bound before it.
  const [{ order }] = await prisma.$queryRaw<Array<{ order: bigint }>>`SELECT nextval('"CustomerPropertyIngressTicket_order_seq"') AS "order"`;
  const ciphertext = encryptCustomerIngressPayload({ version: 1, eventKey, order: order.toString(), scopeKey, endpointScopeId: scopeId, payloadHash },
    payload, { version: 1, classification: "PENDING_ENVELOPE", provenance: "meta_signature", assurance: "protected_namespace",
      issuerSource: "account_secret", accountId, endpointScopeId: scopeId, scopeRevision: "0", policyRevision: "0",
      issuedAt: Date.now(), source: payload.source, verifierCredential: null });
  await prisma.customerPropertyIngressTicket.create({ data: { eventKey, order, scopeKey, endpointScopeId: scopeId, eventKind: "message",
    payloadVersion: 1, payloadCiphertext: ciphertext, payloadHash, processingState, errorCode, intakeAgentRevisionId: revisionId } });
  keys[kind] = eventKey;
}
const state = async (kind: keyof typeof keys) => prisma.customerPropertyIngressTicket.findUniqueOrThrow({ where: { eventKey: keys[kind] },
  select: { errorCode: true, processingState: true, intakeAgentRevisionId: true } });

beforeAll(async () => {
  await prisma.messengerAccount.create({ data: { id: accountId, channel: "INSTAGRAM", externalId, title: "Synthetic relabel",
    username: `relabel_${accountId.replaceAll("-", "")}`, enabled: true, token: encryptSecret(`${tag}-token`), appSecret: encryptSecret(`${tag}-secret`) } });
  scopeId = (await prisma.$transaction(tx => ensureCustomerEndpoint(tx, { channel: "INSTAGRAM", subscriberId: peer, accountId, accountExternalId: externalId }))).endpointScopeId;
  revisionId = (await registerCurrentCustomerAgentRevision(createCustomerAgentProviderSnapshot())).id;
  await pinnedRow("echo", true, "HELD", "pending_verifier_or_age_stale");
  await pinnedRow("customer", false, "HELD", "pending_verifier_or_age_stale");
  await pinnedRow("inflight", true, "RECEIVED", null);
});
afterAll(async () => {
  await prisma.customerPropertyIngressTicket.deleteMany({ where: { endpointScopeId: scopeId } });
  await prisma.customerEndpointScope.deleteMany({ where: { id: scopeId } });
  await prisma.messengerAccount.deleteMany({ where: { id: accountId } });
});

it("dry run reports only the old echo, apply backs up first and relabels it, restore undoes it", async () => {
  const dry = await relabelHistoricalEchoTickets({ apply: false });
  expect(dry.truncated).toBe(false);
  // A cap below the table size stops early and says so instead of loading everything.
  const capped = await relabelHistoricalEchoTickets({ apply: false, maxRows: 1 });
  expect(capped).toMatchObject({ scanned: 1, truncated: true });
  // ...and the next run continues after the reported cursor instead of rescanning.
  const next = await relabelHistoricalEchoTickets({ apply: false, maxRows: 1, afterOrder: BigInt(capped.lastOrder!) });
  expect(BigInt(next.lastOrder ?? "0")).toBeGreaterThan(BigInt(capped.lastOrder!));
  const mine = dry.matched.filter(entry => Object.values(keys).includes(entry.eventKey));
  expect(mine).toEqual([{ eventKey: keys.echo, processingState: "HELD", errorCode: "pending_verifier_or_age_stale", to: "provider_echo" }]);
  expect((await state("echo")).errorCode).toBe("pending_verifier_or_age_stale"); // dry run wrote nothing
  await expect(relabelHistoricalEchoTickets({ apply: true })).rejects.toThrow(/backup/);

  const backupPath = path.join(mkdtempSync(path.join(tmpdir(), "echo-relabel-")), "backup.json");
  const applied = await relabelHistoricalEchoTickets({ apply: true, backup: backupPath });
  expect(JSON.parse(readFileSync(backupPath, "utf8")).rows).toEqual(expect.arrayContaining(mine));
  expect(await state("echo")).toEqual({ errorCode: "provider_echo", processingState: "HELD", intakeAgentRevisionId: revisionId });
  expect((await state("customer")).errorCode).toBe("pending_verifier_or_age_stale"); // a real customer turn is never relabelled
  expect(await state("inflight")).toMatchObject({ errorCode: null, processingState: "RECEIVED" }); // its own job labels it
  expect(applied.updated).toBeGreaterThanOrEqual(1);
  // Second run finds nothing of ours: already labelled rows are not selected.
  expect((await relabelHistoricalEchoTickets({ apply: false })).matched.filter(entry => Object.values(keys).includes(entry.eventKey))).toEqual([]);

  expect(await restoreHistoricalEchoTickets(readFileSync(backupPath, "utf8"))).toBeGreaterThanOrEqual(1);
  expect((await state("echo")).errorCode).toBe("pending_verifier_or_age_stale");
}, 60_000);
