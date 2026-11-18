import { narrationRemovesOldPosts, type NarrationReleaseChannel } from "@royal-home/shared";
import { prisma } from "../db.js";
import { Prisma } from "../generated/prisma/client.js";
import { sendPushToAgent } from "../push.js";
import { loadNarrationConfiguration } from "./narrationGeneration.js";
import { updatePublishedMarks } from "./publishedMarks.js";
import { removeFromSocial, tiktokPostUrl, type OldPostsSnapshot } from "./publishedVideoFix.js";
import { propertyOwnerAgentId } from "./propertyOwner.js";
import { logSystemError } from "./systemError.js";
import { isHandoffPublishRunning } from "./videoHandoff.js";
import { collectUnresolvedOldPosts, postKeysOf, readCarried, type CarriedOldPost } from "./remakeRequests.js";

/**
 * СНАЧАЛА НОВЫЙ ПОСТ, ПОТОМ СТАРЫЙ (18.11.2026, владелец: «ролик сразу уходит в соцсети, а старые посты удаляются
 * везде»). Перемонтаж вышедшего ролика (новая озвучка, новая цена у монтажёра — любая заявка VideoRemakeRequest с
 * replaceOldPostsOnPublish) раньше снимал старые посты ДО публикации нового: упала новая публикация — объект
 * оставался вовсе без ролика в этой сети. Теперь:
 *
 *  1. prepareOldPostsBeforeRemakePublish — один раз, перед публикацией: снимок старых постов (каналы, id, ссылка
 *     Instagram) ложится в заявку (oldPosts), а из карточки эти каналы вычёркиваются — иначе публикация их
 *     пропустила бы (skipChannels). Повтор задания снимок не переписывает: в карточке к тому времени новые id.
 *  2. Публикация нового ролика — обычная (publishHandoffResult): канал, где новый вышел, снова в карточке.
 *  3. finishOldPostsAfterRemakePublish — после публикации и обходом раз в минуту (Instagram дозревает позже,
 *     TikTok и Meta повторяются отдельными заданиями): в каждой сети, где НОВЫЙ вышел, старый снимается по id из
 *     снимка (removeFromSocial с snapshot). Где новый не вышел — старый возвращается в карточку и остаётся висеть.
 *     TikTok удалить через API нельзя (первоисточник: Content Posting API не даёт удаления) — «старый удалите
 *     сами» со ссылкой. Instagram без ключа удаления, YouTube без права youtube.force-ssl и любой отказ удаления —
 *     так же вручную со ссылкой, плюс строка в журнал ошибок.
 *  4. Рубильник «Снимать старые посты при новой озвучке» (настройки озвучки, по умолчанию включён) выключен —
 *     для заявки NARRATION_CHANGED старые посты остаются рядом с новыми (OLD_KEPT).
 *
 * Идемпотентно: состояние каждой сети хранится в заявке (oldPostsOutcome), снятие берёт сеть условной записью
 * (REMOVING), второй проход снятую сеть не трогает. Заявка закрывается (oldPostsReplacedAt), когда решены все сети.
 */

type ChannelState = NarrationReleaseChannel["state"] | "REMOVING";
type ChannelOutcome = { state: ChannelState; url?: string | null; error?: string; at?: string };
type Outcome = Record<string, ChannelOutcome>;

/** Сколько ждать новую публикацию в сети (Instagram дозревает, TikTok повторяется по лимитам) до «новый не вышел». */
const NEW_POST_WAIT_MS = 2 * 86_400_000;
/** Снятие, начатое и брошенное (процесс упал), можно повторить после этого. */
const REMOVING_STALE_MS = 15 * 60_000;

const keysOf = postKeysOf;

function asRecord(v: Prisma.JsonValue | null | undefined): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? { ...(v as Record<string, unknown>) } : {};
}
/** instagramUrlOnly — Instagram числился только ссылкой (старые объекты без канала в списке): назад возвращается одна ссылка.
 *  takenAt — когда взят снимок, то есть когда началась публикация нового (ревью 18.11): срок «новый не вышел» считается
 *  от него, а не от создания заявки — монтаж мог идти трое суток.
 *  main — сети, где старый пост стоял в карточке; extra — старые посты, перенесённые из прежней незакрытой замены
 *  (lib/remakeRequests.ts), в той же сети их может быть два. */
type Snapshot = OldPostsSnapshot & { instagramUrlOnly?: boolean; takenAt?: string; main?: string[]; extra?: CarriedOldPost[] };
function readSnapshot(v: Prisma.JsonValue | null): Snapshot | null {
  const r = asRecord(v);
  if (!Array.isArray(r.channels)) return null;
  return { channels: (r.channels as unknown[]).filter((c): c is string => typeof c === "string"), postIds: asRecord(r.postIds as Prisma.JsonValue),
    instagramUrl: typeof r.instagramUrl === "string" ? r.instagramUrl : null, instagramUrlOnly: r.instagramUrlOnly === true,
    ...(typeof r.takenAt === "string" ? { takenAt: r.takenAt } : {}),
    ...(Array.isArray(r.main) ? { main: (r.main as unknown[]).filter((c): c is string => typeof c === "string") } : {}),
    extra: readCarried(r.extra) };
}
function readOutcome(v: Prisma.JsonValue | null): Outcome { return asRecord(v) as Outcome; }

const openRequestWhere = (propertyId: string) => ({ propertyId, replaceOldPostsOnPublish: true, oldPostsReplacedAt: null });

/**
 * Шаг 1, внутри задания публикации ПЕРЕД publishHandoffResult. Возвращает true, если снимок есть (взят сейчас или
 * раньше) и после публикации нужен шаг 3.
 */
export async function prepareOldPostsBeforeRemakePublish(propertyId: string, now: Date = new Date()): Promise<boolean> {
  const request = await prisma.videoRemakeRequest.findFirst({ where: openRequestWhere(propertyId), orderBy: { createdAt: "desc" }, select: { id: true, oldPosts: true, carriedOldPosts: true, createdAt: true } });
  if (!request) return false;
  if (request.oldPosts !== null) return true;
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Property" WHERE id = ${propertyId} FOR UPDATE`;
    const p = await tx.property.findUnique({ where: { id: propertyId }, select: { publishedChannels: true, publishedPostIds: true, instagramUrl: true } });
    if (!p) return false;
    const main = [...(p.publishedChannels ?? [])];
    const snapshot: Snapshot = { channels: [...main], main, postIds: asRecord(p.publishedPostIds), instagramUrl: p.instagramUrl, takenAt: now.toISOString() };
    if (p.instagramUrl && !snapshot.channels.includes("INSTAGRAM")) { snapshot.channels.push("INSTAGRAM"); snapshot.main = [...main, "INSTAGRAM"]; snapshot.instagramUrlOnly = true; }
    // Старые посты прежней незакрытой замены (вторая замена, пока первая ждала TikTok): снимет эта.
    // Старшие открытые заявки (прежний код заводил новую поверх идущей): их нерешённые старые посты — сюда, сами закрыты.
    const older = await tx.videoRemakeRequest.findMany({ where: { ...openRequestWhere(propertyId), id: { not: request.id }, createdAt: { lt: request.createdAt } },
      select: { id: true, oldPosts: true, oldPostsOutcome: true, carriedOldPosts: true } });
    if (older.length) await tx.videoRemakeRequest.updateMany({ where: { id: { in: older.map((r) => r.id) } }, data: { oldPostsReplacedAt: now } });
    const extra = [...readCarried(request.carriedOldPosts), ...collectUnresolvedOldPosts(older)];
    if (extra.length) snapshot.extra = extra;
    for (const e of extra) if (!snapshot.channels.includes(e.channel)) snapshot.channels.push(e.channel);
    const outcome: Outcome = Object.fromEntries(snapshot.channels.map((c) => [c, { state: "WAITING" as const }]));
    const claimed = await tx.videoRemakeRequest.updateMany({ where: { id: request.id, oldPosts: { equals: Prisma.DbNull } },
      data: { oldPosts: snapshot as unknown as Prisma.InputJsonValue, oldPostsOutcome: outcome as unknown as Prisma.InputJsonValue,
        ...(snapshot.channels.length === 0 ? { oldPostsReplacedAt: now } : {}) } });
    if (!claimed.count) return true;
    if (snapshot.channels.length === 0) return false;
    await updatePublishedMarks(propertyId, (current) => {
      const postIds = { ...current.postIds };
      for (const c of snapshot.channels) for (const k of keysOf(c)) delete postIds[k];
      return { channels: current.channels.filter((c) => !snapshot.channels.includes(c)), postIds, data: { instagramUrl: null } };
    }, tx);
    return true;
  });
}

export type RemakePublishSummary = { failedChannels: { channel: string }[]; pendingChannels: { channel: string }[] };

/**
 * Шаг 3. `summary` — итог только что прошедшей публикации (из задания): сети, где новый пост не вышел и не дозреет
 * (не в pendingChannels), решаются сразу — старый остаётся. Без итога (обход) — только сети, где новый уже вышел,
 * и просроченные ожидания.
 */
export async function finishOldPostsAfterRemakePublish(propertyId: string, summary: RemakePublishSummary | null, now: Date = new Date()): Promise<{ removed: string[]; manual: string[]; kept: string[]; done: boolean } | null> {
  const head = await prisma.videoRemakeRequest.findFirst({ where: { ...openRequestWhere(propertyId), oldPosts: { not: Prisma.DbNull } }, orderBy: { createdAt: "desc" }, select: { id: true } });
  if (!head) return null;
  // Отметка проверки — на ВСЕ открытые заявки объекта (ревью 18.11): иначе старшая навсегда стояла бы первой в обходе.
  await prisma.videoRemakeRequest.updateMany({ where: openRequestWhere(propertyId), data: { oldPostsCheckedAt: now } });
  await mergeOlderOpenRequests(propertyId, head.id);
  const request = await prisma.videoRemakeRequest.findFirst({ where: { id: head.id, oldPostsReplacedAt: null },
    select: { id: true, reason: true, createdAt: true, oldPosts: true, oldPostsOutcome: true } });
  if (!request) return null;
  const snapshot = readSnapshot(request.oldPosts);
  if (!snapshot) return null;
  const outcome = readOutcome(request.oldPostsOutcome);
  const removeOld = request.reason !== "NARRATION_CHANGED" || narrationRemovesOldPosts((await loadNarrationConfiguration()).config);
  const current = await prisma.property.findUnique({ where: { id: propertyId }, select: { publishedChannels: true, deletedAt: true } });
  if (!current) return null;
  const pending = new Set((summary?.pendingChannels ?? []).map((c) => c.channel));
  const since = snapshot.takenAt ? new Date(snapshot.takenAt) : request.createdAt;
  const expired = now.getTime() - since.getTime() > NEW_POST_WAIT_MS;

  const next: Outcome = { ...outcome };
  const mineExtra: string[] = [];
  const toRemove: string[] = [];
  const toRestore: string[] = [];
  for (const channel of snapshot.channels) {
    const o = outcome[channel] ?? { state: "WAITING" };
    const stuck = o.state === "REMOVING" && (!o.at || now.getTime() - new Date(o.at).getTime() > REMOVING_STALE_MS);
    if (o.state !== "WAITING" && !stuck) continue;
    const newIsLive = (current.publishedChannels ?? []).includes(channel);
    if (newIsLive) {
      if (!removeOld) next[channel] = { state: "OLD_KEPT" };
      else if (channel === "TIKTOK") next[channel] = { state: "OLD_MANUAL", url: await tiktokPostUrl((snapshot.postIds.TIKTOK ?? snapshot.extra?.find((e) => e.channel === "TIKTOK")?.postIds.TIKTOK) as string | undefined) };
      else { toRemove.push(channel); next[channel] = { state: "REMOVING", at: now.toISOString() }; }
    } else if ((summary && !pending.has(channel)) || expired || current.deletedAt) {
      next[channel] = { state: "NEW_FAILED" };
      toRestore.push(channel);
    }
  }
  if (JSON.stringify(next) === JSON.stringify(outcome)) return { removed: [], manual: [], kept: [], done: false };
  // Условная запись с прочитанным итогом: два прохода разом (задание и обход) не снимут один пост дважды —
  // второй увидит изменившийся итог и уйдёт.
  const claimed = await prisma.videoRemakeRequest.updateMany({ where: { id: request.id, oldPostsReplacedAt: null,
    ...(request.oldPostsOutcome === null ? { oldPostsOutcome: { equals: Prisma.DbNull } } : { oldPostsOutcome: { equals: request.oldPostsOutcome as Prisma.InputJsonValue } }) },
    data: { oldPostsOutcome: next as unknown as Prisma.InputJsonValue } });
  if (!claimed.count) return { removed: [], manual: [], kept: [], done: false };
  // TikTok и OLD_KEPT решены уже этой записью — в «свои» сети для итога они тоже входят.
  for (const c of snapshot.channels) if (next[c] && next[c] !== outcome[c] && !toRemove.includes(c) && !toRestore.includes(c)) mineExtra.push(c);

  // Новый не вышел — старый пост возвращается в карточку: его снова видно, и следующий выпуск его заменит.
  if (toRestore.length) {
    await updatePublishedMarks(propertyId, (marks) => {
      const postIds = { ...marks.postIds };
      const back = toRestore.filter((c) => !marks.channels.includes(c));
      for (const c of back) {
        // Старый пост из карточки; его не было — перенесённый из прежней замены (он тоже висит в сети).
        const source = (snapshot.main ?? snapshot.channels).includes(c) ? snapshot.postIds : snapshot.extra?.find((e) => e.channel === c)?.postIds ?? {};
        for (const k of keysOf(c)) if (source[k] !== undefined) postIds[k] = source[k];
      }
      return { channels: [...marks.channels, ...back.filter((c) => c !== "INSTAGRAM" || !snapshot.instagramUrlOnly)], postIds,
        ...(back.includes("INSTAGRAM") && snapshot.instagramUrl ? { data: { instagramUrl: snapshot.instagramUrl } } : {}) };
    });
  }

  const removed: string[] = [];
  if (toRemove.length) {
    // Старый пост карточки и перенесённые из прежней замены — каждый своим снимком; сеть снята, только если сняты все.
    const mainChannels = toRemove.filter((c) => (snapshot.main ?? snapshot.channels).includes(c));
    const parts = [mainChannels.length ? await removeFromSocial(propertyId, mainChannels, { snapshot, insidePublishJob: true }) : null,
      ...(snapshot.extra ?? []).filter((e) => toRemove.includes(e.channel)).map((e) =>
        removeFromSocial(propertyId, [e.channel], { snapshot: { channels: [e.channel], postIds: e.postIds, instagramUrl: e.instagramUrl }, insidePublishJob: true }))];
    const results = (await Promise.all(parts)).filter((r): r is NonNullable<typeof r> => !!r);
    const tried = new Map<string, number>(), ok = new Map<string, number>();
    for (const c of mainChannels) tried.set(c, 1);
    for (const e of snapshot.extra ?? []) if (toRemove.includes(e.channel)) tried.set(e.channel, (tried.get(e.channel) ?? 0) + 1);
    for (const r of results) for (const c of r.removed) ok.set(c, (ok.get(c) ?? 0) + 1);
    const social = { removed: [...tried.keys()].filter((c) => (ok.get(c) ?? 0) >= (tried.get(c) ?? 0)), manual: results.flatMap((r) => r.manual), failed: results.flatMap((r) => r.failed) };
    for (const c of social.removed) { next[c] = { state: "OLD_REMOVED" }; removed.push(c); }
    const manualUrl = new Map(social.manual.map((m) => [m.channel as string, m.url]));
    const failedError = new Map(social.failed.map((f) => [f.channel, f.error]));
    for (const c of toRemove) {
      if (social.removed.includes(c)) continue;
      // Снять не вышло (нет ключа удаления Instagram, у YouTube нет права youtube.force-ssl, сеть отказала) —
      // руками, со ссылкой; причина уже в журнале ошибок (removeFromSocial пишет все отказы).
      next[c] = { state: "OLD_MANUAL", url: manualUrl.get(c) ?? oldPostUrl(c, snapshot), ...(failedError.get(c) ? { error: failedError.get(c)!.slice(0, 300) } : {}) };
    }
  }
  // Итог по сетям — только СВОИХ сетей и условной записью (ревью 18.11): параллельный проход мог за это время решить
  // другую сеть, и запись всего объекта целиком стёрла бы его результат.
  const mine = Object.fromEntries([...toRemove, ...toRestore, ...mineExtra].map((c) => [c, next[c]!]));
  const final = await writeChannelOutcomes(request.id, mine, now);
  Object.assign(next, final ?? {});
  const unresolved = !final || Object.values(final).some((o) => o.state === "WAITING" || o.state === "REMOVING");

  const manual = Object.entries(next).filter(([c, o]) => o.state === "OLD_MANUAL" && outcome[c]?.state !== "OLD_MANUAL").map(([c]) => c);
  if (manual.length) await tellOwnerManual(propertyId, manual.map((c) => ({ channel: c, url: next[c]!.url ?? null })));
  return { removed, manual, kept: Object.entries(next).filter(([, o]) => o.state === "OLD_KEPT").map(([c]) => c), done: !unresolved };
}

/**
 * Старшие открытые заявки того же объекта (дубли из прежних версий кода): их нерешённые старые посты переходят в
 * снимок последней, сами они закрываются — обход больше не стоит на них вечно (ревью 18.11).
 */
async function mergeOlderOpenRequests(propertyId: string, latestId: string): Promise<void> {
  // Только СТАРШЕ заявки со снимком (третье ревью 18.11): более новая без снимка (прежний код заводил её поверх)
  // ещё не публиковалась — её снимок возьмёт и перенесёт старшие сама (prepareOldPostsBeforeRemakePublish).
  const head = await prisma.videoRemakeRequest.findUnique({ where: { id: latestId }, select: { createdAt: true } });
  if (!head) return;
  const older = await prisma.videoRemakeRequest.findMany({ where: { ...openRequestWhere(propertyId), id: { not: latestId }, createdAt: { lt: head.createdAt } },
    select: { id: true, oldPosts: true, oldPostsOutcome: true, carriedOldPosts: true } });
  if (!older.length) return;
  const carried = collectUnresolvedOldPosts(older);
  await prisma.$transaction(async (tx) => {
    const latest = await tx.videoRemakeRequest.findUnique({ where: { id: latestId }, select: { oldPosts: true, oldPostsOutcome: true } });
    const snap = readSnapshot(latest?.oldPosts ?? null);
    if (!latest || !snap) return;
    const outcome = readOutcome(latest.oldPostsOutcome);
    const extra = [...(snap.extra ?? []), ...carried];
    const channels = [...snap.channels];
    for (const e of carried) if (!channels.includes(e.channel)) { channels.push(e.channel); outcome[e.channel] = outcome[e.channel] ?? { state: "WAITING" }; }
    // Сеть, уже решённая у последней заявки, для перенесённого старого поста снова ждёт решения.
    for (const e of carried) if (outcome[e.channel] && !["WAITING", "REMOVING"].includes(outcome[e.channel]!.state)) outcome[e.channel] = { state: "WAITING" };
    await tx.videoRemakeRequest.update({ where: { id: latestId }, data: { oldPosts: { ...snap, channels, extra } as unknown as Prisma.InputJsonValue,
      oldPostsOutcome: outcome as unknown as Prisma.InputJsonValue } });
    await tx.videoRemakeRequest.updateMany({ where: { id: { in: older.map((r) => r.id) } }, data: { oldPostsReplacedAt: new Date() } });
  });
}

/**
 * Дописать итог своих сетей к свежему итогу заявки условной записью (сравнение с прочитанным), до пяти попыток.
 * Все сети решены — заявка закрывается той же записью. Возвращает записанный итог или null (не удалось).
 */
async function writeChannelOutcomes(requestId: string, mine: Outcome, now: Date): Promise<Outcome | null> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const row = await prisma.videoRemakeRequest.findUnique({ where: { id: requestId }, select: { oldPostsOutcome: true, oldPostsReplacedAt: true } });
    if (!row || row.oldPostsReplacedAt) return null;
    const merged: Outcome = { ...readOutcome(row.oldPostsOutcome), ...mine };
    const unresolved = Object.values(merged).some((o) => o.state === "WAITING" || o.state === "REMOVING");
    const written = await prisma.videoRemakeRequest.updateMany({ where: { id: requestId, oldPostsReplacedAt: null,
      ...(row.oldPostsOutcome === null ? { oldPostsOutcome: { equals: Prisma.DbNull } } : { oldPostsOutcome: { equals: row.oldPostsOutcome as Prisma.InputJsonValue } }) },
      data: { oldPostsOutcome: merged as unknown as Prisma.InputJsonValue, ...(unresolved ? {} : { oldPostsReplacedAt: now }) } });
    if (written.count) return merged;
  }
  void logSystemError("meta", `Заявка ${requestId}: итог снятия старых постов не записан за пять попыток (идут параллельные проходы)`, { dedupKey: "remake-old-posts-outcome-contended" });
  return null;
}

/** Прямая ссылка на старый пост, когда её можно собрать из id. */
function oldPostUrl(channel: string, snapshot: OldPostsSnapshot): string | null {
  const id = snapshot.postIds[channel];
  if (channel === "INSTAGRAM") return snapshot.instagramUrl;
  if (channel === "YOUTUBE" && typeof id === "string") return `https://www.youtube.com/shorts/${id}`;
  if (channel === "THREADS" && typeof snapshot.postIds.THREADS_URL === "string") return snapshot.postIds.THREADS_URL;
  return null;
}

async function tellOwnerManual(propertyId: string, items: { channel: string; url: string | null }[]): Promise<void> {
  const property = await prisma.property.findUnique({ where: { id: propertyId }, select: { shortId: true, title: true, intakeAgentId: true, assignedAgentId: true, createdById: true } });
  const name = (c: string) => ({ INSTAGRAM: "Instagram", TIKTOK: "TikTok", YOUTUBE: "YouTube", FACEBOOK: "Facebook", TELEGRAM: "Telegram", THREADS: "Threads" } as Record<string, string>)[c] ?? c;
  const body = items.map((i) => `${name(i.channel)}: ${i.url ?? "найдите старый ролик в приложении"}`).join("\n");
  void logSystemError("meta", `Объект №${property?.shortId ?? propertyId}: вышел новый ролик, старый удалите руками — ${body.replace(/\n/g, "; ")}`,
    { dedupKey: "Объект №…: вышел перемонтированный ролик, старый удалите руками" });
  const ownerId = property ? propertyOwnerAgentId(property) : null;
  if (ownerId && property) {
    void sendPushToAgent(ownerId, { title: `Новый ролик №${property.shortId} вышел, старый удалите сами`, body: `${property.title}\n${body}`,
      url: `/properties/${property.shortId}`, tag: `remake-old-posts-${propertyId}` }).catch(() => {});
  }
}

/** Обход раз в минуту (задача narration-preview-due): дозревшие публикации и просроченные ожидания. */
export async function finishOldPostsSweep(now: Date = new Date()): Promise<number> {
  const rows = await prisma.videoRemakeRequest.findMany({ where: { replaceOldPostsOnPublish: true, oldPostsReplacedAt: null, oldPosts: { not: Prisma.DbNull } },
    // От давно не проверенных (ревью 18.11): двадцать заявок, ждущих повтора TikTok, не задерживают остальных.
    select: { propertyId: true }, orderBy: [{ oldPostsCheckedAt: { sort: "asc", nulls: "first" } }, { createdAt: "asc" }], take: 20 });
  let touched = 0;
  for (const { propertyId } of rows) {
    // Идёт публикация — её конец сам позовёт шаг 3 с итогом.
    if (await isHandoffPublishRunning(propertyId)) { await prisma.videoRemakeRequest.updateMany({ where: { propertyId, oldPostsReplacedAt: null }, data: { oldPostsCheckedAt: now } }); continue; }
    try {
      const r = await finishOldPostsAfterRemakePublish(propertyId, null, now);
      if (r && (r.removed.length || r.manual.length || r.done)) touched++;
    } catch (err) {
      void logSystemError("meta", `Объект ${propertyId}: снятие старых постов после нового ролика упало: ${err instanceof Error ? err.message : String(err)}`, { dedupKey: "remake-old-posts-sweep" });
    }
  }
  return touched;
}

/** Ход замены по сетям для карточки (NarrationReleaseView.channels): REMOVING показывается как «ещё выходит». */
export function releaseChannelsView(outcome: Prisma.JsonValue | null): NarrationReleaseChannel[] {
  return Object.entries(readOutcome(outcome)).map(([channel, o]) => ({ channel, state: o.state === "REMOVING" ? "WAITING" : o.state, ...(o.url ? { url: o.url } : {}) }));
}
