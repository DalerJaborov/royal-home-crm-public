import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { Building2, MessageSquare, Repeat } from "lucide-react";
import { useNow } from "../hooks/useNow";
import { ClientAvatar } from "./ClientAvatar";
import { ConfirmDialog } from "./ConfirmDialog";
import { MutationError } from "./MutationError";
import { Rh2Portal } from "./rh2/Rh2Scope";
import { ApiError } from "../lib/api";
import { isRequiresRelease, useAcceptLead, useClients, useDeclineLead } from "../hooks/useClients";
import { useSettings } from "../hooks/useSettings";
import { useMobileUx } from "../hooks/useMobileUx";
import { useAuthStore } from "../store/auth";
import { setIncomingLeadShown } from "../lib/incomingLeadBus";
import { hapticSuccess, hapticTap } from "../lib/haptics";
import { toast, useToastStore } from "../store/toast";
import { CLIENT_SOURCE_LABELS } from "../lib/clientFormat";
import { formatMoney } from "../lib/format";
import type { Client } from "../types";

/**
 * ВХОДЯЩИЙ ЛИД — ЭКРАН ЗВОНКА, А НЕ СТРОКА В СПИСКЕ.
 *
 * Требование владельца (мобильный артефакт v3 «входящий лид», 50b68112): лид,
 * назначенный агенту, обязан вести себя как входящий вызов — занять весь экран
 * телефона, отсчитывать оставшееся время и предложить ровно два решения. До
 * этого единственными сигналами были две строки на Главной («Ждут вашего
 * принятия») и push: агент, работавший в любом другом разделе, узнавал о лиде,
 * только когда сам возвращался на Главную, а срок принятия тем временем шёл.
 *
 * ЭТО ДОПОЛНИТЕЛЬНЫЙ ПУТЬ, А НЕ ЗАМЕНА. Push с кнопками «Принять/Отклонить» и
 * приём в самой карточке (ClientDetail) остаются как были — здесь те же самые
 * хуки (useAcceptLead/useDeclineLead) и тот же ключ кэша списка, поэтому три
 * входа не могут разъехаться в поведении: принятое в одном месте гаснет в двух
 * других само.
 *
 * ГРАНИЦЫ. Только телефон (useMobileUx) и только роль AGENT: на ПК агент видит
 * список целиком, и полноэкранное окно поверх работы было бы помехой, а
 * руководителю принимать нечего — лид назначен не ему. Один лид показывается
 * один раз за сессию вкладки (sessionStorage): окно, всплывающее заново на
 * каждом переходе между разделами, из помощи превращается в препятствие.
 *
 * ДВА СОСТОЯНИЯ НА ЭКРАНЕ. `open` — во весь экран; `collapsed` — тихая строка
 * сверху, из которой окно разворачивается обратно (смахивание вниз по верхней
 * полосе сворачивает). Закрытое окно не смонтировано вовсе.
 *
 * ВИДИМОСТЬ НЕ ЗАВИСИТ ОТ АНИМАЦИИ: состояние выражено классом (`.open`,
 * `.show`), а не ключевыми кадрами — не сработает переход, элемент всё равно
 * окажется на своём месте (см. theme-2026-lead-incoming.css).
 */

/** Ключ в sessionStorage: какие лиды окно уже показывало в этой вкладке. */
const SEEN_KEY = "rh:lead-incoming:seen";
/** Больше держать незачем: за сессию вкладки столько лидов не приходит, а
 *  неограниченный список — это рост записи в хранилище, которое чистится
 *  только закрытием вкладки. */
const SEEN_LIMIT = 50;

function readSeen(): string[] {
  try {
    const raw = sessionStorage.getItem(SEEN_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    // Приватный режим Safari и заблокированное хранилище: без памяти окно просто
    // покажется ещё раз. Это хуже, чем с памятью, но лучше, чем упавший экран.
    return [];
  }
}

function markSeen(id: string) {
  try {
    const next = [...readSeen().filter((v) => v !== id), id].slice(-SEEN_LIMIT);
    sessionStorage.setItem(SEEN_KEY, JSON.stringify(next));
  } catch {
    /* см. readSeen */
  }
}

/** «9:41» из секунд. Отрицательное время — ноль: срок вышел, дальше решает сервер. */
function mmss(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Короткая строка под именем: что человек ищет. Ни одного придуманного слова —
 *  только те поля, которые сервер действительно прислал. */
function subtitleOf(c: Client): string {
  const budget =
    c.budgetMin && c.budgetMax
      ? `${formatMoney(c.budgetMin, c.currency)} – ${formatMoney(c.budgetMax, c.currency)}`
      : c.budgetMax
        ? `до ${formatMoney(c.budgetMax, c.currency)}`
        : c.budgetMin
          ? `от ${formatMoney(c.budgetMin, c.currency)}`
          : null;
  return [
    c.kind === "SELLER" ? "продавец" : c.kind === "BUYER" ? "покупатель" : null,
    c.desiredRooms ? `${c.desiredRooms}-комн.` : null,
    c.desiredDistrict?.name ?? null,
    budget,
  ]
    .filter(Boolean)
    .join(" · ");
}

export function IncomingLeadWindow() {
  const mobile = useMobileUx();
  const me = useAuthStore((s) => s.agent);
  const isAgent = me?.role === "AGENT";
  const enabled = mobile && isAgent;

  // Тот же запрос и тот же ключ кэша, что у «Ждут вашего принятия» на Главной
  // (AgentHome.tsx, PendingLeadsRows) — общий кэш, а не второй список. Свежесть
  // даёт общий поллинг приложения (25 с, lib/queryClient.ts).
  //
  // `pendingAcceptance: true` — серверный фильтр (routes/clients/list.ts,
  // 07.09.2026): раньше страница из 20 обычных карточек могла не содержать
  // старый переназначенный лид вообще, если между ним и верхом списка успели
  // накопиться 20+ уже принятых. Теперь в выдаче только ожидающие, отсортированы
  // сервером по assignedAt — самые старые первыми.
  const { data } = useClients({ pageSize: 20, pendingAcceptance: true }, enabled);
  const items = useMemo(() => data?.items ?? [], [data]);

  /** Лиды, которые ждут принятия именно этим агентом — сервер уже отдал только
   *  их (scopeToOwnAgent + pendingAcceptance) и в нужном порядке (assignedAt
   *  asc). Здесь остаётся убрать «прочие обращения»: окно приёма — про
   *  покупателей и продавцов, как и раньше (canAcceptRow, pages/Clients.tsx). */
  const pending = useMemo(() => {
    if (!enabled || !me) return [] as Client[];
    return items.filter((c) => c.kind !== "OTHER");
  }, [items, enabled, me]);

  const [leadId, setLeadId] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(false);

  /** Окно показало лид и уже вызвало по нему приём — тогда исчезновение лида из
   *  «ждут принятия» ожидаемо и закрывать окно нельзя: там панель «принят». */
  const acceptedRef = useRef(false);

  // Выбор лида: первый ещё не показанный. Пометка «показан» ставится в тот же
  // миг, поэтому само окно по нему второй раз не всплывёт — но лид никуда не
  // девается: строка на Главной, список клиентов и карточка на месте.
  useEffect(() => {
    if (!enabled || leadId) return;
    const seen = readSeen();
    const next = pending.find((c) => !seen.includes(c.id));
    if (!next) return;
    markSeen(next.id);
    acceptedRef.current = false;
    setCollapsed(false);
    setLeadId(next.id);
    hapticTap();
  }, [enabled, leadId, pending]);

  const lead = useMemo(() => items.find((c) => c.id === leadId) ?? null, [items, leadId]);

  // Публикуем в шину, пока это окно занимает лида — свёрнутое в тихую строку
  // считается тоже «занимает» (см. incomingLeadBus.ts): секция «Ждут вашего
  // принятия» на Главной прячет ровно эту строку, чтобы не дублировать.
  useEffect(() => {
    setIncomingLeadShown(leadId);
    return () => setIncomingLeadShown(null);
  }, [leadId]);

  const close = useCallback(() => {
    setLeadId(null);
    setCollapsed(false);
  }, []);

  /**
   * Лид перестал ждать принятия, пока окно открыто (срок вышел и его забрал
   * следующий агент, руководитель переназначил, карточку удалили) — окно
   * закрывается само: держать на экране решение, которого больше нет, хуже,
   * чем не показывать ничего. Собственный приём этой веткой не считается —
   * его отмечает acceptedRef.
   */
  useEffect(() => {
    if (!leadId || acceptedRef.current) return;
    if (!lead || !lead.pendingAcceptance) close();
  }, [lead, leadId, close]);

  if (!enabled || !leadId) return null;

  return (
    <IncomingLeadDialog
      // key по лиду: следующий входящий получает чистое окно, а не остатки
      // состояния предыдущего (открытая панель «принят», текст ошибки).
      key={leadId}
      leadId={leadId}
      lead={lead}
      collapsed={collapsed}
      onExpand={() => {
        setCollapsed(false);
        hapticTap();
      }}
      onCollapse={() => setCollapsed(true)}
      onClose={close}
      acceptedRef={acceptedRef}
    />
  );
}

function IncomingLeadDialog({
  leadId,
  lead,
  collapsed,
  onExpand,
  onCollapse,
  onClose,
  acceptedRef,
}: {
  leadId: string;
  lead: Client | null;
  collapsed: boolean;
  onExpand: () => void;
  onCollapse: () => void;
  onClose: () => void;
  acceptedRef: React.MutableRefObject<boolean>;
}) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const acceptLead = useAcceptLead(leadId);
  const declineLead = useDeclineLead(leadId);
  const [confirmDecline, setConfirmDecline] = useState(false);
  const shown = lead;

  /** Пока лид развёрнут на весь экран, фоновая пилюля «Сохранено» гасится —
   *  см. store/toast.ts. Свёрнутое окно (тихая строка сверху) её не перекрывает,
   *  поэтому суспенд снимается вместе со сворачиванием, не только с закрытием. */
  useEffect(() => {
    if (collapsed) return;
    useToastStore.getState().setSuspended(true);
    return () => useToastStore.getState().setSuspended(false);
  }, [collapsed]);

  /**
   * СРОК ПРИНЯТИЯ. `leadAcceptMinutes` живёт в Настройках, а рядовому сотруднику
   * сервер отдаёт усечённые настройки (routes/settings.ts, toStaffSettings) — то
   * есть у самого агента этого числа нет, и нового эндпоинта ради обратного
   * отсчёта мы не заводим. Поэтому два честных режима: число известно
   * (руководитель смотрит с телефона) — идёт обратный отсчёт; число неизвестно —
   * показываем, СКОЛЬКО ЛИД УЖЕ ЖДЁТ (считается из assignedAt, он приходит
   * всегда) и тихую строку о том, что срока в данных нет. Подставить «10 минут»
   * нельзя: цифра на экране агента, не совпадающая с настройкой руководителя,
   * хуже отсутствующей.
   */
  const { data: settings } = useSettings();
  const acceptMinutes =
    typeof settings?.leadAcceptMinutes === "number" && Number.isFinite(settings.leadAcceptMinutes)
      ? settings.leadAcceptMinutes
      : null;

  // Тик раз в секунду и только пока есть что отсчитывать: после принятия таймер
  // не нужен, а невидимая перерисовка каждую секунду — нет.
  const now = useNow(!!shown);

  const assignedMs = shown ? new Date(shown.assignedAt).getTime() : Number.NaN;
  const waitedSec = Number.isFinite(assignedMs) ? (now - assignedMs) / 1000 : null;
  const leftSec = acceptMinutes !== null && waitedSec !== null ? acceptMinutes * 60 - waitedSec : null;

  /** Один и тот же счётчик в двух местах: в шапке окна и в тихой строке. */
  // Срок вышел, а лид всё ещё здесь — значит, он у агента до следующего хода
  // круга (ночью круг стоит до утра, 23.09.2026). «Осталось 0:00» читалось как
  // «уже поздно», хотя принять можно.
  const timerLabel =
    leftSec !== null && leftSec <= 0 ? (
      <>время вышло, примите сейчас</>
    ) : leftSec !== null ? (
      <>
        осталось <span className="li-timer">{mmss(leftSec)}</span>
      </>
    ) : waitedSec !== null ? (
      <>
        ждёт <span className="li-timer">{mmss(waitedSec)}</span>
      </>
    ) : null;

  // Приём лида на телефоне — сразу в карточку клиента (решение владельца
  // 11.09.2026): агенту после «Принять» нужна сама карточка, а не промежуточная
  // панель с кнопками «Позвонить»/«Написать» — те уже есть в самой карточке.
  const handleAccept = useCallback(() => {
    if (acceptLead.isPending) return;
    const shortId = lead?.shortId;
    acceptLead.mutate(undefined, {
      onSuccess: () => {
        acceptedRef.current = true;
        hapticSuccess();
        onClose();
        if (shortId !== undefined) navigate(`/clients/${shortId}`);
      },
      onError: (err) => {
        // Портфель полон — сервер спрашивает, кого освободить. Выбор есть только
        // в карточке: уходим туда и закрываем окно, чтобы оно не висело поверх.
        if (isRequiresRelease(err)) {
          onClose();
          if (shortId !== undefined) navigate(`/clients/${shortId}`);
        }
      },
    });
  }, [acceptLead, acceptedRef, lead, navigate, onClose]);

  const swipe = useCollapseSwipe(!collapsed, onCollapse);

  if (!shown) return null;

  const sourceLabel = CLIENT_SOURCE_LABELS[shown.source] ?? shown.source;
  const escalated = !shown.acceptedAt && !!shown.escalatedAt;
  const busy = acceptLead.isPending || declineLead.isPending;
  /** Пока окно свёрнуто, до кнопок внутри нельзя добраться и клавиатурой —
   *  иначе табуляция уводит фокус в то, чего на экране нет. */
  const innerTabIndex = collapsed ? -1 : undefined;

  return (
    <Rh2Portal>
      <div className={`li-wrap${collapsed ? "" : " open"}${swipe.dragging ? " dragging" : ""}`}>
        {/* Тихая строка сверху: во что свёрнуто окно. Живёт в собственном слое
            над рамкой приложения и не спорит ни с полосой «нет соединения» (та
            в потоке под шапкой), ни с тостами (те внизу, z-index 60). */}
        <button
          type="button"
          className={`li-quiet${collapsed ? " show" : ""}`}
          onClick={onExpand}
          tabIndex={collapsed ? undefined : -1}
          aria-hidden={collapsed ? undefined : true}
          aria-label={`Новый клиент ждёт принятия: ${shown.fullName}. Развернуть`}
        >
          <i aria-hidden="true" />
          <span>Новый клиент ждёт{timerLabel ? <> · {timerLabel}</> : null}</span>
        </button>

        <div
          className="li-full"
          role="dialog"
          data-no-sheet
          data-no-drag
          aria-modal={collapsed ? undefined : true}
          aria-hidden={collapsed ? true : undefined}
          aria-labelledby={`li-name-${leadId}`}
          // Палец тянет окно вниз — окно идёт за пальцем. Инлайн-стиль здесь
          // единственный способ: значение рождается в жесте, а не в макете.
          style={swipe.dragging ? { transform: `translateY(${swipe.dy}px)` } : undefined}
        >
          <div className="li-top" {...swipe.handleProps}>
            <i aria-hidden="true" />
            <span>
              {escalated ? "Никто не принял" : "Новый клиент"} · {sourceLabel}
              {timerLabel ? <> · {timerLabel}</> : null}
            </span>
          </div>

          <div className="li-panels">
            <div className="li-pending">
              <div className="li-center">
                <ClientAvatar fullName={shown.fullName} avatarUrl={shown.avatarUrl} size={96} />
                <h1 className="li-name" id={`li-name-${leadId}`}>
                  {shown.displayName ?? shown.fullName}
                </h1>
                <p className="li-sub">{subtitleOf(shown) || "Пожелания ещё не записаны"}</p>
                <div className="li-hints">
                  {shown.leadReason && (
                    <div className="li-hint">
                      <Building2 className="i" aria-hidden="true" />
                      <span>{shown.leadReason.text}</span>
                    </div>
                  )}
                  <div className="li-hint">
                    <MessageSquare className="i" aria-hidden="true" />
                    <span>Пришёл из «{sourceLabel}»</span>
                  </div>
                  {shown.requirementsNotes?.trim() && (
                    <div className="li-hint">
                      <Building2 className="i" aria-hidden="true" />
                      <span>{shown.requirementsNotes.trim()}</span>
                    </div>
                  )}
                  {!!shown.reassignCount && (
                    <div className="li-hint">
                      <Repeat className="i" aria-hidden="true" />
                      <span>Уже переходил между агентами: {shown.reassignCount}</span>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>

          <div className="li-actions">
            <div className="li-btns">
              <button
                type="button"
                className="li-btn accept"
                disabled={busy}
                tabIndex={innerTabIndex}
                onClick={handleAccept}
              >
                {acceptLead.isPending ? "Принятие…" : "Принять"}
              </button>
              <button
                type="button"
                className="li-btn reject"
                disabled={busy}
                tabIndex={innerTabIndex}
                onClick={() => setConfirmDecline(true)}
              >
                {declineLead.isPending ? "Отклоняем…" : "Отклонить"}
              </button>
            </div>
            {acceptMinutes !== null ? (
              <p className="li-note">Не ответите за {acceptMinutes} мин, лид передадут дальше</p>
            ) : (
              <p className="quiet" style={{ marginTop: 10 }}>
                <span className="txt">Нет данных: срок принятия виден только руководителю</span>
              </p>
            )}
            {/*
              Задание 17.09.2026 («клиент теряется, если вовремя не позвонить»):
              окно приёма раньше говорило только про срок ПРИНЯТИЯ — про срок
              ЗВОНКА агент не узнавал вообще нигде, пока не открывал карточку
              (там уже стоит своя липкая полоса, см. ClientDetail.tsx). Та же
              защита от выдумывания числа, что у acceptMinutes выше: строка не
              рисуется, пока leadCallMinutes не пришло с сервера.
            */}
            {typeof settings?.leadCallMinutes === "number" && Number.isFinite(settings.leadCallMinutes) && (
              <p className="li-note">После принятия — позвонить за {settings.leadCallMinutes} мин</p>
            )}
            {(acceptLead.isError || declineLead.isError) && (
              <MutationError
                variant="rh2"
                mutation={acceptLead.isError ? acceptLead : declineLead}
                fallback={acceptLead.isError ? "Не удалось принять лид" : "Не удалось отклонить лид"}
              />
            )}
          </div>
        </div>
      </div>

      {confirmDecline && (
        <ConfirmDialog
          title="Отклонить лид?"
          description="Первый отказ подряд ничего не стоит Royal Score, второй и следующие подряд снижают счёт. Лид сразу уйдёт следующему свободному агенту, а если отдать некому или лид по вашему объекту — руководителю. Эту карточку вы больше не увидите."
          confirmLabel="Отклонить"
          layer="above-incoming"
          onConfirm={() => {
            setConfirmDecline(false);
            declineLead.mutate(undefined, {
              onSuccess: (res) => {
                onClose();
                toast.success(res.reassignedTo ? "Отклонён: лид ушёл следующему агенту" : "Отклонён: лид ушёл руководителю");
              },
              // Пока агент решал «Отклонить», лид уже принял кто-то другой
              // (409 «уже принят»), карточку/права успели поменять (403/404) —
              // окно обязано закрыться с понятным текстом, а не повиснуть с
              // ошибкой поверх уже неактуального решения. Сеть и 5xx под это
              // условие не подходят (ApiError.status у них другой или это не
              // ApiError вовсе) — там всё как раньше: MutationError в li-actions.
              onError: (err) => {
                if (err instanceof ApiError && [403, 404, 409].includes(err.status)) {
                  toast.error(err.message);
                  qc.invalidateQueries({ queryKey: ["clients"] });
                  onClose();
                }
              },
            });
          }}
          onCancel={() => setConfirmDecline(false)}
        />
      )}
    </Rh2Portal>
  );
}

/**
 * СМАХНУТЬ ВНИЗ — СВЕРНУТЬ. Жест снят с верхней полосы окна, а не со всего
 * окна: внутри есть прокручиваемая панель, и перехват на родителе отнял бы у
 * неё прокрутку. `touch-action:none` стоит ровно на этой полосе (CSS) — без
 * него браузер сперва решит, что начинается прокрутка страницы, и жест
 * стартует рывком; а `pan-y` здесь ставить нельзя, это ровно та ловушка, из-за
 * которой в этом репозитории уже ломались свайпы (память проекта).
 *
 * Срабатывает по расстоянию ИЛИ по скорости: короткий резкий флик — такой же
 * законный жест, как медленное протягивание на треть экрана.
 */
function useCollapseSwipe(active: boolean, onCollapse: () => void) {
  const [dragging, setDragging] = useState(false);
  const [dy, setDy] = useState(0);
  const start = useRef(0);
  const samples = useRef<[number, number][]>([]);

  const finish = useCallback(() => {
    if (!dragging) return;
    setDragging(false);
    const list = samples.current;
    let velocity = 0;
    if (list.length > 1) {
      const [t0, d0] = list[0];
      const [t1, d1] = list[list.length - 1];
      velocity = (d1 - d0) / Math.max(1, t1 - t0);
    }
    const distance = dy;
    setDy(0);
    if (distance > 90 || velocity > 0.5) {
      onCollapse();
      hapticTap();
    }
  }, [dragging, dy, onCollapse]);

  return {
    dragging,
    dy,
    handleProps: {
      onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => {
        if (!active) return;
        start.current = e.clientY;
        samples.current = [];
        setDy(0);
        setDragging(true);
        e.currentTarget.setPointerCapture(e.pointerId);
      },
      onPointerMove: (e: React.PointerEvent<HTMLDivElement>) => {
        if (!dragging) return;
        const next = Math.max(0, e.clientY - start.current);
        setDy(next);
        samples.current.push([performance.now(), next]);
        if (samples.current.length > 6) samples.current.shift();
      },
      onPointerUp: finish,
      onPointerCancel: finish,
    },
  };
}
