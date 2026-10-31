// Приём комментариев Meta: разбор вебхука, фильтр своих и сотрудников, постановка в
// очередь. Вынесено из messengers/comments.ts (31.10.2026) без смены поведения: это
// вход и для ядра (публичные комментарии), и для старого обработчика.
import { prisma } from "../db.js";
import { isOwnAccountSender } from "../lib/ownAccountGuard.js";
import { logSystemError } from "../lib/systemError.js";
import { describeError } from "../lib/describeError.js";
import { isBotEnabledForChannel } from "./botChannels.js";
import { loadBotCapabilities } from "./botCapabilities.js";
import { isMetaChannelEnabled } from "./meta.js";
import { enqueueComments, noteCommentsOff, type IncomingComment } from "./commentsQueue.js";
import { youtubeCommentsConfigured } from "./youtubeComments.js";
import type { MessengerChannel } from "./turnTypes.js";

interface CommentValue {
  id?: string;
  parent_id?: string;
  text?: string;
  from?: { id?: string; username?: string; name?: string };
  media?: { id?: string };
}

/**
 * Лента страницы Facebook (field="feed"). Туда сыплется всё сразу: комментарии,
 * лайки, репосты, новые записи — поэтому в разборе обязательны `item` и `verb`.
 */
interface FacebookFeedValue {
  item?: string;
  verb?: string;
  comment_id?: string;
  post_id?: string;
  message?: string;
}

/**
 * Достаёт комментарии из тела вебхука Meta. Чистая функция — проверяется тестом
 * без базы и без сети.
 *
 * Отбрасываем собственные комментарии агентства: `entry.id` — идентификатор
 * НАШЕГО аккаунта Instagram, и совпадение с автором означает, что это наша же
 * реплика. Без этой проверки бот отвечает сам себе, а Meta исправно доставляет
 * каждый новый круг — зацикливание на глазах у всех подписчиков.
 */
export function parseIncomingComments(body: unknown): IncomingComment[] {
  const payload = body as {
    object?: string;
    entry?: { id?: string; changes?: { field?: string; value?: CommentValue & FacebookFeedValue }[] }[];
  } | null;
  // Instagram шлёт object=instagram, страница Facebook — object=page. Всё
  // остальное (WhatsApp, изменения самого приложения) сюда не относится.
  if (payload?.object !== "instagram" && payload?.object !== "page") return [];
  const channel: MessengerChannel = payload.object === "page" ? "FACEBOOK" : "INSTAGRAM";

  const out: IncomingComment[] = [];
  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      /**
       * У ДВУХ КАНАЛОВ РАЗНАЯ ФОРМА ОДНОГО И ТОГО ЖЕ СОБЫТИЯ.
       *
       * Instagram: field="comments", в value сразу id/text/from/media.
       * Facebook: field="feed" — это лента страницы целиком: комментарии, лайки,
       * репосты, новые записи. Нужен только `item="comment"` и `verb="add"`:
       * `edited` — правка чужого текста (отвечать заново не на что), `remove` —
       * удаление. Идентификатор комментария там `comment_id`, публикация —
       * `post_id`, текст — `message`, автор — `from.name` (ника у Facebook нет).
       */
      const value = change.value;
      if (channel === "INSTAGRAM" && change.field !== "comments") continue;
      if (channel === "FACEBOOK") {
        if (change.field !== "feed") continue;
        if (value?.item !== "comment" || value?.verb !== "add") continue;
      }

      const commentId = channel === "FACEBOOK" ? value?.comment_id : value?.id;
      const authorId = value?.from?.id;
      const text = ((channel === "FACEBOOK" ? value?.message : value?.text) ?? "").trim();
      // Комментарий без текста (одна картинка-стикер) отвечать не на что.
      if (!commentId || !authorId || !text) continue;
      // Свой же комментарий (ответ страницы) назад в очередь не берём — иначе
      // бот отвечает сам себе на глазах у подписчиков.
      if (entry.id && authorId === entry.id) continue;
      out.push({
        channel,
        commentId,
        mediaId: (channel === "FACEBOOK" ? value?.post_id : value?.media?.id) ?? "",
        accountExternalId: entry.id,
        // У Facebook верхний комментарий тоже приходит с parent_id — равным id
        // самой записи (02.10.2026). Такой считался «ответом в ветке»: личного не
        // шло ни разу, а бот при этом писал «ответили вам в директ».
        parentId:
          channel === "FACEBOOK" && value?.parent_id && value.parent_id === value?.post_id
            ? undefined
            : value?.parent_id,
        authorId,
        authorName: channel === "FACEBOOK" ? value?.from?.name : value?.from?.username,
        text,
      });
    }
  }
  return out;
}

/** Отвечаем ли мы сейчас на комментарии вообще: транспорт Instagram настроен и
 *  включён, и бот в Instagram не выключен рубильником (общим или канальным).
 *  Комментарии — тот же Instagram, что и директ: выключив бота в Instagram,
 *  владелец не должен обнаружить, что под постами он всё ещё говорит. */
export async function isCommentsBotEnabled(channel: MessengerChannel = "INSTAGRAM"): Promise<boolean> {
  // Отдельный ползунок «отвечать на комментарии» (Настройки → Бот → «Что бот
  // умеет»): под постами бот говорит на людях, и выключать это хочется отдельно
  // от личной переписки, не трогая Instagram целиком.
  if (!(await loadBotCapabilities()).comments) {
    await noteCommentsOff(channel, "выключен общий ползунок «Отвечать на комментарии» (Настройки → Бот)");
    return false;
  }
  // YOUTUBE — свой транспорт (Data API v3, опрос вместо вебхука), у него нет ни
  // Meta-канального рубильника (isBotEnabledForChannel — только Meta+Telegram),
  // ни isMetaChannelEnabled (это про WhatsApp/Instagram/Facebook): единственный
  // вопрос — заведены ли ключи (см. youtubeComments.ts::youtubeCommentsConfigured).
  if (channel === "YOUTUBE") {
    if (!(await youtubeCommentsConfigured())) {
      await noteCommentsOff(channel, "YouTube не настроен: нет client_id/client_secret/refresh_token в Настройках");
      return false;
    }
    return true;
  }
  // Канальный рубильник — свой у каждого канала: владелец может отвечать в
  // Instagram и молчать на странице Facebook, и наоборот (16.08.2026).
  if (!(await isBotEnabledForChannel(channel))) {
    await noteCommentsOff(channel, `бот выключен для канала ${channel} (Настройки → Бот → каналы)`);
    return false;
  }
  if (!(await isMetaChannelEnabled(channel as "INSTAGRAM" | "FACEBOOK"))) {
    await noteCommentsOff(
      channel,
      `канал ${channel} не настроен или выключен: нет маркера/секрета приложения либо снят общий рубильник Meta ` +
        `(Настройки → Meta и Настройки → Каналы)`
    );
    return false;
  }
  return true;
}

// noteCommentsOff живёт в commentsQueue.ts (импортирован выше) — общая для
// Instagram/Facebook и YouTube дневная дедупликация «модерация не работает».

/**
 * Ставит комментарии в очередь. Возвращает число ПРИНЯТЫХ (без дублей) — по нему
 * видно, что повторная доставка ничего не породила.
 *
 * Ошибку наружу не бросаем: вебхук уже ответил Meta «200», и его падение здесь
 * обернулось бы только потерянной записью в журнале.
 */
/**
 * РАЗБИРАЕМ СРАЗУ, НА СЛЕДУЮЩЕМ ТИКЕ КРОНА (переписано 05.09.2026, было —
 * искусственная пауза 1-2 минуты уже здесь, при приёме, для ВСЕХ комментариев
 * без разбора).
 *
 * Раньше пауза «на человечность» держала весь разбор целиком, то есть спам и
 * реклама конкурента под нашим постом висели на виду у подписчиков те же 1-3
 * минуты, что и обычный ответ — а прятать/удалять их незачем медленно (владелец
 * 05.09.2026: «надо быстро убирать»). Пауза никуда не делась, она переехала В
 * МОМЕНТ ПУБЛИКАЦИИ ТЕКСТА (см. humanReplyDelay() ниже) — держит смысл только
 * там, где боту есть что маскировать под живого человека. hide/delete/ignore
 * теперь ждут только естественный такт крона (до минуты), заодно это отменяет
 * прежнее исключение для воронки лид-магнита (владелец 16.08.2026, «жду две
 * минуты — ни ответа, ни файла») — воронка и всё остальное разбираются
 * одинаково быстро, отдельной ветки для неё здесь больше не нужно.
 *
 * Сама постановка в очередь (форма строки + createMany skipDuplicates) вынесена в
 * enqueueComments (commentsQueue.ts) — тем же путём кладёт свои строки и YouTube-
 * поллер (youtubeComments.ts), второй копии нет.
 */
/** Комментарий оставил наш же аккаунт или сотрудник — отвечать ему бот не должен. */
async function isOwnOrStaffCommenter(c: IncomingComment): Promise<boolean> {
  if (await isOwnAccountSender({ senderId: c.authorId, senderName: c.authorName ?? null })) return true;
  const nick = (c.authorName ?? "").trim().replace(/^@/, "").toLowerCase();
  if (!nick || c.channel !== "INSTAGRAM") return false;
  const agent = await prisma.agent.findFirst({
    where: { instagramUsername: { equals: nick, mode: "insensitive" } },
    select: { id: true },
  });
  return agent != null;
}

async function freshPublicCommentItems(items: readonly IncomingComment[]): Promise<IncomingComment[]> {
  // Наша собственная реплика, вернувшаяся как новый комментарий. По `entry.id`
  // такое обычно уже отсеяно, но полагаться на одну проверку в защите от
  // зацикливания нельзя: цена ошибки — бесконечная ветка под постом.
  const ours = await prisma.instagramComment.findMany({
    where: { replyCommentId: { in: items.map((c) => c.commentId) } },
    select: { replyCommentId: true },
    take: items.length,
  });
  const ownIds = new Set(ours.map((o) => o.replyCommentId));
  const fresh = [];
  for (const c of items) {
    if (ownIds.has(c.commentId)) continue;
    // Второй наш аккаунт и сотрудники (02.10.2026). Защита личной переписки
    // узнаёт свои аккаунты по нику (у Instagram у одного аккаунта бывают разные
    // id), а комментарии сверяли только id — и бот отвечал под постом нашему же
    // @royalhome.info и агентам, которые соавторы роликов.
    if (await isOwnOrStaffCommenter(c)) continue;
    fresh.push(c);
  }
  return fresh;
}

/** Managed producer only: errors propagate so the owning HTTP producer can return 503 BEFORE ACK.
 * Queue row + capture atomically persisted by root's P12 port, never by an optimistic note/boolean. */
export async function ingestManagedMetaPublicComments(
  capture: import("./commentsQueue.js").MetaPublicCaptureSession
): Promise<import("../lib/publicCommentTypes.js").PublicResult<readonly import("../lib/publicCommentTypes.js").PublicSourceRef[]>> {
  const fresh = await freshPublicCommentItems(capture.items);
  const enabled = fresh.length > 0 ? await isCommentsBotEnabled(fresh[0].channel) : false;
  return capture.commitFiltered(fresh, enabled);
}

export async function ingestInstagramComments(body: unknown): Promise<number> {
  const items = parseIncomingComments(body);
  if (items.length === 0) return 0;
  try {
    const fresh = await freshPublicCommentItems(items);
    if (fresh.length === 0) return 0;
    const enabled = await isCommentsBotEnabled(fresh[0]?.channel);
    return await enqueueComments(fresh, enabled);
  } catch (err) {
    void logSystemError("meta", `Комментарии Instagram не приняты: ${describeError(err)}`);
    return 0;
  }
}
