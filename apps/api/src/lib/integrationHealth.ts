import { prisma } from "../db.js";
import { logSystemError, type SystemErrorSource } from "./systemError.js";
import { describeError } from "./describeError.js";
import { resolveGeminiRuntime } from "../ai/geminiSettings.js";
import { checkGeminiModel } from "../ai/geminiCheck.js";
import { getChatTitle, getChatMemberStatus, isTelegramEnabled, canBotWriteToChat } from "../telegram/api.js";
import { parseTelegramChatIds } from "./telegramChats.js";
import { loadCredentials, GRAPH_VERSION, instagramApiUrl, instagramRequest, fetchWithRetry } from "../messengers/meta.js";
import { decryptSecretSafe } from "../crypto.js";
import { listAccounts, accountTokenById } from "../messengers/accounts.js";
import { r2HealthCheck } from "./r2Client.js";
import {
  tiktokAccessGrant,
  tiktokCreatorInfo,
  youtubeAccessGrant,
  THREADS_GRAPH_BASE,
  type TikTokCredentials,
} from "./socialPublish.js";
import { listCrosspostWhitelistedPages } from "./facebookCrosspost.js";
import {
  TOKEN_SCOPE_CATALOG,
  describeMissingScopes,
  instagramLoginScopeProbes,
  metaTokenInfo,
  missingScopes,
  type RequiredScope,
  type TokenKind,
} from "./tokenScopes.js";
import { dushanbeDateTimeString } from "./dushanbeTime.js";
import { checkTelephonyDailyHealth } from "./telephony/stationHealth.js";

/**
 * СУТОЧНАЯ САМОПРОВЕРКА ВНЕШНИХ ДОСТУПОВ.
 *
 * Класс проблемы, ради которого написан модуль (карта — docs/TASKS.md, 11.09.2026):
 * доступ к внешнему сервису протухает или отзывается, но система узнаёт об этом
 * только в тот момент, когда доступ реально понадобился — то есть когда клиент
 * уже написал, ролик уже должен был выйти, объект уже помечен «опубликован».
 * Эталон правки — `checkYouTubeTokenHealth()` в socialPublish.ts.
 *
 * Правила, общие для всех проверок здесь:
 *
 * 1. **Ни одна проверка ничего не меняет.** Где у сервиса нет безопасного
 *    read-эндпоинта, используется то, что проверка ключа идёт РАНЬШЕ разбора
 *    тела: заведомо неверное тело даёт 400 при живом ключе и 401 при мёртвом,
 *    и до самого действия выполнение не доходит.
 * 2. **Не настроено — не ошибка.** Незаполненный ключ означает «канал не
 *    используется», и будить этим директора каждое утро нельзя. Исключение —
 *    аварийный сброс пароля админки сайта: там «не настроено» и есть поломка,
 *    потому что узнать о ней в момент нужды уже поздно.
 * 3. **Отказ одной проверки не отменяет остальные.** Каждая обёрнута отдельно:
 *    общий try/catch означал бы, что упавший R2 прячет мёртвый ключ Gemini.
 * 4. **Повторы гасит дедуп `logSystemError`** — сутки подряд одна и та же
 *    строка не размножается, счётчик растёт у одной записи.
 */

/** Проверка — не разговор бота: ждать дольше нет смысла, отказ важнее полноты. */
const CHECK_TIMEOUT_MS = 15_000;

export interface IntegrationCheck {
  /** Как называется в отчёте. */
  name: string;
  /** `true` — жив, `false` — сломан (запись в журнал уже сделана),
   *  `null` — не настроен, проверять нечего. */
  ok: boolean | null;
  /** Короткая причина для лога процесса; в журнал ошибок идёт свой текст. */
  detail?: string;
}

async function report(source: SystemErrorSource, message: string): Promise<void> {
  await logSystemError(source, message);
}

/**
 * Ключ Gemini. Точный двойник бага YouTube: `checkGeminiModel()` был написан
 * ещё 22.08.2026 и даже помечен в собственном комментарии как будущая «утренняя
 * самопроверка», но единственной точкой вызова оставалась кнопка в Настройках.
 * Голосовые от клиентов приходят не каждый день, текст по умолчанию идёт через
 * Claude — мёртвый ключ жил бы неделями, а симптом («бот просит написать
 * текстом») причину не показывает.
 */
export async function checkGeminiHealth(): Promise<IntegrationCheck> {
  const name = "Gemini";
  const runtime = await resolveGeminiRuntime();
  if (runtime.keys.length === 0) return { name, ok: null, detail: "ключ не задан" };

  const result = await checkGeminiModel(runtime.model, runtime.keys);
  if (result.ok) return { name, ok: true, detail: `${result.ms} мс, ключ №${result.keyIndex ?? 1}` };

  await report(
    "ai",
    `Ключ Gemini не работает — расшифровка голосовых и ИИ-режиссёр монтажа откажут: ` +
      `модель ${runtime.model}, ответ Google ${result.status ?? "нет ответа"} — ${result.detail}. ` +
      `Проверить и заменить ключ: Настройки → Ключи.`
  );
  return { name, ok: false, detail: result.detail };
}

/**
 * ОДНА ПРОВЕРКА «БОТ МОЖЕТ ПИСАТЬ В ЧАТ» на основной канал и дополнительные чаты (аудит
 * Codex 04.10, CHANNEL-NEW-15): раньше право публикации проверяли только дополнительные
 * чаты, а основной канал отвечал на getChat и оставался «зелёным» после снятия прав
 * администратора или исключения бота. getChat для публичного канала отвечает и без членства.
 */
async function probeTelegramChatWrite(
  chatId: string
): Promise<{ ok: true; title: string | null } | { ok: false; detail: string }> {
  try {
    const [title, member] = await Promise.all([getChatTitle(chatId), getChatMemberStatus(chatId)]);
    if (!canBotWriteToChat(member)) return { ok: false, detail: `бот не может писать (статус ${member.status})` };
    return { ok: true, title };
  } catch (err) {
    return { ok: false, detail: describeError(err) };
  }
}

/**
 * Кросспост в Telegram-канал. Бота могли исключить из канала или снять с него
 * права админа — публикация ролика тогда молча не доходит, а в CRM объект
 * помечен «опубликован». `getChat` ничего не отправляет в канал.
 */
export async function checkTelegramChannelHealth(): Promise<IntegrationCheck> {
  const name = "Telegram-канал";
  if (!isTelegramEnabled()) return { name, ok: null, detail: "TELEGRAM_BOT_TOKEN не задан" };
  const settings = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { telegramChannelId: true },
  });
  const channelId = settings?.telegramChannelId?.trim();
  if (!channelId) return { name, ok: null, detail: "канал не настроен" };

  const probe = await probeTelegramChatWrite(channelId);
  if (probe.ok) return { name, ok: true, detail: probe.title ?? channelId };
  await report(
    "telegram",
    `Бот не имеет доступа к Telegram-каналу ${channelId} — кросспост роликов не дойдёт: ${probe.detail}. ` +
      `Проверить, что бот всё ещё админ канала.`
  );
  return { name, ok: false, detail: probe.detail };
}

/**
 * ДОПОЛНИТЕЛЬНЫЕ ЧАТЫ TELEGRAM (26.09.2026, «ролик в несколько групп») — та же
 * суточная проверка, что и у основного канала выше (checkTelegramChannelHealth),
 * по каждому настроенному дополнительному чату отдельно: отказ одного не должен
 * прятать отказ другого, поэтому отдельный report() на чат, а не общий на весь
 * список (правило 3 докстринга файла).
 */
export async function checkTelegramExtraChatsHealth(): Promise<IntegrationCheck[]> {
  if (!isTelegramEnabled()) return [];
  const settings = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { telegramChannelId: true, telegramExtraChatIds: true },
  });
  const chatIds = parseTelegramChatIds(settings?.telegramExtraChatIds ?? null, settings?.telegramChannelId ?? null);

  const results: IntegrationCheck[] = [];
  for (const chatId of chatIds) {
    const name = `Telegram-чат ${chatId}`;
    const probe = await probeTelegramChatWrite(chatId);
    if (probe.ok) {
      results.push({ name, ok: true, detail: probe.title ?? chatId });
    } else {
      await report("telegram", `Бот не может писать в чат ${chatId}: ${probe.detail}`);
      results.push({ name, ok: false, detail: probe.detail });
    }
  }
  return results;
}

/**
 * Аккаунт канала, которым бы CRM ответила по умолчанию — ТОТ ЖЕ порядок выбора,
 * что и в resolveIncomingAccount (messengers/accounts.ts:139-217), без ветки
 * «точное совпадение по externalId»: у проверки здоровья нет конкретного входящего,
 * который надо доставить, поэтому ветка exact там взяться неоткуда и заведомо
 * пуста — единственная содержательная часть выбора это она и есть.
 *
 * `null` — аккаунтов канала в таблице нет вовсе; вызывающий откатывается на
 * Settings, как и resolveIncomingAccount.
 */
async function pickAccountForHealth(channel: string) {
  const rows = await listAccounts(channel);
  if (rows.length === 0) return null;
  return rows.find((r) => r.isDefault && r.enabled) ?? rows.find((r) => r.enabled) ?? rows[0];
}

/** Общий read-запрос к Graph API: спрашивает у объекта только его собственный id. */
async function graphIdReadable(objectId: string, token: string): Promise<{ ok: boolean; detail: string }> {
  const url =
    `https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(objectId)}` +
    `?fields=id&access_token=${encodeURIComponent(token)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) });
  const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
  if (res.ok) return { ok: true, detail: `HTTP ${res.status}` };
  return { ok: false, detail: `HTTP ${res.status}: ${body.error?.message ?? "без пояснения"}` };
}

/**
 * Токен Страницы Facebook (переписка в Messenger). Ни продления, ни срока жизни
 * в коде не описано — в отличие от Instagram и рекламного кабинета, у которых
 * TTL прописан и есть автопродление. Канал живой, поэтому смерть токена заметна
 * быстро, но первый написавший клиент ответа уже не получит.
 *
 * СНАЧАЛА MessengerAccount, Settings — ЗАПАСНОЙ ПУТЬ (14.09.2026). Раньше
 * проверка смотрела ТОЛЬКО в Settings.metaPageToken/metaPageId, а рабочий маркер
 * может лежать в подключённом аккаунте (Настройки → Каналы) — ровно тот разрыв,
 * что уже нашёлся у Instagram (см. instagramFeed.ts, разбор того же дня).
 * Аккаунт выбирается тем же порядком, что и resolveIncomingAccount, — см.
 * pickAccountForHealth выше.
 */
export async function checkMetaPageTokenHealth(): Promise<IntegrationCheck> {
  const name = "Facebook Page";
  const account = await pickAccountForHealth("FACEBOOK");
  const creds = await loadCredentials();
  const pageId = account?.externalId || creds.pageId;
  const pageToken = account ? (await accountTokenById(account.id, "FACEBOOK")).token : creds.pageToken;
  if (!pageToken || !pageId) return { name, ok: null, detail: "не настроен" };

  try {
    const r = await graphIdReadable(pageId, pageToken);
    if (r.ok) return { name, ok: true, detail: r.detail };
    await report(
      "meta",
      `Токен Страницы Facebook${account ? ` «${account.title}»` : ""} не работает — бот не сможет отвечать в ` +
        `Messenger: ${r.detail}. Выпустить новый вечный Page Token и записать в Настройки → Каналы.`
    );
    return { name, ok: false, detail: r.detail };
  } catch (err) {
    await report("meta", `Проверка токена Страницы Facebook не удалась: ${describeError(err)}`);
    return { name, ok: false, detail: describeError(err) };
  }
}

/**
 * Токен WhatsApp Cloud API — тот же случай, что и Страница, но это основной канал
 * продаж. СНАЧАЛА MessengerAccount, Settings — ЗАПАСНОЙ ПУТЬ, тем же приёмом и по
 * той же причине, что и у Facebook Page выше.
 */
export async function checkMetaWhatsappTokenHealth(): Promise<IntegrationCheck> {
  const name = "WhatsApp";
  const account = await pickAccountForHealth("WHATSAPP");
  const creds = await loadCredentials();
  const phoneId = account?.externalId || creds.waPhoneId;
  const waToken = account ? (await accountTokenById(account.id, "WHATSAPP")).token : creds.waToken;
  if (!waToken || !phoneId) return { name, ok: null, detail: "не настроен" };

  try {
    const r = await graphIdReadable(phoneId, waToken);
    if (r.ok) return { name, ok: true, detail: r.detail };
    await report(
      "meta",
      `Токен WhatsApp${account ? ` «${account.title}»` : ""} не работает — бот не сможет отвечать клиентам в ` +
        `WhatsApp: ${r.detail}. Заменить маркер в Настройках → Каналы.`
    );
    return { name, ok: false, detail: r.detail };
  } catch (err) {
    await report("meta", `Проверка токена WhatsApp не удалась: ${describeError(err)}`);
    return { name, ok: false, detail: describeError(err) };
  }
}

/** До смерти маркера Instagram (60 дней) остаётся запас — предупреждаем заранее,
 *  а не когда автопродление (раз в неделю) уже не успеет попробовать снова. */
const STALE_WARNING_DAYS = 50;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Маркеры ВСЕХ подключённых аккаунтов Instagram — по одной строке на аккаунт,
 * а не одна строка на канал (14.09.2026, тот же разбор, что у refreshInstagramTokenIfDue
 * в instagramFeed.ts). У канала обычно два аккаунта («Royal Home», «Royal Home Info»),
 * и то, что проверка раньше знала только Settings.metaIgToken, ЗНАЧИЛО, что смерть
 * рабочего маркера конкретного аккаунта эта проверка не заметила бы вовсе —
 * «Здоровье системы» осталось бы зелёным, пока аккаунт молчит клиентам.
 *
 * Не настроено (аккаунтов нет вовсе) — одна строка "не настроен", как и у
 * остальных проверок файла.
 */
export async function checkInstagramAccountsHealth(): Promise<IntegrationCheck[]> {
  const rows = await prisma.messengerAccount.findMany({
    where: { channel: "INSTAGRAM" },
    select: { id: true, title: true, token: true, tokenRefreshedAt: true, updatedAt: true },
  });
  if (rows.length === 0) return [{ name: "Instagram", ok: null, detail: "не настроен" }];

  const out: IntegrationCheck[] = [];
  for (const row of rows) {
    const name = `Instagram «${row.title}»`;
    const token = decryptSecretSafe(row.token);
    if (!token) {
      out.push({ name, ok: null, detail: "маркер не задан" });
      continue;
    }

    try {
      const req = instagramRequest(instagramApiUrl(`/${GRAPH_VERSION}/me?fields=id,username`), token);
      const res = await fetchWithRetry(req.url, { headers: req.headers }, CHECK_TIMEOUT_MS);
      const body = (await res.json().catch(() => ({}))) as { username?: string; error?: { message?: string } };
      if (res.ok) {
        out.push({ name, ok: true, detail: body.username ? `@${body.username}` : `HTTP ${res.status}` });
      } else {
        const detail = `HTTP ${res.status}: ${body.error?.message ?? "без пояснения"}`;
        await report(
          "meta",
          `Маркер Instagram «${row.title}» не работает — аккаунт не сможет отвечать клиентам: ${detail}. ` +
            `Проверить в Настройках → Каналы.`
        );
        out.push({ name, ok: false, detail });
      }
    } catch (err) {
      await report("meta", `Проверка маркера Instagram «${row.title}» не удалась: ${describeError(err)}`);
      out.push({ name, ok: false, detail: describeError(err) });
    }

    // Предупреждение о старости — НЕЗАВИСИМО от того, жив ли маркер прямо сейчас:
    // именно этого сигнала не хватило 14.09.2026 (см. instagramFeed.ts) — маркер
    // ещё отвечал на запрос выше, а автопродление его неделями не касалось.
    const lastRefreshed = row.tokenRefreshedAt ?? row.updatedAt;
    const ageDays = Math.floor((Date.now() - lastRefreshed.getTime()) / DAY_MS);
    if (ageDays > STALE_WARNING_DAYS) {
      await report(
        "meta",
        `Маркер Instagram «${row.title}» не продлевался ${ageDays} дней — при 60 днях жизни маркера запас почти ` +
          `исчерпан. Проверить автопродление (крон refreshInstagramTokenIfDue) и Настройки → Каналы.`
      );
    }
  }
  return out;
}

/**
 * Токен TikTok (17.09.2026) — по образцу checkYouTubeTokenHealth (socialPublish.ts):
 * обмен refresh→access ничего не публикует и не тратит квоту загрузки, поэтому
 * можно звать каждые сутки. Заодно проверяет creator_info/query — тот же вызов,
 * что делает publishTikTokVideo перед публикацией, так что «жив» здесь означает
 * «публикация тоже пройдёт», не только «токен не просрочен».
 */
/** Права TikTok из последнего обмена в checkTikTokTokenHealth (null — обмена не
 *  было или он не удался). */
let lastTikTokScopes: string[] | null = null;

export async function checkTikTokTokenHealth(): Promise<IntegrationCheck> {
  lastTikTokScopes = null;
  const name = "TikTok";
  const settings = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { tiktokClientKey: true, tiktokClientSecret: true, tiktokRefreshToken: true },
  });
  const creds: TikTokCredentials = {
    clientKey: settings?.tiktokClientKey ?? undefined,
    clientSecret: decryptSecretSafe(settings?.tiktokClientSecret ?? null) ?? undefined,
    refreshToken: decryptSecretSafe(settings?.tiktokRefreshToken ?? null) ?? undefined,
  };
  if (!creds.clientKey || !creds.clientSecret || !creds.refreshToken) return { name, ok: null, detail: "не настроен" };

  try {
    const grant = await tiktokAccessGrant(creds);
    // Права — из того же обмена: второй обмен ради них снова повернул бы
    // refresh_token (TikTok выдаёт новый на каждый), см. checkTokenScopesHealth.
    lastTikTokScopes = grant.scopes;
    const accessToken = grant.accessToken;
    const info = await tiktokCreatorInfo(accessToken);
    return { name, ok: true, detail: info.creatorUsername ?? "доступ жив" };
  } catch (err) {
    await report(
      "tiktok",
      `Доступ к TikTok потерян — автопубликация роликов работать не будет: ${describeError(err)}. ` +
        `Нужно переподключить аккаунт в Настройках → Каналы связи.`
    );
    return { name, ok: false, detail: describeError(err) };
  }
}

/**
 * Токен Threads (23.09.2026) — простой `GET /me`: сам обмен долгий/короткий
 * токен уже сделан заранее (refreshThreadsTokenIfDue, cron.ts), здесь только
 * проверяем, что сохранённый токен ещё принимается площадкой. В отличие от
 * checkTikTokTokenHealth ничего не обменивает и не поворачивает токен —
 * Threads не выдаёт новый access_token на каждое обращение.
 */
export async function checkThreadsTokenHealth(): Promise<IntegrationCheck> {
  const name = "Threads";
  const settings = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { threadsAccessToken: true, threadsUserId: true, threadsUsername: true },
  });
  const accessToken = decryptSecretSafe(settings?.threadsAccessToken ?? null);
  if (!accessToken || !settings?.threadsUserId) return { name, ok: null, detail: "не настроен" };

  try {
    const url = `${THREADS_GRAPH_BASE}/v1.0/me?fields=id,username&access_token=${encodeURIComponent(accessToken)}`;
    const res = await fetchWithRetry(url, {}, 15_000);
    const body = (await res.json().catch(() => ({}))) as { username?: string; error?: { message?: string } };
    if (!res.ok) throw new Error(body.error?.message ?? `HTTP ${res.status}`);
    return { name, ok: true, detail: body.username ?? settings.threadsUsername ?? "доступ жив" };
  } catch (err) {
    await report(
      "threads",
      `Доступ к Threads потерян — автопубликация постов работать не будет: ${describeError(err)}. ` +
        `Нужно переподключить аккаунт в Настройках → Каналы связи.`
    );
    return { name, ok: false, detail: describeError(err) };
  }
}

/**
 * Ключи Cloudflare R2. Обслуживают только вложения чата и записи звонков до
 * 07.08.2026 — то есть отзыв ключей обнаружился бы через месяцы, когда кто-то
 * попробует открыть архивный файл. HEAD по бакету ничего не читает и не пишет.
 */
export async function checkR2Health(): Promise<IntegrationCheck> {
  const name = "Cloudflare R2";
  try {
    const status = await r2HealthCheck();
    if (status === null) return { name, ok: null, detail: "не настроен" };
    if (status >= 200 && status < 300) return { name, ok: true, detail: `HTTP ${status}` };
    await report(
      "storage",
      `Доступ к хранилищу R2 потерян (HTTP ${status}) — старые вложения чата и записи звонков до 07.08 не откроются. ` +
        `Проверить ключи R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY в окружении.`
    );
    return { name, ok: false, detail: `HTTP ${status}` };
  } catch (err) {
    await report("storage", `Проверка доступа к R2 не удалась: ${describeError(err)}`);
    return { name, ok: false, detail: describeError(err) };
  }
}

/**
 * Общий приём для сайта: ключ на стороне сайта сверяется РАНЬШЕ разбора тела
 * (`api/crm-sync-router.ts`), поэтому заведомо неверное тело — безопасный
 * способ проверить именно ключ. 401 — ключ мёртв, 400 — ключ верный и запрос
 * отвергнут на схеме, до самого действия дело не дошло.
 */
async function siteKeyProbe(path: string, apiKey: string, body: unknown): Promise<{ status: number; text: string }> {
  const url = `${process.env.SITE_SYNC_URL}${path}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Api-Key": apiKey },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
  });
  return { status: res.status, text: (await res.text().catch(() => "")).slice(0, 200) };
}

/** Рабочий ключ синхронизации объектов с royalhome.tj. */
export async function checkSiteSyncKeyHealth(): Promise<IntegrationCheck> {
  const name = "Синхронизация с сайтом";
  const apiKey = process.env.SITE_SYNC_API_KEY;
  if (!process.env.SITE_SYNC_URL || !apiKey) return { name, ok: null, detail: "не настроена" };

  try {
    // Пустой объект не проходит схему сайта — значит ни одна публикация не
    // выполняется, но ключ уже проверен.
    const { status, text } = await siteKeyProbe("/listings", apiKey, {});
    if (status === 400) return { name, ok: true, detail: "ключ принят" };
    await report(
      "site-sync",
      `Ключ синхронизации с сайтом не принят — публикация объектов на royalhome.tj работать не будет: ` +
        `сайт ответил HTTP ${status} ${text}. Сверить SITE_SYNC_API_KEY в CRM и CRM_SYNC_API_KEY на сайте.`
    );
    return { name, ok: false, detail: `HTTP ${status}` };
  } catch (err) {
    await report("site-sync", `Проверка связи с сайтом не удалась: ${describeError(err)}`);
    return { name, ok: false, detail: describeError(err) };
  }
}

/**
 * Ключ аварийного сброса пароля админки сайта.
 *
 * Единственная проверка, где «не настроено» — это ПОЛОМКА, а не «канал не
 * используется»: ключом пользуются ровно один раз, в аварии, и узнать что он
 * мёртв в тот самый момент — худший из возможных вариантов. На 11.09.2026
 * `SITE_SYNC_ADMIN_RESET_KEY` на проде отсутствовал вовсе.
 *
 * Тело намеренно неверного типа (`resetTotp` строкой вместо boolean): сайт
 * сверит ключ, отвергнет тело на схеме и НЕ выдаст ссылку на смену пароля.
 */
export async function checkSiteAdminResetKeyHealth(): Promise<IntegrationCheck> {
  const name = "Аварийный сброс админки сайта";
  const url = process.env.SITE_SYNC_URL;
  const apiKey = process.env.SITE_SYNC_ADMIN_RESET_KEY;
  if (!url) return { name, ok: null, detail: "связь с сайтом не настроена" };
  if (!apiKey) {
    await report(
      "site-sync",
      `Аварийный сброс пароля админки сайта недоступен: SITE_SYNC_ADMIN_RESET_KEY не задан в окружении CRM. ` +
        `Понадобится он ровно в тот момент, когда доступ к админке уже потерян, — задать заранее.`
    );
    return { name, ok: false, detail: "ключ не задан" };
  }

  try {
    const { status, text } = await siteKeyProbe("/admin-reset", apiKey, { resetTotp: "__healthcheck__" });
    if (status === 400) return { name, ok: true, detail: "ключ принят" };
    await report(
      "site-sync",
      `Ключ аварийного сброса пароля админки сайта не принят: сайт ответил HTTP ${status} ${text}. ` +
        `Сверить SITE_SYNC_ADMIN_RESET_KEY в CRM и CRM_SYNC_ADMIN_RESET_KEY на сайте.`
    );
    return { name, ok: false, detail: `HTTP ${status}` };
  } catch (err) {
    await report("site-sync", `Проверка ключа аварийного сброса не удалась: ${describeError(err)}`);
    return { name, ok: false, detail: describeError(err) };
  }
}

/**
 * Телефония (20.09.2026) — только та часть сводной проверки станции, которую
 * незачем гонять каждые 15 минут (сверка AstDB запасного пути со станцией, см.
 * шапку telephony/stationHealth.ts): остальные, более срочные проверки уже
 * крутятся своим отдельным 15-минутным тиком в cron.ts и пишут в тот же снимок
 * IntegrationHealthSnapshot напрямую. Здесь — просто ещё одна строка в тот же
 * суточный список, без третьего параллельного механизма.
 */
async function checkTelephonyHealth(): Promise<IntegrationCheck> {
  const result = await checkTelephonyDailyHealth();
  return { name: result.name, ok: result.ok, detail: result.detail };
}

// ─── Права маркеров (23.09.2026) ─────────────────────────────────────────────

/** Строка проверки прав и, если чего-то не хватает, запись в журнал с тем, что
 *  нажать. Имя строки начинается с «Права:» — на экране «Здоровье системы» она
 *  стоит рядом со строкой «маркер жив» того же канала. */
async function scopeRow(
  source: SystemErrorSource,
  kind: TokenKind,
  label: string,
  missing: RequiredScope[] | null,
  note?: string
): Promise<IntegrationCheck> {
  const name = `Права: ${label}`;
  const tail = note ? `; ${note}` : "";
  if (missing === null) return { name, ok: null, detail: `права узнать не удалось${tail}` };
  if (missing.length === 0) return { name, ok: true, detail: `все ${TOKEN_SCOPE_CATALOG[kind].scopes.filter((s) => !s.awaitingApproval).length} прав на месте${tail}` };
  const detail = describeMissingScopes(kind, missing);
  await report(
    source,
    `${label}: ${detail}. Эти возможности CRM не работают, пока маркер не перевыпущен со всеми правами — ` +
      `полный список прав каждого маркера в apps/api/src/lib/tokenScopes.ts, инструкция в треде проекта.`
  );
  return { name, ok: false, detail: `${detail}${tail}` };
}

function expiryNote(expiresAt: Date | null): string {
  return expiresAt ? `истекает ${dushanbeDateTimeString(expiresAt)}` : "бессрочный";
}

async function metaScopeRow(kind: TokenKind, label: string, token: string | undefined): Promise<IntegrationCheck | null> {
  if (!token) return null;
  const info = await metaTokenInfo(token);
  if (!info) return scopeRow("meta", kind, label, null);
  return scopeRow("meta", kind, label, missingScopes(kind, info.scopes), expiryNote(info.expiresAt));
}

/**
 * ХВАТАЕТ ЛИ МАРКЕРАМ ПРАВ — по списку lib/tokenScopes.ts, а не «жив ли маркер».
 *
 * Проверки выше отвечают, открывается ли дверь. Эта — все ли двери открываются:
 * маркер Страницы, выпущенный под Messenger, жив и зелёный, но комментарии им не
 * скрыть; refresh-токен YouTube с одним youtube.upload публикует ролики, но
 * комментарии не читает. Такие маркеры до 23.09.2026 узнавались по поломке, и
 * владелец перевыпускал их «каждые несколько дней» по одному праву за раз.
 *
 * Не настроено — строки нет вовсе (правило 2 файла). Узнать права не удалось —
 * строка с ok = null и без тревоги: это не «прав нет».
 */
export async function checkTokenScopesHealth(): Promise<IntegrationCheck[]> {
  const out: IntegrationCheck[] = [];
  const push = (row: IntegrationCheck | null) => {
    if (row) out.push(row);
  };
  const creds = await loadCredentials();

  // Страница Facebook и WhatsApp — тем же выбором аккаунта, что проверки «жив ли».
  const page = await pickAccountForHealth("FACEBOOK");
  const pageToken = page ? (await accountTokenById(page.id, "FACEBOOK")).token : creds.pageToken;
  push(await metaScopeRow("FACEBOOK_PAGE", TOKEN_SCOPE_CATALOG.FACEBOOK_PAGE.title, pageToken));

  const wa = await pickAccountForHealth("WHATSAPP");
  const waToken = wa ? (await accountTokenById(wa.id, "WHATSAPP")).token : creds.waToken;
  push(await metaScopeRow("WHATSAPP", TOKEN_SCOPE_CATALOG.WHATSAPP.title, waToken));

  const s = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: {
      metaIgManageToken: true,
      metaAdsEnabled: true,
      metaAdsToken: true,
      youtubeClientId: true,
      youtubeClientSecret: true,
      youtubeRefreshToken: true,
    },
  });
  push(
    await metaScopeRow(
      "INSTAGRAM_MANAGE",
      TOKEN_SCOPE_CATALOG.INSTAGRAM_MANAGE.title,
      decryptSecretSafe(s?.metaIgManageToken ?? null) || undefined
    )
  );
  if (s?.metaAdsEnabled) {
    push(
      await metaScopeRow("META_ADS", TOKEN_SCOPE_CATALOG.META_ADS.title, decryptSecretSafe(s.metaAdsToken ?? null) || undefined)
    );
  }

  // Instagram — каждый аккаунт отдельно: у каждого свой маркер и свой набор прав.
  const igRows = await prisma.messengerAccount.findMany({
    where: { channel: "INSTAGRAM" },
    select: { title: true, token: true },
  });
  const igTokens: { label: string; token: string }[] = igRows
    .map((r) => ({ label: `Instagram «${r.title}»`, token: decryptSecretSafe(r.token) || "" }))
    .filter((r) => r.token);
  if (igTokens.length === 0 && creds.igToken) igTokens.push({ label: "Instagram", token: creds.igToken });
  for (const ig of igTokens) {
    const probes = await instagramLoginScopeProbes(ig.token);
    const known = Object.values(probes).some((p) => p !== "unknown");
    const missing = TOKEN_SCOPE_CATALOG.INSTAGRAM.scopes.filter((sc) => probes[sc.scope] === "missing");
    const unknown = TOKEN_SCOPE_CATALOG.INSTAGRAM.scopes.filter((sc) => probes[sc.scope] === "unknown").length;
    push(
      await scopeRow(
        "meta",
        "INSTAGRAM",
        ig.label,
        known ? missing : null,
        unknown && known ? `не проверено прав: ${unknown}` : undefined
      )
    );
  }

  // YouTube — права в поле scope того же обмена refresh→access.
  const ytSecret = decryptSecretSafe(s?.youtubeClientSecret ?? null) || undefined;
  const ytRefresh = decryptSecretSafe(s?.youtubeRefreshToken ?? null) || undefined;
  if (s?.youtubeClientId && ytSecret && ytRefresh) {
    try {
      const grant = await youtubeAccessGrant({ clientId: s.youtubeClientId, clientSecret: ytSecret, refreshToken: ytRefresh });
      push(
        await scopeRow(
          "youtube",
          "YOUTUBE",
          TOKEN_SCOPE_CATALOG.YOUTUBE.title,
          grant.scopes.length ? missingScopes("YOUTUBE", grant.scopes) : null
        )
      );
    } catch {
      // Мёртвый refresh-токен — забота checkYouTubeTokenHealth (cron.ts), здесь
      // вторая тревога о том же была бы лишней.
      push(await scopeRow("youtube", "YOUTUBE", TOKEN_SCOPE_CATALOG.YOUTUBE.title, null));
    }
  }

  // TikTok — из обмена, который уже сделала checkTikTokTokenHealth.
  if (lastTikTokScopes) {
    push(
      await scopeRow(
        "tiktok",
        "TIKTOK",
        TOKEN_SCOPE_CATALOG.TIKTOK.title,
        lastTikTokScopes.length ? missingScopes("TIKTOK", lastTikTokScopes) : null
      )
    );
  }

  return out;
}

/**
 * КРОССПОСТИНГ НА ПАРТНЁРСКИЕ СТРАНИЦЫ FACEBOOK (28.09.2026) — список
 * Settings.facebookCrosspostPageIds сверяется с тем, что реально подтвердила
 * каждая Страница у себя (`crosspost_whitelisted_pages`). Пустой список — не
 * настроено, ни одной проверки. Каждый id — своя строка, отказ одного не
 * останавливает проверку остальных (тот же приём, что checkInstagramAccountsHealth).
 */
export async function checkFacebookCrosspostHealth(): Promise<IntegrationCheck[]> {
  const settings = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { facebookCrosspostPageIds: true },
  });
  const pageIds = settings?.facebookCrosspostPageIds ?? [];
  if (pageIds.length === 0) return [];

  const creds = await loadCredentials();
  if (!creds.pageToken || !creds.pageId) {
    return [{ name: "Facebook Кросспостинг", ok: null, detail: "маркер Страницы не настроен" }];
  }

  let whitelisted: { id: string; name: string }[];
  try {
    whitelisted = await listCrosspostWhitelistedPages(creds.pageId, creds.pageToken);
  } catch (err) {
    await report("meta", `Проверка партнёрских Страниц для кросспостинга не удалась: ${describeError(err)}`);
    return [{ name: "Facebook Кросспостинг", ok: false, detail: describeError(err) }];
  }

  const whitelistedIds = new Set(whitelisted.map((p) => p.id));
  const out: IntegrationCheck[] = [];
  for (const pageId of pageIds) {
    const name = `Кросспостинг «${pageId}»`;
    if (whitelistedIds.has(pageId)) {
      out.push({ name, ok: true });
      continue;
    }
    await report(
      "meta",
      `Страница ${pageId} не подтвердила кросспостинг с нашей: Настройки Страницы → Crossposting.`
    );
    out.push({ name, ok: false, detail: "не подтверждена" });
  }
  return out;
}

/**
 * Прогоняет все проверки. Каждая обёрнута отдельно: упавшая проверка не
 * отменяет остальные и сама попадает в журнал.
 */
export async function runIntegrationHealthChecks(): Promise<IntegrationCheck[]> {
  const checks: Array<[string, () => Promise<IntegrationCheck>]> = [
    ["Gemini", checkGeminiHealth],
    ["Telegram-канал", checkTelegramChannelHealth],
    ["Facebook Page", checkMetaPageTokenHealth],
    ["WhatsApp", checkMetaWhatsappTokenHealth],
    ["TikTok", checkTikTokTokenHealth],
    ["Threads", checkThreadsTokenHealth],
    ["Cloudflare R2", checkR2Health],
    ["Синхронизация с сайтом", checkSiteSyncKeyHealth],
    ["Аварийный сброс админки сайта", checkSiteAdminResetKeyHealth],
    ["Телефония (запасной путь)", checkTelephonyHealth],
  ];

  const results: IntegrationCheck[] = [];
  for (const [name, run] of checks) {
    try {
      results.push(await run());
    } catch (err) {
      // Сюда попадает только сбой самой обёртки — сами проверки ошибки ловят.
      const reason = describeError(err);
      void logSystemError("cron", `Проверка доступа «${name}» не выполнена: ${reason}`);
      results.push({ name, ok: false, detail: reason });
    }
  }

  // Instagram — отдельно: одна проверка канала выше отдаёт ОДНУ IntegrationCheck,
  // а у Instagram аккаунтов на канал обычно два («Royal Home», «Royal Home Info»),
  // и каждый умирает независимо (см. checkInstagramAccountsHealth). Обёрнуто тем
  // же приёмом, что и остальные: сбой самой проверки не должен теряться молча.
  try {
    results.push(...(await checkInstagramAccountsHealth()));
  } catch (err) {
    const reason = describeError(err);
    void logSystemError("cron", `Проверка доступа «Instagram» не выполнена: ${reason}`);
    results.push({ name: "Instagram", ok: false, detail: reason });
  }

  // Дополнительные чаты Telegram (26.09.2026) — тот же приём, что у Instagram
  // выше: своя проверка на чат, отдельным списком, сбой обёртки не должен
  // прятать основной канал.
  try {
    results.push(...(await checkTelegramExtraChatsHealth()));
  } catch (err) {
    const reason = describeError(err);
    void logSystemError("cron", `Проверка дополнительных чатов Telegram не выполнена: ${reason}`);
    results.push({ name: "Telegram (доп. чаты)", ok: false, detail: reason });
  }

  // Кросспостинг на партнёрские Страницы (28.09.2026) — тем же приёмом: список
  // партнёров переменной длины, своя IntegrationCheck на каждый id.
  try {
    results.push(...(await checkFacebookCrosspostHealth()));
  } catch (err) {
    const reason = describeError(err);
    void logSystemError("cron", `Проверка кросспостинга Facebook не выполнена: ${reason}`);
    results.push({ name: "Facebook Кросспостинг", ok: false, detail: reason });
  }

  // Права маркеров — ПОСЛЕ проверок «жив ли»: TikTok берёт права из обмена,
  // который сделала checkTikTokTokenHealth выше, а не поворачивает refresh_token
  // вторым обменом.
  try {
    results.push(...(await checkTokenScopesHealth()));
  } catch (err) {
    const reason = describeError(err);
    void logSystemError("cron", `Проверка прав маркеров не выполнена: ${reason}`);
    results.push({ name: "Права маркеров", ok: false, detail: reason });
  }

  return results;
}
