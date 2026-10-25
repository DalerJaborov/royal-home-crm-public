import { ShellOwnHeader } from "../components/rh2/ShellOwnHeader";
import { useMemo, useState } from "react";
import { useAuthStore } from "../store/auth";
import { useNavigate } from "react-router-dom";
import { useGoBack } from "../hooks/useGoBack";
import { Bell, Calendar, CheckSquare, Flame, MapPin, MessageCircle, TrendingUp, Trophy } from "lucide-react";
import type { CSSProperties } from "react";
import type { LucideIcon } from "lucide-react";
import {
  useAutoReadNotifications,
  useMarkNotificationRead,
  useMarkAllNotificationsRead,
  useNotifications,
  useSeenSnapshot,
} from "../hooks/useNotifications";
import { api } from "../lib/api";
import { dushanbeDate, dushanbeDayKey, dushanbeDayLabel, dushanbeTime } from "../lib/date";
import { groupNotifications, notificationLevel as levelOf, PINNED_NOTIFICATION_LEVELS as PINNED } from "../lib/notificationGroups";
import type { AppNotification } from "../types";
import { useMobileUx } from "../hooks/useMobileUx";
import { MhQuiet } from "../components/home/mh/MhScreen";
import { ChevronLeft } from "lucide-react";
import { useClients, useAcceptLead, isRequiresRelease } from "../hooks/useClients";
import { MutationError } from "../components/MutationError";
import { Rh2ErrorState } from "../components/rh2/Rh2ErrorState";
import { Rh2EmptyState } from "../components/rh2/Rh2EmptyState";

/**
 * `/notifications` — полноэкранная лента уведомлений.
 *
 * На телефоне открывается колокольчиком в MobileHomeHeader (18.08.2026), на
 * десктопе — колокольчиком в шапке (Topbar). Десктопный редирект на Главную
 * убран 27.08.2026 (аудит №4): комментарий уверял, что «на десктопе уведомления
 * живут в выпадашке Topbar», но там была захардкоженная строка «Новых
 * уведомлений нет» — директор за компьютером не мог открыть ленту НИКАК.
 *
 * ОБЛИК: дословный перенос утверждённого прототипа темы «Royal Home 2026»
 * (docs/pult/theme-2026/screens/notifications.html). Классы прототипные
 * (`.scr`, `.pg-h`, `.card`, `.sec-h.stack`, `.list`/`.row`/`.day`, `.chip`,
 * `.pill`), экран включает эталон обёрткой `<div className="rh2 screens">`, стили
 * приходят из apps/web/src/theme-2026-proto.css.
 *
 * НА ПК — разметка эта самая, прототипная (`.rh2 screens`, `.card`/`.list`/
 * `.row`), перестраивается медиазапросом ниже 820px.
 *
 * НА ТЕЛЕФОНЕ (14.09.2026) — отдельный дизайн мобильного макета c99db05f
 * (`notificationsMobileView()` ниже, в ЭТОМ ЖЕ файле, `.rh2 .mh`). НЕ отдельный
 * файл-двойник: правило проекта («Oversight/MobileOversight», два антифрод-
 * пропуска 22.08 и 30.08 — раздельные файлы молча расходятся) запрещает
 * заводить второй компонент со своими хуками. Здесь один набор хуков
 * (`useNotifications`, `useMarkNotificationRead` и т.д.) считается ОДИН раз в
 * `Notifications()`, а мобильная разметка получает уже готовые значения
 * параметрами — версии физически не могут разойтись, потому что вторых
 * запросов нет вовсе.
 *
 * ЧЕТЫРЕ УРОВНЯ — ПО СУТИ ДЕЛА (владелец 09.09.2026, переделано 12.09.2026).
 *
 * Сначала лента делилась на «Требуют действия» и «Просто к сведению», и деление
 * выводилось здесь, на фронте, из `kind` — у сервера признака не было. Потом
 * появился признак, но не тот: шкала громкости (Срочное / Важное / Обычное /
 * К сведению). Владелец же описывал деление по ТИПУ дела и первым назвал «ждёт
 * моего одобрения», объяснив почему: «они блокируют работу людей». Громкость на
 * этот вопрос не отвечает — заявка на удаление не «срочная», она просто ничья,
 * пока её не решили, и человек на той стороне стоит.
 *
 * Уровни данных остаются прежними. Для ADMIN/DIRECTOR три визуальные очереди:
 * согласования, контроль, задачи и подсказки; у остальных четыре прежних раздела.
 *
 * ДВА ВЕРХНИХ РАЗДЕЛА БЕРУТСЯ ИЗ ДВУХ МЕСТ. `data.pinned` — непрочитанное этих
 * уровней по ВСЕЙ ленте, отдельным запросом: строка недельной давности выпадает
 * за двадцать записей первой страницы, и без этого списка с глаз исчезает ровно
 * то, что дольше всех ждёт. Плюс такие же строки с текущей страницы, включая уже
 * прочитанные — они остаются видны до перезагрузки, чтобы список не дёргался под
 * руками. Склейка по id.
 *
 * Записи без level (созданные до появления поля) считаются «прочим».
 */

// Та же область, что в TeamMemberDetail.tsx / components/home/mh/MhScreen.tsx:
// оболочка (AppLayout) даёт содержимому поля `px-5 pt-4` и запас снизу под
// нижнюю панель, артефакт держит поля сам.
const MH_HOST: CSSProperties = {
  margin: "0 -16px calc(-96px - env(safe-area-inset-bottom, 0px))",
  paddingBottom: "calc(96px + env(safe-area-inset-bottom, 0px))",
  minHeight: "calc(100dvh - 16px - env(safe-area-inset-top, 0px))",
  display: "flex",
  flexDirection: "column",
};


/**
 * Подпись «прочитано» для строки, которая не новая и не передана (владелец,
 * кадр с телефона агента, 15.09.2026). Для «Ждёт решения» (APPROVAL) слово
 * «Просмотрено» врёт: строка, прочитанная вручную (кнопка «Прочитано», открытие
 * записи), а решение по лиду ещё не принято, выглядит разобранной, хотя человек на
 * той стороне всё ещё ждёт. Автопрочтение (useAutoReadNotifications) APPROVAL с
 * 04.10.2026 не трогает вовсе. Прочие
 * уровни и «Передан» (retiredAt, проверяется до вызова этой функции) не тронуты.
 */
function readLabel(n: AppNotification): string {
  return levelOf(n) === "APPROVAL" ? "Ждёт вас" : "Просмотрено";
}

/** Числовой shortId клиента из url лид-уведомления (`/clients/123`), либо null. */
function leadShortId(n: AppNotification): number | null {
  if (n.kind !== "lead" || !n.url) return null;
  const m = /^\/clients\/(\d+)$/.exec(n.url);
  return m ? Number(m[1]) : null;
}

/**
 * «Принять» прямо в ленте (владелец, кадр с телефона, 15.09.2026): раньше это
 * умел только системный пуш (pushLeadActions.ts) — смахнул его, и лид можно
 * принять только зайдя в карточку, хотя раздел зовётся «Ждёт решения».
 *
 * ЭТАЛОН — apps/web/src/components/home/AgentHome.tsx, PendingLeadRow: тот же
 * хук `useAcceptLead`, та же обработка `isRequiresRelease` (портфель полон —
 * ведём в карточку выбрать, кого освободить, вместо своей логики), та же
 * плашка `MutationError`. Отдельный компонент строки, а не хук внутри map по
 * списку уведомлений — правило хуков этого не прощает.
 */
function LeadAcceptAction({
  clientId,
  onRequireRelease,
  className,
}: {
  clientId: string;
  onRequireRelease: () => void;
  className: string;
}) {
  const acceptLead = useAcceptLead(clientId);
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4 }}>
      <button
        type="button"
        className={className}
        disabled={acceptLead.isPending}
        onClick={(e) => {
          e.stopPropagation();
          acceptLead.mutate(undefined, {
            onError: (err) => {
              if (isRequiresRelease(err)) onRequireRelease();
            },
          });
        }}
      >
        {acceptLead.isPending ? "Принятие…" : "Принять"}
      </button>
      <MutationError mutation={acceptLead} fallback="Не удалось принять лид" />
    </div>
  );
}

/**
 * Тон и значок кружка слева. Прототип рисует в `.av` либо инициалы человека,
 * либо пиктограмму; у уведомления человека нет, поэтому пиктограмма по поводу —
 * ровно те же значки, что стояли в прежней ленте, в токенах темы.
 */
const KIND_LOOK: Record<string, { icon: LucideIcon; tone: CSSProperties }> = {
  lead: { icon: Flame, tone: { background: "var(--pink)", color: "var(--pink-ink)" } },
  message: { icon: MessageCircle, tone: { background: "var(--sky)", color: "var(--sky-ink)" } },
  showing: { icon: Calendar, tone: { background: "var(--lav)", color: "var(--lav-ink)" } },
  task: { icon: CheckSquare, tone: { background: "var(--aqua)", color: "var(--aqua-ink)" } },
  score: { icon: Trophy, tone: { background: "var(--lime)", color: "var(--lime-ink)" } },
  /** Гео-подбор (12.09.2026, блок D7) — своя иконка, иначе серый колокольчик. */
  look: { icon: MapPin, tone: { background: "var(--sky)", color: "var(--sky-ink)" } },
  /** «Объект загорелся» (24.09.2026) — рост просмотров, не огонь лида. */
  hot: { icon: TrendingUp, tone: { background: "var(--lime)", color: "var(--lime-ink)" } },
};
const DEFAULT_LOOK = { icon: Bell, tone: { background: "var(--soft)", color: "var(--muted)" } };

/** Подпись дня, как в прототипе: «Сегодня, 7 сентября», «Вчера, 6 сентября», «5 сентября». */
function dayCaption(at: string): string {
  const label = dushanbeDayLabel(at);
  if (label === "Сегодня" || label === "Вчера") {
    return `${label}, ${dushanbeDate(at, { day: "numeric", month: "long" })}`;
  }
  return label;
}

/** Разбивает ленту на дни, сохраняя порядок сервера (свежие сверху). */
function byDay(items: AppNotification[]): { key: string; caption: string; items: AppNotification[] }[] {
  const groups: { key: string; caption: string; items: AppNotification[] }[] = [];
  for (const n of items) {
    const key = dushanbeDayKey(n.createdAt);
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.items.push(n);
    else groups.push({ key, caption: dayCaption(n.createdAt), items: [n] });
  }
  return groups;
}

export function Notifications() {
  const navigate = useNavigate();
  // «Назад» экрана: запасной путь — «Ещё», откуда уведомления и открывают.
  const goBack = useGoBack("/more");
  const mobile = useMobileUx();
  const { data, isLoading, isError, refetch } = useNotifications();
  const markRead = useMarkNotificationRead();
  const markAllRead = useMarkAllNotificationsRead();
  /**
   * «Показать ещё» (шаблон tpl-notifications, `.pager`) — первая страница идёт
   * из `useNotifications()` (дропдаун и бейдж колокольчика её же кешируют,
   * второй источник правды заводить незачем), следующие страницы дозагружает
   * этот экран сам через тот же `/me/notifications?page=`. Сервер не отдаёт
   * общее число уведомлений (только `hasMore`), поэтому подпись — честные
   * «Показано N», а не выдуманное «из скольки-то».
   */
  const [extraItems, setExtraItems] = useState<AppNotification[]>([]);
  const [nextPage, setNextPage] = useState(2);
  // Пока свою страницу не грузили ни разу, «есть ли ещё» отвечает первая
  // страница (`data.hasMore`); после первой ручной догрузки — её собственный
  // ответ. `undefined` до первого ответа сервера прячет кнопку молча, а не
  // рисует её раньше времени.
  const [moreHasMore, setMoreHasMore] = useState<boolean | undefined>(undefined);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);

  async function loadMore() {
    setLoadingMore(true);
    setMoreError(null);
    try {
      const res = await api<{ items: AppNotification[]; hasMore: boolean }>(
        `/me/notifications?page=${nextPage}`
      );
      setExtraItems((prev) => [...prev, ...res.items]);
      setMoreHasMore(res.hasMore);
      setNextPage((p) => p + 1);
    } catch (err) {
      setMoreError(err instanceof Error ? err.message : "Не удалось загрузить ещё");
    } finally {
      setLoadingMore(false);
    }
  }

  /**
   * Склейка по id (аудит 02.10.2026): первая страница опрашивается вживую, и
   * каждое новое уведомление сдвигает ленту вниз — хвост первой страницы
   * приезжает ещё раз первой строкой догруженной. Без склейки строка
   * показывалась дважды и с одним ключом React. Побеждает верхняя, свежая копия.
   */
  const items = useMemo(() => {
    const seen = new Set<string>();
    const out: AppNotification[] = [];
    for (const n of [...(data?.items ?? []), ...extraItems]) {
      if (seen.has(n.id)) continue;
      seen.add(n.id);
      out.push(n);
    }
    return out;
  }, [data?.items, extraItems]);
  const hasMore = moreHasMore ?? data?.hasMore ?? false;
  const unreadCount = data?.unreadCount ?? 0;
  /**
   * ЛЕНТА ОТКРЫТА — ЗНАЧИТ ПРОСМОТРЕНА (владелец 27.08.2026: «если кто-то что-то
   * увидел, пусть они исчезают уже эти уведомления»). Кнопка «Прочитано» в углу
   * остаётся, но полагаться на неё было нельзя: на проде у людей копилось по
   * 90-191 непрочитанному. Красный кружок, горящий всегда, ничего не сообщает.
   */
  const newIds = useSeenSnapshot(items);
  useAutoReadNotifications(unreadCount, !isLoading && !isError, items);

  /**
   * Клиенты, ждущие принятия (тот же серверный фильтр, что PendingLeadsSection
   * в AgentHome.tsx) — источник настоящих `id` для кнопки «Принять» в ленте:
   * уведомление хранит только `shortId` в `url`, а `/clients/:id/accept`
   * принимает внутренний uuid. Пока лид не принят и не отклонён, он есть в
   * этом списке; исчез из списка — значит решение уже принято, кнопку не
   * показываем (не изобретаем свой признак «уже принято» на фронте).
   */
  const { data: pendingLeadsData } = useClients({ pageSize: 100, pendingAcceptance: true });
  const pendingIdByShortId = new Map<number, string>();
  // Только свои лиды: руководитель видит в этом списке все непринятые, а
  // принять лид может лишь тот, кому он отдан — у чужого «Принять» давало отказ
  // (аудит 23.09.2026, №55).
  const myAgentId = useAuthStore((s) => s.agent?.id);
  const myRole = useAuthStore((s) => s.agent?.role);
  for (const c of pendingLeadsData?.items ?? []) {
    if (c.assignedAgentId === myAgentId) pendingIdByShortId.set(c.shortId, c.id);
  }

  /**
   * Строки двух верхних уровней: пришедшие отдельным запросом по всей ленте плюс
   * те, что и так попали на страницу. Склейка по id — одна и та же запись
   * приходит обоими путями.
   */
  const pinnedById = new Map<string, AppNotification>();
  for (const n of [...(data?.pinned ?? []), ...items.filter((n) => PINNED.includes(levelOf(n)))]) {
    if (!pinnedById.has(n.id)) pinnedById.set(n.id, n);
  }
  const pinnedItems = [...pinnedById.values()];
  const filled = groupNotifications(myRole, items, pinnedItems);

  function open(n: AppNotification) {
    if (!n.read) markRead.mutate(n.id);
    if (n.url) navigate(n.url);
  }

  function rows(list: AppNotification[]) {
    return byDay(list).map((g) => (
      <div className="list" key={g.key}>
        <div className="day">{g.caption}</div>
        {g.items.map((n) => {
          const look = KIND_LOOK[n.kind] ?? DEFAULT_LOOK;
          const Icon = look.icon;
          const isNew = newIds ? newIds.has(n.id) : !n.read;
          const shortId = leadShortId(n);
          const acceptClientId = shortId != null ? pendingIdByShortId.get(shortId) : undefined;
          return (
            /* `wrapt` — модификатор прототипа «текст переносится, а не режется».
               У уведомления заголовок и есть всё сообщение, одна строка с
               многоточием прячет суть (осознанное отступление от эталона,
               docs/theme-2026-missing.md §7). Правило на две строки лежит в
               theme-royal-home-2026.css: theme-2026-proto.css генерируется. */
            <div className={isNew ? "row wrapt" : "row wrapt done"} key={n.id}>
              <span className="av" style={look.tone}>
                <Icon className="i" width={16} height={16} strokeWidth={1.5} aria-hidden />
              </span>
              <div className="t">
                <b>
                  <button className="lk" type="button" onClick={() => open(n)}>
                    {n.title}
                  </button>
                </b>
                <span>{n.body}</span>
              </div>
              {/* Схлопнутые повторы одного повода (владелец 20.08.2026): то же
                  событие произошло N раз подряд — вместо N строк одна с числом.
                  count>1 приходит из upsertByTag на сервере, который же кладёт
                  время последнего повтора в createdAt (notifications.ts:
                  «свежий текст и время встают поверх» — второго поля не заводим).
                  Текст переработан по решению владельца 11.09.2026 («Ждёт
                  владельца» п. 4, «что показывать вместо ×15»): раньше здесь
                  стояло голое число без времени, теперь — «N раз, последний в
                  HH:MM», сразу видно, свежий повтор или недельной давности. */}
              {n.count > 1 && (
                <span className="chip mute">
                  {n.count} раз, последний в {dushanbeTime(n.createdAt)}
                </span>
              )}
              {isNew ? (
                <span className="chip warn">Новое</span>
              ) : n.retiredAt ? (
                <span className="chip mute" title={n.retiredReason ?? undefined}>
                  <span className="dot" />
                  Передан
                </span>
              ) : (
                <span className="chip mute">
                  <span className="dot" />
                  {readLabel(n)}
                </span>
              )}
              <span className="meta only-wide">{dushanbeTime(n.createdAt)}</span>
              <div className="act">
                {acceptClientId && (
                  <LeadAcceptAction
                    clientId={acceptClientId}
                    onRequireRelease={() => open(n)}
                    className="pill sm"
                  />
                )}
                <button className="pill ghost sm" type="button" onClick={() => open(n)}>
                  Открыть
                </button>
              </div>
            </div>
          );
        })}
      </div>
    ));
  }

  /**
   * Тот же список, что `rows()`, но классами макета c99db05f (`.grp` вместо
   * `.day`, `.card-s`/`.row` вместо `.card`/`.list`/`.row`) — те же переменные
   * из замыкания (items/newIds/open), второго запроса нет.
   */
  function mobileRows(list: AppNotification[]) {
    return byDay(list).map((g) => (
      <div key={g.key}>
        <div className="grp">{g.caption}</div>
        <div className="card-s">
          {g.items.map((n) => {
            const look = KIND_LOOK[n.kind] ?? DEFAULT_LOOK;
            const Icon = look.icon;
            const isNew = newIds ? newIds.has(n.id) : !n.read;
            const shortId = leadShortId(n);
            const acceptClientId = shortId != null ? pendingIdByShortId.get(shortId) : undefined;
            return (
              <div className="row wrap2" role="button" tabIndex={0} key={n.id} onClick={() => open(n)}>
                <span className="plate soft" style={look.tone}>
                  <Icon className="i" width={16} height={16} strokeWidth={1.5} aria-hidden="true" />
                </span>
                <span className="t">
                  <span className="n">{n.title}</span>
                  <span className="s">
                    {n.body}
                    {n.count > 1 ? ` · ${n.count} раз, последний в ${dushanbeTime(n.createdAt)}` : ""}
                  </span>
                </span>
                {isNew ? (
                  <span className="chip warn">Новое</span>
                ) : n.retiredAt ? (
                  <span className="chip" title={n.retiredReason ?? undefined}>
                    Передан
                  </span>
                ) : (
                  <span className="chip">{readLabel(n)}</span>
                )}
                {acceptClientId && (
                  <LeadAcceptAction clientId={acceptClientId} onRequireRelease={() => open(n)} className="btn pill sm" />
                )}
              </div>
            );
          })}
        </div>
      </div>
    ));
  }

  if (mobile) {
    // Тот же разбор, что в hooks/useGoBack.ts: history.length видит и чужие
    // страницы, и «Назад» уносил из приложения наружу.
    const back = goBack;

    return (
      <div className="rh2" style={MH_HOST}>
        <div className="mh">
          <ShellOwnHeader />
          <div className="top">
            <button type="button" className="ico" aria-label="Назад" onClick={back}>
              <ChevronLeft className="i" aria-hidden="true" />
            </button>
            <div className="grow" style={{ fontSize: 14, color: "var(--muted)" }}>
              Уведомления{unreadCount > 0 ? ` · ${unreadCount}` : ""}
            </div>
            <button type="button" className="btn ghost sm" disabled={unreadCount === 0 || markAllRead.isPending} onClick={() => markAllRead.mutate()}>
              Прочитать всё
            </button>
          </div>
          <div className="body">
            {isLoading && <MhQuiet>Загружаем ленту…</MhQuiet>}

            {isError && (
              <>
                <MhQuiet tone="crit">
                  Не удалось загрузить ленту. Это не значит, что уведомлений нет — попробуйте ещё раз.
                </MhQuiet>
                <button type="button" className="btn soft sm" onClick={() => refetch()}>
                  Попробовать снова
                </button>
              </>
            )}

            {!isLoading && !isError && filled.length === 0 && <MhQuiet>Новых уведомлений нет.</MhQuiet>}

            {filled.map(({ level, title, note, section }, i) => (
              <section className="sec" key={level}>
                <div className="sec-t">
                  <h2>{title}</h2>
                  <span className="cnt">{note}</span>
                </div>
                {mobileRows(section)}
                {i === filled.length - 1 && (hasMore || moreError) && (
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 8px" }}>
                    <span style={{ fontSize: 13, color: "var(--muted)" }}>{moreError ?? `Показано ${items.length}`}</span>
                    <button type="button" className="btn soft sm" disabled={loadingMore} onClick={() => void loadMore()}>
                      {loadingMore ? "Загружаем…" : moreError ? "Повторить" : "Показать ещё"}
                    </button>
                  </div>
                )}
              </section>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="rh2 screens">
      <div className="scr">
        <div className="pg-h">
          <div>
            <h1>Уведомления</h1>
            <p className="sub">
              Всё, что приходило пушем.{" "}
              {unreadCount > 0 ? `Непрочитанных ${unreadCount}.` : "Непрочитанных нет."}
            </p>
          </div>
          <div className="acts">
            <button
              className="pill ghost"
              type="button"
              onClick={() => markAllRead.mutate()}
              disabled={unreadCount === 0 || markAllRead.isPending}
            >
              Прочитать всё
            </button>
          </div>
        </div>

        {/* Три РАЗНЫХ состояния, а не одно: раньше и загрузка, и отказ сервера
            писали «Новых уведомлений нет» — человек закрывал экран уверенный,
            что его никто не ждёт, хотя лента просто не пришла. */}
        {isLoading && (
          <div className="card tight">
            <div className="state">
              <span className="sk av" />
              <span className="sk w28" />
              <span className="sk w22" /> Загружаем ленту
            </div>
          </div>
        )}

        {isError && (
          <div className="card tight">
            <Rh2ErrorState
              message="Не удалось загрузить ленту. Это не значит, что уведомлений нет — попробуйте ещё раз."
              onRetry={() => refetch()}
            />
          </div>
        )}

        {!isLoading && !isError && filled.length === 0 && (
          <div className="card tight">
            <Rh2EmptyState icon={Bell} title="Новых уведомлений нет." />
          </div>
        )}

        {/* Разделы в порядке владельца. «Показать ещё» — ОДНА кнопка на всю
            ленту, в последней непустой секции: догрузка добавляет записи всех
            уровней сразу, и кнопка под каждой секцией означала бы, что запросов
            несколько, хотя он один.

            Два верхних уровня берём из склейки `pinnedItems` (вся лента), два
            нижних — со страницы: «инсайты» и «прочее» листают, а не ищут. */}
        {(() => {

          return filled.map(({ level, title, note, section }, i) => (
            <section className="card" key={level}>
              <div className="sec-h stack">
                <h2>{title}</h2>
                <span className="note">{note}</span>
              </div>
              {rows(section)}
              {i === filled.length - 1 && (hasMore || moreError) && (
                <div className="pager" style={{ marginTop: 16 }}>
                  {moreError ? (
                    <span className="info" style={{ color: "var(--crit)" }}>
                      {moreError}
                    </span>
                  ) : (
                    <span className="info">Показано {items.length}</span>
                  )}
                  <button
                    className="pill ghost sm"
                    type="button"
                    disabled={loadingMore}
                    onClick={() => void loadMore()}
                  >
                    {loadingMore ? "Загружаем…" : moreError ? "Повторить" : "Показать ещё"}
                  </button>
                </div>
              )}
            </section>
          ));
        })()}
      </div>
    </div>
  );
}
