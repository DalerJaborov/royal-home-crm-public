import { prisma } from "../db.js";
import { logSystemError } from "./systemError.js";
import { dushanbeWallClock, dushanbeStartOfToday, dushanbeDateTimeString } from "./dushanbeTime.js";
import { loadPublishScheduleRules } from "./publishScheduleRules.js";
import { nextPublishSlot } from "./publishSchedule.js";
import { loadOccupiedPublishSlots } from "./publishSlots.js";
import { PUBLISH_SLOT_LOCK_ID } from "./videoHandoff.js";
import { preparePhotoPostImages, publishInstagramCarousel, publishFacebookPhotoPost, publishTelegramPhotoPost, type PhotoPostPublishResult } from "./photoPosts.js";
import { CONTACT_NUMBERS, buildReelsHashtags, buildPriceDisplay, withPostFooter } from "./reelsCaptionTemplate.js";
import { loadMoneyContext, toTjs } from "./money.js";
import { loadCredentials, instagramTokenIdentity } from "../messengers/meta.js";

/**
 * ПОДБОРКИ ОБЪЕКТОВ (28.09.2026, agent-brief.md reposts-digests, решение
 * владельца 26.09.2026) — «5 квартир до 400 000 сомони в Сино» собирают
 * больше просмотров, чем одиночные посты. Раз в неделю (Settings.digestWeekday/
 * digestHourDushanbe) выбирается ОДИН вид подборки по кругу недель и уходит
 * ОДНИМ постом на канал: по одной главной фотографии на объект (до 10),
 * подпись со списком строк.
 *
 * Публикация — теми же тремя функциями каналов, что у фото-постов
 * (lib/photoPosts.ts) и повторов (lib/socialReposts.ts): протокол Graph/
 * Telegram здесь не переизобретается.
 */

export const DIGEST_KINDS = ["DISTRICT_BUDGET", "NEW_THIS_WEEK", "ROOMS"] as const;
export type DigestKind = (typeof DIGEST_KINDS)[number];

const DIGEST_MIN_PROPERTIES = 3;
const DIGEST_MAX_PROPERTIES = 5;

/** Кандидат подборки — минимум полей, нужных списку строк подписи и картинке. */
export interface DigestCandidate {
  id: string;
  shortId: number;
  rooms: number | null;
  areaSqm: unknown;
  price: unknown;
  currency: string;
  districtName: string | null;
}

const CANDIDATE_SELECT = {
  id: true,
  shortId: true,
  rooms: true,
  areaSqm: true,
  price: true,
  currency: true,
  district: { select: { name: true } },
} as const;

function toCandidate(p: { id: string; shortId: number; rooms: number | null; areaSqm: unknown; price: unknown; currency: string; district: { name: string } | null }): DigestCandidate {
  return { id: p.id, shortId: p.shortId, rooms: p.rooms, areaSqm: p.areaSqm, price: p.price, currency: p.currency, districtName: p.district?.name ?? null };
}

const CANDIDATE_BASE_WHERE = {
  deletedAt: null,
  status: "AVAILABLE",
  offSite: false,
  publishedOnSite: true,
  photos: { some: {} },
} as const;

/**
 * Округление вверх до 50 000 сомони — «бюджет» подборки district-budget всегда
 * круглое число, которое можно произнести («до 400 000 сомони»), а не медиана
 * с хвостом типа 384 217.
 */
function roundUpTo50k(amountTjs: number): number {
  return Math.ceil(amountTjs / 50_000) * 50_000;
}

function median(sorted: number[]): number {
  const n = sorted.length;
  if (n === 0) return 0;
  const mid = Math.floor(n / 2);
  return n % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

export interface DigestPick {
  kind: DigestKind;
  title: string;
  properties: DigestCandidate[];
}

/**
 * Вид подборки по кругу недель — `pickDigest` сама не публикует, только
 * выбирает вид и объекты (§5 задания: «чистой логикой»). Круг считается от
 * числа полных недель по UTC от эпохи — простой и воспроизводимый счётчик, не
 * завязанный на календарные особенности (ISO-недели, начало года).
 */
function weekIndex(now: Date): number {
  return Math.floor(now.getTime() / (7 * 86_400_000));
}

export async function pickDigest(now: Date = new Date()): Promise<DigestPick | { kind: DigestKind; reason: string }> {
  const kind = DIGEST_KINDS[weekIndex(now) % DIGEST_KINDS.length];

  if (kind === "NEW_THIS_WEEK") {
    const since = new Date(now.getTime() - 7 * 86_400_000);
    const rows = await prisma.property.findMany({
      where: { ...CANDIDATE_BASE_WHERE, postApprovedAt: { gte: since } },
      orderBy: { postApprovedAt: "desc" },
      take: DIGEST_MAX_PROPERTIES,
      select: CANDIDATE_SELECT,
    });
    if (rows.length < DIGEST_MIN_PROPERTIES) return { kind, reason: `новых объектов за неделю только ${rows.length}, нужно минимум ${DIGEST_MIN_PROPERTIES}` };
    return { kind, title: "Новое за неделю", properties: rows.map(toCandidate) };
  }

  if (kind === "ROOMS") {
    const groups = await prisma.property.groupBy({
      by: ["districtId", "rooms"],
      where: { ...CANDIDATE_BASE_WHERE, districtId: { not: null }, rooms: { not: null } },
      _count: { _all: true },
      orderBy: { _count: { id: "desc" } },
      take: 1,
    });
    const top = groups[0];
    if (!top || top._count._all < DIGEST_MIN_PROPERTIES) {
      return { kind, reason: `самая частая комбинация комнат/района набрала только ${top?._count._all ?? 0}` };
    }
    const district = top.districtId ? await prisma.district.findUnique({ where: { id: top.districtId }, select: { name: true } }) : null;
    const rows = await prisma.property.findMany({
      where: { ...CANDIDATE_BASE_WHERE, districtId: top.districtId, rooms: top.rooms },
      orderBy: { createdAt: "desc" },
      take: DIGEST_MAX_PROPERTIES,
      select: CANDIDATE_SELECT,
    });
    if (rows.length < DIGEST_MIN_PROPERTIES) return { kind, reason: `объектов набралось только ${rows.length}` };
    return { kind, title: `${top.rooms}-комнатные в ${district?.name ?? "районе"}`, properties: rows.map(toCandidate) };
  }

  // DISTRICT_BUDGET — район с наибольшим числом AVAILABLE квартир, бюджет —
  // медиана цен (в сомони) в нём, округлённая вверх до 50 000, 3-5 объектов
  // ДЕШЕВЛЕ бюджета.
  const districtGroups = await prisma.property.groupBy({
    by: ["districtId"],
    where: { ...CANDIDATE_BASE_WHERE, districtId: { not: null } },
    _count: { _all: true },
    orderBy: { _count: { id: "desc" } },
    take: 1,
  });
  const topDistrict = districtGroups[0];
  if (!topDistrict || topDistrict._count._all < DIGEST_MIN_PROPERTIES) {
    return { kind, reason: `в самом населённом районе только ${topDistrict?._count._all ?? 0} объектов` };
  }
  const district = topDistrict.districtId ? await prisma.district.findUnique({ where: { id: topDistrict.districtId }, select: { name: true } }) : null;
  const districtProps = await prisma.property.findMany({
    where: { ...CANDIDATE_BASE_WHERE, districtId: topDistrict.districtId },
    select: CANDIDATE_SELECT,
  });
  const money = await loadMoneyContext();
  const pricesTjs = districtProps
    .map((p) => (p.currency === "USD" ? toTjs(Number((p.price as { toString(): string }).toString()), "USD", money) : Number((p.price as { toString(): string }).toString())))
    .sort((a, b) => a - b);
  const budget = roundUpTo50k(median(pricesTjs));
  const cheaper = districtProps
    .map((p) => ({
      row: p,
      priceTjs: p.currency === "USD" ? toTjs(Number((p.price as { toString(): string }).toString()), "USD", money) : Number((p.price as { toString(): string }).toString()),
    }))
    .filter((x) => x.priceTjs <= budget)
    .sort((a, b) => a.priceTjs - b.priceTjs)
    .slice(0, DIGEST_MAX_PROPERTIES);
  if (cheaper.length < DIGEST_MIN_PROPERTIES) {
    return { kind, reason: `дешевле бюджета ${budget} сомони только ${cheaper.length} объектов` };
  }
  return {
    kind,
    title: `${cheaper.length} квартир до ${budget.toLocaleString("ru-RU")} сомони в ${district?.name ?? "районе"}`,
    properties: cheaper.map((x) => toCandidate(x.row)),
  };
}

// ---------------------------------------------------------------------------
// Подпись
// ---------------------------------------------------------------------------

/** Экспортирована ради теста (проверяет, что подпись называет номера объектов
 *  подборки, а не только заголовок) — само вычисление приватным быть не обязано. */
export async function digestCaption(title: string, properties: DigestCandidate[]): Promise<string> {
  const money = await loadMoneyContext();
  const lines = properties.map((p, i) => {
    const rooms = p.rooms != null ? `${p.rooms}-комн.` : "студия";
    const area = p.areaSqm != null ? `${Number((p.areaSqm as { toString(): string }).toString())} м²` : "";
    const price = buildPriceDisplay(p.price as number, p.currency, money);
    return `№${p.shortId} · ${p.districtName ?? "район не указан"} · ${rooms} · ${area} · ${price}`;
  });
  const firstDistrict = properties.find((p) => p.districtName)?.districtName ?? null;
  const hashtags = buildReelsHashtags(firstDistrict, null);
  return withPostFooter(`${title}\n\n${lines.join("\n")}\n\nПишите в директ или звоните: ${CONTACT_NUMBERS}\n${hashtags}`, properties[0]?.shortId ?? 0);
}

// ---------------------------------------------------------------------------
// Публикация
// ---------------------------------------------------------------------------

const DIGEST_CHANNELS = ["INSTAGRAM", "FACEBOOK", "TELEGRAM"] as const;
type DigestChannel = (typeof DIGEST_CHANNELS)[number];

export interface DigestRunResult {
  ran: boolean;
  reason?: string;
  kind?: DigestKind;
  candidateCount?: number;
  published?: number;
  failed?: number;
}

async function upsertDigestRecord(
  id: string | undefined,
  base: { kind: DigestKind; title: string; propertyIds: string[]; channel: DigestChannel },
  data: {
    status: "PUBLISHED" | "FAILED";
    publishedAt?: Date;
    mediaId?: string | null;
    secondaryId?: string | null;
    permalink?: string | null;
    error?: string | null;
  }
): Promise<void> {
  // PUBLISHED снимает метку захвата «публикуется» (см. DIGEST_CLAIM_MARK).
  const row = data.status === "PUBLISHED" ? { ...data, error: null } : data;
  if (id) {
    await prisma.socialDigestPost.update({ where: { id }, data: row });
  } else {
    await prisma.socialDigestPost.create({ data: { ...base, ...row } });
  }
}

/**
 * МЕТКА ЗАХВАТА строки SCHEDULED (аудит 04.10.2026, PUB08): подборку, чей слот
 * наступил, публикует либо тот же тик, что её создал, либо следующий (добор). Пока
 * кто-то публикует, строки несут эту метку в `error` — второй тик не берёт их
 * (условное обновление error: null → метка), и подборка не выходит дважды. Исход
 * публикации затирает метку (PUBLISHED — null, FAILED — текст отказа). Новой колонки
 * нет сознательно: статус и error — строки, миграция не нужна.
 */
const DIGEST_CLAIM_MARK = "публикуется";
/** Подборка, не вышедшая в свой слот дольше этого, не публикуется: запоздавшая на часы «подборка недели» не нужна. */
const DIGEST_DUE_MAX_LATE_MS = 6 * 3_600_000

/**
 * Публикует одну подборку по всем трём каналам — best-effort, отказ одного не
 * останавливает остальные (тот же принцип, что у публикации фото-постов и
 * повторов). `recordIds` — три строки SCHEDULED, уже созданные под замком
 * слота (см. runSocialDigestsTick) — публикация обновляет их на месте, а не
 * создаёт новые, чтобы SocialDigestPost.scheduledAt честно отражал занятый слот.
 */
async function publishDigest(pick: DigestPick, recordIds: Record<DigestChannel, string>): Promise<{ published: number; failed: number }> {
  const images: { url: string; path: string }[] = [];
  for (const p of pick.properties.slice(0, 10)) {
    const prepared = await preparePhotoPostImages(p.id);
    if (prepared && prepared.paths.length > 0) {
      images.push({ path: prepared.paths[0], url: prepared.urls[0] ?? "" });
    }
  }
  if (images.length === 0) {
    const reason = "ни у одного объекта не нашлось фотографии";
    void logSystemError("meta", `Подборка «${pick.title}» не опубликована: ${reason}`);
    await Promise.all(
      DIGEST_CHANNELS.map((channel) =>
        upsertDigestRecord(recordIds[channel], { kind: pick.kind, title: pick.title, propertyIds: pick.properties.map((p) => p.id), channel }, { status: "FAILED", error: reason })
      )
    );
    return { published: 0, failed: DIGEST_CHANNELS.length };
  }

  const caption = await digestCaption(pick.title, pick.properties);
  const propertyIds = pick.properties.map((p) => p.id);
  const creds = await loadCredentials();
  const settings = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { telegramChannelId: true } });
  let published = 0;
  let failed = 0;

  const urls = images.map((i) => i.url).filter((u): u is string => !!u);
  const paths = images.map((i) => i.path);

  let r: PhotoPostPublishResult;
  if (!creds.igToken) {
    r = { ok: false, error: "Instagram не подключён в Настройках" };
  } else if (urls.length === 0) {
    r = { ok: false, error: "Не настроен CRM_PUBLIC_URL — Meta неоткуда забрать фото" };
  } else {
    const identity = await instagramTokenIdentity(creds.igToken);
    r = identity.ok ? await publishInstagramCarousel(pick.properties[0]?.id ?? "digest", identity.id, creds.igToken, urls, caption) : { ok: false, error: identity.error };
  }
  await upsertDigestRecord(
    recordIds.INSTAGRAM,
    { kind: pick.kind, title: pick.title, propertyIds, channel: "INSTAGRAM" },
    r.ok
      ? { status: "PUBLISHED", publishedAt: new Date(), mediaId: r.mediaId ?? null, permalink: r.permalink ?? null }
      : { status: "FAILED", error: r.error ?? "неизвестная ошибка" }
  );
  if (r.ok) published++;
  else {
    failed++;
    if (!r.pending) void logSystemError("meta", `Подборка «${pick.title}» в Instagram не удалась: ${r.error}`);
  }

  if (!creds.pageToken || !creds.pageId) {
    r = { ok: false, error: "Facebook не подключён в Настройках" };
  } else if (urls.length === 0) {
    r = { ok: false, error: "Не настроен CRM_PUBLIC_URL — Meta неоткуда забрать фото" };
  } else {
    r = await publishFacebookPhotoPost(creds.pageId, creds.pageToken, urls, caption);
  }
  await upsertDigestRecord(
    recordIds.FACEBOOK,
    { kind: pick.kind, title: pick.title, propertyIds, channel: "FACEBOOK" },
    r.ok
      ? { status: "PUBLISHED", publishedAt: new Date(), mediaId: r.mediaId ?? null, permalink: r.permalink ?? null }
      : { status: "FAILED", error: r.error ?? "неизвестная ошибка" }
  );
  if (r.ok) published++;
  else {
    failed++;
    void logSystemError("meta", `Подборка «${pick.title}» в Facebook не удалась: ${r.error}`);
  }

  const channelId = settings?.telegramChannelId?.trim();
  if (!channelId) {
    r = { ok: false, error: "Канал Telegram не настроен" };
  } else {
    r = await publishTelegramPhotoPost(channelId, paths, caption);
  }
  await upsertDigestRecord(
    recordIds.TELEGRAM,
    { kind: pick.kind, title: pick.title, propertyIds, channel: "TELEGRAM" },
    r.ok ? { status: "PUBLISHED", publishedAt: new Date(), secondaryId: r.secondaryId ?? null } : { status: "FAILED", error: r.error ?? "неизвестная ошибка" }
  );
  if (r.ok) published++;
  else {
    failed++;
    void logSystemError("telegram", `Подборка «${pick.title}» в Telegram не удалась: ${r.error}`);
  }

  return { published, failed };
}

/**
 * ДОБОР ОТЛОЖЕННЫХ ПОДБОРОК (аудит 04.10.2026, PUB08): строки SCHEDULED, чей слот
 * наступил, публикуются тем же publishDigest. Группа — три строки одной подборки
 * (один вид, заголовок, слот и набор объектов). Захват условный (см. DIGEST_CLAIM_MARK):
 * два тика не опубликуют одну подборку дважды. Подборка, опоздавшая больше чем на
 * DIGEST_DUE_MAX_LATE_MS, или потерявшая объекты (проданы, сняты) закрывается
 * отказом с причиной, а не публикуется.
 */
async function publishDueDigests(now: Date): Promise<DigestRunResult | null> {
  const due = await prisma.socialDigestPost.findMany({
    where: { status: "SCHEDULED", scheduledAt: { lte: now } },
    orderBy: { scheduledAt: "asc" },
    take: 30,
  });
  if (due.length === 0) return null;

  const groups = new Map<string, typeof due>();
  for (const row of due) {
    const key = `${row.kind}|${row.title}|${row.scheduledAt!.getTime()}|${row.propertyIds.join(",")}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }

  let published = 0;
  let failed = 0;
  let handled = false;
  let last: { kind: DigestKind; count: number } | null = null;
  for (const rows of groups.values()) {
    const ids = rows.map((r) => r.id);
    const closeAll = async (error: string) => {
      await prisma.socialDigestPost.updateMany({ where: { id: { in: ids }, status: "SCHEDULED" }, data: { status: "FAILED", error } });
      void logSystemError("meta", `Подборка «${rows[0].title}» не опубликована: ${error}`);
      handled = true;
      failed += ids.length;
    };

    if (now.getTime() - rows[0].scheduledAt!.getTime() > DIGEST_DUE_MAX_LATE_MS) {
      await closeAll("подборка не вышла в свой слот и устарела");
      continue;
    }
    // Захват: берёт тот, кто первым сменит error: null на метку.
    const claimed = await prisma.socialDigestPost.updateMany({ where: { id: { in: ids }, status: "SCHEDULED", error: null }, data: { error: DIGEST_CLAIM_MARK } });
    if (claimed.count === 0) continue;

    const wanted = rows[0].propertyIds;
    const found = await prisma.property.findMany({ where: { ...CANDIDATE_BASE_WHERE, id: { in: wanted } }, select: CANDIDATE_SELECT });
    const byId = new Map(found.map((p) => [p.id, p]));
    const properties = wanted.map((id) => byId.get(id)).filter((p): p is NonNullable<typeof p> => !!p).map(toCandidate);
    if (properties.length < DIGEST_MIN_PROPERTIES) {
      await closeAll("объекты подборки ушли из продажи, пока она ждала слота");
      continue;
    }

    const recordIds = Object.fromEntries(rows.map((r) => [r.channel, r.id])) as Record<DigestChannel, string>;
    const result = await publishDigest({ kind: rows[0].kind as DigestKind, title: rows[0].title, properties }, recordIds);
    handled = true;
    published += result.published;
    failed += result.failed;
    last = { kind: rows[0].kind as DigestKind, count: properties.length };
  }
  if (!handled) return null;
  return { ran: true, reason: "добор отложенной подборки", kind: last?.kind, candidateCount: last?.count ?? 0, published, failed };
}
/**
 * Тик крона, раз в 15 минут (образец — lib/dailyStories.ts::runDailyStoriesTick):
 * сама решает, наступил ли день+час (Settings.digestWeekday/digestHourDushanbe)
 * и не запускали ли уже сегодня (Settings.digestLastRunAt) — перезапуск сервера
 * посреди часа не даёт второй прогон. Слот берётся общим замком
 * (PUBLISH_SLOT_LOCK_ID) — три строки SocialDigestPost встают SCHEDULED на
 * найденную минуту, чтобы фото-пост/ролик/повтор её не занял следом, — но сама
 * публикация идёт синхронно тут же, а не фоновым заданием (в отличие от
 * фото-постов/повторов: одна подборка в неделю, а не десятки объектов в час,
 * отдельная очередь не оправдана).
 *
 * `force: true` — кнопка «Собрать подборку сейчас» (POST /marketing/digests/run):
 * явное действие человека обходит день/час/«сегодня уже запускали» ровно как
 * `force` у publishPropertyPhotoPost обходит только рубильник, не остальные
 * проверки — здесь остальных проверок и нет, кроме самого рубильника
 * digestsEnabled, который человек, нажавший кнопку в уже включённом разделе,
 * разумно ожидает обойти тоже (иначе кнопка в выключенном режиме была бы
 * бесполезной ловушкой). digestLastRunAt всё равно обновляется — второй
 * автоматический прогон в тот же день по-прежнему не случится.
 */
export async function runSocialDigestsTick(now: Date = new Date(), options?: { force?: boolean }): Promise<DigestRunResult> {
  const settings = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { digestsEnabled: true, digestWeekday: true, digestHourDushanbe: true, digestLastRunAt: true },
  });
  // Сначала добираем подборки, чей отложенный слот наступил (PUB08). Только при включённом
  // рубильнике: выключенный раздел ничего не публикует; сторонние тики не мешают.
  if (settings?.digestsEnabled) {
    const caughtUp = await publishDueDigests(now);
    if (caughtUp) return caughtUp;
  }

  if (!options?.force) {
    if (!settings?.digestsEnabled) return { ran: false, reason: "выключено" };

    const wall = dushanbeWallClock(now);
    if (wall.getUTCDay() !== settings.digestWeekday) return { ran: false, reason: "не тот день недели" };
    if (wall.getUTCHours() !== settings.digestHourDushanbe) return { ran: false, reason: "не тот час" };

    const todayStart = dushanbeStartOfToday(now);
    if (settings.digestLastRunAt && settings.digestLastRunAt >= todayStart) {
      return { ran: false, reason: "сегодня уже запускали" };
    }
  }

  // Отметка ДО публикации (тот же приём, что у dailyStories.ts): публикация
  // идёт секунды-минуты, а тик крона приходит каждые 15 — без ранней отметки
  // второй тик в тот же час запустил бы вторую подборку поверх первой.
  await prisma.settings.update({ where: { id: "singleton" }, data: { digestLastRunAt: now } });

  const pick = await pickDigest(now);
  if ("reason" in pick) {
    return { ran: true, reason: pick.reason, kind: pick.kind, candidateCount: 0, published: 0, failed: 0 };
  }

  const propertyIds = pick.properties.map((p) => p.id);
  const scheduleRules = (await loadPublishScheduleRules()).rules;
  const { recordIds, scheduledAt } = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${PUBLISH_SLOT_LOCK_ID}::bigint)`;
    const occupied = await loadOccupiedPublishSlots(tx, new Date(now.getTime() - scheduleRules.minGapMin * 60_000));
    const slotAt = nextPublishSlot(now, occupied, scheduleRules).at;
    // Кнопка («force») публикует сразу, поэтому пишет «сейчас», а не выданное будущее:
    // scheduledAt в таблице не должен врать о времени выхода.
    const scheduledAt = options?.force && slotAt.getTime() > now.getTime() ? now : slotAt;
    // Слот наступил — эту подборку публикуем тут же, и строки сразу несут метку
    // захвата, чтобы добор следующего тика не взял их посреди публикации.
    const publishNow = scheduledAt.getTime() <= now.getTime();
    const ids: Partial<Record<DigestChannel, string>> = {};
    for (const channel of DIGEST_CHANNELS) {
      const row = await tx.socialDigestPost.create({
        data: { kind: pick.kind, title: pick.title, propertyIds, channel, status: "SCHEDULED", scheduledAt, error: publishNow ? DIGEST_CLAIM_MARK : null },
      });
      ids[channel] = row.id;
    }
    return { recordIds: ids as Record<DigestChannel, string>, scheduledAt };
  });

  // Слот выдан в будущем (занят или закрыто окно публикаций): подборка ждёт его, а
  // не уходит сейчас в нарушение minGap и окна — её доберёт тик, когда слот наступит
  // (аудит 04.10.2026, PUB08).
  if (scheduledAt.getTime() > now.getTime()) {
    return {
      ran: true,
      reason: `отложено до ${dushanbeDateTimeString(scheduledAt)} (Душанбе): слот занят или окно публикаций закрыто`,
      kind: pick.kind,
      candidateCount: pick.properties.length,
      published: 0,
      failed: 0,
    };
  }

  const { published, failed } = await publishDigest(pick, recordIds);
  return { ran: true, kind: pick.kind, candidateCount: pick.properties.length, published, failed };
}
