import { encryptSecret } from "../../crypto.js";
import { prisma } from "../../db.js";
import { buildMetaLoginUrl, consumeMetaLoginCode, metaLoginRedirectUri, MetaLoginError } from "../metaLogin.js";

/**
 * ПОДКЛЮЧЕНИЕ РЕКЛАМНОГО КАБИНЕТА ОДНОЙ КНОПКОЙ.
 *
 * Зачем, если маркер можно вставить руками: потому что вставить руками — нельзя.
 * 20.08.2026 владелец час не мог перенести маркер из Graph API Explorer в Настройки:
 * не работал буфер обмена. Маркер — это 200 символов, которые не наберёшь с клавиатуры,
 * и вся затея с отчётом по рекламе упёрлась не в код, а в Ctrl+C.
 *
 * С 13.11.2026 сам вход (state, проверка права, обмен кода) — общая дверь
 * lib/metaLogin.ts: ею же подключаются Страницы и Instagram. Здесь осталось только
 * то, что относится к рекламе: цель "ads" и куда положить полученный маркер.
 */

export { MetaLoginError as MetaAdsConnectError } from "../metaLogin.js";

/** Куда Facebook вернёт человека — общий адрес входа (см. metaLogin.ts). */
export function adsRedirectUri(): string | null {
  return metaLoginRedirectUri();
}

/** Адрес окна Facebook для рекламной кнопки. */
export function buildConnectUrl(agentId: string): Promise<string> {
  return buildMetaLoginUrl(agentId, "ads");
}

/** Маркер рекламного входа — в Настройки, синхронизация включается. */
export async function saveAdsLoginToken(token: string): Promise<void> {
  await prisma.settings.update({
    where: { id: "singleton" },
    data: {
      metaAdsToken: encryptSecret(token),
      metaAdsTokenRefreshedAt: new Date(),
      // Подключение через кнопку означает намерение включить — иначе человек
      // подтвердил доступ в Facebook и не понял, почему в CRM по-прежнему пусто.
      metaAdsEnabled: true,
    },
  });
}

/**
 * Обмен кода на маркер рекламы и сохранение. Только для state рекламной кнопки:
 * колбэк (routes/ads.ts) с 13.11 раздаёт цели сам, это — прежний вход для рекламы.
 */
export async function completeConnect(code: string, state: string): Promise<void> {
  const login = await consumeMetaLoginCode(code, state);
  if (login.purpose !== "ads") throw new MetaLoginError("Этот вход был не для рекламы — нажмите кнопку заново", login.purpose);
  await saveAdsLoginToken(login.token);
}
