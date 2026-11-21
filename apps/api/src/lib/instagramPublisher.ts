import { instagramTokenIdentity } from "../messengers/meta.js";
import { describeMetaToken, instagramCompanyPublishRoute } from "./metaEternalTokens.js";
import { isMetaAuthFailureText, raiseChannelKeyAlarm } from "./channelKeyAlarm.js";
import { noteInstagramKeyRefused } from "./instagramAccountAccess.js";
import { describeError } from "./describeError.js";

/**
 * КТО И ЧЕМ ПУБЛИКУЕТ В INSTAGRAM — ОДНА ДВЕРЬ (22.11.2026).
 *
 * Случай: 11–12.11 владелец сменил пароль Instagram, личный ключ аккаунта (IGAA…,
 * graph.instagram.com) ответил 401 «session invalidated», и @royal.home.tj перестал
 * публиковать ролики, истории и карусели: каждый путь публикации сам брал личный ключ
 * и сам спрашивал `instagramTokenIdentity`. Переписку к тому времени уже перевели на
 * Страницу ключом компании (lib/metaEternalTokens.ts), публикацию — нет.
 *
 * Теперь путь публикации спрашивает ТОЛЬКО эту функцию «чем и в какой аккаунт»:
 *  1. ключ компании (системный пользователь, срок «никогда», от пароля не зависит) —
 *     если всё сходится (metaEternalTokens.ts::instagramCompanyPublishRoute);
 *  2. иначе личный ключ, как раньше: `instagramTokenIdentity` даёт id аккаунта.
 * Дальше вызывающий передаёт `igUserId` и `token` в publishInstagramReel/Story/Carousel —
 * адрес graph.facebook.com для ключа `EAA…` подставляет metaGraph.ts::instagramRequest.
 *
 * Отказ ключа (401, код 190/102) — тревога руководству через общую дверь
 * (channelKeyAlarm.ts, «к сведению», не чаще раза в сутки на ключ). «Meta закрыла доступ к
 * аккаунту» — своя дверь (instagramAccountAccess.ts), второй тревоги не даём.
 *
 * Сторож: tests/instagram-publisher-one-door.test.ts не пропускает путь публикации,
 * который снова сам зовёт `instagramTokenIdentity`.
 *
 * Отказ сети внутри `instagramTokenIdentity` здесь НЕ перехватывается — вызывающий решает
 * сам (фоновый проход контейнеров ловит его на одной записи и идёт дальше).
 */
export type InstagramPublisher =
  | {
      ok: true;
      /** "company" — ключ компании через graph.facebook.com; "personal" — личный ключ аккаунта. */
      route: "company" | "personal";
      /** Instagram business id (17841…) — куда публиковать. */
      igUserId: string;
      /** Чем публиковать. НИКОГДА не писать в журнал и не отдавать наружу. */
      token: string;
      /** Личный ключ, по которому выбирали путь (для тревоги «чей ключ»). */
      personalToken: string;
      username?: string;
    }
  | { ok: false; error: string };

/**
 * Что делать человеку — одной строкой в тревоге. Коротко намеренно: текст тревоги
 * обрезается на 220 знаках (channelKeyAlarm.ts::raiseCriticalAlarm), и длинная причина
 * от Meta иначе съела бы именно эту, главную, часть.
 */
export const INSTAGRAM_KEY_FIX = "Ключ Instagram перестал работать — переподключите в Настройках → Каналы.";

/** Причина от Meta для тревоги: только `message` из ответа (без JSON вокруг), до 80 знаков. */
function shortReason(error: string): string {
  const message = /"message"\s*:\s*"([^"]{1,300})"/.exec(error)?.[1];
  return (message ?? error).replace(/\s+/g, " ").slice(0, 80);
}

export async function resolveInstagramPublisher(
  personalToken: string | undefined,
  /** Свой срок ожидания для `instagramTokenIdentity` (экран свободных роликов ждёт меньше). */
  opts: { timeoutMs?: number } = {}
): Promise<InstagramPublisher> {
  if (!personalToken) return { ok: false, error: "Instagram не подключён" };
  const company = await instagramCompanyPublishRoute(personalToken);
  if (company) {
    return {
      ok: true,
      route: "company",
      igUserId: company.igUserId,
      token: company.token,
      personalToken,
      ...(company.username ? { username: company.username } : {}),
    };
  }
  const identity = opts.timeoutMs === undefined
    ? await instagramTokenIdentity(personalToken)
    : await instagramTokenIdentity(personalToken, opts.timeoutMs);
  if (!identity.ok) {
    void noteKeyFailure("personal", personalToken, identity.error);
    return { ok: false, error: identity.error };
  }
  return {
    ok: true,
    route: "personal",
    igUserId: identity.id,
    token: personalToken,
    personalToken,
    ...(identity.username ? { username: identity.username } : {}),
  };
}

/**
 * Публикация уже выбранным ключом не удалась — если это отказ самого ключа, тревога.
 * Остальные ошибки (формат видео, лимит, соавторы) вызывающий пишет в журнал сам.
 * Никогда не бросает.
 */
export async function noteInstagramPublishFailure(publisher: InstagramPublisher, error: string | undefined): Promise<void> {
  if (!publisher.ok || !error) return;
  await noteKeyFailure(publisher.route, publisher.personalToken, error);
}

async function noteKeyFailure(route: "company" | "personal", personalToken: string, error: string): Promise<void> {
  try {
    const detail = shortReason(error);
    if (route === "company") {
      if (!isMetaAuthFailureText(error)) return;
      await raiseChannelKeyAlarm({
        key: "meta-system-user",
        label: "Вечный ключ Meta, публикация Instagram",
        detail,
        fix: INSTAGRAM_KEY_FIX,
        audience: "management",
      });
      return;
    }
    // «Войдите в Instagram и пройдите проверку» — это не смерть ключа, а закрытый аккаунт:
    // отметка и тревога своей дверью, второй тревоги не даём.
    const refused = await noteInstagramKeyRefused({ token: personalToken, text: error, detail: error.replace(/\s+/g, " ").slice(0, 300) });
    if (refused.locked || !isMetaAuthFailureText(error)) return;
    const owner = await describeMetaToken(personalToken);
    await raiseChannelKeyAlarm({ key: owner.key, label: owner.label, detail, fix: INSTAGRAM_KEY_FIX, audience: "management" });
  } catch (err) {
    console.warn("[публикация Instagram] тревога о ключе не поставлена:", describeError(err));
  }
}
