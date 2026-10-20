import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";

// Explicit manual proposal. No ordinary test/ship discovery or credential export.
const output = process.stdout.write.bind(process.stdout), originalFetch = globalThis.fetch.bind(globalThis);
const hash = value => createHash("sha256").update(value).digest("hex");
const nano = text => { assert.match(text, /^\d+\.\d{9}$/); return BigInt(text.replace(".", "")); };
const runId = randomUUID(), stop = new AbortController();
const report = { version: 1, runId, status: "failed", scope: "two_synthetic_real_provider_ready_drafts",
  historicalEvaluated: 0, liveSocialPosts: 0, notificationsDispatched: 0,
  counts: { count: 0, generate: 0, syntheticProfile: 0 }, denied: [], http: [], cases: [], diagnosticMessagesSuppressed: 0 };
report.phase = "arguments";
report.observedParsedDecisionKinds = [];
report.workerResults = [];
let prisma, shutdown, originalSettings, originalPolicy, config, artifact, revision, snapshot, identity, modules;
let active = null, credential = "", proxyCredential = "", root = "", configPath = "", configHash = "";
const usedOperations = new Set(), owned = [], ownEvents = [], countPairs = new Map();
const syntheticIgOrigin = "https://synthetic-real-core-instagram.invalid", syntheticIgProxyKey = "synthetic-real-core-ig-proxy-only";
const runnerHash = hash(readFileSync(fileURLToPath(import.meta.url)));
const safeCode = value => typeof value === "string" && /^[a-z0-9_]{1,90}$/.test(value) ? value : "qualification_failed";
function deny(code) { report.denied.push(safeCode(code)); stop.abort(); throw new Error(safeCode(code)); }
function allowedKeys(value, keys) { assert.ok(value && typeof value === "object" && !Array.isArray(value)); assert.deepEqual(Object.keys(value).sort(), [...keys].sort()); }
const load = name => import(pathToFileURL(resolve(root, `apps/api/src/${name}.ts`)).href);
const hex = (value, size) => assert.match(value, new RegExp(`^[a-f0-9]{${size}}$`));
function head() { return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
async function sourceCurrent() {
  if (head() !== config.expectedSourceHead || hash(readFileSync(fileURLToPath(import.meta.url))) !== runnerHash) deny("source_or_runner_changed");
  if (hash(readFileSync(configPath)) !== configHash) deny("approved_config_changed");
  const manifest = await modules.registration.buildCurrentCustomerAgentManifest(snapshot);
  if (modules.revision.customerAgentManifestId(manifest) !== config.expectedAgentRevisionId) deny("runtime_artifact_changed");
}
async function settingsKeyless() {
  const s = await prisma.settings.findUniqueOrThrow({ where: { id: "singleton" }, select: { geminiApiKey: true, geminiApiKey2: true, geminiApiKeysExtra: true } });
  if (s.geminiApiKey !== null || s.geminiApiKey2 !== null || s.geminiApiKeysExtra.length) deny("own_db_keys_must_be_null");
}
async function readBounded(response) {
  assert.ok(response.body); const chunks = []; let size = 0;
  const reader = response.body.getReader();
  try {
    while (true) { const next = await reader.read(); if (next.done) break;
      size += next.value.byteLength; if (size > 2 * 1024 * 1024) deny("provider_response_too_large"); chunks.push(next.value); }
  } finally { await reader.cancel().catch(() => {}); }
  const text = Buffer.concat(chunks).toString("utf8");
  if (text.includes(credential) || (proxyCredential && text.includes(proxyCredential))) deny("provider_echoed_secret");
  return text;
}
function wireBody(init, count) {
  const body = JSON.parse(init.body), request = count ? body.generateContentRequest : body;
  if (!request || request.cachedContent || request.generationConfig?.maxOutputTokens !== 2048 ||
      request.generationConfig?.thinkingConfig?.thinkingLevel !== "minimal") deny("unapproved_generation_limits");
  if (count) {
    allowedKeys(body, ["generateContentRequest"]);
    if (request.model !== "models/gemini-3.6-flash") deny("count_model_changed");
  } else if (Object.hasOwn(request, "model")) deny("unexpected_generate_model_field");
  for (const tool of request.tools ?? []) {
    allowedKeys(tool, ["functionDeclarations"]);
    for (const fn of tool.functionDeclarations ?? []) if (Object.hasOwn(fn, "parameters") || !fn.parametersJsonSchema) deny("unqualified_function_wire");
  }
  if (!request.tools?.length || !request.contents?.length || !request.systemInstruction) deny("missing_full_tools_request");
  const comparable = { ...request }; delete comparable.model; return hash(JSON.stringify(comparable));
}
async function providerResponse(promise, count, pair) {
  const response = await promise;
  report.http.push({ kind: count ? "count" : "generate", status: response.status });
  if (!response.ok) deny(`provider_http_${response.status}`);
  const text = await readBounded(response), raw = JSON.parse(text);
  if (count) { modules.config.customerAgentCountResponseSchema.parse(raw); pair.counted = true; }
  else {
    const parts = raw.candidates?.[0]?.content?.parts ?? [];
    const candidateText = parts.filter(p => typeof p.text === "string" && p.thought !== true).map(p => p.text).join("");
    try {
      const decision = modules.shared.customerAgentDecisionSchema.safeParse(JSON.parse(candidateText));
      if (decision.success) report.observedParsedDecisionKinds.push(decision.data.kind);
    } catch { /* Function rounds have no final decision; actual Core validates them. */ }
  }
  return new Response(text, { status: response.status, headers: { "content-type": "application/json" } });
}
async function guardedFetch(target, init) {
  const enteredAt = Date.now();
  try {
    const url = new URL(typeof target === "string" || target instanceof URL ? String(target) : target.url);
    // Only this exact synthetic GET is intercepted. Every social POST is denied.
    if (url.origin === syntheticIgOrigin) {
      const owner = owned.find(o => url.searchParams.get("access_token") === o.token), headers = new Headers(init?.headers);
      if (owner && modules?.graph && init?.method === "GET" && url.pathname === `/${modules.graph.GRAPH_VERSION}/${encodeURIComponent(owner.peer)}` &&
          url.searchParams.get("fields") === "username" && [...url.searchParams.keys()].sort().join(",") === "access_token,fields" &&
          JSON.stringify([...headers.entries()]) === JSON.stringify([["x-proxy-key", syntheticIgProxyKey]])) {
        report.counts.syntheticProfile++; return new Response(JSON.stringify({ id: owner.peer, username: "synthetic_real_customer" }));
      }
      return deny("social_or_unowned_graph_request");
    }
    const count = url.pathname === `${config.providerBasePath}:countTokens`, generate = url.pathname === `${config.providerBasePath}:generateContent`;
    if (!active || url.origin !== config.providerOrigin || url.search || url.hash || url.username || url.password ||
        (!count && !generate) || init?.method !== "POST" || init.redirect !== "error" || !init.signal || init.signal.aborted) deny("unapproved_provider_target");
    const headers = new Headers(init.headers), expectedHeaders = new Headers({ "content-type": "application/json", "x-goog-api-key": credential,
      ...(proxyCredential ? { "x-proxy-key": proxyCredential } : {}) });
    if (JSON.stringify([...headers.entries()].sort()) !== JSON.stringify([...expectedHeaders.entries()].sort())) deny("unapproved_provider_headers");
    if (typeof init.body !== "string" || Buffer.byteLength(init.body) > 131072) deny("provider_body_limit");
    const digest = wireBody(init, count);
    if (generate) {
      // The real wire has JUST consumed its genuine original counted witness.
      // Do not introduce a DB/source await between that consume and physical POST.
      const pair = active.lastPair && countPairs.get(active.lastPair);
      if (!pair?.counted || pair.generated || pair.digest !== digest || Date.now() >= pair.countDeadlineAt ||
          Date.now() >= pair.operationDeadlineAt || stop.signal.aborted || init.signal.aborted ||
          hash(readFileSync(fileURLToPath(import.meta.url))) !== runnerHash || hash(readFileSync(configPath)) !== configHash ||
          report.counts.generate >= 8) deny("generate_without_original_count");
      pair.generated = true;
      report.counts.generate++;
      return await providerResponse(originalFetch(url.href, { ...init, redirect: "error", signal: AbortSignal.any([stop.signal, init.signal]) }), false, pair);
    }
    await sourceCurrent(); await settingsKeyless();
    const ticket = await prisma.customerPropertyIngressTicket.findUniqueOrThrow({ where: { eventKey: active.eventKey }, include: {
      conversation: { select: { id: true, accountId: true, endpointScopeId: true, channel: true, subscriberId: true } },
    } });
    if (!ticket.providerOperationId || ticket.agentRevisionId !== revision.id || ticket.intakeAgentRevisionId !== revision.id ||
        ticket.processingState !== "CLAIMED" || !ticket.inputRecordedAt || ticket.originVersion !== 1 ||
        ticket.conversation?.accountId !== active.owner.id || ticket.conversation?.channel !== "INSTAGRAM" ||
        ticket.conversation?.subscriberId !== active.owner.peer || ticket.conversation?.endpointScopeId !== ticket.endpointScopeId ||
        ticket.conversation.id !== ticket.originalConversationId || !ticket.providerDeadlineAt || ticket.providerDeadlineAt.getTime() <= Date.now()) deny("original_operation_or_final_missing");
    if (active.operationId && active.operationId !== ticket.providerOperationId) deny("operation_replaced");
    active.operationId ??= ticket.providerOperationId; usedOperations.add(ticket.providerOperationId);
    if (usedOperations.size > 2) deny("third_operation_denied");
    const operation = await prisma.aiProviderOperation.findUniqueOrThrow({ where: { id: active.operationId } });
    if (operation.policyHash !== config.expectedPolicyHash || operation.maxAttempts !== 4 ||
        operation.maxCostUsd?.toFixed(9) !== "0.129024000" || operation.deadlineAt.getTime() !== ticket.providerDeadlineAt.getTime()) deny("original_policy_or_deadline_changed");
    const ordinal = operation.attemptsReserved;
    if (ordinal < 1 || ordinal > 4) deny("physical_ordinal_out_of_bounds");
    const log = await prisma.aiLog.findUniqueOrThrow({ where: { operationId_attemptNo: { operationId: operation.id, attemptNo: ordinal } } });
    if (log.attemptState !== "STARTED" || log.model !== "gemini-3.6-flash" || log.api !== "generateContent" ||
        log.endpoint !== "assistant-tools" || log.profileRevision !== snapshot.profile.profileRevision ||
        !log.reservedUsd || log.reservedUsd.toFixed(9) !== "0.032256000") deny("pre_io_reservation_missing");
    const pairKey = `${operation.id}:${ordinal}`;
    if (countPairs.has(pairKey) || report.counts.count >= 8) deny("extra_count_request");
    const pair = { digest, counted: false, generated: false, countDeadlineAt: enteredAt + 2000, operationDeadlineAt: ticket.providerDeadlineAt.getTime() };
    countPairs.set(pairKey, pair); active.lastPair = pairKey;
    if (stop.signal.aborted || init.signal.aborted || Date.now() >= ticket.providerDeadlineAt.getTime()) deny("original_deadline_or_abort");
    report.counts.count++;
    return await providerResponse(originalFetch(url.href, { ...init, redirect: "error", signal: AbortSignal.any([stop.signal, init.signal]) }), true, pair);
  } catch (error) { if (!report.denied.length) report.denied.push("provider_or_wire_unavailable"); stop.abort(); throw new Error(safeCode(error?.message)); }
}

async function main() {
  const args = process.argv.slice(2);
  assert.deepEqual(args.filter(a => a.startsWith("--")), ["--config", "--max-usd", "--execute-two-real-operations"]);
  assert.equal(args.length, 5); assert.equal(args[0], "--config"); assert.equal(args[2], "--max-usd");
  assert.equal(args[4], "--execute-two-real-operations"); assert.equal(nano(args[3]), 258048000n);
  assert.equal(process.env.TEST_ENV_PIN, "1"); assert.equal(process.env.NODE_OPTIONS ?? "", "");
  assert.equal(process.versions.node.split(".").slice(0, 2).join("."), "24.16");
  report.phase = "configuration";
  configPath = realpathSync(args[1]); const configBytes = readFileSync(configPath); configHash = hash(configBytes); config = JSON.parse(configBytes.toString("utf8"));
  allowedKeys(config, ["version", "worktree", "expectedSourceHead", "expectedAgentRevisionId", "expectedSnapshotHash", "expectedProfileHash", "expectedPolicyHash",
    "ownershipMarkerPath", "providerOrigin", "providerBasePath", "reportPath"]);
  assert.equal(config.version, 1); root = realpathSync(config.worktree); hex(config.expectedSourceHead, 40);
  for (const field of ["expectedAgentRevisionId", "expectedSnapshotHash", "expectedProfileHash", "expectedPolicyHash"]) hex(config[field], 64);
  assert.equal(head(), config.expectedSourceHead);
  report.phase = "ownership_marker";
  const marker = JSON.parse(readFileSync(config.ownershipMarkerPath, "utf8"));
  allowedKeys(marker, ["version", "kind", "host", "port", "database", "nonce", "worktree"]);
  assert.equal(marker.version, 1); assert.equal(marker.kind, "customer-core-real-provider-stand");
  assert.equal(marker.host, "127.0.0.1"); assert.equal(marker.port, 15500); assert.equal(realpathSync(marker.worktree), root);
  assert.match(marker.nonce, /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/); assert.match(marker.database, /^agent_core_real_[a-z0-9_]{6,50}$/);
  const dbUrl = new URL(process.env.DATABASE_URL ?? "");
  assert.equal(dbUrl.protocol, "postgresql:"); assert.equal(dbUrl.hostname, marker.host); assert.equal(dbUrl.port, String(marker.port));
  assert.equal(dbUrl.pathname, `/${marker.database}`); assert.equal(dbUrl.search, "");
  const origin = new URL(config.providerOrigin); assert.equal(origin.protocol, "https:"); assert.equal(origin.origin, config.providerOrigin);
  assert.equal(origin.pathname, "/"); assert.equal(origin.search, ""); assert.equal(origin.username, ""); assert.equal(origin.password, "");
  assert.ok(["/v1beta/models/gemini-3.6-flash", "/gemini/v1beta/models/gemini-3.6-flash"].includes(config.providerBasePath));
  report.phase = "private_artifact";
  const paths = await import(pathToFileURL(resolve(root, "scripts/replayArtifactPaths.mjs")).href);
  artifact = paths.canonicalNewArtifact(config.reportPath).target;
  assert.equal(paths.within(root, artifact), false); assert.equal(paths.within(resolve(root, "apps/api/tests/replay"), artifact), false);
  assert.equal(paths.within(realpathSync("D:/CRM/bot-review-2026-10-13"), artifact), true);
  assert.equal(paths.within(realpathSync("D:/CRM/bot-review-2026-10-13/golden-set"), artifact), false);
  assert.ok(artifact.endsWith(".json"));
  // Prove private destination is writable BEFORE paid work. This immutable
  // start record is never a success artifact; final report still uses wx.
  writeFileSync(`${artifact}.${runId}.started.json`, JSON.stringify({ version: 1, runId, startedAt: new Date().toISOString(),
    maxApprovedReferenceUsd: args[3], sourceHead: config.expectedSourceHead, runnerHash, status: "started_not_completion_evidence" }), { flag: "wx", mode: 0o600 });
  report.phase = "ephemeral_credentials";
  credential = process.env.CUSTOMER_CORE_REAL_GEMINI_KEY ?? ""; proxyCredential = process.env.CUSTOMER_CORE_REAL_PROXY_KEY ?? "";
  assert.ok(credential.length >= 20 && credential.length <= 8192 && !/\s/.test(credential));
  if (config.providerOrigin === "https://generativelanguage.googleapis.com") {
    assert.equal(config.providerBasePath, "/v1beta/models/gemini-3.6-flash"); assert.equal(proxyCredential, "");
  } else assert.equal(config.providerBasePath, "/gemini/v1beta/models/gemini-3.6-flash");
  process.env.GEMINI_API_KEY = credential; process.env.GEMINI_API_KEY_2 = "";
  process.env.GEMINI_PROXY_URL = config.providerOrigin === "https://generativelanguage.googleapis.com" ? "" : config.providerOrigin;
  process.env.GEMINI_PROXY_KEY = proxyCredential;
  // Empty IG values fall back to Gemini proxy/key in the real Meta adapter.
  // Use an explicit separate synthetic origin AND nonempty synthetic IG key.
  process.env.IG_PROXY_URL = syntheticIgOrigin; process.env.IG_PROXY_KEY = syntheticIgProxyKey;
  process.env.BOT_PROPERTY_CONTEXT_ENABLED = "0"; process.env.BOT_TURN_TRACE_ENABLED = "0"; process.env.BOT_TURN_TRACE_TEXT_ENABLED = "0";
  globalThis.fetch = guardedFetch;
  // The actual provider uses native fetch. Legacy push/notification HTTP must
  // not bypass its allowlist through Node's separate request/get consumers.
  for (const module of [http, https]) for (const method of ["request", "get"]) module[method] = () => deny("notification_or_raw_http_denied");
  globalThis.WebSocket = class { constructor() { deny("websocket_denied"); } };
  syncBuiltinESMExports();
  for (const method of ["log", "info", "warn", "error", "debug"]) console[method] = () => { report.diagnosticMessagesSuppressed++; };
  process.on("unhandledRejection", () => { report.denied.push("unhandled_background_rejection"); stop.abort(); });
  process.on("uncaughtException", () => { report.denied.push("uncaught_background_exception"); stop.abort(); });
  setTimeout(() => { stop.abort(); process.exit(1); }, 300000).unref(); // no completed artifact if the runner cannot finish
  report.phase = "own_database_preflight";
  ({ prisma } = await load("db")); shutdown = await load("lib/shutdownState");
  const [ownership] = await prisma.$queryRaw`SELECT current_database() AS name, shobj_description(oid,'pg_database') AS comment FROM pg_database WHERE datname=current_database()`;
  assert.equal(ownership.name, marker.database); assert.equal(ownership.comment, `customer-core-real-provider:${marker.nonce}`);
  for (const model of ["messengerAccount", "customerPropertyIngressTicket", "customerOutboxPart", "aiProviderOperation", "backgroundJob",
    "agent", "client", "contactProfile", "pushSubscription"])
    assert.equal(await prisma[model].count(), 0);
  assert.equal(await prisma.notification.count(), 0);
  // Migration500 creates these three empty installation namespaces even in a
  // fresh DB. Verify the exact bootstrap; never delete it to satisfy a guard.
  const bootstrap = await prisma.customerEndpointScope.findMany({ orderBy: [{ channel: "asc" }, { transportKey: "asc" }],
    select: { realmKey: true, channel: true, transportKey: true, kind: true, messengerAccountId: true,
      scopeRevision: true, publicCredentialFingerprint: true, publicResourceId: true } });
  const emptyScope = { realmKey: "royal-home", messengerAccountId: null, scopeRevision: "0",
    publicCredentialFingerprint: null, publicResourceId: null };
  assert.deepEqual(bootstrap.map(scope => ({ ...scope, scopeRevision: scope.scopeRevision.toString() })), [
    { ...emptyScope, channel: "TELEGRAM", transportKey: "legacy-telegram-bot", kind: "LEGACY_UNKNOWN" },
    { ...emptyScope, channel: "TELEGRAM", transportKey: "legacy-telegram-direct", kind: "LEGACY_UNKNOWN" },
    { ...emptyScope, channel: "WEBSITE", transportKey: "website-public-chat", kind: "NORMAL" },
  ]);
  await settingsKeyless();
  report.phase = "runtime_manifest";
  modules = { config: await load("ai/customerAgentProviderConfig"), registration: await load("lib/customerAgentRegistration"), revision: await load("lib/customerAgentRevision"),
    meta: await load("messengers/meta"), authority: await load("lib/customerIngressAuthority"), ingress: await load("lib/customerIngressProducer"),
    crypto: await load("crypto"), outbox: await load("lib/customerOutbox"), contact: await load("lib/publicAgencyContact"), settings: await load("ai/geminiSettings") };
  modules.renderer = await load("ai/customerAgentRenderer");
  modules.graph = await load("messengers/metaGraph");
  modules.shared = await import(pathToFileURL(resolve(root, "packages/shared/dist/index.js")).href);
  snapshot = modules.config.createCustomerAgentProviderSnapshot(); identity = modules.config.customerAgentProviderIdentities(snapshot);
  assert.equal(snapshot.version, 2); assert.ok(snapshot.profile.usageProtocol); assert.ok(snapshot.budget.usageProtocol);
  assert.deepEqual(identity, { snapshotHash: config.expectedSnapshotHash, providerProfileHash: config.expectedProfileHash, providerPolicyHash: config.expectedPolicyHash });
  assert.equal(snapshot.profile.runtime.model, "gemini-3.6-flash"); assert.deepEqual(snapshot.profile.runtime.fallbackModels, []);
  assert.equal(snapshot.wire.explicitCache, false); assert.equal(snapshot.wire.grounding, false); assert.equal(snapshot.wire.media, false);
  assert.equal(nano(snapshot.budget.maxOperationUsd) * 2n, nano(args[3])); await sourceCurrent();
  assert.deepEqual((await modules.settings.resolveGeminiRuntime()).keys, [credential]);
  originalSettings = await prisma.settings.findUniqueOrThrow({ where: { id: "singleton" }, select: { botEnabled: true, metaEnabled: true, botInstagramEnabled: true } });
  originalPolicy = await prisma.customerRuntimePolicy.findUniqueOrThrow({ where: { id: "singleton" }, select: { contractVersion: true, rolloutMode: true, capabilities: true, activeAgentRevisionId: true } });
  revision = await modules.registration.registerCurrentCustomerAgentRevision(snapshot); assert.equal(revision.id, config.expectedAgentRevisionId);
  await prisma.settings.update({ where: { id: "singleton" }, data: { botEnabled: true, metaEnabled: true, botInstagramEnabled: true } });
  await prisma.customerRuntimePolicy.update({ where: { id: "singleton" }, data: { contractVersion: "scoped", rolloutMode: "ACTIVE", capabilities: { publicRead: true }, activeAgentRevisionId: revision.id } });
  const cases = [
    { language: "ru", text: "Здравствуйте! Какой у вашего агентства номер для звонка? Вы работаете с арендой?" },
    { language: "tg", text: "Салом! Рақами телефони агентӣ барои занг кадом аст? Бо иҷора кор мекунед?" },
  ];
  for (const test of cases) {
    report.phase = test.language === "ru" ? "synthetic_ru_turn" : "synthetic_tg_turn";
    if (report.denied.length || stop.signal.aborted) deny("previous_case_failed_no_next_operation");
    const id = randomUUID(), owner = { id, externalId: `synthetic-real-provider-${id}`, peer: `synthetic-real-peer-${id}`, token: `synthetic-token-${id}`, secret: `synthetic-secret-${id}` };
    await prisma.messengerAccount.create({ data: { id, channel: "INSTAGRAM", externalId: owner.externalId, username: `qa_real_${id.replaceAll("-", "").slice(0, 16)}`,
      title: "Synthetic explicit real-provider qualification", enabled: true, token: modules.crypto.encryptSecret(owner.token), appSecret: modules.crypto.encryptSecret(owner.secret) } });
    owned.push(owner); modules.meta.resetMetaAccountCredsCache();
    const rawBody = Buffer.from(JSON.stringify({ object: "instagram", entry: [{ id: owner.externalId, messaging: [{ sender: { id: owner.peer },
      recipient: { id: owner.externalId }, timestamp: Date.now(), message: { mid: `${runId}-${test.language}`, text: test.text } }] }] }));
    const signature = `sha256=${createHmac("sha256", owner.secret).update(rawBody).digest("hex")}`;
    assert.equal(await modules.meta.verifySignature(rawBody, signature), true);
    const request = { rawBody, get: () => signature }; modules.authority.registerAuthenticatedMetaCustomerRequest(request);
    const stored = await modules.ingress.persistVerifiedCustomerIngressBatch(request); assert.equal(stored.status, "persisted"); assert.equal(stored.tickets.length, 1);
    const eventKey = stored.tickets[0].eventKey; ownEvents.push(eventKey); active = { eventKey, owner, operationId: null };
    const result = await modules.ingress.consumeCustomerInboxTicket(eventKey);
    report.workerResults.push({ language: test.language, status: safeCode(result.status),
      reason: result.reason === undefined ? null : safeCode(result.reason) });
    assert.equal(result.status, "planned"); assert.equal(result.partIds.length, 1);
    const row = await prisma.customerOutboxPart.findUniqueOrThrow({ where: { id: result.partIds[0] } });
    assert.equal(row.status, "READY"); assert.equal(row.agentRevisionId, revision.id); assert.equal(row.acceptedAt, null);
    const payload = modules.outbox.decodeCustomerOutboxPayload(row), publicData = modules.outbox.decodeCustomerOutboxPublicData(row);
    assert.equal(payload.kind, "text"); assert.ok(payload.text.includes(modules.contact.PUBLIC_AGENCY_CONTACT.phone));
    const rental = publicData?.observations.find(o => o.kind === "company_policy" && o.topic === "rental" && o.knowledge.rent === false);
    assert.ok(rental);
    const canonicalRental = modules.renderer.renderCustomerAgentDecision({ decision: { kind: "reply", refs: ["e0"], social: "none", question: "none" },
      evidence: [{ ref: "e0", value: rental }], language: test.language, surface: "dm", requestedFacts: [], knownPhoneSource: "none",
      maxOutputChars: revision.limits.maxOutputChars, knowledgeSourceHash: revision.knowledgeSourceHash });
    assert.ok(canonicalRental && payload.text.includes(canonicalRental));
    assert.ok(!/Какой номер телефона вы хотите оставить|Барои тамос кадом рақами телефонро мегузоред/iu.test(payload.text));
    assert.equal(Array.isArray(row.receiptRefsJson) ? row.receiptRefsJson.length : -1, 0);
    assert.equal(await prisma.customerDeliveryAttempt.count({ where: { partId: row.id } }), 0);
    report.cases.push({ language: test.language, status: "ready_draft", operationId: active.operationId, revisionId: revision.id,
      canonicalAgencyContactPresent: true, canonicalRentalObservation: true, textHash: hash(payload.text), textLength: payload.text.length,
      physicalSocialDelivery: "not_attempted" }); active = null;
  }
  assert.equal(usedOperations.size, 2); assert.equal(report.cases.length, 2); assert.equal(report.denied.length, 0);
  assert.equal(await prisma.notification.count(), 0);
  await sourceCurrent(); await settingsKeyless(); report.status = "complete"; report.phase = "two_ready_drafts";
}

try { await main(); }
catch (error) { report.status = "failed"; report.failure = safeCode(error?.message); stop.abort(); }
finally {
  try {
    // Keep the real original pin/reserve visible even if a pre-fetch guard
    // rejected a call before it could join the egress membership set.
    if (prisma && ownEvents.length) {
      const pins = await prisma.customerPropertyIngressTicket.findMany({ where: { eventKey: { in: ownEvents } },
        select: { providerOperationId: true, agentRevisionId: true, providerDeadlineAt: true, receivedAt: true, processingState: true } });
      report.originalPins = pins.map(pin => ({ operationId: pin.providerOperationId, revisionId: pin.agentRevisionId,
        originalReceivedAt: pin.receivedAt.toISOString(), originalDeadlineAt: pin.providerDeadlineAt?.toISOString(), state: pin.processingState }));
      pins.forEach(pin => { if (pin.providerOperationId) usedOperations.add(pin.providerOperationId); });
    }
    if (prisma && usedOperations.size) {
      const operations = await prisma.aiProviderOperation.findMany({ where: { id: { in: [...usedOperations] } }, include: { attempts: true } });
      report.operations = operations.map(op => ({ id: op.id, policyHash: op.policyHash, dayKey: op.dayKey, deadlineAt: op.deadlineAt.toISOString(), status: op.status,
        attemptsReserved: op.attemptsReserved, referenceReservedUsd: op.reservedUsd.toFixed(9), referenceSettledUsd: op.settledUsd.toFixed(9),
        attempts: op.attempts.map(a => ({ ordinal: a.attemptNo, model: a.model, outcome: a.providerOutcome, state: a.attemptState,
          source: a.usageSource, completeness: a.usageCompleteness, costStatus: a.costStatus, inputTokens: a.inputTokens, outputTokens: a.outputTokens,
          thinkingTokens: a.thinkingTokens, cacheReadTokens: a.cacheReadTokens, referenceReservedUsd: a.reservedUsd?.toFixed(9), referenceSettledUsd: a.settledUsd?.toFixed(9) })) }));
      if (operations.length !== 2 || operations.some(op => !op.attempts.length || op.attempts.some(a => a.attemptState !== "SETTLED" || a.usageCompleteness !== "COMPLETE" || a.costStatus !== "CALCULATED"))) {
        report.status = "failed"; report.failure ??= "usage_or_settlement_incomplete";
      }
      const units = value => nano(value.toFixed(9));
      const usd = value => `${value / 1000000000n}.${(value % 1000000000n).toString().padStart(9, "0")}`;
      const reserved = operations.reduce((sum, op) => sum + units(op.reservedUsd), 0n), settled = operations.reduce((sum, op) => sum + units(op.settledUsd), 0n);
      report.referenceTotals = { reservedUsd: usd(reserved), settledUsd: usd(settled), maximumApprovedUsd: "0.258048000", invoiceCost: "unavailable" };
      if (reserved + settled > 258048000n) { report.status = "failed"; report.failure ??= "reference_cap_exceeded"; }
    }
    if (shutdown) { shutdown.beginShutdown(); await shutdown.drainBackgroundTasks(2000); }
  } catch { report.status = "failed"; report.failure = "report_or_settlement_unavailable"; }
  try { if (prisma && originalSettings) await prisma.settings.update({ where: { id: "singleton" }, data: originalSettings }); }
  catch { report.status = "failed"; report.failure = "own_settings_restore_failed"; }
  finally {
    try { if (prisma && originalPolicy) await prisma.customerRuntimePolicy.update({ where: { id: "singleton" }, data: originalPolicy }); }
    catch { report.status = "failed"; report.failure = "own_policy_restore_failed"; }
  }
  try { await prisma?.$disconnect(); } catch { report.status = "failed"; report.failure = "own_disconnect_failed"; }
  try { if (modules && snapshot) await sourceCurrent(); } catch { report.status = "failed"; report.failure ??= "final_source_changed"; }
  report.completedAt = new Date().toISOString(); report.sourceHead = config?.expectedSourceHead; report.runnerHash = runnerHash;
  report.identities = identity; report.backgroundDrain = "bounded_wait_not_general_settlement_proof";
  report.configHash = configHash; report.wire = [...countPairs].map(([key, value]) => ({ originalOperationOrdinal: key, ...value }));
  if (config) report.providerRoute = { origin: config.providerOrigin, basePath: config.providerBasePath, model: "gemini-3.6-flash", api: "generateContent" };
  report.credentialSource = "ephemeral_env_root_supplied_not_db";
  report.finality = "requires_root_retained_native_exit0_and_report_hash";
  if (report.denied.length) report.status = "failed";
  const encoded = JSON.stringify(report);
  if ((credential && encoded.includes(credential)) || (proxyCredential && encoded.includes(proxyCredential))) { report.status = "failed"; report.failure = "secret_in_report_rejected"; artifact = undefined; }
  delete process.env.CUSTOMER_CORE_REAL_GEMINI_KEY; delete process.env.CUSTOMER_CORE_REAL_PROXY_KEY;
  delete process.env.GEMINI_API_KEY; delete process.env.GEMINI_PROXY_KEY; credential = ""; proxyCredential = "";
  try { if (artifact) writeFileSync(artifact, JSON.stringify(report, null, 2), { flag: "wx", mode: 0o600 }); }
  catch { report.status = "failed"; report.failure = "private_artifact_write_failed"; }
  // Guards remain installed until process termination; no late callback regains HTTP.
  output(JSON.stringify({ status: report.status, counts: report.counts, casesReady: report.cases.length, denied: report.denied.length,
    failure: report.failure ?? null, historicalEvaluated: 0, liveSocialPosts: 0 }) + "\n");
  process.exit(report.status === "complete" ? 0 : 1);
}
