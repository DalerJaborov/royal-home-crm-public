import { Router, type Request, type Response } from "express";
import { z } from "zod";
import {
  INSTAGRAM_COMMENT_STATUSES,
  commentNetworkName,
  instagramCommentQuerySchema,
  instagramCommentReplySchema,
  isInstagramCommentStatus,
  type InstagramCommentStatus,
  commentModerationView,
} from "@royal-home/shared";
import { prisma } from "../db.js";
import { requireAuth, requirePermission } from "../auth/middleware.js";
import { logAudit } from "../lib/audit.js";
import { logSystemError } from "../lib/systemError.js";
import { describeError } from "../messengers/meta.js";
import { isCommentGone, postCommentReply, postCommentReplyResponse, setCommentHidden } from "../messengers/comments.js";
import { resolveIncomingAccount } from "../messengers/accounts.js";
import { publicReplyReceipt } from "../messengers/publicCommentReply.js";
import { claimPublicManualCommentReply, assertPublicManualReplyCurrent, completePublicManualReply,
  publicManualReplyToken, publicManualReplyTarget, publicManualReplyFailure, PublicManualReplyHeld, type PublicManualReplyClaim } from "../lib/customerPublicManualReply.js";

/**
 * Лента комментариев под публикациями Instagram — окно наружу для того, что бот
 * уже делает от имени агентства.
 *
 * До этого роута всё происходило вслепую: бот отвечал подписчикам и прятал от них
 * чужие комментарии, а увидеть это можно было только в базе или в push. Скрытие —
 * действие публичное и необратимое на глазах у автора, поэтому оно обязано быть
 * видно без поиска, а не лежать строкой в таблице.
 *
 * Сама логика ответов живёт в `messengers/comments.ts` — здесь только чтение и
 * ручное «скрыть/вернуть».
 *
 * Права разные, и это принципиально. ЧТЕНИЕ закрыто `messages.view`: комментарии —
 * та же переписка бота от имени компании, что и инбокс. СКРЫТИЕ закрыто отдельным
 * `comments.moderate`: оно видно посторонним людям в Instagram, автор замечает его
 * на себе, и открывать такое заодно с правом читать ленту (оно есть и у
 * руководителя) нельзя.
 */
export const instagramCommentsRouter = Router();
instagramCommentsRouter.use(requireAuth, requirePermission("messages.view"));

/** Что отдаём наружу. authorId (внутренний идентификатор Meta) не отдаём: в
 *  интерфейсе он ничего не значит, а лишний идентификатор человека в ответе —
 *  лишние персональные данные в журнале браузера. */
const COMMENT_FIELDS = {
  id: true,
  commentId: true,
  // Площадка (INSTAGRAM/FACEBOOK/YOUTUBE). Отдаём с 23.09.2026: в ленте лежали
  // комментарии трёх площадок вперемешку, и отличить их было нельзя ничем.
  channel: true,
  mediaId: true,
  parentId: true,
  authorName: true,
  text: true,
  status: true,
  note: true,
  replyText: true,
  repliedAt: true,
  hiddenAt: true,
  dmText: true,
  dmSentAt: true,
  propertyId: true,
  attempts: true,
  createdAt: true,
} as const;

/** Публикация, под которой оставлен комментарий, — насколько она известна CRM.
 *  Ссылка на сам пост берётся из карточки объекта: адреса публикации в таблице
 *  комментариев нет, есть только mediaId, по которому человеку не перейти. */
interface PostRef {
  propertyId: string;
  propertyShortId: number;
  propertyTitle: string;
  instagramUrl: string | null;
}

/**
 * Карточки объектов для всей страницы разом.
 *
 * Одним запросом, а не по объекту на строку: под вирусным постом сотня
 * комментариев ссылается на один и тот же объект, и `await` внутри map дал бы
 * ровно тот N+1, из-за которого инбокс когда-то тормозил на ровном месте.
 *
 * Удалённые объекты берём тоже (без фильтра deletedAt): запись о том, что бот
 * отвечал под этим постом, обязана пережить удаление карточки, иначе история
 * молча теряет половину контекста.
 */
async function loadPosts(propertyIds: (string | null)[]): Promise<Map<string, PostRef>> {
  const ids = [...new Set(propertyIds.filter((id): id is string => Boolean(id)))];
  if (ids.length === 0) return new Map();
  const properties = await prisma.property.findMany({
    where: { id: { in: ids } },
    select: { id: true, shortId: true, title: true, instagramUrl: true },
    take: ids.length,
  });
  return new Map(
    properties.map((p) => [
      p.id,
      { propertyId: p.id, propertyShortId: p.shortId, propertyTitle: p.title, instagramUrl: p.instagramUrl },
    ])
  );
}

/**
 * Лента: страница комментариев, счётчики по статусам и предел выборки.
 *
 * Счётчики считаем всегда и по всей таблице, а не по текущему фильтру: они и есть
 * содержимое переключателя «показать только скрытые», и пересчёт их от фильтра
 * обнулял бы все остальные вкладки, как только человек выбрал одну.
 */
instagramCommentsRouter.get("/", async (req, res) => {
  const parsed = instagramCommentQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: "Неверные данные", details: parsed.error.flatten() });
  }
  const { status, page, pageSize } = parsed.data;
  const where = status ? { status } : {};

  const [rows, total, byStatus] = await Promise.all([
    prisma.instagramComment.findMany({
      where,
      // По времени комментария, а не ответа: комментарий без ответа (в очереди,
      // пропущенный) иначе провалился бы в конец ленты — а это ровно то, что
      // владелец и должен увидеть первым.
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: COMMENT_FIELDS,
    }),
    prisma.instagramComment.count({ where }),
    prisma.instagramComment.groupBy({ by: ["status"], _count: { _all: true } }),
  ]);

  const posts = await loadPosts(rows.map((r) => r.propertyId));

  // Нулевые счётчики тоже нужны: вкладка «Скрытые (0)» честнее исчезающей вкладки,
  // по которой не понять, ничего не скрыто или раздел сломался.
  const counts: Record<string, number> = { all: 0 };
  for (const s of INSTAGRAM_COMMENT_STATUSES) counts[s] = 0;
  for (const g of byStatus) {
    counts[g.status] = g._count._all;
    counts.all += g._count._all;
  }

  res.json({
    items: rows.map(({ propertyId, ...row }) => ({
      ...row,
      post: propertyId ? (posts.get(propertyId) ?? null) : null,
    })),
    total,
    page,
    pageSize,
    counts,
  });
});

// ─── Ручная модерация ───────────────────────────────────────────────────────

/**
 * Скрыть/вернуть комментарий руками — ТЕМ ЖЕ ПУТЁМ, ЧТО И БОТ.
 *
 * До 23.09.2026 здесь лежал свой прямой вызов Graph API «ровно в три строки»: адрес
 * `graph.instagram.com` и общий маркер Instagram из Настроек, без оглядки на канал
 * строки и без маркера аккаунта. Три живых последствия:
 *
 *  - комментарий со страницы Facebook (их приносит тот же вебхук с 16.08.2026, поле
 *    `feed`) кнопка «Скрыть» не скрывала: чужой маркер чужого комментария не видит;
 *  - комментарий под роликом YouTube (17.09.2026) — то же самое, у него и Graph API
 *    другой, и понятия `hide` нет вовсе (там состояние модерации);
 *  - при нескольких подключённых аккаунтах Instagram общий маркер не видел
 *    публикацию чужого аккаунта — ровно та же прод-ошибка, что 22.08.2026 ловили на
 *    загрузке публикации («Object with ID … does not exist»).
 *
 * Выбор адреса и маркера теперь один на весь репозиторий — `setCommentHidden`
 * (messengers/comments.ts), тот же, которым скрывает бот. Аккаунт достаётся той же
 * `resolveIncomingAccount`, что и в ручном ответе ниже (POST /:id/reply).
 */
async function setCommentHiddenForRow(
  row: { channel: string; commentId: string; accountExternalId: string | null },
  hide: boolean
): Promise<void> {
  const account =
    row.channel === "YOUTUBE"
      ? { token: undefined as string | undefined }
      : await resolveIncomingAccount(row.channel, row.accountExternalId ?? undefined);
  await setCommentHidden(row.channel, row.commentId, hide, account.token);
}

const idSchema = z.guid();

/**
 * Каким статус станет после возврата подписчикам.
 *
 * Берём тот, что был ДО скрытия: «Бот не знал ответа» — это случай, ждущий
 * человека, и раньше он молча превращался в «Бот промолчал», то есть в «всё в
 * порядке». Настоящая история терялась, и разбирать было нечего.
 *
 * Догадка по наличию ответа остаётся запасным путём — для записей, скрытых до
 * появления поля, и для тех, что спрятал сам бот (у них прежнего состояния не
 * было вовсе). WORKING и HIDDEN отбрасываем: первый вернул бы запись в мнимую
 * обработку кроном, второй оставил бы её «скрытой» сразу после возврата.
 */
function restoredStatus(row: { statusBeforeHide: string | null; replyText: string | null }): InstagramCommentStatus {
  const before = row.statusBeforeHide;
  if (before && isInstagramCommentStatus(before) && before !== "WORKING" && before !== "HIDDEN" && before !== "DELETED") return before;
  return row.replyText ? "REPLIED" : "SKIPPED";
}

/**
 * Общий путь обеих кнопок: проверки, вызов Meta, запись итога.
 *
 * `WORKING` отвергаем: прямо сейчас этот комментарий держит крон, и его `finish()`
 * затрёт наш статус через секунду — человек увидел бы, что кнопка «сработала», а
 * через минуту всё вернулось. Честный отказ лучше исчезающего действия.
 */
async function moderate(req: Request, res: Response, hide: boolean) {
  const id = idSchema.safeParse(req.params.id);
  if (!id.success) return res.status(400).json({ error: "Неверный идентификатор" });

  const row = await prisma.instagramComment.findUnique({
    where: { id: id.data },
    // channel и accountExternalId — не для показа, а для выбора адреса Graph и
    // маркера: без них скрытие уходило в Instagram при любой площадке.
    select: {
      id: true,
      commentId: true,
      channel: true,
      accountExternalId: true,
      status: true,
      replyText: true,
      statusBeforeHide: true,
    },
  });
  if (!row) return res.status(404).json({ error: "Комментарий не найден" });
  if (row.status === "WORKING") {
    return res.status(409).json({ error: "Бот сейчас разбирает этот комментарий — попробуйте через минуту" });
  }
  const view = commentModerationView(row);
  if (!view.supportsModeration) return res.status(409).json({ error: "Модерация этого канала или статуса не поддерживается" });
  if (view.deleted) return res.status(409).json({ error: "Комментарий отмечен удалённым — эта модерация недоступна" });
  if (!hide && row.channel === "YOUTUBE") {
    return res.status(409).json({ error: "Возврат отклонённого комментария YouTube не поддерживается" });
  }

  const alreadyHidden = row.status === "HIDDEN";
  if (alreadyHidden === hide) {
    // Повторное нажатие (двойной тап на телефоне, догнавший запрос) ничего не
    // должно стоить: в Meta не идём, отвечаем текущим состоянием.
    return res.json({ ok: true, status: row.status });
  }

  try {
    await setCommentHiddenForRow(row, hide);
  } catch (err) {
    // Журнал — в тот источник, которому площадка принадлежит: искать отказ YouTube
    // в записях Meta сотруднику неоткуда.
    void logSystemError(
      row.channel === "YOUTUBE" ? "youtube" : "meta",
      `Комментарий ${row.commentId} не ${hide ? "скрыт" : "возвращён"}: ${describeError(err)}`
    );
    // Площадку называем ту, где комментарий на самом деле: «Instagram не принял»
    // под комментарием со страницы Facebook отправляло сотрудника искать причину
    // не в том кабинете.
    const network = commentNetworkName(row.channel);
    return res.status(502).json({
      error: hide
        ? `${network} не подтвердил скрытие — проверьте результат на площадке`
        : `${network} не подтвердил возврат — проверьте результат на площадке`,
    });
  }

  const status: InstagramCommentStatus = hide ? "HIDDEN" : restoredStatus(row);
  const updated = await prisma.instagramComment.update({
    where: { id: row.id },
    data: {
      status,
      hiddenAt: hide ? new Date() : null,
      note: hide ? `${row.channel === "YOUTUBE" ? "youtube_rejected" : "moderation_hidden"}; manual_hide` : "manual_unhide",
      // Прежний статус запоминаем при скрытии и стираем при возврате: живым он
      // нужен ровно на время, пока комментарий спрятан. Оставленное значение
      // потом восстановилось бы во второй раз, уже поверх новой истории.
      statusBeforeHide: hide ? row.status : null,
    },
    select: { id: true, status: true, hiddenAt: true, note: true },
  });

  // Скрытие видно постороннему автору комментария — это действие от имени
  // компании, и в истории должно быть видно, кто именно его сделал.
  logAudit(req, hide ? "IG_COMMENT_HIDE" : "IG_COMMENT_UNHIDE", "InstagramComment", row.id, {
    commentId: row.commentId,
  });

  res.json({ ok: true, ...updated });
}

/**
 * Скрыть комментарий от подписчиков вручную и вернуть обратно.
 *
 * Право проверяется ЗДЕСЬ, на сервере, а не только прятанием кнопки в интерфейсе:
 * запрос уходит одной строкой из консоли браузера, и спрятанная кнопка защитой не
 * является. Возврат закрыт тем же правом: он тоже меняет то, что видят подписчики.
 */
instagramCommentsRouter.post("/:id/hide", requirePermission("comments.moderate"), (req, res) =>
  moderate(req, res, true)
);

instagramCommentsRouter.post("/:id/unhide", requirePermission("comments.moderate"), (req, res) =>
  moderate(req, res, false)
);

// ─── Ручной ответ ────────────────────────────────────────────────────────────

/**
 * Отказ Meta человеческим текстом, а не общей ошибкой (владелец 15.09.2026).
 *
 * `isCommentGone` уже отличает «комментарий удалён/недоступен» от прочих отказов
 * (см. messengers/comments.ts) — тот же признак, а не вторая копия регулярки.
 * Остальные тексты Graph заворачивает `callGraph` в `Error("Graph API HTTP …")`
 * с телом ответа внутри: ищем в нём типичные коды окна ответа и прав доступа,
 * чтобы не показывать сотруднику сырой JSON от Meta.
 */
function describeReplyFailure(err: unknown, channel: string): string {
  // Площадка строки, а не «Instagram» всегда (23.09.2026): тот же ответ уходит и
  // под пост страницы Facebook, и под ролик YouTube, и сотрудника, которому
  // сказали «Instagram отказал по правам», это отправляло не в тот кабинет.
  const network = commentNetworkName(channel);
  if (isCommentGone(err)) {
    return `Комментарий удалён или недоступен в ${network} — отвечать уже некому`;
  }
  const text = err instanceof Error ? err.message : String(err ?? "");
  if (/expired|too old|can no longer|window/i.test(text)) {
    return `Окно ответа на этот комментарий истекло — ${network} больше не принимает публичные ответы под ним`;
  }
  if (/oauthexception|permission|access token|not authorized|insufficient/i.test(text)) {
    return `${network} отказал по правам доступа — проверьте маркер аккаунта в Настройках`;
  }
  return `${network} не принял ответ: ${describeError(err)}`;
}

/**
 * Ответить на комментарий прямо из CRM (владелец 15.09.2026).
 *
 * Раньше сотрудник, увидев «бот не знает ответа» (ESCALATED), был вынужден идти
 * отвечать в само приложение Instagram — эндпоинта не было (см. заголовок файла
 * Comments.tsx до этой правки). Публикует тем же путём, что бот (postCommentReply
 * в messengers/comments.ts), маркером аккаунта, под чьим постом комментарий
 * (resolveIncomingAccount — тот же вызов, что и в handleComment).
 *
 * Право то же, что у скрытия: `comments.moderate`. Ответ от чужого лица виден
 * подписчикам так же, как скрытие, — это не «прочитать переписку», а действие
 * от имени компании наружу.
 *
 * ЗАПИСЬ ИТОГА — ТЕМ ЖЕ НАБОРОМ ПОЛЕЙ, ЧТО У БОТА (status/replyText/replyCommentId/
 * repliedAt, см. handleComment), чтобы в ленте ручной и автоматический ответ
 * выглядели одинаково. Ручной ответ отмечен `note: "manual_reply"` — решение
 * без миграции схемы: поле note уже хранит короткие машинные коды исхода
 * ("manual_hide", "ai_down" и т.п.), и в словарь подписей
 * (INSTAGRAM_COMMENT_NOTE_LABELS) достаточно было добавить одну строку.
 */
instagramCommentsRouter.post("/:id/reply", requirePermission("comments.moderate"), async (req, res) => {
  const id = idSchema.safeParse(req.params.id);
  if (!id.success) return res.status(400).json({ error: "Неверный идентификатор" });

  const body = instagramCommentReplySchema.safeParse(req.body);
  if (!body.success) {
    return res.status(400).json({ error: body.error.issues[0]?.message ?? "Неверные данные" });
  }

  const row = await prisma.instagramComment.findUnique({
    where: { id: id.data },
    select: { id: true, commentId: true, channel: true, status: true, accountExternalId: true, parentId: true },
  });
  if (!row) return res.status(404).json({ error: "Комментарий не найден" });
  if (row.status === "WORKING") {
    return res.status(409).json({ error: "Бот сейчас разбирает этот комментарий — попробуйте через минуту" });
  }
  const view = commentModerationView(row);
  if (!view.supportsModeration) return res.status(409).json({ error: "Ответ для этого канала или статуса не поддерживается" });
  if (view.deleted) return res.status(409).json({ error: "Комментарий отмечен удалённым — ответить на него нельзя" });
  if (view.hidden) {
    return res.status(409).json({ error: row.channel === "YOUTUBE"
      ? "Комментарий отклонён YouTube — ответить на него из CRM нельзя"
      : "Комментарий скрыт — сначала верните его подписчикам" });
  }

  let replyCommentId: string | null;
  let publicClaim: PublicManualReplyClaim | null = null;
  try {
    publicClaim = await claimPublicManualCommentReply(row.id, req.agent!.id, body.data.text);
    const originalPublicClaim = publicClaim;
    if (originalPublicClaim) {
      // Target/token come from the actual locked source claim, never the older route row/default account.
      const target = publicManualReplyTarget(originalPublicClaim);
      let observed, physicalError: unknown;
      try {
        const token = await publicManualReplyToken(originalPublicClaim);
        const raw = await postCommentReplyResponse(target, body.data.text, token,
          () => assertPublicManualReplyCurrent(originalPublicClaim));
        observed = publicReplyReceipt(target.channel, raw);
      } catch (error) { physicalError = error; observed = publicManualReplyFailure(originalPublicClaim, error); }
      // Settlement is outside actor/source validation and precedes any conditional local projection.
      const completed = await completePublicManualReply(originalPublicClaim, observed);
      if (completed.receipt.outcome !== "accepted" && physicalError instanceof PublicManualReplyHeld) return res.status(physicalError.status).json({
        error: "Публикация удержана: источник или права изменились; попытка сохранена", code: physicalError.code,
      });
      if (completed.receipt.outcome !== "accepted") return res.status(502).json({
        error: "Площадка не подтвердила публикацию. Попытка сохранена; автоматического повтора нет", code: "PUBLIC_REPLY_UNKNOWN",
      });
      replyCommentId = completed.receipt.providerId;
      if (!completed.applicable) {
        logAudit(req, "IG_COMMENT_REPLY", "InstagramComment", row.id, { commentId: target.commentId, projectionPending: true });
        return res.status(202).json({ ok: true, id: row.id, deliveryStatus: "ACCEPTED", projectionPending: true });
      }
    } else {
      // Старый путь (без originCiphertext) раньше ничего не захватывал: два одновременных
      // POST оба проходили проверки выше и оба публиковали ответ. Теперь комментарий атомарно
      // берётся в WORKING с условием на прежний статус; проигравший получает 409.
      const taken = await prisma.instagramComment.updateMany({ where: { id: row.id, status: row.status }, data: { status: "WORKING" } });
      if (taken.count !== 1) {
        return res.status(409).json({ error: "Этот комментарий уже обрабатывается — обновите ленту", code: "PUBLIC_REPLY_HELD" });
      }
      let posted: string | null = null;
      try {
        const account = await resolveIncomingAccount(row.channel, row.accountExternalId ?? undefined);
        posted = await postCommentReply(row, body.data.text, account.token);
      } finally {
        // Не опубликовано (отказ или исключение) — статус назад, чтобы можно было повторить.
        if (!posted) {
          await prisma.instagramComment.updateMany({ where: { id: row.id, status: "WORKING" }, data: { status: row.status } }).catch(() => undefined);
        }
      }
      replyCommentId = posted;
      if (!replyCommentId) return res.status(502).json({ error: "Площадка не подтвердила публикацию", code: "PUBLIC_REPLY_UNKNOWN" });
    }
  } catch (err) {
    if (err instanceof PublicManualReplyHeld) return res.status(err.status).json({
      error: "Публикация удержана: источник или права изменились либо по комментарию уже есть попытка отправки", code: err.code,
    });
    if (publicClaim) {
      void logSystemError("meta", "Не удалось сохранить или прочитать квитанцию ручного публичного ответа; автоматического повтора нет");
      return res.status(503).json({ error: "Квитанция публикации пока не подтверждена. Повторная отправка автоматически не выполняется", code: "PUBLIC_REPLY_UNKNOWN" });
    }
    void logSystemError("meta", `Ручной ответ на комментарий ${row.commentId} не отправлен: ${describeError(err)}`);
    return res.status(502).json({ error: describeReplyFailure(err, row.channel) });
  }

  const updated = publicClaim ? await prisma.instagramComment.findUniqueOrThrow({ where: { id: row.id },
    select: { id: true, status: true, replyText: true, repliedAt: true } }) : await prisma.instagramComment.update({
    where: { id: row.id },
    data: {
      status: "REPLIED",
      replyText: body.data.text,
      replyCommentId,
      repliedAt: new Date(),
      note: "manual_reply",
    },
    select: { id: true, status: true, replyText: true, repliedAt: true },
  });

  // Публичный ответ от имени компании — та же причина, по которой скрытие
  // логируется аудитом (см. moderate выше).
  logAudit(req, "IG_COMMENT_REPLY", "InstagramComment", row.id, { commentId: row.commentId });

  res.json({ ok: true, ...updated });
});
