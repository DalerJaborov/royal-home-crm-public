import { prisma } from "../db.js";
import { decryptSecretSafe } from "../crypto.js";
import { logSystemError } from "./systemError.js";
import { MANAGEMENT_ALARM_ROLES, raiseCriticalAlarm } from "./channelKeyAlarm.js";
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
    const name = await accountName(accountId);
    const episode = `${accountId}:${lostAt.getTime()}`;
    await logSystemError(
      "meta",
      `${name}: Meta закрыла доступ к аккаунту (${reason}). Бот в этом аккаунте не отвечает, проверки его не трогают, ` +
        `пока доступ не вернётся. Что сделать: войти в этот аккаунт в приложении Instagram или на instagram.com и пройти ` +
        `проверку; затем в Настройках → Каналы → «Аккаунты Instagram» нажать «Заменить маркер».`,
      { dedupKey: `ig-account-locked:${episode}`, dedupWindowMs: 30 * 24 * 60 * 60_000, silent: true }
    );
    await raiseCriticalAlarm({
      tag: `ig-account-locked:${episode}`,
      title: "Meta закрыла доступ к аккаунту Instagram",
      body: `${name}: бот здесь не отвечает. Войдите в этот аккаунт в Instagram и пройдите проверку, затем «Заменить маркер» в Настройках → Каналы.`,
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

/** Доступ вернулся (ключ снова отвечает, путь Страницы отвечает или вставлен новый ключ) — снять отметку и записать это. */
export async function clearInstagramAccountLocked(accountId: string, why: "probe_ok" | "token_replaced" | "page_route_ok"): Promise<void> {
  try {
    const cleared = await prisma.messengerAccount.updateMany({
      where: { id: accountId, accessLostAt: { not: null } },
      data: { accessLostAt: null, accessLostReason: null },
    });
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
