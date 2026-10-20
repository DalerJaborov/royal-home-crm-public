import { createHmac, randomUUID } from "node:crypto";
import http from "node:http";
import request from "supertest";
import { isDeepStrictEqual } from "node:util";
import { expect, it, vi } from "vitest";
import { standLedger, useStandModel, registerOwnedHttpServer, useFakeGraphFetch, assertStandDrained, observedProcessOutputs } from "./setupStand.js";
import { prisma } from "../../src/db.js";
import { processMessengerTurn } from "../../src/messengers/conversation.js";
import { admitCustomerPropertyInput } from "../../src/lib/customerPropertyAdmission.js";
import { resetAccountsCache } from "../../src/messengers/accounts.js";
import { sendManagedCustomerPropertyReply } from "../../src/lib/customerPropertyDelivery.js";
import { beforeCustomerPropertyPost, customerPropertyProviderAccepted } from "../../src/lib/customerPropertyTransport.js";
import { loadReplayDataset } from "./dataset.js";
import { assertion } from "./assertions.js";
import { replayReport, writeReplayReport, type ReplayCase } from "./report.js";
import type { CustomerPropertyEvidence } from "@royal-home/shared";
import { app } from "../../src/app.js";
import { encryptSecret } from "../../src/crypto.js";
import { STAND_QUALIFY_CAPABILITIES } from "./scriptedModel.js";

it("current source P03 OFF/ON processors share synthetic facts and persist real output outcomes", async () => {
  if (!process.env.REPLAY_DATASET_DIR || !process.env.REPLAY_ARTIFACT || !process.env.REPLAY_SOURCE_SHA) throw new Error("Explicit corpus/artifact/SHA required");
  const dataset = loadReplayDataset(process.env.REPLAY_DATASET_DIR); const cases: ReplayCase[] = [];
  const tag = `p04-${randomUUID()}`; const peers: string[] = []; const properties: string[] = []; const ads: string[] = []; const clients: string[] = [];
  const account = await prisma.messengerAccount.create({ data: { channel: "INSTAGRAM", externalId: tag, title: "P04 synthetic", token: encryptSecret("fake-no-provider-access") } });
  const settingsFields = { botEnabled: true, botInstagramEnabled: true, botTopicLockEnabled: true, botReplyDelaySec: true, botReplyMaxWaitSec: true, metaEnabled: true, metaAppSecret: true, metaVerifyToken: true } as const;
  const settings = await prisma.settings.findUniqueOrThrow({ where: { id: "singleton" }, select: settingsFields });
  await prisma.settings.update({ where: { id: "singleton" }, data: { botEnabled: true, botInstagramEnabled: true, botTopicLockEnabled: true, botReplyDelaySec: 0, botReplyMaxWaitSec: 0 } });
  resetAccountsCache(); vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime("2026-10-14T10:17:00.000Z");
  const entry = (key: string, attempts: number, language: "ru" | "tg"): ReplayCase => ({ key, channel: "INSTAGRAM", language, media: "text", historicalLabel: "linked-only-not-an-oracle", assertions: [], transcript: [], draft: null, receipts: [], attempts: standLedger.snapshot().slice(attempts), unavailable: ["Original referral/media/card/prices unavailable; explicit synthetic facts and admission"] });
  const raw = { reply: ["Уточните район."], ready: false, confident: true, topic: "price", openQuestion: "", clientAnsweredOpenQuestion: false };
  async function createPeer() { const peer = `${tag}-${peers.length}`; peers.push(peer); return peer; }
  async function admit(peer: string, mid: string, evidence: CustomerPropertyEvidence[]) {
    const result = await admitCustomerPropertyInput({ channel: "INSTAGRAM", peer, accountExternalId: tag, eventKind: "message", eventId: mid, evidence });
    if (result.status !== "admitted") throw new Error("Stand admission rejected"); return result;
  }
  const row = (peer: string) => prisma.botConversation.findUniqueOrThrow({ where: { channel_subscriberId: { channel: "INSTAGRAM", subscriberId: peer } } });
  try {
    for (const currency of ["TJS", "USD"] as const) {
      const property = await prisma.property.create({ data: { title: "Synthetic card", type: "APARTMENT", areaSqm: 60, windowCount: 3, price: 100000000, currency, address: "PRIVATE-ADDRESS-SENTINEL", condition: "GOOD", status: "AVAILABLE", publishedOnSite: true } }); properties.push(property.id);
      const outputs: unknown[] = [];
      for (let repeat = 0; repeat < 2; repeat++) {
        const peer = await createPeer(); process.env.BOT_PROPERTY_CONTEXT_ENABLED = "1";
        const mid = `${tag}-${currency}-${repeat}`; const start = standLedger.attempts.length; const script = useStandModel([]);
        const admission = await admit(peer, mid, [{ kind: "public_selector", origin: "message", reference: `short:${property.shortId}` }]);
        await prisma.botConversation.update({ where: { id: admission.ticket.conversationId }, data: { leadDraft: { phone: "+992900000001", stage: "chatting", intent: "buy" } } });
        const text = dataset.cases.find((item) => item.record.id === "Д905")!.record.goldenTurns[0].clientText;
        const answer = await processMessengerTurn({ channel: "INSTAGRAM", subscriberId: peer, accountExternalId: tag, messageId: mid, customerPropertyEventKind: "message", customerPropertyAdmission: admission, text });
        const part = answer.customerPropertyReply; if (!part) throw new Error("Expected real managed part");
        const beforeSend = await row(peer);
        const status = await sendManagedCustomerPropertyReply(part, async () => { await beforeCustomerPropertyPost("POST"); standLedger.record("effect", "fake-channel-accepted", true); customerPropertyProviderAccepted(null); return null; });
        const persisted = await row(peer); const history = persisted.messages as unknown as { customerPropertyDelivery?: { status: string } }[];
        const result = entry(`Д905/t1/occ1:synthetic-${currency}-${repeat}`, start, "tg");
        result.assertions.push(assertion(`${result.key}:number`, "Canonical huge card price survives", answer.reply.includes("100 000 000"), true), assertion(`${result.key}:currency`, "Canonical card currency kept", answer.reply.includes(currency === "USD" ? "USD" : "сомонӣ"), true),
          assertion(`${result.key}:private`, "Private address absent", answer.reply.includes("PRIVATE-ADDRESS-SENTINEL"), false), assertion(`${result.key}:draft`, "Known contact and stage preserved", persisted.leadDraft, { phone: "+992900000001", stage: "chatting", intent: "buy" }),
          assertion(`${result.key}:pending`, "Returned reply is initially pending, not delivered", (beforeSend.messages as typeof history).at(-1)?.customerPropertyDelivery?.status, "pending"), assertion(`${result.key}:accepted`, "Acceptance hook and exact DB stamp observed", [status, history.at(-1)?.customerPropertyDelivery?.status], ["accepted", "accepted"]));
        process.env.BOT_PROPERTY_CONTEXT_ENABLED = "0";
        const duplicate = await processMessengerTurn({ channel: "INSTAGRAM", subscriberId: peer, accountExternalId: tag, messageId: mid, customerPropertyEventKind: "message", text });
        result.assertions.push(assertion(`${result.key}:off-duplicate`, "OFF honors durable consumed event without provider/model", duplicate.shouldReply, false)); script.assertConsumed();
        result.transcript = [{ role: "user", content: text }, { role: "assistant", content: answer.reply }]; result.draft = persisted.leadDraft;
        result.receipts = [{ kind: "synthetic-provider-acceptance", status, mid: null, storedStatus: history.at(-1)?.customerPropertyDelivery?.status }]; result.attempts = standLedger.snapshot().slice(start);
        outputs.push({ reply: answer.reply, draft: result.draft, receipts: result.receipts }); cases.push(result);
      }
      expect(isDeepStrictEqual(outputs[0], outputs[1])).toBe(true);
    }
    for (const status of ["missing", "ambiguous"] as const) {
      const target = await createPeer(); const mid = `${tag}-${status}`; const attemptStart = standLedger.attempts.length;
      process.env.BOT_PROPERTY_CONTEXT_ENABLED = "1"; const script = useStandModel([]);
      const rows = await prisma.property.findMany({ where: { id: { in: properties } }, select: { shortId: true }, orderBy: { shortId: "asc" } });
      const evidence: CustomerPropertyEvidence[] = status === "ambiguous" ? rows.map((item) => ({ kind: "public_selector", origin: "message", reference: `short:${item.shortId}` })) : [];
      const admission = await admit(target, mid, evidence);
      // Explicit synthetic simplification, not a semantic replay of the longer
      // historical Д789 wording or its unavailable referral/card state.
      const answer = await processMessengerTurn({ channel: "INSTAGRAM", subscriberId: target, accountExternalId: tag, messageId: mid, customerPropertyEventKind: "message", customerPropertyAdmission: admission, text: "Адрес?" });
      script.assertConsumed(); const persisted = await row(target);
      const result = entry(`Д789/t1:synthetic-canonical-address-${status}`, attemptStart, "tg");
      result.assertions.push(assertion(`${result.key}:resolution`, "Real stored focus preserves uncertainty", (persisted.customerPropertyFocus as { status?: string }).status, status),
        assertion(`${result.key}:reply`, "Ambiguous-language word 'Адрес?' follows current TG default and asks for the object instead of inventing an address", answer.reply, status === "ambiguous" ? "Шумо кадом объектро дар назар доред? Рақами объект ё пайвандашро фиристед." : "Объектро дақиқ муайян карда натавонистам. Рақами объект ё пайвандашро фиристед."),
        assertion(`${result.key}:private`, "Private card address remains absent", answer.reply.includes("PRIVATE-ADDRESS-SENTINEL"), false),
        assertion(`${result.key}:pending`, "Clarification is a real pending managed part, not provider acceptance", Boolean(answer.customerPropertyReply), true));
      result.transcript = [{ role: "user", content: "Адрес?" }, { role: "assistant", content: answer.reply }]; result.attempts = standLedger.snapshot().slice(attemptStart); cases.push(result);
    }
    process.env.BOT_PROPERTY_CONTEXT_ENABLED = "0";
    const peer = await createPeer(); const start = standLedger.attempts.length; const model = useStandModel([{ endpoint: "lead-qualify", result: raw, qualification: STAND_QUALIFY_CAPABILITIES }]);
    const answer = await processMessengerTurn({ channel: "INSTAGRAM", subscriberId: peer, accountExternalId: tag, messageId: `${tag}-off`, text: "Что именно?" }); model.assertConsumed();
    const baseline = entry("Д086/t1/occ1:current-release-OFF-synthetic", start, "ru");
    baseline.assertions.push(assertion(`${baseline.key}:model`, "OFF uses actual legacy qualifier with bounded model script", standLedger.snapshot().slice(start).filter((attempt) => attempt.kind === "model").length, 1), assertion(`${baseline.key}:no-managed`, "OFF does not create fact-only managed receipt", Boolean(answer.customerPropertyReply), false));
    baseline.assertions.push(assertion(`${baseline.key}:valid-model`, "OFF model result reaches the consumer instead of a rejected-wire retry", Boolean(answer.aiUnavailable), false));
    baseline.assertions.push(assertion(`${baseline.key}:useful-consumer`, "Successful OFF model coverage requires a nonempty sendable reply", Boolean(answer.reply) && answer.shouldReply !== false, true));
    baseline.transcript = [{ role: "user", content: "Что именно?" }, { role: "assistant", content: answer.reply }]; baseline.draft = (await row(peer)).leadDraft; baseline.attempts = standLedger.snapshot().slice(start); cases.push(baseline);
    for (const failure of ["unknown", "held", "accepted-stamp-failure"] as const) {
      process.env.BOT_PROPERTY_CONTEXT_ENABLED = "1";
      const target = await createPeer(); const faultMid = `${tag}-${failure}`; const faultStart = standLedger.attempts.length; const noCalls = useStandModel([]);
      const property = await prisma.property.findUniqueOrThrow({ where: { id: properties[0] }, select: { shortId: true } });
      const admission = await admit(target, faultMid, [{ kind: "public_selector", origin: "message", reference: `short:${property.shortId}` }]);
      const result = await processMessengerTurn({ channel: "INSTAGRAM", subscriberId: target, accountExternalId: tag, messageId: faultMid, customerPropertyEventKind: "message", customerPropertyAdmission: admission, text: "Сколько стоит?" });
      if (!result.customerPropertyReply) throw new Error("Expected real pending fault part");
      if (failure === "held") await prisma.property.update({ where: { id: properties[0] }, data: { price: 100000001 } });
      const stamp = failure === "accepted-stamp-failure" ? vi.spyOn(prisma, "$executeRaw").mockRejectedValueOnce(new Error("Synthetic exact MID stamp failure")) : null;
      let attempts = 0;
      let outcome: string;
      try {
        outcome = await sendManagedCustomerPropertyReply(result.customerPropertyReply, async () => { attempts++; await beforeCustomerPropertyPost("POST");
          standLedger.record("effect", `synthetic-channel:${failure}`, true); if (failure !== "unknown") customerPropertyProviderAccepted(null); return null; });
      } finally { stamp?.mockRestore(); if (failure === "held") await prisma.property.update({ where: { id: properties[0] }, data: { price: 100000000 } }); }
      const stored = (await row(target)).messages as unknown as { customerPropertyDelivery?: { status: string } }[];
      process.env.BOT_PROPERTY_CONTEXT_ENABLED = "0";
      const retried = await processMessengerTurn({ channel: "INSTAGRAM", subscriberId: target, accountExternalId: tag, messageId: faultMid, customerPropertyEventKind: "message", text: "Сколько стоит?" }); noCalls.assertConsumed();
      const fault = entry(`synthetic-fault:${failure}`, faultStart, "ru");
      fault.assertions.push(assertion(`${fault.key}:outcome`, "Acceptance/unknown/hold distinguished", outcome!, failure === "accepted-stamp-failure" ? "accepted" : failure),
        assertion(`${fault.key}:history`, "Exact part remains pending after failed stamp; durable fence prevents replay, not durable acceptance recovery", stored.at(-1)?.customerPropertyDelivery?.status, failure === "accepted-stamp-failure" ? "pending" : failure),
        assertion(`${fault.key}:attempts`, "HOLD never calls transport; uncertainty does not resend", attempts, failure === "held" ? 0 : 1),
        assertion(`${fault.key}:off-retry`, "OFF cannot replay a consumed uncertain/accepted input", retried.shouldReply, false));
      fault.receipts = [{ kind: "synthetic-outcome/real-PG-fence", outcome: outcome!, persistedStatus: stored.at(-1)?.customerPropertyDelivery?.status }]; fault.attempts = standLedger.snapshot().slice(faultStart); cases.push(fault);
    }
    process.env.BOT_PROPERTY_CONTEXT_ENABLED = "0";
    const knownPeer = await createPeer(); const knownStart = standLedger.attempts.length;
    const client = await prisma.client.create({ data: { fullName: "P04 synthetic client", phone: `+99298${String(Number.parseInt(randomUUID().slice(0, 8), 16) % 10000000).padStart(7, "0")}`, source: "INSTAGRAM" } }); clients.push(client.id);
    await prisma.botConversation.create({ data: { channel: "INSTAGRAM", subscriberId: knownPeer, accountId: account.id, clientId: client.id, leadDraft: { phone: client.phone, stage: "done", intent: "buy" }, messages: [] } });
    const knownScript = useStandModel([{ endpoint: "lead-qualify", result: { ...raw, ready: true, reply: ["Назовите номер телефона. Уточните район."], lead: null }, qualification: STAND_QUALIFY_CAPABILITIES }]);
    const known = await processMessengerTurn({ channel: "INSTAGRAM", subscriberId: knownPeer, accountExternalId: tag, messageId: `${tag}-linked-known`, text: "Что именно?" }); knownScript.assertConsumed();
    const knownAfter = await row(knownPeer); const contact = entry("Д086/t1/occ1:synthetic-linked-client-valid-ready", knownStart, "ru");
    contact.assertions.push(assertion(`${contact.key}:same-client`, "Existing linked contact remains the same resource", knownAfter.clientId, client.id),
      assertion(`${contact.key}:valid-model`, "Linked ready fixture passes the whole-result boundary", Boolean(known.aiUnavailable), false),
      assertion(`${contact.key}:useful-consumer`, "Linked-contact positive model coverage requires a nonempty sendable reply", Boolean(known.reply) && known.shouldReply !== false, true),
      assertion(`${contact.key}:stage`, "Accepted ready=true preserves the declared completed contact stage", (knownAfter.leadDraft as { stage?: string }).stage, "done"),
      assertion(`${contact.key}:no-reask`, "Valid ready model cannot request the already linked phone", /номер телефона|рақам(?:атон|ро)/i.test(known.reply), false),
      assertion(`${contact.key}:phone`, "Existing actual CRM Client phone remains intact", (await prisma.client.findUniqueOrThrow({ where: { id: client.id } })).phone, client.phone));
    contact.draft = knownAfter.leadDraft; contact.transcript = [{ role: "assistant", content: known.reply }]; contact.attempts = standLedger.snapshot().slice(knownStart); cases.push(contact);
    process.env.BOT_PROPERTY_CONTEXT_ENABLED = "1";
    const ingressPeer = await createPeer(); const adId = `${tag}-signed-ad`; ads.push(adId);
    await prisma.ad.create({ data: { platform: "META", externalId: adId, name: "Synthetic P04 ad", propertyId: properties[0] } });
    const secret = "p04-fictional-meta-webhook-secret";
    await prisma.settings.update({ where: { id: "singleton" }, data: { metaEnabled: true, metaAppSecret: encryptSecret(secret), metaVerifyToken: encryptSecret("p04-fictional-verify-token") } });
    resetAccountsCache(); const ingressStart = standLedger.attempts.length; const noModel = useStandModel([]); let posts = 0;
    useFakeGraphFetch(async (_url, init) => {
      const targetUrl = new URL(typeof _url === "string" ? _url : _url instanceof URL ? _url.href : _url.url);
      const payload = typeof init?.body === "string" ? JSON.parse(init.body) as { message?: { text?: string }; recipient?: { id?: string } } : null;
      if (!targetUrl.pathname.endsWith("/me/messages") || init?.method !== "POST" || !payload?.message?.text) return standLedger.deny("effect", "unexpected-fake-graph-operation");
      posts++; return new Response(JSON.stringify({ recipient_id: payload.recipient?.id, message_id: `P04-SYNTHETIC-MID-${posts}` }), { status: 200 });
    });
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)); const unregister = registerOwnedHttpServer(server);
    try {
      const payload = { object: "instagram", entry: [{ id: tag, messaging: [{ sender: { id: ingressPeer }, recipient: { id: tag }, message: { mid: `${tag}-signed-mid`, text: "Нархшчансумай" }, referral: { source: "ADS", ad_id: adId } }] }] };
      const bytes = JSON.stringify(payload); const signature = `sha256=${createHmac("sha256", secret).update(bytes).digest("hex")}`;
      const response = await request(server).post("/api/v1/webhooks/meta").set("Content-Type", "application/json").set("x-hub-signature-256", signature).send(bytes);
      expect(response.status).toBe(200); await assertStandDrained(); noModel.assertConsumed();
      const delivered = await row(ingressPeer); const messages = delivered.messages as unknown as { role: string; customerPropertyDelivery?: { status: string }; mid?: string }[];
      const out = messages.find((message) => message.customerPropertyDelivery);
      const ingress = entry("Д905/t1/occ1:synthetic-signed-ad-ingress", ingressStart, "tg");
      ingress.assertions.push(assertion(`${ingress.key}:focus`, "Actual signed route/parser/DB registry resolve synthetic ad", (delivered.customerPropertyFocus as { propertyId?: string })?.propertyId, properties[0]),
        assertion(`${ingress.key}:post`, "Exactly one fake Graph POST", posts, 1), assertion(`${ingress.key}:stored-receipt`, "Actual Meta acceptance hook and exact stored MID", [out?.customerPropertyDelivery?.status, out?.mid], ["accepted", "P04-SYNTHETIC-MID-1"]));
      ingress.receipts = [{ kind: "fake-Graph/actual-adapter-acceptance", postCount: posts, status: out?.customerPropertyDelivery?.status }]; ingress.attempts = standLedger.snapshot().slice(ingressStart); cases.push(ingress);
      const pairDraft = { phone: client.phone, stage: "chatting", intent: "buy" };
      const inputText = "Нархшчансумай";
      for (const enabled of [false, true]) {
        process.env.BOT_PROPERTY_CONTEXT_ENABLED = enabled ? "1" : "0";
        const target = await createPeer(); const pairStart = standLedger.attempts.length; const startPosts = posts;
        // Fresh logical contacts avoid carrying the previous known-contact case's
        // real shield/profile history into this controlled comparison.
        const logicalPhone = `+99298${String(Number.parseInt(randomUUID().slice(0, 8), 16) % 10000000).padStart(7, "0")}`;
        const pairClient = await prisma.client.create({ data: { fullName: "P04 paired synthetic contact", phone: logicalPhone, source: "INSTAGRAM" } }); clients.push(pairClient.id);
        const initialDraft = { ...pairDraft, phone: logicalPhone };
        await prisma.botConversation.create({ data: { channel: "INSTAGRAM", subscriberId: target, accountId: account.id, clientId: pairClient.id, leadDraft: initialDraft, messages: [] } });
        const script = useStandModel(enabled ? [] : [{ endpoint: "lead-qualify", result: raw, qualification: STAND_QUALIFY_CAPABILITIES }]);
        const body = JSON.stringify({ object: "instagram", entry: [{ id: tag, messaging: [{ sender: { id: target }, recipient: { id: tag }, message: { mid: `${tag}-pair-${enabled}`, text: inputText }, referral: { source: "ADS", ad_id: adId } }] }] });
        const sig = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
        expect((await request(server).post("/api/v1/webhooks/meta").set("Content-Type", "application/json").set("x-hub-signature-256", sig).send(body)).status).toBe(200);
        await assertStandDrained(); script.assertConsumed(); const after = await row(target);
        const modelCalls = standLedger.snapshot().slice(pairStart).filter((attempt) => attempt.kind === "model").length;
        const pair = entry(`Д905/t1/occ1:comparable-current-${enabled ? "ON" : "OFF"}`, pairStart, "tg");
        pair.assertions.push(assertion(`${pair.key}:expected-model-path`, "Same IN/public mapping/initial contact follows flag-specific existing runtime", modelCalls, enabled ? 0 : 1),
          assertion(`${pair.key}:valid-model`, "Comparable mode does not silently pass an invalid model result", Boolean(observedProcessOutputs.at(-1)?.aiUnavailable), false),
          assertion(`${pair.key}:useful-consumer`, "Comparable mode produces a nonempty sendable result before its actual fake OUT", observedProcessOutputs.at(-1)?.empty === false && observedProcessOutputs.at(-1)?.shouldReply !== false, true),
          assertion(`${pair.key}:out`, "One actual fake-Graph OUT from each comparable mode", posts - startPosts, 1), assertion(`${pair.key}:same-resource`, "Initial logical linked client remains bound", after.clientId, pairClient.id));
        pair.transcript = [{ role: "user", content: inputText }]; pair.draft = { ...(after.leadDraft as Record<string, unknown>), phone: "[SYNTHETIC-KNOWN-PHONE]" }; pair.receipts = [{ kind: "comparable-fixture", publicCard: { price: "100000000", currency: "TJS" }, initialDraft: { ...initialDraft, phone: "[SYNTHETIC-KNOWN-PHONE]" }, normalizedMapping: "same-synthetic-ad/card", alias: "distinct-physical-contact/peer/provider-mid with identical logical initial state; no prior contact history" }]; pair.attempts = standLedger.snapshot().slice(pairStart); cases.push(pair);
      }
    } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); unregister(); useFakeGraphFetch(undefined); }
    const report = replayReport({ sha: process.env.REPLAY_SOURCE_SHA, hashes: dataset.hashes, cases, integrity: { records: 200, selectedTurns: 210 }, quoteAccounting: dataset.quoteAccounting, layer: "own-PostgreSQL/current-source-process/P03-OFF-vs-ON; actual-signed-ingress/parser; fake-Graph/actual-acceptance-hooks", flags: { propertyContextOnTested: true, propertyContextOffTested: true, turnTrace: false } });
    standLedger.assertClean(); loadReplayDataset(process.env.REPLAY_DATASET_DIR); writeReplayReport(process.env.REPLAY_ARTIFACT, report); expect(report.exitCode).toBe(0);
  } finally {
    vi.useRealTimers(); process.env.BOT_PROPERTY_CONTEXT_ENABLED = "0";
    try {
      const scoped = await prisma.customerEndpointScope.findMany({ where: { messengerAccountId: account.id }, select: { id: true } });
      const scopeIds = scoped.map(item => item.id);
      const native = await prisma.botConversation.findMany({
        where: { channel: "INSTAGRAM", subscriberId: { in: peers }, accountId: account.id },
        select: { id: true, contactProfileId: true },
      });
      const profileIds = native.flatMap(item => item.contactProfileId ? [item.contactProfileId] : []);
      const fixtureClients = await prisma.client.findMany({ where: { id: { in: clients } }, select: { phone: true } });
      const fixtureIdentities = { OR: [
        { kind: "IG_ID", value: { in: peers } },
        { kind: "PHONE", value: { in: fixtureClients.map(item => item.phone.replace(/\D/g, "").slice(-9)) } },
      ] };
      const inquiries = await prisma.customerInquiry.findMany({ where: { conversationId: { in: native.map(item => item.id) } }, select: { id: true } });
      await prisma.botConversation.deleteMany({ where: { id: { in: native.map(item => item.id) }, accountId: account.id } });
      await prisma.customerInquiry.deleteMany({ where: { id: { in: inquiries.map(item => item.id) } } });
      await prisma.outboundShieldState.deleteMany({ where: { endpointScopeId: { in: scopeIds } } });
      await prisma.propertyExposure.deleteMany({ where: { endpointScopeId: { in: scopeIds } } });
      await prisma.shownProperty.deleteMany({ where: { endpointScopeId: { in: scopeIds } } });
      await prisma.customerPropertyIngressTicket.deleteMany({ where: { endpointScopeId: { in: scopeIds } } });
      await prisma.customerEndpointScope.deleteMany({ where: { id: { in: scopeIds } } });
      await prisma.client.deleteMany({ where: { id: { in: clients } } });
      // Only profiles reached from our exact native rows and exclusively owned
      // fixture identities qualify. Never delete a shared/merged/live profile.
      await prisma.contactProfile.deleteMany({ where: {
        id: { in: profileIds }, clientId: null, mergedIntoId: null, mergedFrom: { none: {} },
        identities: { some: { kind: "IG_ID", value: { in: peers } }, every: fixtureIdentities },
        botConversations: { none: {} }, telegramConversations: { none: {} }, telegramDirectConversations: { none: {} },
        jobApplications: { none: {} }, incomingCalls: { none: {} },
        linkCandidatesLeft: { none: {} }, linkCandidatesRight: { none: {} }, mergesIn: { none: {} }, mergesOut: { none: {} },
      } });
      expect(await prisma.contactProfile.count({ where: { id: { in: profileIds } } })).toBe(0);
      await prisma.processedMessage.deleteMany({ where: { channel: "INSTAGRAM", messageId: { startsWith: tag } } });
      await prisma.ad.deleteMany({ where: { externalId: { in: ads } } });
      await prisma.property.deleteMany({ where: { id: { in: properties } } }); await prisma.messengerAccount.delete({ where: { id: account.id } });
    } finally {
      await prisma.settings.update({ where: { id: "singleton" }, data: settings }); resetAccountsCache();
    }
  }
});
