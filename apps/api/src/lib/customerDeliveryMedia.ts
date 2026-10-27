import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import { crmPublicBase, publicUploadUrl } from "./crmPublicUrl.js";
import { uploadsDir } from "../upload.js";
import { pcmToWavBuffer } from "../ai/tts.js";
import { transcodeToM4a, transcodeToOggOpus } from "./audioTranscode.js";
import type { CustomerDeliveryPayload, CustomerDeliveryMediaEndpoint, CustomerVoiceMediaWitness,
  CustomerApprovedFileMediaWitness } from "./customerDeliveryContracts.js";
import { customerVoiceMediaWitnessSchema, customerApprovedFileMediaWitnessSchema } from "./customerDeliveryContracts.js";
import { isCurrentIssuedCustomerApprovedFile, customerApprovedFileWitnessCurrent, type CustomerApprovedFilePlan,
  type CustomerApprovedFilePrepared, type CustomerApprovedFileAuthority } from "./customerApprovedFiles.js";
import { customerVoiceReplyIssuedBy, type CustomerVoiceReplyResult, type CustomerVoiceReplyAuthority } from "./customerVoiceReply.js";

const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const mediaIssued = new WeakMap<object, { eventKey: string; agentRevisionId: string; turnKey: string; kind: "audio" | "file" | "link" }>();
const sha256 = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(",")}}`;
  return JSON.stringify(value);
}
function within(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function voicePublicBase(): string | null {
  try {
    const raw = crmPublicBase();
    if (!raw) return null;
    const base = new URL(raw);
    return base.protocol === "https:" && !base.username && !base.password && !base.search && !base.hash ? raw : null;
  } catch { return null; }
}
export function customerVoiceAssetsConfigured(): boolean { return voicePublicBase() !== null; }
function voicePublicUrl(assetPath: string): string | null {
  try {
    const raw = voicePublicBase(), derived = publicUploadUrl(assetPath);
    if (!raw || !derived || derived !== `${raw}${assetPath}`) return null;
    const base = new URL(raw), url = new URL(derived);
    return url.origin === base.origin && !url.username && !url.password && !url.search && !url.hash &&
      url.pathname === `${base.pathname.replace(/\/+$/u, "")}${assetPath}` ? derived : null;
  } catch { return null; }
}

export type CustomerAgentMediaExecutionMode = "OFF" | "PREVIEW" | "LIVE";
/** Media execution is opt-in and fails closed on absent or malformed deployment config. */
export function customerAgentMediaExecutionMode(): CustomerAgentMediaExecutionMode {
  const mode = process.env.CUSTOMER_AGENT_MEDIA_EXECUTION_MODE;
  return mode === "PREVIEW" || mode === "LIVE" ? mode : "OFF";
}

async function writeImmutableAudio(bytes: Buffer, extension: "ogg" | "m4a", digest: string): Promise<string | null> {
  if (!bytes.length || bytes.length > MAX_AUDIO_BYTES || sha256(bytes) !== digest) return null;
  try {
    const root = await fs.realpath(uploadsDir), directory = path.join(root, "msg-voice");
    await fs.mkdir(directory, { recursive: true });
    const realDirectory = await fs.realpath(directory);
    if (!within(root, realDirectory) || realDirectory !== directory) return null;
    const fileName = `customer-agent-${digest}.${extension}`, destination = path.join(realDirectory, fileName);
    const temporary = path.join(realDirectory, `.customer-agent-${randomUUID()}.tmp`);
    try {
      await fs.writeFile(temporary, bytes, { flag: "wx", mode: 0o644 });
      try { await fs.link(temporary, destination); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") return null; }
    } finally { await fs.unlink(temporary).catch(() => {}); }
    const stat = await fs.lstat(destination), real = await fs.realpath(destination);
    if (!stat.isFile() || stat.isSymbolicLink() || real !== destination || !within(root, real) || stat.size !== bytes.length || stat.size > MAX_AUDIO_BYTES) return null;
    const assetPath = `/uploads/msg-voice/${fileName}`;
    // A pre-existing content-addressed path is not trusted just because its
    // name and length match. Reopen it through the bounded no-follow reader
    // and verify the digest before the witness can be minted.
    return await readImmutableAudio(assetPath, digest, bytes.length) ? assetPath : null;
  } catch { return null; }
}

async function readImmutableAudio(assetPath: string, expectedHash: string, expectedSize: number): Promise<Buffer | null> {
  if (!/^\/uploads\/msg-voice\/customer-agent-[a-f0-9]{64}\.(?:ogg|m4a)$/u.test(assetPath) ||
      !/^[a-f0-9]{64}$/u.test(expectedHash) || !Number.isInteger(expectedSize) || expectedSize < 1 || expectedSize > MAX_AUDIO_BYTES) return null;
  try {
    const root = await fs.realpath(uploadsDir), candidate = path.join(root, "msg-voice", path.posix.basename(assetPath));
    const real = await fs.realpath(candidate), lstat = await fs.lstat(candidate);
    if (!lstat.isFile() || lstat.isSymbolicLink() || real !== candidate || !within(root, real)) return null;
    const handle = await fs.open(real, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.size !== expectedSize || before.size > MAX_AUDIO_BYTES) return null;
      const bytes = await handle.readFile(), after = await handle.stat();
      if (!after.isFile() || after.size !== before.size || after.mtimeMs !== before.mtimeMs || bytes.length !== after.size || sha256(bytes) !== expectedHash) return null;
      return bytes;
    } finally { await handle.close(); }
  } catch { return null; }
}

async function beforeDeadline<T>(work: Promise<T>, deadlineAtMs: number): Promise<T | null> {
  const remaining = deadlineAtMs - Date.now();
  if (remaining <= 0) {
    // Keep the rejection handler attached even when abandoning optional work.
    void work.catch(() => {});
    return null;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), remaining); });
  const result = await Promise.race([work.then(value => value as T | null, () => null), timeout]);
  if (timer !== undefined) clearTimeout(timer);
  return Date.now() < deadlineAtMs ? result : null;
}

export interface PreparedCustomerVoiceAsset {
  payload: Extract<CustomerDeliveryPayload, { kind: "audio" }>;
  witness: CustomerVoiceMediaWitness;
  prepared: Extract<CustomerVoiceReplyResult, { status: "prepared" }>;
}

/** Convert exact helper PCM to channel-supported bytes and publish an immutable, hash-named asset. */
export async function prepareCustomerVoiceAsset(input: {
  prepared: Extract<CustomerVoiceReplyResult, { status: "prepared" }>;
  authority: CustomerVoiceReplyAuthority;
  expectedSealedTextSha256: string;
  expectedDeadlineAtMs: number;
  preparationDeadlineAtMs: number;
  stillCurrent(): boolean | Promise<boolean>;
  endpoint: CustomerDeliveryMediaEndpoint;
}, deps: { transcodeToOggOpus?: typeof transcodeToOggOpus; transcodeToM4a?: typeof transcodeToM4a } = {}): Promise<PreparedCustomerVoiceAsset | null> {
  try {
    const { prepared, authority, endpoint } = input;
    if (customerAgentMediaExecutionMode() !== "LIVE" || !customerVoiceAssetsConfigured() || !authority.voiceReplies || !authority.voiceTrigger ||
        !customerVoiceReplyIssuedBy(prepared, authority, input.expectedSealedTextSha256) ||
        prepared.sealedTextSha256 !== input.expectedSealedTextSha256 || prepared.deadlineAtMs !== input.expectedDeadlineAtMs ||
        !Number.isFinite(input.preparationDeadlineAtMs) || input.preparationDeadlineAtMs > input.expectedDeadlineAtMs ||
        prepared.synthesizer !== "gemini_tts" || canonical(prepared.authoritySnapshot) !== canonical(authority) ||
        endpoint.channel !== authority.channel || endpoint.endpointScopeId !== authority.endpointScopeId || endpoint.accountId !== authority.accountId ||
        endpoint.transportKey !== authority.transportKey || endpoint.scopeRevision !== authority.scopeRevision || endpoint.peerId !== authority.peer) return null;
    const current = async () => {
      try { return Date.now() < input.preparationDeadlineAtMs && await input.stillCurrent() === true && Date.now() < input.preparationDeadlineAtMs; }
      catch { return false; }
    };
    if (!await current()) return null;
    const wav = pcmToWavBuffer(Buffer.from(prepared.pcm), prepared.sampleRateHz);
    const channel = endpoint.channel;
    const encoder = channel === "WHATSAPP" ? deps.transcodeToOggOpus ?? transcodeToOggOpus : deps.transcodeToM4a ?? transcodeToM4a;
    const media = await beforeDeadline(Promise.resolve().then(() => encoder(wav)), input.preparationDeadlineAtMs);
    if (!media || media.length < 1 || media.length > MAX_AUDIO_BYTES || !await current()) return null;
    const assetSha256 = sha256(media), extension = channel === "WHATSAPP" ? "ogg" : "m4a";
    const assetPath = await beforeDeadline(writeImmutableAudio(media, extension, assetSha256), input.preparationDeadlineAtMs);
    if (!assetPath || !await current()) return null;
    const publicUrl = voicePublicUrl(assetPath);
    if (!publicUrl || !await current()) return null;
    const body = { version: 1 as const, kind: "customer_voice" as const, assetPath, assetSha256,
      byteLength: media.length, mimeType: channel === "WHATSAPP" ? "audio/ogg" as const : "audio/mp4" as const,
      publicUrl, endpoint, voiceTrigger: authority.voiceTrigger, sealedTextSha256: prepared.sealedTextSha256,
      voiceReplies: true as const, deadlineAtMs: prepared.deadlineAtMs, synthesizer: prepared.synthesizer,
      agentRevisionId: authority.agentRevisionId, eventKey: authority.eventKey, scopeKey: authority.scopeKey, turnKey: authority.turnKey };
    const witness = customerVoiceMediaWitnessSchema.parse({ ...body, fingerprint: sha256(canonical(body)) });
    mediaIssued.set(witness, { eventKey: authority.eventKey, agentRevisionId: authority.agentRevisionId,
      turnKey: authority.turnKey, kind: "audio" });
    return { payload: { kind: "audio", url: publicUrl, mediaWitness: witness }, witness, prepared };
  } catch { return null; }
}

export function issueCustomerApprovedFilePayload(input: {
  plan: CustomerApprovedFilePrepared;
  authority: CustomerApprovedFileAuthority;
  endpoint: CustomerDeliveryMediaEndpoint;
}): { payload: Extract<CustomerDeliveryPayload, { kind: "file" | "link" }>; plan: CustomerApprovedFilePrepared } | null {
  try {
    const { plan, authority, endpoint } = input;
    if (!isCurrentIssuedCustomerApprovedFile(plan, authority) || endpoint.endpointScopeId !== authority.endpointScopeId ||
        endpoint.accountId !== authority.accountId || endpoint.transportKey !== authority.transportKey || endpoint.scopeRevision !== authority.scopeRevision ||
        endpoint.peerId !== authority.peer) return null;
    const body = { version: 1 as const, kind: "approved_customer_file" as const, approvedFile: plan, endpoint,
      agentRevisionId: authority.agentRevisionId, eventKey: authority.eventKey, scopeKey: authority.scopeKey, turnKey: authority.turnKey };
    const witness = customerApprovedFileMediaWitnessSchema.parse({ ...body, fingerprint: sha256(canonical(body)) });
    mediaIssued.set(witness, { eventKey: authority.eventKey, agentRevisionId: authority.agentRevisionId,
      turnKey: authority.turnKey, kind: plan.deliveryKind });
    const payload = plan.deliveryKind === "file"
      ? { kind: "file" as const, url: plan.publicUrl, name: plan.fileName, mediaWitness: witness }
      : { kind: "link" as const, url: plan.publicUrl, mediaWitness: witness };
    return { payload, plan };
  } catch { return null; }
}

export function customerDeliveryMediaWitnessIssuedBy(input: { payload: unknown; eventKey: string; agentRevisionId: string; turnKey: string }): boolean {
  if (!input.payload || typeof input.payload !== "object" || !("mediaWitness" in input.payload)) return false;
  const witness = Reflect.get(input.payload, "mediaWitness"), issued = witness && typeof witness === "object" ? mediaIssued.get(witness) : undefined;
  return !!issued && issued.eventKey === input.eventKey && issued.agentRevisionId === input.agentRevisionId &&
    issued.turnKey === input.turnKey && Reflect.get(input.payload, "kind") === issued.kind;
}

function fingerprintMatches(witness: CustomerVoiceMediaWitness | CustomerApprovedFileMediaWitness): boolean {
  const { fingerprint, ...body } = witness;
  return fingerprint === sha256(canonical(body));
}

export async function customerVoiceMediaWitnessCurrent(input: {
  witness: unknown; endpoint: CustomerDeliveryMediaEndpoint; eventKey: string; scopeKey: string; turnKey: string;
  agentRevisionId: string; db: { settings: { findUnique(args: unknown): Promise<unknown> } };
}): Promise<boolean> {
  try {
    if (customerAgentMediaExecutionMode() !== "LIVE") return false;
    const parsed = customerVoiceMediaWitnessSchema.safeParse(input.witness);
    if (!parsed.success) return false;
    const witness = parsed.data;
    if (!fingerprintMatches(witness) || witness.eventKey !== input.eventKey || witness.scopeKey !== input.scopeKey || witness.turnKey !== input.turnKey ||
        witness.agentRevisionId !== input.agentRevisionId || canonical(witness.endpoint) !== canonical(input.endpoint) ||
        Date.now() >= witness.deadlineAtMs || witness.assetPath.split("/").at(-1)?.split(".")[0] !== `customer-agent-${witness.assetSha256}`) return false;
    const settings = await input.db.settings.findUnique({ where: { id: "singleton" }, select: { botCanSendVoiceReplies: true } }) as { botCanSendVoiceReplies?: unknown } | null;
    if (settings?.botCanSendVoiceReplies !== true) return false;
    const expectedExtension = witness.endpoint.channel === "WHATSAPP" ? ".ogg" : ".m4a";
    if (!witness.assetPath.endsWith(expectedExtension)) return false;
    const publicUrl = voicePublicUrl(witness.assetPath);
    if (!publicUrl || publicUrl !== witness.publicUrl) return false;
    return !!await readImmutableAudio(witness.assetPath, witness.assetSha256, witness.byteLength);
  } catch { return false; }
}

export function customerApprovedFileWitnessMatches(input: { witness: unknown; plan: CustomerApprovedFilePrepared;
  authority: CustomerApprovedFileAuthority; endpoint: CustomerDeliveryMediaEndpoint }): boolean {
  try {
    const parsed = customerApprovedFileMediaWitnessSchema.safeParse(input.witness);
    if (!parsed.success || !isCurrentIssuedCustomerApprovedFile(input.plan, input.authority)) return false;
    const witness = parsed.data;
    return fingerprintMatches(witness) && canonical(witness.approvedFile) === canonical(input.plan) &&
      witness.agentRevisionId === input.authority.agentRevisionId && witness.eventKey === input.authority.eventKey &&
      witness.scopeKey === input.authority.scopeKey && witness.turnKey === input.authority.turnKey &&
      canonical(witness.endpoint) === canonical(input.endpoint);
  } catch { return false; }
}

export async function customerApprovedFileMediaWitnessCurrent(input: { witness: unknown; endpoint: CustomerDeliveryMediaEndpoint;
  authority: CustomerApprovedFileAuthority; stillCurrent(authority: CustomerApprovedFileAuthority): boolean | Promise<boolean> }): Promise<boolean> {
  try {
    const parsed = customerApprovedFileMediaWitnessSchema.safeParse(input.witness);
    if (!parsed.success) return false;
    const witness = parsed.data;
    if (!fingerprintMatches(witness) || witness.eventKey !== input.authority.eventKey || witness.scopeKey !== input.authority.scopeKey ||
        witness.turnKey !== input.authority.turnKey || witness.agentRevisionId !== input.authority.agentRevisionId ||
        canonical(witness.endpoint) !== canonical(input.endpoint)) return false;
    return await customerApprovedFileWitnessCurrent({ witness: witness.approvedFile, channel: input.endpoint.channel,
      authority: input.authority, stillCurrent: input.stillCurrent });
  } catch { return false; }
}

export function storedMediaWitnessFingerprintValid(raw: unknown): boolean {
  const voice = customerVoiceMediaWitnessSchema.safeParse(raw);
  if (voice.success) return fingerprintMatches(voice.data);
  const file = customerApprovedFileMediaWitnessSchema.safeParse(raw);
  return file.success && fingerprintMatches(file.data);
}
