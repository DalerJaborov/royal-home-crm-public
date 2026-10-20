import { useState } from "react";
import { MessageSquare } from "lucide-react";
import type { InstagramCommentStatus } from "@royal-home/shared";
import {
  useInstagramComments,
  useModerateInstagramComment,
  type InstagramCommentItem,
} from "../hooks/useInstagramComments";
import { useCan } from "../lib/permissions";
import { useMarkSectionSeen } from "../hooks/useCounters";
import { COMMENT_TABS } from "../lib/instagramCommentsView";
import { Pagination } from "../components/Pagination";
import { useAccumulatedPages } from "../hooks/useAccumulatedPages";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { Rh2CommentCard } from "../components/Rh2CommentCard";
import { exactDateTime } from "../lib/format";
import { ScreenTabs } from "../components/ScreenTabs";
import { InboxTabs } from "../components/SectionTabs";

/**
 * Экран «Комментарии» — что бот сказал и что он спрятал под нашими публикациями.
 *
 * Бот отвечает на комментарии Instagram и скрывает спам с оскорблениями от имени
 * агентства. До этого экрана всё это было видно только в базе и в push: владелец
 * не знал ни что написано от его лица, ни кого перестали видеть подписчики.
 *
 * Отсюда и порядок: сначала скрытое и то, где бот спасовал, потом всё остальное.
 * Скрытие — единственное действие, которое посторонний человек замечает на себе,
 * поэтому оно и выделено, и вынесено в отдельную вкладку, и снимается одной
 * кнопкой, не выходя из ленты.
 *
 * ОБЛИК — эталон темы «Royal Home 2026» дословно
 * (docs/pult/theme-2026/artifact-ff1d9d17-pult-director.html, tpl-comments):
 * срезы `.seg` в `.hscroll`, карточки `.cmt` в `.list`, скрытый комментарий
 * `.cmt.hidden-cmt`, пагинация `.pager`. Классы прототипные, стили приходят из
 * theme-2026-proto.css (область `.rh2`). Поле ответа переиспользует форму
 * `.aib-ask` (тот же макет, что у вопроса ИИ-помощнику на Главной).
 *
 * ОТВЕТИТЬ НА КОММЕНТАРИЙ ПРЯМО ИЗ CRM (владелец 15.09.2026) — раньше эндпоинта
 * не было, и там, где бот спасовал (ESCALATED, «Бот не знал ответа»), сотрудник
 * был вынужден идти отвечать в само приложение Instagram. POST
 * /instagram-comments/:id/reply публикует тем же путём, что бот (postCommentReply),
 * закрыт правом `comments.moderate` (см. Rh2CommentCard.tsx). Личные сообщения
 * по-прежнему не пишутся из CRM — воронка личных сообщений отдельная и здесь не
 * тронута.
 *
 * ОДИН ЭКРАН НА ОБЕ ШИРИНЫ (10.09.2026): мобильная копия components/mobile/
 * MobileComments.tsx повторяла эту разметку 1:1 (общая карточка комментария и
 * так уже была в Rh2CommentCard.tsx, общие вкладки — в COMMENT_TABS) без единой
 * своей строчки логики — узкую раскладку делают медиазапросы темы (≤820/≤640).
 * Копия удалена, правило одной живой копии на экран.
 */

/** Вкладки фильтра — lib/instagramCommentsView.ts, порядок как в макете
 *  (сначала скрытое и то, где бот спасовал). */
const TABS = COMMENT_TABS;

export function Comments() {
  const can = useCan();
  const canView = can("messages.view");
  // Скрытие видно посторонним в Instagram — оно закрыто своим правом, а не общим
  // «видеть переписку». Кнопку прячем, но защита — на сервере (requirePermission).
  const canModerate = can("comments.moderate");
  // Гасит значок «бот не знал ответа» в меню у этого сотрудника. Хук зовём до
  // любых ранних возвратов: правило хуков — ошибка сборки, а не замечание.
  useMarkSectionSeen("comments");
  // Полоса «Обращения» — тот же набор, что на Сообщениях/Звонках/Телефонии
  // (docs/archive/menu-wave2-brief-15-09.md). Хук тоже до ранних return.

  const [status, setStatus] = useState<InstagramCommentStatus | null>(null);
  const [page, setPage] = useState(1);
  // Скрытие и возврат видны постороннему автору комментария, поэтому оба
  // подтверждаются: случайный тап по ленте не должен ничего менять публично.
  const [pending, setPending] = useState<{ item: InstagramCommentItem; hide: boolean } | null>(null);

  const { data, isLoading, error } = useInstagramComments({ status: status ?? undefined, page }, { enabled: canView });

  // Мягкая подгрузка вместо страниц (решение владельца 15.09.2026): страницы
  // копятся в ленту, сброс — сменой статуса (см. setPage(1) ниже).
  // Стоит ДО проверки прав: ниже есть ранний возврат для того, кому раздел
  // закрыт, а хук, оказавшийся за ним, вызывался бы не в каждую отрисовку —
  // правило хуков это запрещает, и сборка падает.
  // Свежая первая страница, пока пролистано дальше неё (аудит №38, useAccumulatedPages).
  const { data: headPage } = useInstagramComments(
    { status: status ?? undefined, page: 1 },
    { enabled: canView && page > 1 }
  );
  const items = useAccumulatedPages(data?.items, page, status, headPage?.items);
  const moderate = useModerateInstagramComment();

  /**
   * ПРЕДУПРЕЖДЕНИЕ СВЕРХУ (макет, tpl-comments) — «бот не знал ответа N,
   * первый ждёт…». Число N честное: `counts.ESCALATED` из той же ленты.
   * Второй отдельный запрос (тот же эндпоинт, только статус ESCALATED и
   * pageSize по числу самих эскалаций) — чтобы найти САМЫЙ старый висящий
   * комментарий: сервер отдаёт список новыми сначала (orderBy createdAt
   * desc), а нужен самый ранний, отдельная сортировка на сервере не заведена.
   * Время — точной датой (exactDateTime), не «N минут назад»: решение
   * владельца 20.08.2026, см. lib/format.ts.
   */
  const escalatedCount = data?.counts?.ESCALATED ?? 0;
  const escalatedProbe = useInstagramComments(
    { status: "ESCALATED", pageSize: Math.min(Math.max(escalatedCount, 1), 200) },
    { enabled: canView && escalatedCount > 0 },
  );
  const oldestEscalatedAt = escalatedProbe.data?.items.length
    ? escalatedProbe.data.items.reduce(
        (min, it) => (it.createdAt < min ? it.createdAt : min),
        escalatedProbe.data.items[0].createdAt,
      )
    : null;

  function choose(next: InstagramCommentStatus | null) {
    setStatus(next);
    setPage(1);
  }

  if (!canView) {
    return (
      <div className="rh2 screens">
        <div className="scr">
          <div className="pg-h">
            <div>
              <h1>Комментарии</h1>
              <p className="sub">
                Раздел доступен тем же, кто видит переписку бота: директору и администратору.
              </p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const counts = data?.counts;

  return (
    <div className="rh2 screens">
      <div className="scr">
        <div className="pg-h">
          <div>
            <h1>Комментарии</h1>
            <p className="sub">
              Что люди пишут под нашими публикациями в Instagram, что бот ответил им от имени агентства и что
              скрыл от подписчиков. Бот отвечает через одну, три минуты.
            </p>
          </div>
        </div>

        <InboxTabs />

        {/* Предупреждение сверху (макет) — только реальный счётчик и реальная
            дата самого старого висящего комментария, без выдуманного «спам
            конкурента»: у нас нет отдельной классификации «этот скрытый
            комментарий — реклама», а просто «скрыт» ничего не объясняет
            честнее самой карточки в списке. */}
        {escalatedCount > 0 && (
          <div className="card tight">
            <div className="quiet crit">
              <span className="dot crit"></span>
              <span className="txt">
                Бот не знал ответа: {escalatedCount}.
                {oldestEscalatedAt ? ` Самый старый — с ${exactDateTime(oldestEscalatedAt)}.` : ""}
              </span>
              <button type="button" className="lnk" onClick={() => choose("ESCALATED")}>
                Посмотреть
              </button>
            </div>
          </div>
        )}

        {/* Без права видно всё то же самое, но руками ничего не изменить. Сказать об
            этом прямо честнее, чем показать ленту без кнопок и оставить гадать.
            Строка, а не карточка-уведомление (договор §6.1). */}
        {!canModerate && (
          <div className="card tight">
            <div className="quiet">
              <span className="dot"></span>
              <span className="txt">
                Скрывать и возвращать комментарии могут сотрудники с этим правом: комментарий пропадает у всех
                подписчиков, и автор это замечает.
              </span>
            </div>
          </div>
        )}

        {/* Отказ сервера при скрытии или возврате — тихой строкой, с кнопкой
            «Понятно»: без reset() ошибка залипала бы после удачной повторной
            попытки (см. MutationError, тот же приём). */}
        {moderate.isError && (
          <div className="card tight">
            <div className="quiet crit" role="alert">
              <span className="dot crit"></span>
              <span className="txt">
                {moderate.error instanceof Error ? moderate.error.message : "Не удалось изменить комментарий"}
              </span>
              <button type="button" className="lnk" onClick={() => moderate.reset()}>
                Понятно
              </button>
            </div>
          </div>
        )}

        <div className="card">
          {/* Срезы прокручиваются вбок: семь штук в строку не помещаются, а перенос
              на две строки съедал бы пол-экрана до первого комментария. */}
          <div className="hscroll">
            <div className="seg" role="tablist" aria-label="Срезы комментариев">
              {TABS.filter((t) => !t.onlyIfAny || t.status === status || (counts?.[t.status!] ?? 0) > 0).map((tab) => {
                const count = tab.status ? (counts?.[tab.status] ?? 0) : (counts?.all ?? 0);
                return (
                  <button
                    key={tab.label}
                    type="button"
                    role="tab"
                    aria-selected={tab.status === status}
                    onClick={() => choose(tab.status)}
                  >
                    {tab.label} <span className="n">{count}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {isLoading ? (
            <div className="state" style={{ marginTop: 16 }}>
              <span className="sk av"></span>
              <span className="sk w40"></span>
              <span className="sk w22"></span>
              Загружаем комментарии
            </div>
          ) : error ? (
            // При отказе сервера показывалось «Комментариев пока нет» — то есть CRM
            // уверенно сообщала, что клиенты молчат, хотя просто не смогла спросить.
            <div className="state err" style={{ marginTop: 16 }}>
              <span className="dot crit"></span>
              {error instanceof Error ? error.message : "Комментарии не загрузились."}
            </div>
          ) : items.length === 0 ? (
            <div className="empty" style={{ marginTop: 16 }}>
              <span className="ic">
                <MessageSquare className="i" />
              </span>
              <p>
                {status
                  ? "Под этот фильтр пока ничего не подходит. Посмотрите вкладку «Все»."
                  : "Как только под публикацией в Instagram появится комментарий, он окажется здесь вместе с ответом бота."}
              </p>
              {status && (
                <button type="button" className="pill ghost" onClick={() => choose(null)}>
                  Показать все
                </button>
              )}
            </div>
          ) : (
            <div className="list" style={{ marginTop: 16 }}>
              {items.map((item) => (
                <Rh2CommentCard
                  key={item.id}
                  item={item}
                  busy={moderate.isPending}
                  canModerate={canModerate}
                  onModerate={(hide) => setPending({ item, hide })}
                />
              ))}
            </div>
          )}

          {data && (
            <div style={{ marginTop: 16 }}>
              <Pagination
                variant="loadMore"
                page={data.page}
                pageSize={data.pageSize}
                total={data.total}
                onPageChange={setPage}
              />
            </div>
          )}
        </div>

        {pending && (
          <ConfirmDialog
            title={pending.hide && pending.item.channel === "YOUTUBE" ? "Отклонить комментарий в YouTube?"
              : pending.hide ? "Скрыть от подписчиков?" : "Вернуть подписчикам?"}
            description={
              pending.hide && pending.item.channel === "YOUTUBE"
                ? "Комментарий и его ответы перестанут отображаться под видео. Возврат через CRM не поддерживается."
                : pending.hide
                ? "Комментарий пропадёт из-под публикации у всех, кроме его автора. Ответ бота, если он был, останется в CRM."
                : "Комментарий снова увидят все подписчики — вместе с тем, что в нём написано."
            }
            confirmLabel={pending.hide && pending.item.channel === "YOUTUBE" ? "Отклонить" : pending.hide ? "Скрыть" : "Вернуть"}
            danger={pending.hide}
            onCancel={() => setPending(null)}
            onConfirm={() => {
              moderate.mutate({ id: pending.item.id, hide: pending.hide });
              setPending(null);
            }}
          />
        )}
      </div>
    </div>
  );
}
