import { prisma } from "../db.js";
import { decryptSecretSafe } from "../crypto.js";
import { logSystemError } from "./systemError.js";
import { isMetaAuthFailure, MANAGEMENT_ALARM_ROLES, raiseCriticalAlarm } from "./channelKeyAlarm.js";
import { instagramRouteForToken } from "./metaEternalTokens.js";

/**
 * «META ЗАКРЫЛА ДОСТУП К АККАУНТУ INSTAGRAM» — ОДНА ДВЕРЬ (21.11.2026).
 *
 * Случай: 20.11 личный ключ Arvan Estate стал отвечать 401 «You cannot access the
 * app till you log in to www.instagram.com and follow the instructions given» — это
 * не смена пароля, а проверка безопасности / блокировка самого аккаунта у Meta
 * (владелец 21.11: «арван потом его пока заблокировали»). Переподключать бесполезно,
 * пока владелец аккаунта не войдёт в Instagram и не пройдёт проверку.
 *
 * Что делаем: ставим аккаунту отметку `accessLostAt` ОДИН раз, с одной записью в
 * журнал и одной тревогой руководству (несрочно). Дальше сторожа здоровья, лента,
 * сверка подписки и «аккаунт молчит» такой аккаунт не дёргают: иначе каждая проверка
 * писала бы своё и будила людей поломкой, о которой уже знают. Суточная проверка
 * ключа продолжается молча — первый успешный ответ снимает отметку сам; новый
 * ключ («Заменить маркер») снимает её сразу.
 *
 * АККАУНТ С РАБОЧИМ ПУТЁМ ЧЕРЕЗ СТРАНИЦУ (ревью #344): отказал только его личный ключ, а
 * бот отвечает ключом компании. Такой аккаунт «закрытым» не метим — это неправда и она
 * выключила бы ему сверку переписок и ленту. Вместо этого — «запасной личный ключ не
 * работает» (noteInstagramBackupKeyDead), руководству раз в сутки.
 *
 * Эпизод = время отметки: журнал и тревога ключуются им, поэтому новый случай после
 * снятия отметки снова даёт запись и тревогу (окна 30/7 дней действуют внутри эпизода).
 *
 * Никогда не бросает: сторож не должен ронять то, о чём сторожит.
 */

/** Признак ответа Meta «аккаунт закрыт, войдите в Instagram и пройдите проверку». */
export function isInstagramAccountLockedText(text: string | undefined): boolean {
  return /cannot access the app till you log in to (www\.)?instagram\.com/i.test(text ?? "");
}

/**
 * ОТКАЗ КЛЮЧА, ПОСЛЕ КОТОРОГО АККАУНТ МЕТИТСЯ (25.11.2026, прод 24.11 03:18: «The session has been invalidated because
 * the user changed their password», HTTP 401 / код 190 по Arvan Estate — за ~28 часов около 270 строк журнала: отправка,
 * повтор зависших раз в 30 минут, профиль, публикация, комментарии, личное по комментарию). До этой правки дверь метила
 * только «войдите в Instagram и пройдите проверку», а мёртвый после смены пароля ключ каждый путь встречал заново.
 * Теперь: «аккаунт закрыт» ИЛИ «ключ не принят» (узкая проверка channelKeyAlarm.ts::isMetaAuthFailure: 401 или код
 * 190/102 вместе с текстом про маркер/сессию). 5xx, 429, лимиты 613/4/17 и отказы «про клиента» сюда не попадают.
 */
export function isInstagramKeyRefusal(status: number | undefined, text: string | undefined): boolean {
  return isInstagramAccountLockedText(text) || isMetaAuthFailure(status, text);
}

/**
 * ПОКА ОТМЕТКА СТОИТ, В META ЭТИМ КЛЮЧОМ НЕ ХОДИМ (25.11.2026). Вызов, который знает ключ (или аккаунт), спрашивает здесь
 * до запроса: аккаунт с отметкой — «закрыто», запрос не делается, вызывающий молчит (журнал и тревогу дала отметка).
 *
 * САМОИЗЛЕЧЕНИЕ: раз в PROBE_EVERY_MS на аккаунт (в каждом процессе) один запрос пропускается как проба. Ответ Meta
 * успешный — отметка снимается (noteInstagramProbeSucceeded); отказ — отметка уже стоит, писать нечего. Иначе ошибочная
 * отметка на живом аккаунте глушила бы его до суточной проверки (integrationHealth.ts), а это сутки молчания клиентам.
 *
 * Чтение — один запрос по аккаунтам С ОТМЕТКОЙ (обычно их ноль, расшифровки нет вовсе). Никогда не бросает: сбой
 * чтения — «открыто», как было до двери.
 */
export const PROBE_EVERY_MS = 30 * 60_000;
const probeTakenAt = new Map<string, number>();

/** Только для тестов: забыть, когда брались пробы. */
export function resetInstagramAccessProbes(): void {
  probeTakenAt.clear();
}

export interface InstagramAccessRef {
  accountId?: string | null;
  /** Instagram-идентификатор аккаунта (messengerAccount.externalId) — у комментариев. */
  externalId?: string | null;
  /** Ключ, которым пойдёт запрос: метка ищется по нему (только среди аккаунтов с отметкой). */
  token?: string | null;
}

export interface LostInstagramAccount {
  id: string;
  reason: string | null;
}

/** Аккаунт этой ссылки с отметкой «доступ потерян»; null — отметки нет (или аккаунт не Instagram/не найден). */
export async function lostInstagramAccount(ref: InstagramAccessRef): Promise<LostInstagramAccount | null> {
  try {
    if (!ref.accountId && !ref.externalId && !ref.token) return null;
    const rows = await prisma.messengerAccount.findMany({
      where: {
        channel: "INSTAGRAM",
        accessLostAt: { not: null },
        ...(ref.accountId ? { id: ref.accountId } : {}),
      },
      select: { id: true, token: true, externalId: true, extraExternalIds: true, accessLostReason: true },
      take: 50,
    });
    const hit = rows.find((r) =>
      (ref.accountId && r.id === ref.accountId) ||
      (ref.externalId && (r.externalId === ref.externalId || r.extraExternalIds.includes(ref.externalId))) ||
      (ref.token && decryptSecretSafe(r.token) === ref.token));
    return hit ? { id: hit.id, reason: hit.accessLostReason } : null;
  } catch {
    return null;
  }
}

/** Ошибка «в Meta не ходили: у аккаунта отметка потери доступа». Вызывающий не пишет её в журнал — это уже сделала отметка. */
export class InstagramAccessLostError extends Error {
  readonly instagramAccessLost = true;
  constructor(readonly accountId: string, reason: string | null) {
    super(`Instagram: доступ к аккаунту ${accountId} потерян (${(reason ?? "ключ не принят").slice(0, 120)}) — запрос в Meta не отправлен`);
    this.name = "InstagramAccessLostError";
  }
}

export function isInstagramAccessLostError(err: unknown): err is InstagramAccessLostError {
  return err instanceof InstagramAccessLostError ||
    (typeof err === "object" && err !== null && (err as { instagramAccessLost?: unknown }).instagramAccessLost === true);
}

/**
 * Решение перед запросом в Meta этим ключом/аккаунтом: null — идти как обычно; `{ probe: true }` — идти, это проба
 * (успех вызывающий передаёт в noteInstagramProbeSucceeded); `{ probe: false }` — не идти.
 */
export async function instagramAccessGate(ref: InstagramAccessRef, now: number = Date.now()): Promise<{ account: LostInstagramAccount; probe: boolean } | null> {
  const account = await lostInstagramAccount(ref);
  if (!account) return null;
  const last = probeTakenAt.get(account.id) ?? 0;
  if (now - last >= PROBE_EVERY_MS) {
    probeTakenAt.set(account.id, now);
    return { account, probe: true };
  }
  return { account, probe: false };
}

/** Проба после отметки прошла (Meta приняла ключ) — снять отметку. Никогда не бросает. */
export async function noteInstagramProbeSucceeded(accountId: string): Promise<void> {
  await clearInstagramAccountLocked(accountId, "probe_ok");
}

/**
 * След пропуска: одна строка журнала на аккаунт и вид работы в сутки (а не строка на каждый диалог раз в 30 минут).
 * Отметка уже дала свою запись и тревогу — эта строка только говорит, что работа ждёт. Никогда не бросает.
 */
export async function noteInstagramWorkHeld(accountId: string, what: string): Promise<void> {
  try {
    await logSystemError("meta",
      `Instagram (аккаунт ${accountId}): ${what} ждёт — доступ к аккаунту потерян, в Meta не ходим. ` +
        `После «Заменить маркер» в Настройках → Каналы работа продолжится сама.`,
      { dedupKey: `ig-access-held:${accountId}:${what}`.slice(0, 120), dedupWindowMs: DAY_MS, silent: true, quietPult: true });
  } catch {
    // Журнал не должен ронять то, о чём пишет.
  }
}

const REASON_MAX = 300;
const DAY_MS = 24 * 60 * 60_000;

async function accountName(accountId: string): Promise<string> {
  const row = await prisma.messengerAccount.findUnique({ where: { id: accountId }, select: { title: true, username: true } });
  return `Instagram «${row?.title ?? accountId}»${row?.username ? ` @${row.username}` : ""}`;
}

/** Отвечает ли аккаунт сейчас через Страницу ключом компании (есть куда отступить от личного ключа). */
export async function instagramAccountPageRouted(accountId: string): Promise<boolean> {
  try {
    const row = await prisma.messengerAccount.findUnique({ where: { id: accountId }, select: { token: true } });
    const token = decryptSecretSafe(row?.token ?? null);
    if (!token) return false;
    // Настройка пути, а не текущее состояние: временная пауза Страницы после отказа Meta (5 мин)
    // не делает аккаунт «без пути» (ревью #344, второй круг).
    const route = await instagramRouteForToken(token, { ignoreBench: true });
    return route.kind === "page" && !route.pageOnly;
  } catch {
    return false;
  }
}

/**
 * Личный ключ аккаунта не работает. Что сказать руководству — по фактам пути Страницы (ревью #344,
 * третий круг), раз в сутки на аккаунт:
 *  - Страница только что отказала как путь (или стоит на паузе после отказа) — бот не может отвечать
 *    вовсе: «Meta отказывает обоим путям», срочно;
 *  - через Страницу за последние сутки была успешная отправка — «бот отвечает через Страницу, но
 *    личный ключ не работает», к сведению (входящие держатся на подписке личного ключа);
 *  - отправок через Страницу за сутки не было — подтвердить, что путь отвечает, нечем: так и пишем.
 */
export async function noteInstagramBackupKeyDead(accountId: string, detail: string, opts: { pageRefused?: boolean } = {}): Promise<void> {
  try {
    const name = await accountName(accountId);
    const reason = detail.replace(/\s+/g, " ").slice(0, 160);
    const row = await prisma.messengerAccount.findUnique({ where: { id: accountId }, select: { token: true, eternalLastSentAt: true } });
    const token = decryptSecretSafe(row?.token ?? null);
    const pageRefused = opts.pageRefused ?? (token ? (await instagramRouteForToken(token)).kind !== "page" : false);
    if (pageRefused) {
      await logSystemError("meta", `${name}: бот не может отвечать — Meta отказывает обоим путям (Страница и личный ключ: ${reason}).`,
        { dedupKey: `ig-both-routes-failed:${accountId}`, dedupWindowMs: DAY_MS, silent: true });
      await raiseCriticalAlarm({
        tag: `ig-both-routes-failed:${accountId}`,
        title: "Instagram: бот не может отвечать",
        body: `${name}: бот не может отвечать, Meta отказывает обоим путям — проверьте аккаунт в Instagram и кабинете Meta.`,
        url: "/settings?tab=channels",
        recipientRoles: MANAGEMENT_ALARM_ROLES,
        everyMs: DAY_MS,
      });
      return;
    }
    const pageAnsweredRecently = !!row?.eternalLastSentAt && Date.now() - row.eternalLastSentAt.getTime() < DAY_MS;
    const state = pageAnsweredRecently
      ? "бот отвечает через Страницу, но личный ключ аккаунта не работает"
      : "личный ключ аккаунта не работает; путь через Страницу настроен, но за сутки ответов через него не было — подтвердить, что он отвечает, нечем";
    await logSystemError(
      "meta",
      `Предупреждение: ${name}: ${state} (${reason}). Если откажет и Страница, отвечать будет нечем. Переподключите аккаунт в Настройках → Каналы.`,
      { dedupKey: `ig-backup-key-dead:${accountId}`, dedupWindowMs: DAY_MS, silent: true }
    );
    await raiseCriticalAlarm({
      tag: `ig-backup-key-dead:${accountId}`,
      title: "Instagram: переподключите аккаунт",
      body: `${name}: ${state} (${reason.slice(0, 80)}). Переподключите аккаунт в Настройках → Каналы, чтобы не пропали входящие.`,
      url: "/settings?tab=channels",
      quiet: true,
      recipientRoles: MANAGEMENT_ALARM_ROLES,
      everyMs: DAY_MS,
    });
  } catch (err) {
    console.error("[instagramAccountAccess] предупреждение о запасном ключе не записано:", err instanceof Error ? err.message : String(err));
  }
}

/**
 * Отметить аккаунт закрытым Meta. Повторный вызов при уже стоящей отметке ничего не делает.
 * Аккаунт с рабочим путём через Страницу не метится: «запасной личный ключ не работает».
 */
export async function noteInstagramAccountLocked(accountId: string, detail: string): Promise<{ marked: boolean; backupOnly?: boolean }> {
  try {
    const reason = detail.replace(/\s+/g, " ").slice(0, REASON_MAX);
    if (await instagramAccountPageRouted(accountId)) {
      await noteInstagramBackupKeyDead(accountId, reason);
      return { marked: false, backupOnly: true };
    }
    const lostAt = new Date();
    const marked = await prisma.messengerAccount.updateMany({
      where: { id: accountId, accessLostAt: null },
      data: { accessLostAt: lostAt, accessLostReason: reason },
    });
    if (marked.count === 0) return { marked: false };
    probeTakenAt.set(accountId, lostAt.getTime()); // первая проба — не раньше PROBE_EVERY_MS после отметки
    const name = await accountName(accountId);
    const episode = `${accountId}:${lostAt.getTime()}`;
    // Ключ не принят (смена пароля, выход из сессии), а не проверка безопасности: войти и пройти проверку не нужно,
    // нужен новый ключ. Метка эпизода и тревоги — та же: одна дверь, одна тревога на эпизод.
    const locked = isInstagramAccountLockedText(reason);
    await logSystemError(
      "meta",
      locked
        ? `${name}: Meta закрыла доступ к аккаунту (${reason}). Бот в этом аккаунте не отвечает, проверки его не трогают, ` +
          `пока доступ не вернётся. Что сделать: войти в этот аккаунт в приложении Instagram или на instagram.com и пройти ` +
          `проверку; затем в Настройках → Каналы → «Аккаунты Instagram» нажать «Заменить маркер».`
        : `${name}: Meta не принимает ключ аккаунта (${reason}) — обычно после смены пароля или выхода из аккаунта. Бот в этом ` +
          `аккаунте не отвечает, проверки и повторы его не трогают, пока ключ не заменят. Что сделать: в Настройках → Каналы → ` +
          `«Аккаунты Instagram» нажать «Заменить маркер» и войти в аккаунт заново.`,
      { dedupKey: `ig-account-locked:${episode}`, dedupWindowMs: 30 * 24 * 60 * 60_000, silent: true }
    );
    await raiseCriticalAlarm({
      tag: `ig-account-locked:${episode}`,
      title: locked ? "Meta закрыла доступ к аккаунту Instagram" : "Instagram: ключ аккаунта больше не принимается",
      body: locked
        ? `${name}: бот здесь не отвечает. Войдите в этот аккаунт в Instagram и пройдите проверку, затем «Заменить маркер» в Настройках → Каналы.`
        : `${name}: бот здесь не отвечает — Meta не принимает ключ (сменили пароль или вышли из аккаунта). Нажмите «Заменить маркер» в Настройках → Каналы.`,
      url: "/settings?tab=channels",
      quiet: true,
      recipientRoles: MANAGEMENT_ALARM_ROLES,
      // Одна на эпизод: новый эпизод (новое время отметки) — новая метка, тревога уйдёт снова.
      everyMs: 7 * 24 * 60 * 60_000,
    });
    return { marked: true };
  } catch (err) {
    console.error("[instagramAccountAccess] отметка не поставлена:", err instanceof Error ? err.message : String(err));
    return { marked: false };
  }
}

/**
 * ЛЮБОЙ ОТКАЗ ЛИЧНОГО КЛЮЧА INSTAGRAM — ЧЕРЕЗ ЭТУ ДВЕРЬ (21.11.2026, прод после #344). Отметку «Meta закрыла
 * доступ» ставили только отправка и суточная проверка, а ленту, сторож подписки и сверку переписок Arvan
 * дёргал раз в 15 минут — 66 строк «401 … log in to www.instagram.com» в журнале за сутки. Теперь кто бы ни
 * получил текст «войдите в Instagram и пройдите проверку», отметка ставится сразу (одна запись, одна тревога),
 * и все проверки дальше этот аккаунт не трогают. true — это был отказ «аккаунт закрыт» (вызывающему писать нечего).
 *
 * 25.11.2026: и «ключ не принят» (isInstagramKeyRefusal: 401 / код 190 про маркер или сессию) — после смены пароля
 * Arvan каждый путь писал своё. `status` — HTTP-код ответа, когда он есть (без него решает текст/JSON тела).
 * Ключ, которого нет среди аккаунтов (запасной из Настроек, ключ Страницы), не метится: { locked: false }.
 */
export async function noteInstagramKeyRefused(input: { accountId?: string | null; token?: string; text: string; detail: string; status?: number }): Promise<{ locked: boolean }> {
  try {
    if (!isInstagramKeyRefusal(input.status, input.text)) return { locked: false };
    const id = input.accountId ?? (input.token ? await instagramAccountIdByToken(input.token) : null);
    if (!id) return { locked: false };
    await noteInstagramAccountLocked(id, input.detail);
    return { locked: true };
  } catch (err) {
    console.error("[instagramAccountAccess] отказ ключа не разобран:", err instanceof Error ? err.message : String(err));
    return { locked: false };
  }
}

async function instagramAccountIdByToken(token: string): Promise<string | null> {
  const rows = await prisma.messengerAccount.findMany({ where: { channel: "INSTAGRAM" }, select: { id: true, token: true } });
  return rows.find((r) => decryptSecretSafe(r.token) === token)?.id ?? null;
}

/** Доступ вернулся (ключ снова отвечает, путь Страницы отвечает или вставлен новый ключ) — снять отметку и записать это. */
export async function clearInstagramAccountLocked(accountId: string, why: "probe_ok" | "token_replaced" | "page_route_ok"): Promise<void> {
  try {
    const cleared = await prisma.messengerAccount.updateMany({
      where: { id: accountId, accessLostAt: { not: null } },
      data: { accessLostAt: null, accessLostReason: null },
    });
    probeTakenAt.delete(accountId);
    if (cleared.count === 0) return;
    const because = why === "probe_ok" ? "личный ключ снова отвечает" : why === "page_route_ok" ? "аккаунт отвечает через Страницу" : "вставлен новый ключ";
    await logSystemError(
      "meta",
      `Instagram (аккаунт ${accountId}): доступ вернулся (${because}), проверки снова включены.`,
      { dedupKey: `ig-account-unlocked:${accountId}:${Date.now()}`, silent: true }
    );
  } catch (err) {
    console.error("[instagramAccountAccess] отметка не снята:", err instanceof Error ? err.message : String(err));
  }
}
