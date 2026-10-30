import { z } from "zod";
import { prisma } from "../db.js";
import { fetchAttachments, storeFetchedAttachments, type AttachmentSource } from "../messengers/attachments.js";
import type { StoredAttachment } from "../ai/client.js";
import { loadCredentials } from "../messengers/meta.js";
import { GRAPH_VERSION, instagramApiUrl, instagramRequest } from "../messengers/metaGraph.js";
import { readRecoveryInstagramCredential } from "./customerInstagramSenderRead.js";
import { isMetaCdnUrl } from "../messengers/sharedPostCard.js";
import { bindCustomerMetaSendCredentials } from "./customerMetaTransport.js";
import { loadCustomerTransportForConversation } from "./customerConversationScope.js";
import type { CustomerNormalizedIngressInput } from "./customerIngressPayload.js";
import type { CustomerPrincipal } from "./customerPrincipal.js";
import type { CustomerAgentAwaitContext } from "../ai/customerAgentCore.js";
import type { CustomerAgentMediaPart } from "../ai/customerAgentMediaPerception.js";
import { aiDailyBudgetOf, spendAiFiles, type AiFileKind } from "./aiDailyBudget.js";
import { readCapped } from "./safeFetch.js";
import { customerVideoHasAudio } from "./customerMediaAudioTrack.js";
import { resolveCustomerSharedPublication } from "./customerSharedPublication.js";
import { customerPropertyUrl } from "./customerPropertyUrls.js";
import { RECRUITMENT_DOCX_MIME, recruitmentDocxText } from "./recruitmentDocumentText.js";

/** Real encrypted current-IN media only. Never fetch a model URI or use a
 * global WhatsApp token for an account-scoped customer. Existing safe downloader
 * owns SSRF/redirect/byte/duration limits and credential stripping. */
export async function loadCustomerDmMediaContent(input: {
  principal: CustomerPrincipal; media: CustomerNormalizedIngressInput["media"];
  wait: CustomerAgentAwaitContext; assertCurrent(wait: CustomerAgentAwaitContext): Promise<boolean>;
  preserveAttachments?: boolean;
}): Promise<{ parts: CustomerAgentMediaPart[]; incomplete: boolean; storedAttachments?: StoredAttachment[];
  /** A shared publication was FOUND in our own account (whether or not its media could be read). */ publicationFound?: boolean }> {
  const check = async () => {
    input.wait.signal.throwIfAborted();
    if (Date.now() >= input.wait.deadlineAt || !await input.assertCurrent(input.wait)) throw new Error("Original media context changed");
  };
  await check();
  const conversationId = input.principal.scope.conversationId;
  const row = await prisma.botConversation.findUnique({ where: { id: conversationId }, select: {
    id: true, aiBudgetDate: true, aiTurnsToday: true, aiVoiceToday: true, aiPhotoToday: true,
    aiVideoToday: true, aiDocToday: true, aiLimitNoticeAt: true,
  } });
  const budget = row ? aiDailyBudgetOf({ ...row, clientId: null }) : null;
  if (!budget || budget.turnsLeft <= 0) throw new Error("Customer media budget unavailable");
  let incomplete = input.media.length > 3, publicationFound = false;
  const metadataDeadline = Math.min(input.wait.deadlineAt, Date.now() + 12_000);
  const sources: Array<{ source: AttachmentSource; attachmentIndex: number }> = [];
  for (const [index, media] of input.media.slice(0, 3).entries()) {
    await check();
    const publicationLink = media.url && customerPropertyUrl(media.url).kind === "instagram";
    const fileKind: AiFileKind | null = publicationLink ? null : media.kind === "image" ? "photo" : media.kind === "audio" ? "voice" : media.kind === "video" ? "video" : media.kind === "document" ? "document" : null;
    // A publication URL is not the original media binary. Public registry/reel
    // resolution remains a separate existing path, never pretend HTML is video.
    if (fileKind ? budget.filesLeft[fileKind] <= 0 : !Object.values(budget.filesLeft).some(left => left > 0)) { incomplete = true; continue; }
    let source: AttachmentSource | undefined;
    if (media.url && input.principal.scope.channel !== "WHATSAPP" && (fileKind || isMetaCdnUrl(media.url))) {
      source = { url: media.url, ...(fileKind ? { declaredKind: media.kind } : {}) };
    } else if (input.principal.scope.channel === "INSTAGRAM" && input.principal.scope.accountId && (media.publicationId || media.url)) {
      const transport = await loadCustomerTransportForConversation(conversationId);
      if (!transport || transport.endpointScopeId !== input.principal.scope.endpointScopeId || !transport.accountExternalId) throw new Error("Original media transport unavailable");
      const credential = await readRecoveryInstagramCredential(prisma, input.principal.scope.accountId, transport.accountExternalId);
      await check();
      if (!credential) throw new Error("Original media credential unavailable");
      const sameCredential = async () => {
        const fresh = await readRecoveryInstagramCredential(prisma, input.principal.scope.accountId!, transport.accountExternalId!);
        if (!fresh || fresh.fingerprint !== credential.fingerprint) throw new Error("Original media credential changed");
      };
      const resolved = await resolveCustomerSharedPublication(media, async path => {
        await sameCredential();
        const remaining = metadataDeadline - Date.now();
        if (remaining <= 0) return { unavailable: true };
        const request = instagramRequest(instagramApiUrl(`/${GRAPH_VERSION}${path}`), credential.token);
        try {
          const res = await fetch(request.url, { method: "GET", headers: request.headers, redirect: "error",
            signal: AbortSignal.any([input.wait.signal, AbortSignal.timeout(Math.max(1, Math.min(3000, remaining)))]) });
          if (!res.ok) { await res.body?.cancel(); return res.status === 400 || res.status === 404 ? null : { unavailable: true }; }
          if (Number(res.headers.get("content-length") ?? 0) > 256 * 1024) { await res.body?.cancel(); return { unavailable: true }; }
          const bytes = await readCapped(res, 256 * 1024);
          return bytes.truncated ? { unavailable: true } : JSON.parse(bytes.body.toString("utf8"));
        } catch { await check(); return { unavailable: true }; }
      }, check);
      await sameCredential(); await check();
      for (const item of resolved) {
        if (sources.length >= 3) { incomplete = true; break; }
        sources.push({ source: item, attachmentIndex: index + 1 });
      }
      if (!resolved.length) incomplete = true; else publicationFound = true;
      continue;
    } else if (input.principal.scope.channel === "WHATSAPP" && media.assetRef && /^\d{1,80}$/.test(media.assetRef)) {
      const transport = await loadCustomerTransportForConversation(conversationId);
      if (!transport || transport.endpointScopeId !== input.principal.scope.endpointScopeId || transport.accountId !== input.principal.scope.accountId) throw new Error("Original media transport unavailable");
      const bound = await bindCustomerMetaSendCredentials(await loadCredentials(), "WHATSAPP", input.principal.scope.peer, undefined, transport);
      await check();
      const res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${media.assetRef}`, { redirect: "error",
        headers: { Authorization: `Bearer ${bound.token}` }, signal: AbortSignal.any([input.wait.signal, AbortSignal.timeout(Math.max(1, Math.min(8000, input.wait.deadlineAt - Date.now())))]) });
      if (!res.ok || Number(res.headers.get("content-length") ?? 0) > 16384) { await res.body?.cancel(); incomplete = true; continue; }
      const bytes = await readCapped(res, 16384);
      if (bytes.truncated) { incomplete = true; continue; }
      const metadata = z.object({ url: z.string().url().max(4096) }).passthrough().safeParse(JSON.parse(bytes.body.toString("utf8")));
      await check();
      if (metadata.success) {
        const url = new URL(metadata.data.url);
        if (url.protocol === "https:" && (url.hostname === "lookaside.fbsbx.com" || url.hostname.endsWith(".fbcdn.net") || url.hostname.endsWith(".fbsbx.com"))) {
          source = { url: url.toString(), headers: { Authorization: `Bearer ${bound.token}` }, declaredKind: media.kind };
        }
      }
    }
    if (!source) { incomplete = true; continue; }
    if (sources.length >= 3) { incomplete = true; continue; }
    sources.push({ source, attachmentIndex: index + 1 });
  }
  if (!sources.length) return { parts: [], incomplete, publicationFound };
  // Download in parallel while retaining original attachment order/index. The
  // real detected file kind, not its untrusted declared type, owns daily cost.
  const fetched = await Promise.all(sources.map(async ({ source, attachmentIndex }) => ({ attachmentIndex,
    fetched: await fetchAttachments([source], { signal: input.wait.signal, deadlineAt: input.wait.deadlineAt }) })));
  await check();
  const parts: CustomerAgentMediaPart[] = [], reserved = new Map<AiFileKind, number>();
  for (const { fetched: result, attachmentIndex } of fetched) {
    incomplete ||= result.hadUnsupported;
    const file = [...result.images, ...result.audios, ...result.medias][0];
    if (!file) continue;
    const kind: AiFileKind = file.kind === "image" ? "photo" : file.kind === "audio" ? "voice" : file.media === "video" ? "video" : "document";
    if ((reserved.get(kind) ?? 0) >= budget.filesLeft[kind]) { incomplete = true; continue; }
    reserved.set(kind, (reserved.get(kind) ?? 0) + 1);
    const hasAudio = file.kind === "media" && file.media === "video" ? await customerVideoHasAudio(file.buffer, input.wait) : undefined;
    await check();
    if (file.kind === "media" && file.mediaType === RECRUITMENT_DOCX_MIME) {
      try {
        const text = await recruitmentDocxText(file.buffer);
        await check();
        if (text.trim()) parts.push({ attachmentIndex, mimeType: "text/plain", data: Buffer.from(text).toString("base64") });
        else incomplete = true;
      } catch { await check(); incomplete = true; }
      continue;
    }
    parts.push({ attachmentIndex, mimeType: file.mediaType, data: file.kind === "image" ? file.data : file.buffer.toString("base64"),
      ...(hasAudio !== undefined ? { hasAudio } : {}) });
  }
  // Apply established counters BEFORE paid perception, using detected kinds.
  for (const [kind, count] of reserved) { await check(); await spendAiFiles(conversationId, budget.dayKey, kind, count); }
  if (!input.preserveAttachments) return { parts, incomplete, publicationFound };
  await check();
  const storedAttachments = await storeFetchedAttachments({ images: fetched.flatMap(row => row.fetched.images),
    audios: fetched.flatMap(row => row.fetched.audios), medias: fetched.flatMap(row => row.fetched.medias) });
  await check();
  return { parts, incomplete, storedAttachments, publicationFound };
}
