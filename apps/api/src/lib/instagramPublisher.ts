import { instagramTokenIdentity } from "../messengers/meta.js";
import { describeMetaToken, instagramCompanyPublishRoute, isPermissionCode, noteCompanyPublishRefused } from "./metaEternalTokens.js";
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
 * Сама публикация — тоже через эту дверь: `publishViaInstagramPublisher(publisher, (igUserId, token) =>
 * publishInstagramReel/Story/Carousel(...))`. Адрес graph.facebook.com для ключа `EAA…`
 * подставляет metaGraph.ts::instagramRequest.
 *
 * ПОДСТРАХОВКА (ревью PR #391): ключ компании выбирается первым, но Meta может отказать ему
 * в правах (10, 200–299 — например, ads_* при Странице из Business Manager) или в самом ключе
 * (190/102). Если отказ пришёл на СОЗДАНИИ контейнера (контейнера нет — дубля нет), публикация
 * ОДИН раз повторяется личным ключом, а путь компании для этой Страницы встаёт на паузу
 * (metaEternalTokens.ts::noteCompanyPublishRefused). После контейнера (media_publish) повтора нет.
 *
 * Отказ ключа — тревога через общую дверь channelKeyAlarm.ts: личный ключ (401, 190/102) —
 * руководству «к сведению», раз в сутки на аккаунт; мёртвый ключ компании — директору, как
 * все тревоги ключа компании (метка `meta-system-user`); отказ ключу компании в правах —
 * руководству «к сведению», один раз на ключ и Страницу (без повтора по сроку). «Meta закрыла доступ к аккаунту» —
 * своя дверь (instagramAccountAccess.ts), второй тревоги не даём.
 *
 * Сторож: tests/instagram-publisher-one-door.test.ts не пропускает путь публикации,
 * который снова сам зовёт `instagramTokenIdentity` или публикует мимо этой двери.
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
      /** Личный ключ, по которому выбирали путь (для тревоги «чей ключ» и повтора). */
      personalToken: string;
      /** Страница, через которую идёт ключ компании (только route "company"). */
      pageId?: string;
      /** Отпечаток ключа компании, не сам ключ (только route "company") — метка тревоги. */
      companyKeyId?: string;
      username?: string;
    }
  | { ok: false; error: string };

export type InstagramPublisherOk = Extract<InstagramPublisher, { ok: true }>;

/**
 * ОТКАЗ META НА ШАГЕ ПУБЛИКАЦИИ INSTAGRAM (22.11.2026, ревью PR #391). `graphErrorMessage`
 * оставляет только текст, а эта дверь должна
 * отличить отказ КЛЮЧА (190/102, права 10/200–299) от отказа ролика. `step: "create"` —
 * Meta не создала контейнер (или слайд карусели): публиковать нечего, повтор другим ключом
 * дубля не даст. `step: "publish"` — контейнер уже есть, повтор другим ключом запрещён.
 */
export interface InstagramGraphRefusal {
  step: "create" | "publish";
  status: number;
  code?: number;
  subcode?: number;
}

/** Что нужно двери от результата любой публикации Instagram (PublishResult, PhotoPostPublishResult). */
export interface InstagramPublishAttempt {
  ok: boolean;
  pending?: boolean;
  error?: string;
  graphError?: InstagramGraphRefusal;
}

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
      pageId: company.pageId,
      companyKeyId: company.companyKeyId,
      ...(company.username ? { username: company.username } : {}),
    };
  }
  return personalPublisher(personalToken, opts.timeoutMs);
}

async function personalPublisher(personalToken: string, timeoutMs?: number): Promise<InstagramPublisher> {
  const identity = timeoutMs === undefined
    ? await instagramTokenIdentity(personalToken)
    : await instagramTokenIdentity(personalToken, timeoutMs);
  if (!identity.ok) {
    void noteKeyFailure({ route: "personal", personalToken }, identity.error);
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
 * Тот же аккаунт личным ключом — когда ключ компании не ответил на ЧТЕНИЕ перед серией (лимит
 * публикаций у историй). Для личного пути возвращает его же. Отказ личного — тревога, как всегда.
 */
export async function personalInstagramPublisher(publisher: InstagramPublisherOk): Promise<InstagramPublisher> {
  if (publisher.route === "personal") return publisher;
  return personalPublisher(publisher.personalToken);
}

/** Отказ ключа компании: "auth" — сам ключ (190/102, 401), "permission" — права (10, 200–299). */
function companyRefusalKind(error: string | undefined, graph: InstagramGraphRefusal | undefined): "auth" | "permission" | null {
  if (graph && (graph.status === 401 || graph.code === 190 || graph.code === 102)) return "auth";
  if (error && isMetaAuthFailureText(error)) return "auth";
  if (graph && isPermissionCode(graph.code)) return "permission";
  return null;
}

/**
 * ПУБЛИКАЦИЯ ВЫБРАННЫМ КЛЮЧОМ — с подстраховкой (ревью PR #391). `run` получает id аккаунта и
 * ключ и делает ОДНУ публикацию (publishInstagramReel/Story/StoryImage/Carousel). Возвращает
 * результат и ключ, которым он получен: серии (части истории) дальше идут им же.
 * Отказ ключа здесь уже отмечен (тревога, пауза) — вызывающему звать noteInstagramPublishFailure
 * не нужно. Сверх того, что бросит сам `run`, не бросает.
 */
export async function publishViaInstagramPublisher<R extends InstagramPublishAttempt>(
  publisher: InstagramPublisherOk,
  run: (igUserId: string, token: string) => Promise<R>
): Promise<{ result: R; publisher: InstagramPublisherOk }> {
  const first = await run(publisher.igUserId, publisher.token);
  if (first.ok || first.pending) return { result: first, publisher };
  const refusal = publisher.route === "company" ? companyRefusalKind(first.error, first.graphError) : null;
  await noteKeyFailure(publisher, first.error ?? "", first.graphError);
  // Повтор — только отказ КЛЮЧА компании и только до контейнера (иначе второй ролик).
  if (!refusal || first.graphError?.step !== "create") return { result: first, publisher };
  const personal = await personalPublisher(publisher.personalToken);
  if (!personal.ok) return { result: first, publisher };
  const second = await run(personal.igUserId, personal.token);
  if (!second.ok && !second.pending) await noteKeyFailure(personal, second.error ?? "", second.graphError);
  return { result: second, publisher: personal };
}

/**
 * Публикация уже выбранным ключом не удалась — если это отказ самого ключа, тревога.
 * Остальные ошибки (формат видео, лимит, соавторы) вызывающий пишет в журнал сам.
 * Пути публикации зовут publishViaInstagramPublisher, она делает это сама. Никогда не бросает.
 */
export async function noteInstagramPublishFailure(
  publisher: InstagramPublisher,
  error: string | undefined,
  graph?: InstagramGraphRefusal
): Promise<void> {
  if (!publisher.ok || !error) return;
  await noteKeyFailure(publisher, error, graph);
}

async function noteKeyFailure(
  publisher: Pick<InstagramPublisherOk, "route" | "personalToken" | "pageId" | "companyKeyId">,
  error: string,
  graph?: InstagramGraphRefusal
): Promise<void> {
  const { route, personalToken } = publisher;
  try {
    const detail = shortReason(error);
    if (route === "company") {
      const kind = companyRefusalKind(error, graph);
      if (!kind) return;
      // Мёртвый маркер Страницы не держим в кэше выдачи до 10 мин; отказ в правах — пауза
      // только публикации (ревью PR #391, пункт 3). Следующий ролик сразу идёт личным ключом.
      if (publisher.pageId) noteCompanyPublishRefused(publisher.pageId, kind, `код ${graph?.code ?? "—"}: ${detail}`);
      if (kind === "auth") {
        // Та же метка и тот же адресат, что у остальных тревог ключа компании
        // (integrationHealth.ts, metaEternalTokens.ts::systemPageGrant): директору, раз в 12 ч.
        // Иначе тихая «к сведению» под общей меткой гасила бы срочную тревогу проверки ключа,
        // хотя мёртвый ключ компании глушит и переписку, и публикацию разом.
        await raiseChannelKeyAlarm({
          key: "meta-system-user",
          label: "Вечный ключ Meta (системный пользователь), публикация Instagram",
          detail,
          fix: "Business Suite → Настройки компании → Системные пользователи → выпустить ключ заново и вставить в Настройки → Каналы.",
        });
        return;
      }
      // Отказ в ПРАВАХ (10, 200–299): ключ жив, переписка через Страницу может работать, публикация
      // уходит личным ключом — руководству «к сведению» ОДИН раз на пару «ключ компании + Страница»
      // (ревью PR #391): ежедневный повтор, пока не выданы необязательные ads_*, — шум, который
      // перестают читать. Перевыпустили ключ — новый отпечаток, новая тревога.
      await raiseChannelKeyAlarm({
        key: `ig-publish:${publisher.pageId ?? "-"}:${publisher.companyKeyId ?? "-"}`,
        once: true,
        label: "Публикация Instagram постоянным ключом компании",
        detail: `Meta отказала ключу компании в правах на публикацию (код ${graph?.code ?? "—"}): ${detail}`,
        fix: "Публикация пробует личный ключ. Настройки → Каналы → «Проверить права» ключа компании.",
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
