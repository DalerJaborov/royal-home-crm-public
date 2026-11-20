import { prisma } from "../db.js";
import { logSystemError } from "./systemError.js";
import { MANAGEMENT_ALARM_ROLES, raiseCriticalAlarm } from "./channelKeyAlarm.js";

/**
 * «META ЗАКРЫЛА ДОСТУП К АККАУНТУ INSTAGRAM» — ОДНА ДВЕРЬ (21.11.2026).
 *
 * Случай: 20.11 личный маркер Arvan Estate стал отвечать 401 «You cannot access the
 * app till you log in to www.instagram.com and follow the instructions given» — это
 * не смена пароля, а проверка безопасности / блокировка самого аккаунта у Meta
 * (владелец 21.11: «арван потом его пока заблокировали»). Переподключать бесполезно,
 * пока владелец аккаунта не войдёт в Instagram и не пройдёт проверку.
 *
 * Что делаем: ставим аккаунту отметку `accessLostAt` ОДИН раз, с одной записью в
 * журнал и одной тревогой руководству (несрочно). Дальше сторожа здоровья, лента,
 * сверка подписки и «аккаунт молчит» такой аккаунт не дёргают: иначе каждая проверка
 * писала бы своё и будила людей поломкой, о которой уже знают. Суточная проверка
 * маркера продолжается молча — первый успешный ответ снимает отметку сам; новый
 * маркер («Заменить маркер») снимает её сразу.
 *
 * Никогда не бросает: сторож не должен ронять то, о чём сторожит.
 */

/** Признак ответа Meta «аккаунт закрыт, войдите в Instagram и пройдите проверку». */
export function isInstagramAccountLockedText(text: string | undefined): boolean {
  return /cannot access the app till you log in to (www\.)?instagram\.com/i.test(text ?? "");
}

const REASON_MAX = 300;

/** Отметить аккаунт закрытым Meta. Повторный вызов при уже стоящей отметке ничего не делает. */
export async function noteInstagramAccountLocked(accountId: string, detail: string): Promise<{ marked: boolean }> {
  try {
    const reason = detail.replace(/\s+/g, " ").slice(0, REASON_MAX);
    const marked = await prisma.messengerAccount.updateMany({
      where: { id: accountId, accessLostAt: null },
      data: { accessLostAt: new Date(), accessLostReason: reason },
    });
    if (marked.count === 0) return { marked: false };
    const row = await prisma.messengerAccount.findUnique({ where: { id: accountId }, select: { title: true, username: true } });
    const name = `Instagram «${row?.title ?? accountId}»${row?.username ? ` @${row.username}` : ""}`;
    await logSystemError(
      "meta",
      `${name}: Meta закрыла доступ к аккаунту (${reason}). Бот в этом аккаунте не отвечает, проверки его не трогают, ` +
        `пока доступ не вернётся. Что сделать: войти в этот аккаунт в приложении Instagram или на instagram.com и пройти ` +
        `проверку; затем в Настройках → Каналы → «Аккаунты Instagram» нажать «Заменить маркер».`,
      { dedupKey: `ig-account-locked:${accountId}`, dedupWindowMs: 30 * 24 * 60 * 60_000, silent: true }
    );
    await raiseCriticalAlarm({
      tag: `ig-account-locked:${accountId}`,
      title: "Meta закрыла доступ к аккаунту Instagram",
      body: `${name}: бот здесь не отвечает. Войдите в этот аккаунт в Instagram и пройдите проверку, затем «Заменить маркер» в Настройках → Каналы.`,
      url: "/settings?tab=channels",
      quiet: true,
      recipientRoles: MANAGEMENT_ALARM_ROLES,
      // Одна на случай: новый случай возможен только после снятия отметки, а это редко.
      everyMs: 7 * 24 * 60 * 60_000,
    });
    return { marked: true };
  } catch (err) {
    console.error("[instagramAccountAccess] отметка не поставлена:", err instanceof Error ? err.message : String(err));
    return { marked: false };
  }
}

/** Доступ вернулся (успешный вызов маркером или новый маркер) — снять отметку и записать это. */
export async function clearInstagramAccountLocked(accountId: string, why: "probe_ok" | "token_replaced"): Promise<void> {
  try {
    const cleared = await prisma.messengerAccount.updateMany({
      where: { id: accountId, accessLostAt: { not: null } },
      data: { accessLostAt: null, accessLostReason: null },
    });
    if (cleared.count === 0) return;
    await logSystemError(
      "meta",
      `Instagram (аккаунт ${accountId}): доступ вернулся (${why === "probe_ok" ? "маркер снова отвечает" : "вставлен новый маркер"}), проверки снова включены.`,
      { dedupKey: `ig-account-unlocked:${accountId}`, silent: true }
    );
  } catch (err) {
    console.error("[instagramAccountAccess] отметка не снята:", err instanceof Error ? err.message : String(err));
  }
}
