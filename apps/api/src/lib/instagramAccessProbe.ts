import { prisma } from "../db.js";
import { decryptSecretSafe } from "../crypto.js";
import { fetchWithRetry, GRAPH_VERSION, instagramApiUrl, instagramRequest, isFacebookLoginToken } from "../messengers/meta.js";
import { instagramAccessGate, lostInstagramAccount, noteInstagramProbeSucceeded } from "./instagramAccountAccess.js";
import { describeError } from "./describeError.js";

/**
 * ПРОБА БЕЗ ВХОДЯЩИХ (ревью #432, 26.11.2026). Отметка «доступ потерян» раньше снималась только успехом реального
 * вызова Instagram (проба раз в 30 минут внутри отправки) или суточной проверкой. Если клиенты в этот аккаунт не пишут,
 * ложная отметка висела бы до 24 часов. Теперь работа по расписанию (повтор зависших, очередь комментариев) сама
 * делает дешёвый `GET /me` личным ключом — не чаще PROBE_EVERY_MS на аккаунт в процессе (те же ворота, что у отправки).
 *
 * Итог: true — отметка всё ещё стоит (работу держать), false — отметки нет или она только что снята (работать).
 * Ключ Страницы («Войти через Facebook», EAA) здесь не пробуем: `/me` такого ключа — Страница, а не Instagram; его
 * отметку снимает суточная проверка Страницы (integrationHealth.ts). Никогда не бросает.
 */
export async function stillLostAfterProbe(accountId: string, now: number = Date.now()): Promise<boolean> {
  try {
    const gate = await instagramAccessGate({ accountId }, now);
    if (!gate) return false;
    if (!gate.probe) return true;
    const row = await prisma.messengerAccount.findUnique({ where: { id: accountId }, select: { token: true } });
    const token = decryptSecretSafe(row?.token ?? "");
    if (!token || isFacebookLoginToken(token)) return true;
    const req = instagramRequest(instagramApiUrl(`/${GRAPH_VERSION}/me?fields=id`), token);
    const res = await fetchWithRetry(req.url, { headers: req.headers });
    if (res.ok) {
      await noteInstagramProbeSucceeded(accountId);
      return Boolean(await lostInstagramAccount({ accountId }));
    }
    // Отказ ключа — отметка уже стоит, писать нечего; 5xx/обрыв — исход неизвестен, ждём следующей пробы.
    await res.body?.cancel().catch(() => undefined);
    return true;
  } catch (err) {
    console.warn(`[instagram] проба доступа аккаунта ${accountId} не удалась: ${describeError(err)}`);
    return true;
  }
}
