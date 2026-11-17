import { prisma } from "../db.js";
import { accountBrandName } from "../messengers/accounts.js";
import { logSystemError } from "../lib/systemError.js";
import { brandize, brandNameError, mentionsDefaultBrand } from "./brandPattern.js";

/**
 * ИМЯ КОМПАНИИ В ДИАЛОГАХ ОДНОГО АККАУНТА (08.11.2026).
 *
 * Второй бренд на тех же фактах — Instagram Arvan Estate, дочерняя компания:
 * Душанбе, комиссия, офис и телефон те же, а называться бот обязан «Арван» и
 * никогда «Royal Home». Слово «Royal Home» зашито в десятках кусков промта и
 * готовых текстов (ai/agencyFacts.ts, ai/leadQualifier.ts, шаблоны писем), и
 * переписывать каждый кусок под бренд значило бы завести второй промт, который
 * разойдётся с первым при первой же правке. Поэтому имя подменяется ОДНОЙ
 * функцией в точке выхода: в собранном промте хода, в готовых текстах аккаунта и
 * страховкой на выходе бота (guardBrandLeak, шаг replyChain.finalizeBotReply).
 *
 * Поле `MessengerAccount.brandName` пусто у всех существующих аккаунтов — для них
 * каждая функция здесь возвращает текст БЕЗ ИЗМЕНЕНИЯ, побайтово.
 *
 * ЧТО МЕНЯЕТСЯ: «Royal Home» и «Royal Home Info» (название второго аккаунта — для
 * клиента это та же компания, «Арван Info» вышло бы нелепо), в любом регистре.
 * ЧТО НЕТ: адрес сайта royalhome.tj, ники royal.home.tj / @royalhome.info, имена
 * пакетов и ссылки — перед «Royal» там стоит `/`, `@`, `.`, `-` или буква, а
 * после «Home» — буква или точка; такие совпадения шаблон не берёт.
 */
export { brandize, mentionsDefaultBrand, brandNameError };

/** Имя компании для диалога аккаунта: null — аккаунт без своего имени. */
export const brandForAccount = accountBrandName;

/**
 * То же по диалогу — для текстов, которые пишутся вне основного хода (напоминание
 * молчащему, подтверждение заявки, ответ собственника), где под рукой только id
 * диалога. Нет диалога, нет аккаунта или сбой базы — null, то есть прежнее имя.
 */
export async function brandForConversation(conversationId: string | null | undefined): Promise<string | null> {
  if (!conversationId) return null;
  try {
    const row = await prisma.botConversation.findUnique({ where: { id: conversationId }, select: { accountId: true } });
    return brandForAccount(row?.accountId);
  } catch {
    return null;
  }
}

export interface BrandLeakContext {
  conversationId?: string | null;
  /** Где поймали: «ответ бота», «комментарий» — для строки журнала. */
  where: string;
}

/**
 * СТРАХОВКА НА ВЫХОДЕ. Промт и шаблоны аккаунта уже подменены, поэтому «Royal
 * Home» в готовом ответе — утечка: модель вспомнила прежнее имя из обучения или
 * из старой переписки. Заменяем и пишем в журнал, чтобы утечку видели люди, а не
 * только подмена молча закрывала дыру.
 *
 * Аккаунт без своего имени — ничего не трогаем и не пишем.
 */
export function guardBrandLeak(texts: string[], brand: string | null | undefined, ctx: BrandLeakContext): string[] {
  const name = brand?.trim();
  if (!name) return texts;
  let leaked = false;
  const out = texts.map((t) => {
    if (!mentionsDefaultBrand(t)) return t;
    leaked = true;
    return brandize(t, name);
  });
  if (leaked) {
    void logSystemError(
      "ai",
      `Утечка имени «Royal Home» в аккаунте «${name}» (${ctx.where}): в ответе стояло прежнее название, оно заменено на «${name}» до отправки. ` +
        `Посмотрите диалог: подмена в промте не удержала это место.`,
      { dedupKey: "brand-name-leak", dedupScope: ctx.conversationId ?? undefined }
    );
  }
  return out;
}
