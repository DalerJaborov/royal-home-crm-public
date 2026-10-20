import { useState } from "react";
import { Link } from "react-router-dom";
import { Image } from "lucide-react";
import { commentModerationView, commentNetworkName, instagramCommentNoteLabel } from "@royal-home/shared";
import type { InstagramCommentItem } from "../hooks/useInstagramComments";
import { useReplyToInstagramComment } from "../hooks/useInstagramComments";
import { RH2_COMMENT_CHIP, rh2CommentInitials } from "../lib/instagramCommentsView";
import { rh2AvatarTone } from "../lib/rh2Avatar";
import { relativeTime } from "../lib/format";
import { MutationError } from "./MutationError";

/**
 * Один комментарий: кто написал, что написал, что бот ответил, что с ним стало.
 *
 * Разметка — `.cmt` эталона темы «Royal Home 2026»
 * (docs/pult/theme-2026/artifact-ff1d9d17-pult-director.html, tpl-comments):
 * аватар, тело, миниатюра публикации справа. Компонент один на обе ширины —
 * pages/Comments.tsx рисует один и тот же экран, узкую раскладку делают
 * медиазапросы темы (≤820/≤640px); отдельной мобильной копии больше нет
 * (10.09.2026, разъехавшихся копий не осталось — та же беда экранов Oversight).
 */
export function Rh2CommentCard({
  item,
  busy,
  canModerate,
  onModerate,
}: {
  item: InstagramCommentItem;
  busy: boolean;
  canModerate: boolean;
  onModerate: (hide: boolean) => void;
}) {
  const moderation = commentModerationView(item);
  const hidden = moderation.hidden;
  const note = instagramCommentNoteLabel(item.note);
  const author = item.authorName ? `@${item.authorName}` : "Подписчик";
  const manualReply = item.note === "manual_reply";

  const reply = useReplyToInstagramComment();
  const [draft, setDraft] = useState("");
  // Поле открыто, только пока нет своего ответа: под уже отвеченным комментарием
  // (ботом или сотрудником) переписываться из ленты незачем — второе публичное
  // сообщение под тем же комментарием выглядело бы для подписчиков странно.
  const canReply = canModerate && moderation.canReply && !item.replyText;

  function submitReply() {
    const text = draft.trim();
    if (!text) return;
    reply.mutate(
      { id: item.id, text },
      { onSuccess: () => setDraft("") }
    );
  }

  return (
    // data-list-row — как и в PropertyRow/Clients, устойчивый крючок для e2e.
    // Скрытое помечено `.hidden-cmt`: это единственное действие бота, которое
    // посторонний человек замечает на себе, и искать его в общей ленте владелец
    // не должен.
    <article data-list-row className={`cmt${hidden ? " hidden-cmt" : ""}`}>
      <span className="av" style={rh2AvatarTone(item.authorName)}>
        {rh2CommentInitials(item.authorName)}
      </span>
      <div className="body">
        <div className="head">
          <b>{author}</b>
          <span className={`chip ${RH2_COMMENT_CHIP[item.status] ?? RH2_COMMENT_CHIP.SKIPPED}`}>
            {moderation.label}
          </span>
          {/* Площадка: в ленте лежат Instagram, страница Facebook и YouTube
              вперемешку, и до 23.09.2026 отличить их было нельзя ничем — а
              «скрыть» на каждой площадке работает по-своему. */}
          <span className="chip mute">{commentNetworkName(item.channel)}</span>
          <span className="chip mute">{relativeTime(item.createdAt)}</span>
        </div>

        <p className="under">
          {item.post ? (
            <>
              Под объектом{" "}
              <Link className="lk mut" to={`/properties/${item.post.propertyShortId}`}>
                {item.post.propertyTitle}
              </Link>
            </>
          ) : (
            // Адреса публикации в комментарии нет — он берётся из карточки объекта.
            // Пост без привязки к объекту честнее назвать так, чем вести в никуда.
            "Публикация не привязана к объекту CRM"
          )}
        </p>

        <p className="text">«{item.text}»</p>

        {item.parentId && <p className="under">Ответ внутри ветки комментариев</p>}

        {/* Скрытие описываем словами, а не одним значком: «за что» — первый вопрос,
            который задаст владелец, увидев, что человека перестали показывать. */}
        {hidden && (
          <p className="under">
            {moderation.label}{item.hiddenAt ? ` ${relativeTime(item.hiddenAt)}` : ""}
            {note ? `. ${note}` : ""}. {moderation.youtubeRejection
              ? "Возврат из CRM не поддерживается."
              : moderation.hiddenConfirmed ? "Автор по-прежнему видит свой комментарий." : "Текущая видимость не подтверждена."}
          </p>
        )}

        {item.replyText && (
          <p className="under">
            {manualReply ? "Сотрудник ответил публично" : "Бот ответил публично"}
            {item.repliedAt ? ` ${relativeTime(item.repliedAt)}` : ""}: «{item.replyText}»
          </p>
        )}

        {item.dmText && (
          <p className="under">
            И написал в личные сообщения{item.dmSentAt ? ` ${relativeTime(item.dmSentAt)}` : ""}: «{item.dmText}»
          </p>
        )}

        {/* Причина нужна там, где ответа нет: иначе «Бот промолчал» выглядит
            поломкой, хотя молчание могло быть правильным решением. */}
        {note && !hidden && (
          <p className="under">
            Почему: {note}
            {item.status === "FAILED" && item.attempts > 0 ? ` (попыток: ${item.attempts})` : ""}
          </p>
        )}

        {/* Ответить прямо из CRM (владелец 15.09.2026) — там, где бот спасовал
            (ESCALATED), сотрудник больше не идёт отвечать в само приложение
            Instagram. Право то же, что у скрытия: ответ виден подписчикам так же
            публично. Поле прячется, как только под комментарием уже есть ответ —
            свой или ботовский. */}
        {canReply && (
          <div className="aib-ask">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                submitReply();
              }}
            >
              <input
                type="text"
                className="inp"
                aria-label="Ответить публично от имени агентства"
                placeholder="Ответить публично от имени агентства…"
                value={draft}
                disabled={reply.isPending}
                maxLength={2200}
                autoComplete="off"
                onChange={(e) => setDraft(e.target.value)}
              />
              <button type="submit" className="pill sm" disabled={reply.isPending || !draft.trim()}>
                Ответить
              </button>
            </form>
          </div>
        )}
        <MutationError mutation={reply} variant="rh2" fallback="Не удалось отправить ответ" />

        <div className="acts">
          {/* Условный рендер, а не атрибут hidden: на flex-элементе он не срабатывает.
              Без права кнопки нет вовсе — «неактивная» кнопка обещала бы возможность,
              которой нет, и на сервере всё равно вернулся бы отказ. */}
          {canModerate && (moderation.canHide || moderation.canUnhide) && (
            <button type="button" className="pill ghost sm" disabled={busy} onClick={() => onModerate(!hidden)}>
              {hidden ? "Вернуть подписчикам" : item.channel === "YOUTUBE" ? "Отклонить в YouTube" : "Скрыть от подписчиков"}
            </button>
          )}
          {item.post?.instagramUrl && (
            <a className="lnk" href={item.post.instagramUrl} target="_blank" rel="noreferrer">
              Открыть публикацию
            </a>
          )}
          {item.post && (
            <Link className="lnk" to={`/properties/${item.post.propertyShortId}`}>
              Открыть объект
            </Link>
          )}
        </div>
      </div>
      <span className="thumb" aria-hidden="true">
        <Image className="i lg" />
      </span>
    </article>
  );
}
