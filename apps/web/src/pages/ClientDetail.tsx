import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { EmptyState } from "../components/EmptyState";
import { Rh2Sheet } from "../components/rh2/Rh2Sheet";
import { ApiError } from "../lib/apiError";
import { assignLeadErrorText } from "../lib/assignLeadError";
import { ArrowLeft, ArrowRightLeft, Bot, Briefcase, CalendarClock, CircleCheck, Clock, Copy, GitMerge, Handshake, Home, MessageCircle, MessageSquare, MoreVertical, Pencil, Phone, RotateCcw, ShieldAlert, Tag, Trash2, UserCog } from "lucide-react";
import { ClientMoreMenu, countMoreItems, type MoreGroup, type MoreItem } from "../components/ClientMoreMenu";
import { useProperties, useProperty } from "../hooks/useProperties";
import { useDebouncedValue } from "../hooks/useDebouncedValue";
import { ClientFormModal } from "../components/ClientFormModal";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { isRequiresRelease, useAcceptLead, useAssignLead, useClient, useClientToCandidate, useDeclineLead, useDeleteClient, useLiveVoiceCall, usePropertyPickerOptions, useUpdateClient, type ReleaseCandidate } from "../hooks/useClients";
import { CallPhoneChooser, type CallPhoneOption } from "../components/CallPhoneChooser";
import { MatchPanel } from "../components/match/MatchPanel";
import { CloseDealChoiceModal } from "../components/CloseDealChoiceModal";
import { NewDealSheet } from "../components/NewDealSheet";
import { TransferClientModal } from "../components/TransferClientModal";
import { MergeClientModal } from "../components/MergeClientModal";
import { useSimilarNotes, useDismissSimilarClient, type SimilarNotesClient } from "../hooks/useDuplicates";
import { RequestDeleteClientModal } from "../components/RequestDeleteClientModal";
import {
  usePendingDeleteRequest,
  usePendingPropertyCountDisputes,
  useDisputePropertyCount,
  type PropertyCountDisputeRole,
} from "../hooks/useDeleteRequests";
import { CLIENT_KINDS, DEAL_STAGE_LABELS, type ClientKind } from "@royal-home/shared";
import { useAgents } from "../hooks/useAgents";
import { assignableStaff, notAgentConfirmText, notAgentWarningText, staffOptionLabel } from "../lib/assignableStaff";
import { useSettings } from "../hooks/useSettings";
import { useAuthStore } from "../store/auth";
import { ClientStateBadge } from "../components/ClientStateBadge";
import { AddInteractionModal } from "../components/AddInteractionModal";
import { InteractionTimeline } from "../components/InteractionTimeline";
import { MutationError } from "../components/MutationError";
import { VoiceNoteButton, type VoiceNote } from "../components/VoiceNoteButton";
import { useCan, useIsReadOnly } from "../lib/permissions";
import { canTransferClientToCandidates } from "../lib/vacanciesView";
import {
  useReactivateClient,
  useReturnDeferredClient,
  useSecurityReview,
  useClientLossEvent,
  useOverrideClientLossEvent,
  useClientMatch,
} from "../hooks/useClients";
import { pluralizeRu, relativeTime } from "../lib/format";
import { canCallOnTransferredCard, transferBannerOf } from "../lib/clientTransferAccess";
import {
  clientKindLabel,
  CLIENT_KIND_LABELS,
  formatClientCode,
  formatClientName,
  matchScoreBand,
} from "../lib/clientFormat";
import { dushanbeDate } from "../lib/date";
import { ClientChatCard, ClientChatPanel, type ClientConversation } from "../components/ClientChatPanel";
import { clientHistoryFacts } from "../lib/clientHistoryFacts";
import { WhatsAppFirstContact } from "../components/WhatsAppFirstContact";
import { ClientInsight } from "../components/ClientInsight";
import { ClientSignals } from "../components/ClientSignals";
import { ClientCardSkeleton } from "../components/rh2/Skeleton";
import { digitsOf } from "../lib/phone";
import { ClientAvatar } from "../components/ClientAvatar";
import { ClientDesiredPlacesMap } from "../components/ClientDesiredPlacesMap";
import type { Client } from "../types";
import { primaryConversationId } from "../lib/primaryConversationId";
import { RH2_SCR_BARE } from "../components/rh2/Rh2Scope";
import { useMobileUx } from "../hooks/useMobileUx";
import { useCleanShell } from "../hooks/useCleanShell";
import { CleanClientDetailHeader, CleanClientDetailSkeleton, CleanClientDetailTabs, cleanClientDetailScale, cleanClientPanelProps, cleanClientShowsPanel } from "../components/clean/CleanClientDetailLayout";
import { MobileClientCard } from "../components/mobile/MobileClientCard";


/**
 * Кнопка сетки действий на телефоне — по прототипу design_handoff_royal_home_crm
 * (блок vClient: min-height 44px, рамка line, текст 600 13.5px, лёгкое сжатие
 * при нажатии). Радиус — var(--radSm), а в активной теме прототипа (THEMES[2]
 * «Glass light») это 16px, а не число 13 из инлайн-фолбэка HTML-атрибута
 * (var(--radSm,13px)) — тема эту переменную переопределяет, фолбэк никогда не
 * рендерится. Цвет текста меняется классом снаружи: обычные — чернильные,
 * «Удалить» — красная, «Переназначить агенту» — акцентная.
 */
/* Константа M_GRID_BTN (классы кнопки мобильной сетки действий) удалена
   09.09.2026 при переносе на тему «Royal Home 2026»: сетки на карточке нет с
   тех пор, как редкие действия уехали в список «Другие действия», и константа
   уже была объявлена и не использована ни разу — единственным её следом были
   старые утилитарные классы в файле. */

/* Ряда из трёх круглых действий 38px (actCall/openChat/actShow в прототипе)
   здесь больше нет: «Позвонить» стала главной кнопкой во всю ширину, а
   «Написать» — такой же большой сразу под ней. */

// STATUS_OPTIONS (ручной список статусов для дропдауна ManualStatus) удалён
// 15.09.2026 вместе с самим ManualStatus — ручная смена статуса продавца
// убрана из карточки целиком, см. комментарий у вызова moreRow ниже.


/**
 * ВСЕ диалоги клиента, а не один (19.08.2026, было «один для любого канала»).
 *
 * Раньше у карточки физически не мог быть больше одного диалога бот-платформы
 * (BotConversation.clientId был уникален в БД) — теперь может: клиент написал
 * в Instagram, потом позвонил и его попросили написать в WhatsApp, обе переписки
 * должны быть видны на одной карточке, а не только последняя. Отсортированы по
 * свежести последнего сообщения — самый актуальный диалог первым.
 */
function conversationsOf(client: Client): ClientConversation[] {
  const list: ClientConversation[] = [...client.botConversation];
  if (client.telegramConversation) {
    list.push({
      id: client.telegramConversation.id,
      pausedUntil: client.telegramConversation.pausedUntil,
      channel: "TELEGRAM",
      messages: client.telegramConversation.messages,
    });
  }
  return list.sort((a, b) => {
    const lastA = a.messages.at(-1)?.at;
    const lastB = b.messages.at(-1)?.at;
    if (!lastA) return 1;
    if (!lastB) return -1;
    return new Date(lastB).getTime() - new Date(lastA).getTime();
  });
}

export function ClientDetail() {
  const { id } = useParams();
  // Переписка: открыта ли панель и нужно ли сразу поставить курсор в поле ответа
  // (открыли, чтобы ответить, — а не чтобы прочитать; см. ClientChatPanel). Объявлен
  // раньше useClient ниже: тот читает chat.open, чтобы включать поллинг карточки,
  // пока панель на экране (06.09.2026, см. useClients.ts::useClient).
  const [chat, setChat] = useState<{ open: boolean; focusReply: boolean }>({ open: false, focusReply: false });
  const {
    data: client,
    isLoading,
    isError,
    error: clientError,
    refetch: refetchClient,
  } = useClient(id, { pollConversations: chat.open });
  // «Подбор · N» (17.09.2026, docs/match-policy-plan-17-09.md §6) — грузится,
  // только пока карточка клиента открыта: тот же запрос, что и MatchPanel
  // (общий ключ кэша ["client-match", id]), второй раз по сети не уходит.
  const clientMatchQuery = useClientMatch(client?.id);
  const me = useAuthStore((s) => s.agent);
  /**
   * Карточка клиента на телефоне — минимум на первом экране (владелец
   * 12.09.2026 утром: «слишком много функций, спрятать в кнопки, только самое
   * важное»). Разметка ветвится по устройству (см. hooks/useMobileUx.ts), а
   * не по вкусу в настройках, — тот же признак, что решает жесты и шторки во
   * всём приложении. ПК ниже не меняется: везде, где стоит `!mobile`/`mobile`,
   * ветка `!mobile` — буквально прежняя разметка.
   */
  const mobile = useMobileUx();
  const clean = useCleanShell();
  // Роут теперь короткий числовой shortId (/clients/1042) — все мутации ниже адресуют
  // настоящий UUID с уже загруженной карточки, а не парсят его заново из URL.
  const updateClient = useUpdateClient(client?.id ?? "");
  const acceptLead = useAcceptLead(client?.id ?? "");
  const declineLead = useDeclineLead(client?.id ?? "");
  const assignLead = useAssignLead(client?.id ?? "");
  const deleteClient = useDeleteClient(client?.id ?? "");
  const toCandidate = useClientToCandidate(client?.id ?? "");
  const reactivate = useReactivateClient(client?.id ?? "");
  const returnDeferred = useReturnDeferredClient(client?.id ?? "");
  const navigate = useNavigate();
  const location = useLocation();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [kindChangeTarget, setKindChangeTarget] = useState<ClientKind | null>(null);
  const [confirmToCandidate, setConfirmToCandidate] = useState(false);
  const [toCandidateError, setToCandidateError] = useState<string | null>(null);
  const [confirmDecline, setConfirmDecline] = useState(false);
  // Правка имени прямо в карточке (владелец 19.08.2026: «дай возможность менять
  // имя без четырёх шагов подряд») — отдельно от общего мастера ClientFormModal,
  // тем же полем fullName через тот же updateClient PATCH.
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [showInteraction, setShowInteraction] = useState(false);
  // Подбор объекта: одна панель (components/match/MatchPanel.tsx), одна кнопка
  // «Подбор · N» везде (владелец 17.09.2026 вечер) — открыта/закрыта, без режимов.
  const [matchOpen, setMatchOpen] = useState(false);
  const [showCloseDeal, setShowCloseDeal] = useState(false);
  const [showNewDeal, setShowNewDeal] = useState(false);
  const [showTransfer, setShowTransfer] = useState(false);
  const [showMerge, setShowMerge] = useState<SimilarNotesClient | true | false>(false);
  /** Предупреждение перед повторным созданием объекта — «Создать объект из заявки»
   *  открывало ту же форму на любом клике, без единого признака, что у продавца уже
   *  есть карточка объекта в CRM (владелец 15.09.2026: риск двух независимых
   *  объектов на одну заявку). */
  const [confirmDuplicateProperty, setConfirmDuplicateProperty] = useState(false);
  const [showEditForm, setShowEditForm] = useState(false);
  /**
   * Вкладки карточки — те же пять, что в прототипе темы «Royal Home 2026»
   * (screens/client-detail.html): «Коротко», «Переписка», «Звонки», «Объекты»,
   * «История». Прежние «Информация/История» и отдельный переключатель «только
   * звонки» внутри хронологии сведены сюда: тот же список взаимодействий, тот
   * же фильтр, но одним рядом вкладок, а не двумя разными местами экрана.
   */
  /** Начальная вкладка — из адреса (`?tab=calls` и т.п.): так плитка «Звонки»
   *  карточки сотрудника (TeamMemberDetail.tsx) открывает карточку клиента сразу
   *  на нужной вкладке, а не всегда на «Коротко». Незнакомое значение — как без
   *  параметра. */
  const [tab, setTab] = useState<"short" | "chat" | "calls" | "props" | "hist">(() => {
    const fromUrl = new URLSearchParams(location.search).get("tab");
    return fromUrl === "short" || fromUrl === "chat" || fromUrl === "calls" || fromUrl === "props" || fromUrl === "hist"
      ? fromUrl
      : "short";
  });
  /** Карточка вкладок стоит ниже «Где сделка» — с сетки быстрых действий (`.cd-qa`)
   *  до неё есть чем прокручивать, особенно на телефоне. Переключатель вкладок
   *  из сетки не просто ставит `tab`, а ещё довозит до самих вкладок. */
  const tabsCardRef = useRef<HTMLDivElement>(null);
  /**
   * Телефон: плоский стек секций вместо вкладок (макет c99db05f, `renderClient` —
   * владелец 14.09.2026: «ничего из старого не оставлять, всё что на артефакте
   * перенести полностью»). На ПК ничего не меняется — там по-прежнему одна
   * видимая вкладка и переключатель `tab`. На телефоне все пять секций рисуются
   * подряд, `tab` больше не решает видимость, а сами refs нужны только чтобы
   * «Ещё» → «Объекты/Звонки/Переписка/История» прокручивало к нужному месту
   * стека, а не переключало невидимую вкладку.
   */
  const sectionRefs = useRef<Record<typeof tab, HTMLDivElement | null>>({
    short: null,
    chat: null,
    calls: null,
    props: null,
    hist: null,
  });
  const jumpToTab = (id: typeof tab) => {
    setTab(id);
    if (mobile) {
      sectionRefs.current[id]?.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    tabsCardRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  /**
   * Редкие действия на телефоне свёрнуты (владелец 20.08.2026: «как можно ещё
   * упростить, что убрать»). До этого сетка разворачивала до восьми одинаковых
   * серых кнопок 44px — «Изменить», «Удалить», «Объединить с карточкой»,
   * «Переназначить агенту» — стеной над вкладками: чтобы дойти до самого
   * содержимого карточки, приходилось пролистать экран действий, которыми
   * пользуются раз в месяц. Тот же приём, что на десктопе (ActionMenu «Ещё»),
   * только раскрытием на месте: выпадающее меню под пальцем на узком экране
   * перекрывает половину карточки.
   */
  const [moreActions, setMoreActions] = useState(false);
  /** Телефон: те же moreGroups, что и в десктопной «Другие действия», но в
   *  шторке `Rh2Sheet` из новой кнопки «Ещё» полосы действий (не из
   *  инлайн-карты выше — та на телефоне не рендерится, см. `.acts` ниже). */
  const [showMoreSheet, setShowMoreSheet] = useState(false);
  const [showKindSheet, setShowKindSheet] = useState(false);
  const [showRobot, setShowRobot] = useState(false);
  // «Похожая карточка» жила внутри блока «Требования» на телефоне, пока он не
  // переехал в «Коротко» (владелец 25.08.2026), и всплывает снизу экрана по кнопке
  // из «Ещё», только когда есть что показать. На десктопе блок «Требования»
  // остался как был — этот стейт его не касается.
  //
  // Соседом здесь было «Предложение ИИ» (баннер «После разговора: проверьте, верно
  // ли поняли клиента»). Владелец отменил его 12.09.2026 — «я специально плачу за
  // дорогую модель, чтобы она не переспрашивала»: разбор звонка пишет услышанное в
  // карточку сам и молча, а след остаётся строкой в хронологии («ИИ уточнил
  // карточку по разговору: …»). Возвращать баннер нельзя, см. apps/api/src/lib/
  // cardSuggestions.ts — там записаны оба решения владельца, 07.08 и 12.09.
  const [showSimilarSheet, setShowSimilarSheet] = useState(false);
  // «Направить на удаление» — заявка агента (владелец 30.08.2026). Само удаление
  // остаётся за правом clients.delete, здесь только окно с причиной.
  const [showRequestDelete, setShowRequestDelete] = useState(false);
  const [assignTo, setAssignTo] = useState("");
  const [showReassign, setShowReassign] = useState(false);
  // Портфель полон, а пришёл лид по СВОЕМУ объекту: сервер отвечает не отказом, а
  // вопросом «кого отдать» (решение владельца 11.08.2026). Держим его список здесь.
  const [releaseCandidates, setReleaseCandidates] = useState<ReleaseCandidate[] | null>(null);
  // Руководитель разбирает непринятые/эскалированные лиды — список агентов нужен только ему.
  const isSupervisor = me?.role === "ADMIN" || me?.role === "DIRECTOR" || me?.role === "MANAGER";
  /**
   * Права читаем реестром, а не ролью: право распределять лидов можно выдать или
   * отобрать конкретному сотруднику, не меняя его роль (см. lib/permissions), и
   * ровно по этому праву пускает сервер. Проверка «роль из списка» разошлась бы с
   * ним ровно в том случае, ради которого реестр и заведён.
   */
  const canDo = useCan();
  const accountReadOnly = useIsReadOnly();
  const canMerge = canDo("clients.merge");
  /**
   * Удаление показываем ПО ПРАВУ, а не по роли (дрейф, найденный 30.08.2026):
   * кнопка стояла на `role === "ADMIN" || role === "DIRECTOR"`, а сервер
   * (routes/clients/card.ts) всё это время проверял право `clients.delete` —
   * сотрудник, которому директор выдал право галочкой, кнопки не видел вовсе.
   */
  const canDelete = canDo("clients.delete");
  /**
   * Назначить, переназначить, забрать себе, «в кандидаты» — по праву
   * clients.assign, ровно как пускает сервер (routes/clients/lifecycle.ts), а не
   * по роли (F8, 02.10.2026): оператору с выданным правом кнопок не было,
   * менеджеру со снятым правом они были и отвечали 403.
   */
  const canAssignClients = canDo("clients.assign");
  /**
   * Заявку на удаление заводит агент, который ведёт карточку. Тому, кто и так
   * может удалить сам (canDelete), просить не у кого — ему кнопка не нужна.
   */
  const canRequestDelete = canDo("clients.requestDelete") && !canDelete;
  // Заявка по этой карточке, если она уже ждёт решения: кнопку в таком случае
  // заменяем видимой строкой, а не гасим в серый (правило проекта — причина
  // недоступности пишется словами рядом, серая кнопка читается как «нет прав»).
  const { data: deleteRequestState } = usePendingDeleteRequest(
    client?.id,
    !!client?.id && (canRequestDelete || canDelete)
  );
  const pendingDeleteRequest = deleteRequestState?.request ?? null;
  const { data: similarNotes } = useSimilarNotes(canMerge ? client?.id : undefined);
  const dismissSimilar = useDismissSimilarClient(client?.id);
  const isSeller = client?.kind === "SELLER";
  // Есть ли у продавца уже созданный объект — предупредить перед повторным «Создать
  // объект из заявки» (владелец 15.09.2026: риск двух независимых объектов на одну
  // заявку). Тот же GET /properties, что и каталог, с новым фильтром sellerClientId —
  // не заводим отдельный эндпоинт ради одной проверки. Хук вызывается безусловно
  // (правило хуков), enabled сужает сам запрос до карточек продавца.
  const { data: sellerProperties } = useProperties(
    { sellerClientId: client?.id ?? "", page: 1 },
    !!client?.id && isSeller
  );
  // Тот же признак, что hasActiveAssignedAgent на сервере (lib/conversationState.ts) —
  // бот молчит клиенту, пока он закреплён за живым агентом, не дожидаясь первого
  // ручного ответа. Панель переписки должна показывать это состояние, а не
  // «Бот отвечает сам», когда на деле он уже не ответит (05.09.2026).
  const agentActivelyAssigned =
    !!client?.assignedAgentId && client.status !== "LOST" && client.status !== "ARCHIVED" && client.workStatus !== "INACTIVE";
  // OTHER (работа/аренда/прочее) не назначается агенту — нет ни «принятия», ни
  // круговой эскалации; руководство работает с карточкой напрямую.
  const isOther = client?.kind === "OTHER";
  const agentsQuery = useAgents({ enabled: canAssignClients });
  /**
   * КОМУ МОЖНО НАЗНАЧИТЬ (B13, решение владельца 02.10.2026). В списке — все
   * работающие сотрудники, кроме отключённых и замороженных (отпуск, больничный):
   * им сервер и не даст. Не агенту (директору, менеджеру) назначить можно —
   * владелец иногда сам ведёт клиентов, — но экран говорит это до нажатия и
   * переспрашивает «Точно назначить?».
   */
  const staffForAssign = assignableStaff(agentsQuery.data);
  const assignToStaff = staffForAssign.find((a) => a.id === assignTo);
  const confirmAssignTo = () => {
    const question = notAgentConfirmText(assignToStaff);
    return !question || window.confirm(question);
  };
  const notAgentWarningLine = notAgentWarningText(assignToStaff);
  const notAgentWarning = notAgentWarningLine ? (
    <span className="state" style={{ paddingBottom: 0 }}>
      <span className="dot warn" />
      {notAgentWarningLine}
    </span>
  ) : null;
  // «Завершить сделку» доступна только после первого проведённого показа (ТЗ п. 16,
  // голосовое уточнение владельца 12.08.2026) — до этого момента закрывают клиента
  // через «Неактивный», которая гейта не требует.
  //
  // ПРОВЕДЁННЫЙ, а не назначенный: показ создаётся в момент назначения, на будущую
  // дату, и до 14.08.2026 кнопка открывалась сразу после назначения показа на
  // следующий месяц. Признак тот же, что на сервере (lib/conductedShowing.ts):
  // не отменён и либо отмечен выполненным, либо записан задним числом (без
  // nextActionDate), либо его время уже прошло.
  /** Работа с клиентом приостановлена (ТЗ п. 22). Управляет этим агент, в отличие
   *  от `status` (Новый/Горячий/…), который ставит сама CRM. */
  const isInactive = client?.workStatus === "INACTIVE";
  /** «Отложенные» (задача G, 03-04.09.2026) — не «Неактивный»: слот свободен,
   *  светофора нет, возврат по таймеру или раньше, если клиент напишет сам. */
  const isDeferred = client?.workStatus === "DEFERRED";
  /**
   * «Подборка отправлена» — руководитель раньше не видел на карточке, что агент уже
   * предложил клиенту объекты (POST /:id/send-properties пишет только в обычную
   * хронологию, но экран её не выделял). Отдельного поля под это заводить не стали —
   * маршрут создаёт обычные SYSTEM-интеракции с этим текстом, и хронология уже
   * загружена вместе с карточкой; ищем по тексту тем же приёмом, что и
   * oversight.ts::inactiveEventsWhere (маркер только в тексте, без отдельного поля).
   * Несколько объектов одной отправки создаются в один createMany — Postgres даёт
   * им одинаковый createdAt (единое now() внутри одной вставки), группируем по нему,
   * чтобы показать «N объектов», а не только последнюю строку.
   */
  const lastPropertiesSent = useMemo(() => {
    const sent = (client?.interactions ?? []).filter(
      (i) => i.type === "SYSTEM" && i.propertyId && i.notes.endsWith("— отправлена клиенту")
    );
    if (sent.length === 0) return null;
    // interactions уже отсортированы от новых к старым (orderBy createdAt desc на сервере).
    const lastAt = sent[0].createdAt;
    return { at: lastAt, count: sent.filter((i) => i.createdAt === lastAt).length };
  }, [client?.interactions]);
  /**
   * «ПЕРЕДАЧА» — гейт снижен 22.08.2026 (мозговой штурм владельца, «рубеж 2:
   * дверь передачи, которой сейчас нет»): раньше требовался обязательно
   * проведённый показ (как у «Завершить сделку» выше), теперь достаточно хотя
   * бы ОДНОЙ попытки реального контакта — звонок с ответом дольше
   * leadCallMinSeconds или ответ клиента в переписке. Та же метрика, что решает
   * серверный гейт (lib/clientTransfer.ts::canTransferClient, сам переиспользует
   * lib/inactiveTrafficLight.ts::countRealContacts) — здесь только КОПИЯ для
   * видимости кнопки, не защита: окончательное решение всегда за сервером.
   */
  const { data: settings } = useSettings();
  const leadCallMinSeconds = settings?.leadCallMinSeconds ?? 30;
  // Факты считает сервер по ПОЛНОЙ истории: карточка режет хронологию на 200 записей,
  // и вывод из неё прятал «Завершить сделку»/«Передать» после 200 новых записей (WEB-PAGES21).
  const {
    hadShowing,
    hadRealContact,
    callsCount: historyCallsCount,
  } = clientHistoryFacts(client, leadCallMinSeconds);

  // Сигнал «открой переписку» подаёт AddInteractionModal.onSaved для исхода
  // WAITING_OPTIONS. Идёт через location.state, а не прямым вызовом: подать его
  // может и другая страница. (Раньше вторым источником было окно «Статус + Итог»
  // обязательных окон — механизм удалён 13.09.2026.)
  // Чистим state сразу после использования — иначе обновление страницы (F5)
  // открывало бы переписку заново.
  //
  // Раньше здесь были scrollIntoView и focus по id поля: переписка жила в самой
  // карточке, и «открыть» её было нечем. Теперь открывается панель — то, что
  // владелец и просил под словами «мягко выходит окно для переписки».
  useEffect(() => {
    if (!client) return;
    if (!(location.state as { openChat?: boolean } | null)?.openChat) return;
    // Чистим сигнал в любом случае: у клиента без единого канала открывать нечего,
    // но повторно срабатывать он не должен.
    navigate(location.pathname, { replace: true, state: null });
    if (conversationsOf(client).length === 0) return;
    setChat({ open: true, focusReply: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, location.state]);

  /**
   * `?reassign=1` СРАЗУ РАСКРЫВАЕТ панель переназначения — по такому адресу
   * приходят из аларма «агент не отвечает клиенту»
   * (apps/api/src/lib/agentUnansweredAlarm.ts).
   *
   * Владелец 09.09.2026: получив это уведомление, он либо звонит агенту, либо
   * передаёт карточку сам. Второе не должно стоить поиска строки «Переназначить
   * агенту» в списке «Ещё» — от тревоги до действия один тап, иначе тревога так
   * и остаётся тревогой. Панель та же самая, второго способа передать не заводим.
   *
   * Параметр снимается сразу: закрытая панель не должна раскрываться заново при
   * возврате назад по истории браузера. Право проверяем здесь же — ссылку может
   * открыть и агент, которому эта панель не положена.
   */
  useEffect(() => {
    if (!client) return;
    if (!new URLSearchParams(location.search).has("reassign")) return;
    navigate(location.pathname, { replace: true });
    if (canDo("clients.assign")) setShowReassign(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, location.search]);

  // Ссылка по настоящему id (часть пушей сервера, аудит 23.09.2026 №12) —
  // после загрузки адрес заменяется на короткий номер, как у всех экранов.
  useEffect(() => {
    if (client && id && id !== String(client.shortId)) {
      navigate(`/clients/${client.shortId}${location.search}${location.hash}`, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, id]);

  if (isLoading) return clean ? <CleanClientDetailSkeleton /> : <ClientCardSkeleton />;
  /**
   * ОТКАЗ СЕТИ ≠ «КАРТОЧКУ УДАЛИЛИ» (найдено аудитом 22.08.2026). До этой правки
   * любой отказ запроса (не только настоящий 404) падал в ветку «Карточка не
   * найдена» ниже — агент, у которого просто моргнул интернет, читал это как
   * «клиента передали или удалили» и шёл искать его заново вместо того, чтобы
   * обновить страницу. 404 — это и есть «не найдена», а не 500/таймаут.
   */
  const notFoundError = isError && clientError instanceof ApiError && clientError.status === 404;
  if (isError && !notFoundError) {
    return (
      <EmptyState
        illustration="clients"
        title="Не удалось загрузить карточку"
        hint={clientError instanceof Error ? clientError.message : "Проверьте соединение и попробуйте ещё раз."}
        action={
          /* Пустые состояния до загрузки карточки живут ВНЕ обёртки `.rh2`
             (ранний return, до неё дело не доходит), поэтому кнопка макета
             получает свою обёртку: `.rh2 .pill` — потомковый селектор, ему
             достаточно любого предка с этим классом. */
          <span className="rh2 screens">
            <span className="scr" style={RH2_SCR_BARE}>
              <button className="pill" onClick={() => refetchClient()}>
                Повторить
              </button>
            </span>
          </span>
        }
      />
    );
  }
  /**
   * Тупик без выхода был серой строкой в углу пустого экрана. Человек попадает
   * сюда по ссылке из уведомления или из бота на карточку, которую уже удалили
   * или передали, — и остаётся ни с чем: ни объяснения, ни куда идти дальше.
   */
  if (!client)
    return (
      <EmptyState
        illustration="clients"
        title="Карточка не найдена"
        hint="Карточка удалена, объединена с дубликатом или переведена в кандидаты на вакансию. Проверьте список — возможно, клиент там под другим именем."
        action={
          <span className="rh2 screens">
            <span className="scr" style={RH2_SCR_BARE}>
              <Link className="pill" to={isSeller ? "/sellers" : isOther ? "/other-inquiries" : "/clients"}>
                К списку
              </Link>
            </span>
          </span>
        }
      />
    );

  // Уровень 3: до принятия лида агент видит требования, но не контакты и не может работать с карточкой.
  // Для OTHER pendingAcceptance всегда true (нет агента, который мог бы принять) — это не «ожидание».
  const pending = !!client.pendingAcceptance && !isOther;
  const canAccept = pending && me?.role === "AGENT" && client.assignedAgentId === me.id;
  /**
   * Карточка только для чтения — для того, кто видит чужие карточки, но не работает
   * с ними: служба безопасности разбирает причины ухода клиентов, и в её пресете
   * прямо написано «видеть — но не менять». Сервер это правило теперь держит
   * (PATCH /clients/:id), а здесь мы не рисуем кнопки, которые всё равно ответят
   * отказом: мёртвая кнопка хуже отсутствующей — человек жмёт и не понимает, почему
   * ничего не происходит.
   *
   * Свои карточки и руководство под это не попадают: у первого совпадает агент, у
   * второго есть право распределять лидов — то же, по которому пускает сервер.
   */
  const readOnly = accountReadOnly || (client.assignedAgentId !== me?.id && !canDo("clients.assign"));
  const locked = (pending && me?.role === "AGENT") || readOnly;
  /**
   * Пачка 16 (11.09.2026): у карточки, переданной другому агенту, действия
   * пустые, кроме «Позвонить» — и то только у того, кому дано писать в чужие
   * карточки (`clients.assign`, то же право, что уже открывает readOnly выше).
   * Логика — в lib/clientTransferAccess.ts (чистая функция, покрыта тестом).
   */
  const canCallTransferred = !accountReadOnly && canCallOnTransferredCard(client, canDo("clients.assign"));
  const transferBanner = transferBannerOf(client);

  /**
   * ОДНА КНОПКА «ПОДБОР · N» ВЕЗДЕ (17.09.2026 вечер, docs/match-policy-plan-17-09.md
   * §6) — заменяет прежние «Подходит N объектов» и «Выбрать объект»/moreRow.
   * Один и тот же узел рендерится в шапке действий (ПК), в разделе «Объекты» (ПК)
   * и на телефоне (MobileClientCard, через onOpenMatch+matchTotal). N — total из
   * useClientMatch, пока не загрузился — просто «Подбор» (счёт не выдумываем).
   */
  const matchButton =
    (!locked || accountReadOnly) && !isSeller && !isOther ? (
      <button className="pill ghost" type="button" onClick={() => setMatchOpen(true)}>
        Подбор{clientMatchQuery.data ? ` · ${clientMatchQuery.data.total}` : ""}
      </button>
    ) : null;

  const conversations = conversationsOf(client);


  // Хронология и её срез «только звонки»: один список с фильтром, а не вторая
  // история в другом углу карточки (см. разметку ниже).
  const interactions = client.interactions ?? [];
  const callsCount = historyCallsCount;
  // Карточка приносит только последние 200 записей — остальные хронология
  // догружает сама (InteractionTimeline, «Показать более ранние»).
  const interactionsTruncated = (client.interactionsTotal ?? 0) > interactions.length;

  /**
   * Сколько действий спрятано под «Ещё» на телефоне. Считается по тем же
   * условиям, что и сами кнопки ниже, — список должен ровно совпадать с
   * содержимым раскрывающегося блока, иначе подпись «Ещё действия · 4» соврёт.
   */
  const hiddenActionCount = [
    !locked && !isSeller && !isOther, // Выбрать объект
    !locked && !isOther && isInactive, // Вернуть в работу (и продавцу тоже)
    !locked && !isOther && isDeferred, // Поднять из «Отложенных»
    !locked, // Записать разговор
    !locked, // Показ / встреча
    !locked, // Изменить
    !locked && !isSeller && !isOther && hadShowing, // Завершить сделку
    !locked && !isSeller && !isOther && hadRealContact, // Передать агенту
    !locked && canMerge, // Объединить с карточкой
    !pending && canAssignClients && !isOther && !!client.assignedAgent && !showReassign, // Переназначить
    canDelete, // Удалить
    // «Направить на удаление» или строка «заявка отправлена» вместо неё — место
    // в сетке занимают одинаково, поэтому в счёте это один пункт.
    canRequestDelete, // Направить на удаление / заявка уже отправлена
    !locked && canMerge && !!similarNotes && similarNotes.length > 0, // Похожая карточка
  ].filter(Boolean).length;


  /**
   * НОМЕРА КЛИЕНТА ОДНИМ СПИСКОМ ДЛЯ ОБЩЕЙ КНОПКИ «ПОЗВОНИТЬ» (владелец
   * 11.09.2026, показ 12.09): «Основной телефон / Номер WhatsApp / доп. номера»
   * раньше шли отдельными строками карточки, у каждой своя кнопка. Теперь один
   * список для CallPhoneChooser — один номер звонит сразу, 2–4 открывают шторку
   * выбора. Основной первым, дальше WhatsApp (если отличается от основного, как
   * и раньше), дальше ручные запасные — подписи «Дополнительный»/«Дополнительный N».
   */
  const phoneOptions: CallPhoneOption[] = [{ key: "main", label: "Основной", phone: client.phone }];
  if (client.whatsappPhone && digitsOf(client.whatsappPhone) !== digitsOf(client.phone)) {
    phoneOptions.push({ key: "whatsapp", label: "WhatsApp", phone: client.whatsappPhone });
  }
  const extraPhonesList = client.extraPhones ?? [];
  extraPhonesList.forEach((p, i) => {
    phoneOptions.push({
      key: `extra-${i}`,
      label: extraPhonesList.length > 1 ? `Дополнительный ${i + 1}` : "Дополнительный",
      phone: p,
    });
  });

  const backTo = isSeller ? "/sellers" : isOther ? "/other-inquiries" : "/clients";
  const backLabel = isSeller ? "Продавцы" : isOther ? "Прочие обращения" : "Покупатели";
  /**
   * ЖАЛОБА ВЛАДЕЛЬЦА (audit §6, 31.08.2026): «захожу в лида агента из „Команды“ —
   * назад ведёт только на общий список клиентов, а не туда, откуда я пришёл».
   * Экраны с собственным осмысленным «назад» (карточка агента, строка в
   * «Контроле руководителя») кладут `{ from, fromLabel }` в `state` при переходе
   * (см. components/BackLink.tsx, BackLinkState) — тот компонент был написан для
   * этого случая, но здесь так и не подключён (разошлись стили: `.lk.mut` темы
   * прототипа против Tailwind-разметки BackLink), поэтому крошка молча
   * игнорировала state. Читаем `state` тут же, тем же приоритетом, что и BackLink.
   */
  const backState = location.state as { from?: string; fromLabel?: string } | null;
  const effectiveBackTo = backState?.from || backTo;
  const effectiveBackLabel = backState?.fromLabel || backLabel;

  /** Живые сделки клиента: завершённые и отменённые на карточке не нужны, они в «Сделках». */
  // Те же роли, что у блока сделки на странице объекта (canManageDealsForProperty).
  const canStartDeal = me?.role !== "MARKETING" && me?.role !== "EDITOR" && me?.role !== "SECURITY";
  const openDeals = (client.deals ?? []).filter((d) => d.stage !== "COMPLETED" && d.stage !== "CANCELLED");

  /**
   * Строка под именем: когда пришёл, когда говорили в последний раз, кто ведёт.
   * Источник (решение владельца 11.09.2026, «Ждёт владельца» п. 3 — приоритет
   * пяти шкал статуса, шкала 5 из 5) переехал в «О карточке» ниже: он не входит
   * в главный статус шапки, дублировать его тут и там незачем.
   */
  const headSub = [
    `Пришёл ${dushanbeDate(client.createdAt, { day: "numeric", month: "long" })}`,
    `Последний контакт ${relativeTime(client.lastContactAt)}`,
    client.assignedAgent ? `Агент ${client.assignedAgent.fullName}` : "Агент не назначен",
  ].join(". ");

  /**
   * «Решить сейчас» — только то, на что у человека есть право и эндпоинт
   * (договор §5, §6.11). Собираем строками `.solve`, чтобы счётчик в шапке
   * блока не разошёлся с тем, что в нём нарисовано.
   */
  const solveRows: ReactNode[] = [];
  if (canAccept) {
    solveRows.push(
      <div className="solve" key="accept">
        <span className="t">
          <b>Новый лид назначен вам.</b> Телефон и работа с карточкой откроются после принятия. Не примете
          вовремя, лид уйдёт {client.ownPropertyLead ? "руководителю" : "следующему агенту"}.
          {client.leadReason && (
            <>
              {" "}
              {client.leadReason.propertyShortId !== null ? (
                <Link to={`/properties/${client.leadReason.propertyShortId}`} style={{ textDecoration: "underline" }}>{client.leadReason.text}</Link>
              ) : (
                client.leadReason.text
              )}
              {client.assignReason === "own_property_match" && client.matchScore != null
                ? `, совпадение ${client.matchScore} из 100 (${matchScoreBand(client.matchScore)}).`
                : "."}
            </>
          )}
        </span>
        <span className="acts">
          <button
            className="pill sm"
            type="button"
            disabled={acceptLead.isPending || declineLead.isPending}
            onClick={() =>
              acceptLead.mutate(undefined, {
                onError: (err) => {
                  // 409 «выберите, кого освободить» — не отказ, а вопрос: портфель
                  // полон, но лид по своему объекту всё равно можно взять.
                  const needsRelease = isRequiresRelease(err);
                  if (needsRelease) setReleaseCandidates(needsRelease.candidates);
                },
              })
            }
          >
            {acceptLead.isPending ? "Принятие" : "Принять"}
          </button>
          <button
            className="pill ghost sm"
            type="button"
            disabled={acceptLead.isPending || declineLead.isPending}
            onClick={() => setConfirmDecline(true)}
          >
            Отклонить
          </button>
        </span>
      </div>
    );
  }
  // Пул «ничьих» (POST /clients/:id/claim-pool) УДАЛЁН ЦЕЛИКОМ (17.09.2026,
  // закон о владении клиентом П-4/Р-3) — см. комментарий в
  // routes/clients/lifecycle.ts. `Client.poolCandidateIds` остаётся в схеме,
  // но больше никто его не читает и не пишет.
  if (releaseCandidates) {
    solveRows.push(
      <div className="solve" key="release">
        <span className="t">
          <b>Получить этот лид как 7-го клиента?</b>{" "}
          {client.matchScore != null
            ? `Совпадение с вашим объектом ${client.matchScore} из 100 (${matchScoreBand(client.matchScore)}). Портфель уже полон, поэтому выберите, кого из текущих обычных клиентов передать другому агенту.`
            : "Этот лид по вашему объекту, и его можно взять сверх лимита. Выберите, кого из текущих обычных клиентов передать другому агенту."}{" "}
          Своих объектов среди них нет, их эта замена не касается никогда. Отданный уйдёт по очереди KPI
          вместе с незакрытыми задачами.
          <span className="wrap" style={{ marginTop: 8 }}>
            {releaseCandidates.map((rc) => (
              <button
                key={rc.id}
                className="pill ghost sm"
                type="button"
                disabled={acceptLead.isPending}
                onClick={() =>
                  acceptLead.mutate({ releaseClientId: rc.id }, { onSuccess: () => setReleaseCandidates(null) })
                }
              >
                {formatClientName(rc)} {formatClientCode(rc.shortId, rc.kind)}, {relativeTime(rc.assignedAt)}
              </button>
            ))}
          </span>
        </span>
        <span className="acts">
          <button className="pill ghost sm" type="button" onClick={() => setReleaseCandidates(null)}>
            Не принимать пока
          </button>
        </span>
      </div>
    );
  }
  {
    /* Разбор непринятого лида руководителем: назначить агенту вручную или забрать себе. */
  }
  if (pending && canAssignClients) {
    solveRows.push(
      <div className="solve" key="assign">
        <span className="t">
          {client.escalatedAt ? (
            <>
              <b>Заявку никто не принял.</b>{" "}
              {client.reassignCount ? `${client.reassignCount} агентов пропустили её вовремя. ` : ""}
              Круговое переназначение остановлено. Назначьте её конкретному агенту или заберите себе: заявка
              сразу станет принятой, агенту придёт уведомление.
            </>
          ) : (
            <>
              <b>Лид ждёт принятия.</b> Назначен агенту {client.assignedAgent?.fullName}. Можно назначить
              агента вручную: заявка сразу станет принятой, без таймера.
            </>
          )}
          {assignLead.isError && (
            <span className="state err" style={{ paddingBottom: 0 }}>
              <span className="dot crit" />
              {assignLeadErrorText(assignLead.error, "Не удалось назначить.")}
            </span>
          )}
          {notAgentWarning}
        </span>
        <span className="acts">
          <span className="fld">
            <select value={assignTo} onChange={(e) => setAssignTo(e.target.value)} aria-label="Кому назначить">
              <option value="">Выберите сотрудника</option>
              {/* Отсутствующих (отпуск, больничный, заморозка) не предлагаем:
                  передать карточку тому, кого нет на работе, — ровно та ошибка,
                  от которой уводит вся лестница тревог (владелец 09.09.2026). */}
              {staffForAssign.map((a) => (
                <option key={a.id} value={a.id}>
                  {staffOptionLabel(a)}
                </option>
              ))}
            </select>
          </span>
          <button
            className="pill sm"
            type="button"
            disabled={!assignTo || assignLead.isPending}
            onClick={() => {
              if (!confirmAssignTo()) return;
              assignLead.mutate({ agentId: assignTo }, { onSuccess: () => setAssignTo("") });
            }}
          >
            Назначить
          </button>
          {me && (
            <button
              className="pill ghost sm"
              type="button"
              disabled={assignLead.isPending}
              onClick={() => assignLead.mutate({ agentId: me.id, accept: true })}
            >
              Взять себе
            </button>
          )}
        </span>
      </div>
    );
  }
  {
    /* Переназначение УЖЕ принятого клиента: тот же эндпоинт (/assign без accept),
       новый агент получает карточку сразу принятой (владелец 23.09.2026). */
  }
  if (!pending && canAssignClients && !isOther && client.assignedAgent && showReassign) {
    solveRows.push(
      <div className="solve" key="reassign">
        <span className="t">
          <b>Передать от {client.assignedAgent.fullName} другому агенту.</b> Новый агент получит карточку
          сразу, без принятия, и увидит её на главной.
          {assignLead.isError && (
            <span className="state err" style={{ paddingBottom: 0 }}>
              <span className="dot crit" />
              {assignLeadErrorText(assignLead.error, "Не удалось переназначить.")}
            </span>
          )}
          {notAgentWarning}
        </span>
        <span className="acts">
          <span className="fld">
            <select value={assignTo} onChange={(e) => setAssignTo(e.target.value)} aria-label="Кому передать">
              <option value="">Выберите сотрудника</option>
              {/* Тот же отсев отсутствующих, что и выше. */}
              {staffForAssign
                .filter((a) => a.id !== client.assignedAgentId)
                .map((a) => (
                  <option key={a.id} value={a.id}>
                    {staffOptionLabel(a)}
                  </option>
                ))}
            </select>
          </span>
          <button
            className="pill sm"
            type="button"
            disabled={!assignTo || assignLead.isPending}
            onClick={() => {
              if (!confirmAssignTo()) return;
              assignLead.mutate(
                { agentId: assignTo },
                {
                  onSuccess: () => {
                    setAssignTo("");
                    setShowReassign(false);
                  },
                }
              );
            }}
          >
            {assignLead.isPending ? "Переназначение" : "Переназначить"}
          </button>
          <button
            className="pill ghost sm"
            type="button"
            onClick={() => {
              setShowReassign(false);
              setAssignTo("");
            }}
          >
            Отмена
          </button>
        </span>
      </div>
    );
  }

  /**
   * Редкие действия. В прототипе это шторка «Другие действия» (`sh-more`) со
   * списком `.row`: подпись, объяснение и одна кнопка в строке. Здесь тот же
   * список, но раскрывается на месте, а не шторкой (см. отчёт по переносу).
   */
  const canCreatePropertyFromLead = isSeller && !locked && (isSupervisor || client.assignedAgentId === me?.id);
  const hasExistingSellerProperty = (sellerProperties?.total ?? 0) > 0;
  /**
   * ОБЪЕКТ ИЗ КАРТОЧКИ ПРОДАВЦА — В МАСТЕР, А НЕ В СТАРУЮ ФОРМУ (23.09.2026).
   * Старая форма не умела видео, и объект, заведённый отсюда, уходил на проверку
   * без ролика. Мастер тот же, что у «Добавить объект из чата»: поля карточки и
   * переписки подставляет сервер (POST /properties/drafts/from-client/:id).
   */
  const openPropertyWizard = () => {
    const params = new URLSearchParams({ fromClient: client.id });
    if (client.assignedAgentId) params.set("intake", client.assignedAgentId);
    navigate(`/properties/new?${params.toString()}`);
  };

  /**
   * Пункты меню «Ещё» — данными, а не готовыми строками (владелец 29.09.2026:
   * лист был свалкой из десяти одинаковых строк с серой кнопкой в каждой).
   * Порядок — по частоте: сначала то, что нужно по состоянию карточки
   * (сделка, вернуть в работу), затем правка и передача, затем редкое, внизу —
   * необратимое. Недоступное по правам в список не попадает вовсе.
   *
   * Что убрано насовсем и почему не вернуть:
   *  - «Связался со своего телефона» (владелец 29.09.2026) — звонок мимо CRM
   *    без записи и исхода; путь сервера и схема удалены, старые записи
   *    остаются в хронологии;
   *  - ручная смена статуса заявки продавца (15.09.2026) — сервер её запрещает;
   *  - «Выбрать объект» (17.09.2026) — подбор один, через «Подбор · N» в шапке;
   *  - «Отложить карточку» (16.09.2026) — причину неактивности выбирает только
   *    автоматика (ai/callAnalysis.ts, lib/silentClientAutoDeactivate.ts);
   *    «Вернуть в работу» остаётся ручным обратным переходом;
   *  - «Записать разговор» (13.09.2026) — вместе с механизмом обязательных окон.
   */
  const mainItems: MoreItem[] = [];
  const extraItems: MoreItem[] = [];
  const dangerItems: MoreItem[] = [];

  if (canCreatePropertyFromLead) {
    mainItems.push({
      key: "property",
      label: "Создать объект из заявки",
      icon: Home,
      hint: hasExistingSellerProperty ? "У продавца уже есть объект в CRM" : undefined,
      onSelect: () => (hasExistingSellerProperty ? setConfirmDuplicateProperty(true) : openPropertyWizard()),
    });
  }
  // Первую сделку заводят отсюда (29.09.2026): пустой блок «Сделки пока нет» с
  // кнопкой на первом экране владелец убрал как лишний — поэтому здесь пункт
  // первый и выделен, а не одна из десяти равных строк.
  if (!isOther && !isSeller && !locked && canStartDeal && openDeals.length === 0) {
    mainItems.push({
      key: "deal",
      label: "Начать сделку",
      icon: Handshake,
      tone: "primary",
      hint: "Договорились с клиентом об объекте",
      onSelect: () => setShowNewDeal(true),
    });
  }
  if (!locked && !isOther && isInactive) {
    mainItems.push({
      key: "reactivate",
      label: "Вернуть в работу",
      icon: RotateCcw,
      hint: "Клиент снова на связи, слот в лимите вернётся",
      disabled: reactivate.isPending,
      onSelect: () => reactivate.mutate(),
    });
  }
  // «Отложенные» (задача G, 03-04.09.2026) — не Неактивные: слота в лимите не
  // занимают, светофора нет. Выход виден сразу, как у «Вернуть в работу».
  if (!locked && !isOther && isDeferred) {
    mainItems.push({
      key: "return-deferred",
      label: "Поднять из «Отложенных»",
      icon: RotateCcw,
      hint: "Раньше срока таймера",
      disabled: returnDeferred.isPending,
      onSelect: () => returnDeferred.mutate(),
    });
  }
  if (!locked) {
    // На телефоне «Показ» уже отдельная кнопка полосы действий — дубля в меню нет.
    if (!mobile) {
      mainItems.push({
        key: "showing",
        label: "Показ или встреча",
        icon: CalendarClock,
        hint: "Записать, в том числе задним числом",
        onSelect: () => setShowInteraction(true),
      });
    }
    mainItems.push({
      key: "edit",
      label: "Изменить данные",
      icon: Pencil,
      onSelect: () => setShowEditForm(true),
    });
  }
  if (!locked && !isSeller && !isOther && hadShowing) {
    mainItems.push({
      key: "close-deal",
      label: "Завершить сделку",
      icon: CircleCheck,
      hint: "Успешно или не состоялась",
      onSelect: () => setShowCloseDeal(true),
    });
  }
  if (!locked && !isSeller && !isOther && hadRealContact) {
    mainItems.push({
      key: "transfer",
      label: "Передать другому агенту",
      icon: ArrowRightLeft,
      onSelect: () => setShowTransfer(true),
    });
  }
  if (!pending && canAssignClients && !isOther && client.assignedAgent && !showReassign) {
    mainItems.push({
      key: "reassign-open",
      label: "Назначить агента",
      icon: UserCog,
      hint: "Карточка сразу станет его, без принятия",
      onSelect: () => setShowReassign(true),
    });
  }
  if (!locked && canMerge) {
    mainItems.push({
      key: "merge",
      label: "Объединить с дубликатом",
      icon: GitMerge,
      onSelect: () => setShowMerge(true),
    });
  }
  // На телефоне то же предупреждение стоит над меню (с кнопками «Объединить» и
  // «Не дубль»), вторая дорожка к тому же окну не нужна.
  if (!mobile && !locked && canMerge && !!similarNotes && similarNotes.length > 0) {
    mainItems.push({
      key: "similar",
      label: `Похожая карточка${similarNotes.length > 1 ? `, ${similarNotes.length}` : ""}`,
      icon: Copy,
      hint: "Решаете вы, объединять или нет",
      onSelect: () => setShowSimilarSheet(true),
    });
  }

  if (!locked) {
    /**
     * СМЕНА ТИПА КАРТОЧКИ ВРУЧНУЮ (19.09.2026, жалоба агента Нозы на карточку
     * №32 — ИИ ошибся направлением, поправить мог только разработчик правкой
     * в базе). Сервер (routes/clients/card.ts) принимает `kind` в PATCH, пишет
     * хронологию и шлёт пуш держателю. Выбор — отдельной шторкой с подтверждением,
     * а не выпадающим списком в строке: смена типа меняет трактовку полей
     * карточки, случайно задеть её нельзя.
     */
    extraItems.push({
      key: "kind",
      label: "Тип карточки",
      icon: Tag,
      value: CLIENT_KIND_LABELS[client.kind ?? "BUYER"],
      disabled: updateClient.isPending,
      onSelect: () => setShowKindSheet(true),
    });
  }
  /**
   * «Звонок роботом» (28.09.2026): сервер умел звонить клиенту голосовым ботом с
   * 13.09 (POST /clients/:id/live-voice-call), кнопки не было нигде. Строка
   * видна, только когда живой голос включён в Настройках; права, линию и номер
   * решает сервер и присылает причину словами — её показывает шторка.
   */
  // Только руководителю и админу (владелец 29.09.2026); сервер проверяет то же.
  if (isSupervisor && !locked && settings?.liveVoiceEnabled) {
    extraItems.push({
      key: "live-voice",
      label: "Звонок роботом",
      icon: Bot,
      onSelect: () => setShowRobot(true),
    });
  }

  /**
   * «В КАНДИДАТЫ» (17.09.2026). Реклама вакансии идёт вместе с рекламой квартир,
   * откликнувшиеся на работу попадали сюда покупателем с агентом (302, 315, 319).
   * Виден тому же кругу, что и разбор очереди лидов (clients.assign): решение о
   * чужой карточке. Тип не ограничиваем — разгребать надо именно BUYER/SELLER.
   *
   * 02.10.2026: по ПРАВАМ, а не по роли — сервер пускает по праву, и менеджер
   * без права видел пункт, который отвечал отказом. Нужны оба: clients.assign
   * (как у маршрута сейчас) и clients.delete — карточка клиента при переводе
   * уходит из списка клиентов, это по сути удаление.
   */
  if (canTransferClientToCandidates(canDo) && !client.deletedAt) {
    dangerItems.push({
      key: "to-candidate",
      label: "Перевести в кандидаты",
      icon: Briefcase,
      tone: "danger",
      hint: "Уедет в «Вакансии», агент будет снят",
      disabled: toCandidate.isPending,
      onSelect: () => {
        setToCandidateError(null);
        setConfirmToCandidate(true);
      },
    });
  }
  if (canDelete) {
    dangerItems.push({
      key: "delete",
      label: "Удалить карточку",
      icon: Trash2,
      tone: "danger",
      hint: "Попадёт в Корзину, оттуда её можно вернуть",
      disabled: deleteClient.isPending,
      onSelect: () => setConfirmDelete(true),
    });
  }
  if (canRequestDelete) {
    dangerItems.push({
      key: "request-delete",
      label: "Запросить удаление",
      icon: Trash2,
      tone: "danger",
      hint: "Решает директор",
      done: pendingDeleteRequest
        ? `Отправлена ${new Date(pendingDeleteRequest.createdAt).toLocaleDateString("ru-RU", { timeZone: "Asia/Dushanbe", day: "numeric", month: "long" })}`
        : undefined,
      onSelect: () => setShowRequestDelete(true),
    });
  }

  const moreGroups: MoreGroup[] = [
    { key: "main", items: mainItems },
    { key: "extra", title: "Дополнительно", items: extraItems },
    { key: "danger", items: dangerItems },
  ];
  const moreCount = countMoreItems(moreGroups);

  /**
   * The same primary lifecycle state on desktop and phone. Temperature and
   * historical fields cannot add contradictory badges beside a pause/closure.
   */
  const mainStatusChip = <ClientStateBadge client={client} />;

  const tabs = [
    { id: "short" as const, label: "Коротко" },
    { id: "chat" as const, label: "Переписка" },
    { id: "calls" as const, label: "Звонки" },
    { id: "props" as const, label: "Объекты" },
    { id: "hist" as const, label: "История" },
  ];

  /**
   * Блоки, одинаковые на ПК и телефоне: «Решить сейчас», сигналы, проверки
   * безопасности/потери, редкие действия десктопной инлайн-карты, «Где сделка».
   * Один узел на оба облика — вынесен в переменную 15.09.2026 при выделении
   * MobileClientCard, чтобы список не разошёлся между двумя местами рендера.
   */
  const commonMiddle = (
    <>
      {!releaseCandidates && <MutationError mutation={acceptLead} fallback="Не удалось принять лид" />}
      <MutationError mutation={declineLead} fallback="Не удалось отклонить лид" />
      <MutationError mutation={updateClient} fallback="Не удалось сохранить изменение" />
      {deleteError && (
        <div className="card tight">
          <div className="quiet crit">
            <span className="dot crit" />
            <span className="txt">{deleteError}</span>
          </div>
        </div>
      )}

      {/* «Решить сейчас»: только то, на что есть эндпоинт и право (договор §5, §6.11) */}
      {solveRows.length > 0 && (
        <div className="card tight">
          <div className="sec-h">
            <h2>Решить сейчас</h2>
            <span className="note">
              {solveRows.length} {pluralizeRu(solveRows.length, ["дело", "дела", "дел"])}
            </span>
          </div>
          {solveRows}
        </div>
      )}

      {/* Полоса «что горит» — сразу под решениями: от неё зависит, о чём вообще
          будет разговор (владелец 20.08.2026). До принятия лида показывать нечего
          честно: показы и шаги приходят пустыми, потому что вся история закрыта. */}
      {!(pending && locked) && <ClientSignals client={client} />}

      {client.securityReview === "PENDING" && <SecurityReviewPanel client={client} />}
      {/* Право `score.clientLossOverride` существовало с лета без единой кнопки в
          интерфейсе (разведка по мёртвому коду 08.09.2026) — панель сама решает,
          показываться ли: проверяет право (directorOnly) и есть ли вообще событие. */}
      {client.status === "LOST" && <ClientLossOverridePanel clientId={client.id} />}

      {/* Редкие действия: в прототипе шторка «Другие действия», здесь тот же список на месте.
          На телефоне moreActions никогда не становится true (переключатель — кнопка
          `.acts` десктопной шапки, на телефоне не рендерится), поэтому здесь блок
          безопасно общий и на мобиле просто не рисуется. */}
      {moreActions && moreCount > 0 && (
        <div className="card tight">
          <div className="sec-h">
            <h2>Другие действия</h2>
            <button className="lnk" type="button" onClick={() => setMoreActions(false)}>
              Свернуть
            </button>
          </div>
          <ClientMoreMenu groups={moreGroups} error={toCandidateError} />
        </div>
      )}

      {/*
        СДЕЛКА КЛИЕНТА — настоящая, с доски «Сделки» (23.09.2026). До этого
        карточка сделку клиента не показывала вовсе: блок «Где сделка» ниже
        рисует СТАТУС КЛИЕНТА (Новый → На контакте → Горячий), и у клиента со
        сделкой в «Согласовании» карточка писала «На контакте, шаг 2 из 4».
        Агент смотрел в карточку и не видел, что сделка уже идёт, а завести
        новую мог только через ⋮ → «Завершить сделку» после показа. Блок стоит
        в общей части, поэтому одинаков на ПК и телефоне.
      */}
      {/* Пустой блок «Сделки пока нет… Начать сделку» убран (владелец 29.09.2026:
          «оно лишнее») — блок виден, только когда сделка уже идёт; завести первую
          сделку — «Ещё» → «Начать сделку». */}
      {!isOther && !isSeller && openDeals.length > 0 && (
        <div className="card tight">
          <div className="sec-h">
            <h2>Сделка</h2>
            {openDeals.length > 0 && (
              <Link className="lnk" to="/deals">
                Доска сделок
              </Link>
            )}
          </div>
          <div className="list">
            {openDeals.map((d) => (
              <Link key={d.id} className="row" to="/deals">
                <div className="t">
                  <b>{d.property?.title ?? "Объект"}</b>
                  <span>{DEAL_STAGE_LABELS[d.stage]}</span>
                </div>
              </Link>
            ))}
          </div>
          {!locked && canStartDeal && (
            <div className="acts">
              <button className="pill ghost sm" type="button" onClick={() => setShowNewDeal(true)}>
                Ещё одна сделка
              </button>
            </div>
          )}
        </div>
      )}

    </>
  );

  /**
   * Модальные окна и шторки — одни на оба облика, открываются и с десктопной
   * инлайн-карты «Другие действия», и с мобильных обработчиков в
   * MobileClientCard. Вынесены в переменную по тому же поводу, что и
   * commonMiddle выше: один список, а не два, которые могут разойтись.
   */
  const sharedModals = (
    <>
      {clean && mobile && showMoreSheet && (
        <Rh2Sheet title="Ещё" onClose={() => setShowMoreSheet(false)}>
          {canMerge && !locked && similarNotes && similarNotes.length > 0 && (
            <SimilarNotesWarning clients={similarNotes} dismissSimilar={dismissSimilar} onMerge={(candidate) => {
              setShowMoreSheet(false);
              setShowMerge(candidate);
            }} />
          )}
          <ClientMoreMenu groups={moreGroups} error={toCandidateError} onPick={() => setShowMoreSheet(false)} />
        </Rh2Sheet>
      )}
      {showInteraction && client.id && (
        <AddInteractionModal
          clientId={client.id}
          selectedClientName={clean ? client.displayName ?? client.fullName : undefined}
          isSeller={isSeller}
          onClose={() => setShowInteraction(false)}
          onSaved={(outcome) => {
            // «Ждёт варианты» → открыть переписку (спецификация, «Путь покупателя»):
            // панель выезжает сразу с курсором в поле ответа.
            if (outcome !== "WAITING_OPTIONS" || conversations.length === 0) return;
            setChat({ open: true, focusReply: true });
          }}
        />
      )}
      {!accountReadOnly && confirmToCandidate && (
        <ConfirmDialog
          title={`Перевести «${client.fullName}» в кандидаты на вакансию?`}
          description="Из карточки соберётся анкета в разделе «Вакансии» (имя, телефон, переписка, присланное резюме), агент будет снят, а сама карточка уедет в Корзину — оттуда её можно вернуть. Историю и переписку это не тронет."
          confirmLabel="Перевести"
          onConfirm={() => {
            setConfirmToCandidate(false);
            toCandidate.mutate(undefined, {
              onSuccess: () => navigate("/vacancies"),
              onError: (err) => setToCandidateError(err instanceof Error ? err.message : "Не удалось перевести"),
            });
          }}
          onCancel={() => setConfirmToCandidate(false)}
        />
      )}
      {!accountReadOnly && confirmDelete && (
        <ConfirmDialog
          title={`Удалить ${isSeller ? "продавца" : "клиента"} «${client.fullName}»?`}
          description="Карточка переместится в Корзину (Архив): историю взаимодействий и сделки не тронет, оттуда можно вернуть или стереть навсегда. Клиента со сделкой (кроме отменённой) удалить нельзя, сначала отмените или завершите её. Если нужно просто убрать из работы, используйте статус «Архив»."
          confirmLabel="Удалить"
          onConfirm={() => {
            setConfirmDelete(false);
            setDeleteError(null);
            deleteClient.mutate(undefined, {
              onSuccess: () => navigate(isSeller ? "/sellers" : "/clients"),
              onError: (err) => setDeleteError(err instanceof Error ? err.message : "Не удалось удалить"),
            });
          }}
          onCancel={() => setConfirmDelete(false)}
        />
      )}
      {!accountReadOnly && showKindSheet && (
        <ClientKindSheet
          current={client.kind ?? "BUYER"}
          onClose={() => setShowKindSheet(false)}
          onPick={(k) => {
            setShowKindSheet(false);
            setKindChangeTarget(k);
          }}
        />
      )}
      {!accountReadOnly && showRobot && <LiveVoiceCallSheet clientId={client.id} onClose={() => setShowRobot(false)} />}
      {!accountReadOnly && kindChangeTarget && (
        <ConfirmDialog
          title={`Сменить тип на «${CLIENT_KIND_LABELS[kindChangeTarget]}»?`}
          description={
            client.kind === "BUYER" || client.kind === "SELLER"
              ? kindChangeTarget === "BUYER" || kindChangeTarget === "SELLER"
                ? "Прежние данные не сотрутся — карточка получит отметку, что интересует обе стороны, и запись в хронологии."
                : "Карточка выпадет из списков «Покупатели»/«Продавцы» у держателя — запись останется в хронологии."
              : "Держатель увидит запись в хронологии и уведомление о смене типа."
          }
          confirmLabel="Сменить"
          danger={false}
          onConfirm={() => {
            const next = kindChangeTarget;
            setKindChangeTarget(null);
            updateClient.mutate({ kind: next });
          }}
          onCancel={() => setKindChangeTarget(null)}
        />
      )}
      {!accountReadOnly && confirmDecline && (
        <ConfirmDialog
          title="Отклонить лид?"
          description="Первый отказ подряд ничего не стоит Royal Score, второй и следующие подряд снижают счёт. Лид сразу уйдёт следующему свободному агенту, а если отдать некому или лид по вашему объекту — руководителю. Эту карточку вы больше не увидите."
          confirmLabel="Отклонить"
          onConfirm={() => {
            setConfirmDecline(false);
            declineLead.mutate(undefined, {
              onSuccess: () => navigate(isSeller ? "/sellers" : "/clients"),
            });
          }}
          onCancel={() => setConfirmDecline(false)}
        />
      )}
      {!accountReadOnly && confirmDuplicateProperty && (
        <ConfirmDialog
          title="У продавца уже есть объект в CRM"
          description="Ещё один объект по этой заявке? Проверьте вкладку «Объекты» — возможно, карточка уже заведена, и нужен не новый объект, а правка существующего."
          confirmLabel="Всё равно создать"
          onConfirm={() => {
            setConfirmDuplicateProperty(false);
            openPropertyWizard();
          }}
          onCancel={() => setConfirmDuplicateProperty(false)}
        />
      )}
      {showEditForm && <ClientFormModal client={client} onClose={() => setShowEditForm(false)} />}
      {matchOpen && <MatchPanel mode="client" client={client} open={matchOpen} onClose={() => setMatchOpen(false)} />}
      {!accountReadOnly && showCloseDeal && <CloseDealChoiceModal client={client} onClose={() => setShowCloseDeal(false)} />}
      {!accountReadOnly && showNewDeal && <NewDealSheet client={client} onClose={() => setShowNewDeal(false)} />}
      {!accountReadOnly && showTransfer && <TransferClientModal client={client} onClose={() => setShowTransfer(false)} />}
      {!accountReadOnly && showMerge && (
        <MergeClientModal
          client={client}
          preselected={showMerge === true ? undefined : showMerge}
          onClose={() => setShowMerge(false)}
        />
      )}
      {!accountReadOnly && showRequestDelete && (
        <RequestDeleteClientModal client={client} onClose={() => setShowRequestDelete(false)} />
      )}
      {!accountReadOnly && showSimilarSheet && similarNotes && similarNotes.length > 0 && (
        <MobileActionSheet title="Похожая карточка" onClose={() => setShowSimilarSheet(false)}>
          <SimilarNotesWarning
            clients={similarNotes}
            onMerge={(c) => {
              setShowSimilarSheet(false);
              setShowMerge(c);
            }}
            dismissSimilar={dismissSimilar}
          />
        </MobileActionSheet>
      )}
      {chat.open && conversations.length > 0 && (
        <ClientChatPanel
          clientId={client.id}
          clientShortId={client.shortId}
          clientName={formatClientName({
            kind: client.kind,
            fullName: `${client.fullName}${client.lastName ? ` ${client.lastName}` : ""}`,
          })}
          conversations={conversations}
          autoFocusReply={chat.focusReply}
          agentActivelyAssigned={agentActivelyAssigned}
          onClose={() => setChat({ open: false, focusReply: false })}
        />
      )}
    </>
  );

  /**
   * Телефон: карточка клиента рисуется отдельным компонентом
   * (components/mobile/MobileClientCard.tsx, облик артефакта c99db05f,
   * `renderClient`). Десктопная ветка ниже (весь `return`) этой веткой не
   * задета совершенно — они разошлись здесь, до неё выполнение не доходит.
   * Модальные окна (AddInteractionModal, ClientFormModal, шторка переписки и
   * т.д.) остаются общими (переменная sharedModals ниже) — MobileClientCard
   * их не дублирует, только открывает через переданные обработчики.
   */
  if (mobile && !clean) {
    return (
      <div className="rh2 screens">
        <div className="scr">
          <div className="wrap" style={{ marginBottom: 4 }}>
            <Link className="lk mut" to={effectiveBackTo} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              <ArrowLeft className="i" />
              {effectiveBackLabel}
            </Link>
            <span className="meta" style={{ color: "var(--faint)" }}>
              {formatClientCode(client.shortId, client.kind)}
            </span>
          </div>

          {transferBanner && (
            <div className="card" style={{ borderColor: "var(--warn)", background: "var(--warn-bg)", marginBottom: 12 }}>
              <p style={{ margin: 0, color: "var(--warn)", fontWeight: 600 }}>
                {transferBanner.headline} {relativeTime(client.access!.transferredAt)}
              </p>
              {transferBanner.reason && (
                <p className="quiet" style={{ margin: "4px 0 0" }}>
                  Причина: {transferBanner.reason}
                </p>
              )}
            </div>
          )}

          <MobileClientCard
            client={client}
            propertyCounts={
              <>
                <PropertyCountRow client={client} role="SELLER" />
                <PropertyCountRow client={client} role="BUYER" />
              </>
            }
            similarWarning={
              similarNotes && similarNotes.length > 0 ? (
                <SimilarNotesWarning clients={similarNotes} onMerge={(c) => setShowMerge(c)} dismissSimilar={dismissSimilar} />
              ) : null
            }
            locked={locked}
            pending={pending}
            isSeller={isSeller}
            isOther={isOther}
            canCallTransferred={canCallTransferred}
            mainStatusChip={mainStatusChip}
            editingName={editingName}
            nameDraft={nameDraft}
            onStartEditName={() => {
              setEditingName(true);
              setNameDraft(client.fullName);
            }}
            onNameDraftChange={setNameDraft}
            onCancelEditName={() => setEditingName(false)}
            onSubmitName={(v) => {
              if (accountReadOnly) return;
              const trimmed = v.trim();
              if (trimmed.length < 2 || trimmed === client.fullName) {
                setEditingName(false);
                return;
              }
              !accountReadOnly && updateClient.mutate({ fullName: trimmed }, { onSuccess: () => setEditingName(false) });
            }}
            savingName={updateClient.isPending}
            phoneOptions={phoneOptions}
            conversations={conversations}
            interactions={interactions}
            lastPropertiesSent={lastPropertiesSent}
            onOpenMatch={() => setMatchOpen(true)}
            matchTotal={clientMatchQuery.data?.total}
            canMerge={canMerge}
            similarNotes={similarNotes}
            onOpenChat={() => {
              // На телефоне обычный переход в чат (решение владельца, п.5
              // хвостов 17.09.2026), а не шторка-пузырь поверх карточки —
              // тот же роут ?open=, что у пуша о брошенном диалоге
              // (см. Messages.tsx). Панель-шторка остаётся резервом на случай,
              // если id диалога вдруг не нашёлся.
              const cid = primaryConversationId(client);
              if (cid) navigate(`/messages?open=${cid}`);
              else setChat({ open: true, focusReply: true });
            }}
            onShowInteraction={() => setShowInteraction(true)}
            onMerge={(c) => setShowMerge(c)}
            moreGroups={moreGroups}
            moreError={toCandidateError}
            showMoreSheet={showMoreSheet}
            onShowMoreSheet={setShowMoreSheet}
            commonMiddle={commonMiddle}
          />
        </div>

        {sharedModals}
      </div>
    );
  }

  return (
    <div className="rh2 screens">
      <div className={clean ? "scr clean-client-detail" : "scr"} style={clean ? cleanClientDetailScale : undefined}>
        <div className="wrap" style={{ marginBottom: 4 }}>
          {/* Прототип рисует крошку строкой `.lk mut` со стрелкой; на широком
              экране `.lk` не флекс, и стрелка с подписью разъезжались по строкам. */}
          <Link className="lk mut" to={effectiveBackTo} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <ArrowLeft className="i" />
            {effectiveBackLabel}
          </Link>
          <span className="meta" style={{ color: "var(--faint)" }}>
            {formatClientCode(client.shortId, client.kind)}
          </span>
        </div>

        {/*
          Пачка 16 (11.09.2026, «осиротевшие спутники, второй заход»): агент,
          у которого клиента забрали, открывает карточку по старой ссылке из
          уведомления или списка и должен сразу понимать, что она чужая и
          почему — а не тыкать в кнопки, отвечающие отказом. `client.access`
          приходит только в этом случае (GET /clients/:id, routes/clients/card.ts).
        */}
        {transferBanner && (
          <div className="card" style={{ borderColor: "var(--warn)", background: "var(--warn-bg)", marginBottom: 12 }}>
            <p style={{ margin: 0, color: "var(--warn)", fontWeight: 600 }}>
              {transferBanner.headline} {relativeTime(client.access!.transferredAt)}
            </p>
            {transferBanner.reason && (
              <p className="quiet" style={{ margin: "4px 0 0" }}>
                Причина: {transferBanner.reason}
              </p>
            )}
          </div>
        )}

        {/* Шапка: аватар, имя, плашки, агент */}
        <CleanClientDetailHeader enabled={clean}>
          <div className={mobile ? "cd-h cd-h-m" : "cd-h"} style={clean ? { display: "grid", gridTemplateColumns: "64px minmax(0, 1fr)", gap: 16, alignItems: "start", textAlign: "left" } : undefined}>
            <span className={mobile ? "av lg" : "av xl"} style={clean ? { width: 64, height: 64 } : undefined}>
              <ClientAvatar
                fullName={client.fullName}
                avatarUrl={client.avatarUrl}
                size={mobile ? 56 : clean ? 64 : 96}
              />
            </span>
            <div className="who">
              {/* Правка ОДНОГО поля без четырёх шагов ClientFormModal (владелец
                  19.08.2026). Ограничение то же, что у сервера (min 2 символа). */}
              {editingName && !accountReadOnly ? (
                <form
                  className="wrap"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const trimmed = nameDraft.trim();
                    if (trimmed.length < 2 || trimmed === client.fullName) {
                      setEditingName(false);
                      return;
                    }
                    updateClient.mutate({ fullName: trimmed }, { onSuccess: () => setEditingName(false) });
                  }}
                >
                  <input
                    className="inp"
                    autoFocus
                    value={nameDraft}
                    onChange={(e) => setNameDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") setEditingName(false);
                    }}
                    aria-label="Имя клиента"
                  />
                  <button
                    className="pill sm"
                    type="submit"
                    disabled={updateClient.isPending || nameDraft.trim().length < 2}
                  >
                    Сохранить
                  </button>
                  <button className="pill ghost sm" type="button" onClick={() => setEditingName(false)}>
                    Отмена
                  </button>
                </form>
              ) : (
                <div className="cd-name-row">
                  <h1 style={clean ? { fontSize: 26, lineHeight: 1.25, overflowWrap: "anywhere", marginBottom: 8 } : undefined}>
                    {client.displayName ??
                      `${client.fullName}${client.lastName ? ` ${client.lastName}` : ""}`}
                  </h1>
                  {mobile && !locked && (
                    <button
                      type="button"
                      className="cd-name-edit"
                      onClick={() => (setEditingName(true), setNameDraft(client.fullName))}
                      aria-label="Изменить имя"
                    >
                      <Pencil className="i" />
                    </button>
                  )}
                </div>
              )}
                  <div className="wrap" style={{ marginBottom: 8 }}>
                    {mainStatusChip}
                    {client.kind && <span className="chip mute">{clientKindLabel(client)}</span>}
                    {client.isPersonalLead && (
                      <span className="chip" title="Агент привёл клиента сам, не через каналы компании">
                        Личный лид
                      </span>
                    )}
                    {lastPropertiesSent && (
                      <span className="chip ok">
                        Подборка отправлена {relativeTime(lastPropertiesSent.at)}, объектов {lastPropertiesSent.count}
                      </span>
                    )}
                  </div>
                  <p className="sub" style={clean ? { fontSize: 14, lineHeight: 1.6, margin: 0 } : undefined}>{headSub}</p>
            </div>
            {!mobile && (
              <div className="acts" style={clean ? { gridColumn: "1 / -1", display: "flex", flexWrap: "wrap", gap: 10, justifyContent: "flex-start" } : undefined}>
                {(!locked || canCallTransferred) && (
                  <>
                    {/* Правило «сначала CRM-звонок» живёт внутри CallClientButton, здесь только облик.
                        Выбор номера — CallPhoneChooser: один номер звонит сразу, два и
                        больше открывают выбор (29.09.2026: строка «Телефоны» ниже
                        убрана, и выбор номера живёт только в этой кнопке). */}
                    <CallPhoneChooser
                      clientId={client.id}
                      phones={phoneOptions}
                      variant="full"
                      label="Позвонить"
                      title="Позвонить через CRM, разговор запишется и попадёт в хронологию"
                      className={clean ? "pill" : "pill ghost"}
                    />
                    {!locked && (
                      <button
                        className="pill ghost"
                        type="button"
                        disabled={conversations.length === 0}
                        onClick={() => setChat({ open: true, focusReply: true })}
                        title={conversations.length > 0 ? "Открыть переписку" : "Клиент ещё не писал ни в один канал"}
                      >
                        Написать
                      </button>
                    )}
                    {/* «Показ» на виду, как на телефоне (23.09.2026): на ПК он
                        жил только за ⋮ → «Показ или встреча». */}
                    {!locked && (
                      <button className="pill ghost" type="button" onClick={() => setShowInteraction(true)}>
                        Показ
                      </button>
                    )}
                  </>
                )}
                {matchButton}
                {!locked && (
                  <button
                    className="pill ghost sm"
                    type="button"
                    onClick={() => (setEditingName(true), setNameDraft(client.fullName))}
                    aria-label="Изменить имя"
                  >
                    <Pencil className="i" />
                    Имя
                  </button>
                )}
                {moreCount > 0 && (
                  <button
                    className="pill ghost"
                    type="button"
                    aria-label="Ещё действия"
                    aria-expanded={moreActions}
                    onClick={() => setMoreActions((v) => !v)}
                  >
                    {/* С подписью, как «Ещё» на телефоне: значок ⋮ без слова агенты
                        не нажимали, а за ним живут передача, тип карточки и закрытие. */}
                    <MoreVertical className="i" />
                    Ещё
                  </button>
                )}
              </div>
            )}
          </div>
        </CleanClientDetailHeader>

        {/* Полоса действий на телефоне — одна, без дублей (владелец 12.09.2026
            утром: «Позвонить» и «Написать» встречались дважды, шапка плюс сетка
            2×4 ниже). «Позвонить/Написать/Показ» — то же самое, что раньше стояло
            в шапке; «Ещё» открывает шторку `Rh2Sheet` с тем же списком, что
            десктопная инлайн-карта «Другие действия» (moreGroups), плюс переходы по
            вкладкам, которые раньше были отдельными ярлыками сетки (Объекты/
            Звонки/Переписка/История — теперь внутри «Ещё», см. showMoreSheet
            ниже). CSS-плотность — apps/web/src/theme-2026-client-card.css. */}
        {mobile && (
          <div className="cd-actbar" role="group" aria-label="Быстрые действия">
            {(!locked || canCallTransferred) && (
              <CallPhoneChooser
                clientId={client.id}
                phones={phoneOptions}
                variant="full"
                label="Позвонить"
                title="Позвонить через CRM, разговор запишется и попадёт в хронологию"
                className="cd-act cd-act--main"
              />
            )}
            {!locked && (
              <>
                <button
                  className="cd-act"
                  type="button"
                  disabled={conversations.length === 0}
                  onClick={() => setChat({ open: true, focusReply: true })}
                  title={conversations.length > 0 ? "Открыть переписку" : "Клиент ещё не писал ни в один канал"}
                >
                  <MessageSquare className="i" />
                  Написать
                </button>
                <button className="cd-act" type="button" onClick={() => setShowInteraction(true)}>
                  <CalendarClock className="i" />
                  Показ
                </button>
              </>
            )}
            {moreCount > 0 && (
              <button
                className="cd-act"
                type="button"
                aria-haspopup="dialog"
                onClick={() => setShowMoreSheet(true)}
              >
                <MoreVertical className="i" />
                Ещё
              </button>
            )}
          </div>
        )}

        {commonMiddle}

        {/* Разделы карточки: на ПК — вкладки с переключателем (как было), на
            телефоне — плоский стек секций (макет c99db05f), gating по `tab`
            снят полностью для mobile, все пять блоков видны подряд. */}
        <div className={clean ? "card clean-client-sections" : "card"} ref={tabsCardRef} style={clean ? { border: 0, padding: 24 } : undefined}>
          {clean ? <CleanClientDetailTabs value={tab} onChange={setTab} /> : !mobile && (
            <div className="tabs" role="tablist" aria-label="Разделы карточки">
              {tabs.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  role="tab"
                  aria-selected={tab === t.id}
                  onClick={() => setTab(t.id)}
                >
                  {t.label}
                </button>
              ))}
            </div>
          )}

          {/* Коротко */}
          {cleanClientShowsPanel(clean, mobile, tab, "short") && (
            <div
              {...(clean ? cleanClientPanelProps("short") : {})}
              style={{ paddingTop: mobile ? 4 : 20 }}
              ref={(el) => {
                sectionRefs.current.short = el;
              }}
            >
              {mobile && !clean && (
                <div className="sec-t" style={{ marginBottom: 10 }}>
                  Коротко
                </div>
              )}
              {/* Сводка ИИ — единственный рассказ о клиенте (владелец 29.09.2026):
                  «Что просит», «Запрос своими словами», «О карточке», строка
                  «Телефоны» и «Что ИИ предлагал раньше» убраны — всё это ИИ
                  вплетает в сводку, а номер выбирается в кнопке «Позвонить». */}
              <ClientInsight client={client} />
              {clean && !client.aiInsight && !(pending && locked) && <div className="clean-client-overview-empty" role="status">
                <p>Краткая сводка по этому клиенту ещё не подготовлена.</p>
                <p className="sub">Предыдущие действия и договорённости доступны в истории карточки.</p>
                <button type="button" className="pill ghost" onClick={() => setTab("hist")}>Открыть историю</button>
              </div>}

              {/* Число объектов от ИИ — тихой строкой, не карточкой-уведомлением
                  (решение владельца 03.09.2026). Обе стороны независимы: у клиента
                  с dualIntent показываются обе. */}
              <PropertyCountRow client={client} role="SELLER" />
              <PropertyCountRow client={client} role="BUYER" />

              {pending && locked ? (
                <p className="state">Запрос клиента, бюджет и история откроются, когда вы примете лид.</p>
              ) : (
                <>
                  {/* «Где ищет» (12.09.2026, docs/geo-match-plan-12-09.md) — карта мест,
                      которые назвал клиент. Пустой список — блок не рисуем вовсе. */}
                  {client.desiredPlaces && client.desiredPlaces.length > 0 && (
                    <>
                      <div className="sec-t">Где ищет</div>
                      <ClientDesiredPlacesMap places={client.desiredPlaces} />
                      <div className="wrap" style={{ marginTop: 8 }}>
                        {client.desiredPlaces.map((p) => (
                          <span className="chip mute" key={p.id}>
                            {p.label || "Место"} · {p.radiusM} м
                          </span>
                        ))}
                      </div>
                    </>
                  )}

                  {canMerge && !locked && similarNotes && similarNotes.length > 0 && (
                    <div style={{ marginTop: 16 }}>
                      <SimilarNotesWarning clients={similarNotes} onMerge={setShowMerge} dismissSimilar={dismissSimilar} />
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {/* Переписка */}
          {cleanClientShowsPanel(clean, mobile, tab, "chat") && (
            <div
              {...(clean ? cleanClientPanelProps("chat") : {})}
              style={{ paddingTop: 20 }}
              ref={(el) => {
                sectionRefs.current.chat = el;
              }}
            >
              {mobile && <div className="sec-t">Переписка</div>}
              {pending && locked ? (
                <p className="state">История и переписка откроются, когда вы примете лид.</p>
              ) : conversations.length > 0 ? (
                <ClientChatCard
                  conversations={conversations}
                  onOpen={() => setChat({ open: true, focusReply: false })}
                  agentActivelyAssigned={agentActivelyAssigned}
                />
              ) : (
                // Пустое место здесь означало бы «переписки нет и не будет», а это
                // неправда: диалог появится сам, как только клиент напишет.
                <div className="empty">
                  <span className="ic">
                    <MessageSquare className="i" />
                  </span>
                  <p>Клиент ещё не писал ни в один канал.</p>
                  <span className="sub">Переписка появится здесь сама с первым его сообщением.</span>
                </div>
              )}
              {/* Написать в WhatsApp первыми — одобренным Meta текстом. Один блок на
                  оба размера экрана: раздел «Переписка» рисуется и там и там. */}
              {!(pending && locked) && <WhatsAppFirstContact clientId={client.id} />}
            </div>
          )}

          {/* Звонки: тот же список хронологии с одним фильтром, а не вторая копия истории */}
          {cleanClientShowsPanel(clean, mobile, tab, "calls") && (
            <div
              {...(clean ? cleanClientPanelProps("calls") : {})}
              style={{ paddingTop: 20 }}
              ref={(el) => {
                sectionRefs.current.calls = el;
              }}
            >
              {mobile && <div className="sec-t">Звонки</div>}
              {pending && locked ? (
                <p className="state">История и переписка откроются, когда вы примете лид.</p>
              ) : callsCount > 0 ? (
                <InteractionTimeline
                  interactions={interactions.filter((i) => i.type === "CALL")}
                  clientId={client.id}
                  type="CALL"
                  truncated={interactionsTruncated}
                />
              ) : (
                <div className="empty">
                  <span className="ic">
                    <Phone className="i" />
                  </span>
                  <p>Разговоров пока не было.</p>
                  <span className="sub">Звонок из CRM попадёт сюда сам, вместе с записью и итогом.</span>
                </div>
              )}
            </div>
          )}

          {/* Объекты: подбор живёт в панели «Подбор» — второго запроса за списком не заводим */}
          {cleanClientShowsPanel(clean, mobile, tab, "props") && (
            <div
              {...(clean ? cleanClientPanelProps("props") : {})}
              style={{ paddingTop: 20 }}
              ref={(el) => {
                sectionRefs.current.props = el;
              }}
            >
              {mobile && <div className="sec-t">Объекты</div>}
              <div className="empty">
                <span className="ic">
                  <Home className="i" />
                </span>
                <p>
                  {lastPropertiesSent
                    ? `Последняя подборка отправлена ${relativeTime(lastPropertiesSent.at)}, объектов ${lastPropertiesSent.count}.`
                    : "Подборка этому клиенту ещё не отправлялась."}
                </p>
                {matchButton}
              </div>
            </div>
          )}

          {/* История */}
          {cleanClientShowsPanel(clean, mobile, tab, "hist") && (
            <div
              {...(clean ? cleanClientPanelProps("hist") : {})}
              style={{ paddingTop: 20 }}
              ref={(el) => {
                sectionRefs.current.hist = el;
              }}
            >
              {mobile && <div className="sec-t">История</div>}
              {/* До принятия лида история и переписка не приходят с сервера вовсе
                  (routes/clients.ts, gateUntilAccepted — владелец 20.08.2026). Без
                  этой подписи агент увидел бы обычное «Взаимодействий пока нет» и
                  решил, что у клиента и правда пусто. */}
              {pending && locked ? (
                <p className="state">История и переписка откроются, когда вы примете лид.</p>
              ) : (
                <InteractionTimeline
                  interactions={interactions}
                  clientId={client.id}
                  total={client.interactionsTotal}
                  truncated={interactionsTruncated}
                />
              )}
            </div>
          )}
        </div>
      </div>

      {sharedModals}
    </div>
  );
}


/**
 * Похожее описание у другой карточки (владелец 19.08.2026) — не автослияние, просто
 * подсказка: агент сам решает, объединять ли (открывает MergeClientModal уже с
 * готовым вторым клиентом, минуя ручной поиск). Вынесено из тела ClientDetail
 * 25.08.2026: раньше жило только внутри блока «Требования», теперь используется и
 * там (десктоп, без изменений), и внутри MobileActionSheet (телефон, «Ещё» → «Похожая
 * карточка») — общий код, чтобы предупреждение не разошлось между двумя местами.
 */
/**
 * ЧИСЛО ОБЪЕКТОВ ОТ ИИ — ТИХОЙ СТРОКОЙ (владелец 06.09.2026, разбор слепых зон
 * п.3; покупатель добавлен 07.09.2026 — «вдруг решит купить не одну, а две»).
 *
 * «Не агент решает, сколько у клиента объектов — ИИ сам понимает это из разговора
 * и вносит. Агент может оспорить, решение с подтверждением руководителя.»
 *
 * Строка `.quiet`, а не цветная карточка-баннер: правило владельца 03.09.2026 —
 * карточек-уведомлений в интерфейсе нет, даже срочное показывается тихой строкой.
 * Форма спора уезжает в правую шторку, как отклонение заявки в «Архиве», а не
 * разворачивается прямо в карточке: это редкое действие, и место под него в
 * самом читаемом блоке карточки было бы занято всегда.
 *
 * Показываем только когда число по ЭТОЙ роли уже есть — не по `kind`:
 * клиент с dualIntent, ставший покупателем, но всё ещё продающий, должен видеть
 * и строку продавца.
 */
export function PropertyCountRow({ client, role }: { client: Client; role: PropertyCountDisputeRole }) {
  const accountReadOnly = useIsReadOnly();
  const isSeller = role === "SELLER";
  const aiCount = isSeller ? client.sellerDeclaredPropertyCount : client.buyerDesiredPropertyCount;
  const hasCount = aiCount != null;
  const { data } = usePendingPropertyCountDisputes(client.id, hasCount);
  const [open, setOpen] = useState(false);

  if (!hasCount) return null;
  const pending = data?.requests.find((r) => r.role === role);

  return (
    <>
      <div className="quiet">
        <span className="txt">
          ИИ насчитал объектов {isSeller ? "на продажу" : "на покупку"}: <b>{aiCount}</b>
          {pending && ` · заявка на пересмотр (${pending.proposedCount}) ждёт решения руководства`}
        </span>
        {!accountReadOnly && !pending && (
          <button className="pill ghost sm" type="button" onClick={() => setOpen(true)}>
            Оспорить
          </button>
        )}
      </div>
      {!accountReadOnly && open && <PropertyCountDisputeSheet client={client} role={role} onClose={() => setOpen(false)} />}
    </>
  );
}

/** Шторка спора — то же устройство, что у RejectSheet в «Архиве». */
function PropertyCountDisputeSheet({
  client,
  role,
  onClose,
}: {
  client: Client;
  role: PropertyCountDisputeRole;
  onClose: () => void;
}) {
  const accountReadOnly = useIsReadOnly();
  const dispute = useDisputePropertyCount(client.id);
  const [proposedCount, setProposedCount] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (accountReadOnly) return;
    setError(null);
    const n = Number(proposedCount);
    if (proposedCount.trim() === "" || !Number.isInteger(n) || n < 0) {
      setError("Введите целое число, ноль или больше");
      return;
    }
    if (!reason.trim()) {
      setError("Объясните, почему число ИИ неверное");
      return;
    }
    try {
      await dispute.mutateAsync({ role, proposedCount: n, reason: reason.trim() });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось отправить заявку");
    }
  }

  const title = role === "SELLER" ? "Оспорить число объектов на продажу" : "Оспорить число объектов на покупку";

  // Общий корпус окон CRM, а не своя разметка: ловушки фокуса у ручной шторки
  // не было. Кнопки действий остаются в теле, а не переезжают в подвал
  // `.sheet-f`: задача — дать окну ловушку фокуса, а не переверстать его.
  return (
    <Rh2Sheet onClose={onClose} title={title}>
      <p className="sub" style={{ fontSize: "var(--fs-14)", color: "var(--muted)" }}>
        Число меняет не агент, а руководитель — вы предлагаете своё и объясняете почему.
      </p>
      <div className={proposedCount.trim() ? "fld" : "fld bad"} style={{ marginTop: 16 }}>
        <span className="lab">Сколько объектов на самом деле</span>
        <input
          autoFocus
          className="inp"
          type="number"
          min={0}
          max={999}
          value={proposedCount}
          onChange={(e) => setProposedCount(e.target.value)}
        />
      </div>
      <div className={reason.trim() ? "fld" : "fld bad"} style={{ marginTop: 16 }}>
        <span className="lab">Почему число ИИ неверное</span>
        <textarea
          rows={3}
          maxLength={1000}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Увидит руководитель"
        />
      </div>
      {error && (
        <div className="state err" style={{ marginTop: 12 }}>
          <span className="dot crit" />
          {error}
        </div>
      )}
      <div className="act" style={{ marginTop: 20, display: "flex", gap: 8 }}>
        <button className="pill sm" type="button" disabled={dispute.isPending} onClick={() => void submit()}>
          Отправить
        </button>
        <button className="pill ghost sm" type="button" onClick={onClose}>
          Отмена
        </button>
      </div>
    </Rh2Sheet>
  );
}

export function SimilarNotesWarning({
  clients,
  onMerge,
  dismissSimilar,
}: {
  clients: SimilarNotesClient[];
  onMerge: (client: SimilarNotesClient) => void;
  dismissSimilar: ReturnType<typeof useDismissSimilarClient>;
}) {
  /* Тихая строка `.quiet warn` прототипа вместо залитой жёлтой плашки
     (договор §6.1): срочность передаёт точка, а не фон во всю ширину. */
  return (
    <>
      {clients.map((c) => (
        <div className="quiet warn" key={c.id}>
          <span className="dot warn" />
          <span className="txt">
            Похоже на «{formatClientName(c)}» ({formatClientCode(c.shortId, c.kind)}) — заметки совпадают на{" "}
            {Math.round(c.similarity * 100)}%. Может, один человек?
          </span>
          <button className="pill ghost sm" type="button" onClick={() => onMerge(c)}>
            <GitMerge className="i" />
            Сравнить
          </button>
          <button
            className="lnk"
            type="button"
            onClick={() => dismissSimilar.mutate(c.id)}
            disabled={dismissSimilar.isPending}
            title="Это разные люди — больше не предлагать"
          >
            Разные люди
          </button>
        </div>
      ))}
    </>
  );
}

/**
 * Всплывает снизу экрана — телефонный аналог модалки (владелец 25.08.2026, п.
 * «Проверить предложение ИИ»/«Похожая карточка», см. ClientDetail выше): то, что
 * раньше стояло инлайном в блоке «Требования», теперь достаётся по кнопке из «Ещё»
 * и не занимает места, пока не нужно.
 */
function MobileActionSheet({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  /* Общий корпус окон CRM (`Rh2Sheet`), а не своя разметка: у ручной шторки
     `.sheet-back` + `.sheet bottom` не было ни ловушки фокуса, ни Esc, ни
     неподвижного фона. Обе кнопки, открывающие её, живут в мобильном «Ещё»,
     поэтому нижняя подача корпуса совпадает с прежней. */
  return (
    <Rh2Sheet onClose={onClose} title={title}>
      {children}
    </Rh2Sheet>
  );
}

/**
 * Карточка ждёт проверки службы безопасности.
 *
 * Видна всем, кто открыл клиента: это состояние карточки, а не секрет. Кнопки —
 * только у того, у кого есть право выносить решение (clients.securityReview);
 * остальные видят, что вопрос открыт, и не гадают, почему лид никому не передан.
 *
 * Два исхода, и оба закрывают карточку. Разница в том, что остаётся в истории:
 * «вопросов нет» — обычное закрытие, «нарушение подтверждено» — запись, по которой
 * потом разбираются с человеком.
 */
function SecurityReviewPanel({ client }: { client: Client }) {
  const can = useCan();
  const review = useSecurityReview(client.id);
  const [note, setNote] = useState("");
  const [voiceNote, setVoiceNote] = useState<VoiceNote | null>(null);

  return (
    <div className="card tight">
      <div className="quiet warn">
        <ShieldAlert className="i" />
        <span className="txt">
          <b>Закрытие ждёт проверки службы безопасности.</b> Причина закрытия означает, что сделка прошла
          мимо компании. До решения карточка не передаётся другому агенту и не считается закрытой.
        </span>
      </div>
      {can("clients.securityReview") ? (
        <>
          <label className="fld" style={{ marginTop: 12 }}>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={2}
              placeholder="Что установила проверка (необязательно)"
            />
          </label>
          <div style={{ marginTop: 8 }}>
            <VoiceNoteButton uploadUrl="/me/voice-notes" value={voiceNote} onChange={setVoiceNote} />
          </div>
          <div className="wrap" style={{ marginTop: 12 }}>
            <button
              type="button"
              disabled={review.isPending}
              onClick={() =>
                review.mutate({
                  verdict: "CLEARED",
                  note: note.trim() || undefined,
                  noteVoiceUrl: voiceNote?.url,
                  noteVoiceTranscript: voiceNote?.transcript ?? undefined,
                })
              }
              className="pill"
            >
              Проверено, вопросов нет
            </button>
            <button
              type="button"
              disabled={review.isPending}
              onClick={() =>
                review.mutate({
                  verdict: "CONFIRMED",
                  note: note.trim() || undefined,
                  noteVoiceUrl: voiceNote?.url,
                  noteVoiceTranscript: voiceNote?.transcript ?? undefined,
                })
              }
              className="pill ghost"
              style={{ color: "var(--crit)", borderColor: "var(--crit)" }}
            >
              Нарушение подтверждено
            </button>
          </div>
          <MutationError mutation={review} fallback="Не удалось сохранить решение" className="mt-2" />
        </>
      ) : (
        <p className="state">Решение принимает служба безопасности.</p>
      )}
    </div>
  );
}

/**
 * Вина агента в потере клиента — автоматическая классификация с ручным
 * переопределением (docs/spec-compliance, Этап 1). Автоматика смотрит на
 * просрочки на момент потери (lib/clientLossFault.ts); директор видит здесь её
 * вывод и может поправить, если знает то, чего в датах не видно.
 *
 * НЕ рисует ничего, пока не выяснит, что рисовать: нет права — нет и намёка на
 * то, что кнопка вообще существует; нет события — клиент мог уйти без
 * назначенного агента (kind=OTHER, например), и это норма, а не пропуск.
 */
function ClientLossOverridePanel({ clientId }: { clientId: string }) {
  const can = useCan();
  const hasAccess = can("score.clientLossOverride");
  const { data, isLoading } = useClientLossEvent(clientId, hasAccess);
  const event = data?.event;
  const override = useOverrideClientLossEvent(event?.id ?? "");
  const [comment, setComment] = useState("");

  if (!hasAccess || isLoading || !event || event.overridden) return null;

  const otherKind = event.currentKind === "client_lost_agent_fault" ? "client_lost_no_fault" : "client_lost_agent_fault";
  const currentLabel =
    event.currentKind === "client_lost_agent_fault" ? "есть просрочки со стороны агента" : "без просрочек со стороны агента";
  const otherLabel =
    otherKind === "client_lost_agent_fault" ? "есть просрочки со стороны агента" : "без просрочек со стороны агента";

  return (
    <div className="card tight">
      <div className="quiet">
        <ShieldAlert className="i" />
        <span className="txt">
          <b>Royal Score: вина агента в потере клиента.</b> Автоматика определила: «{currentLabel}». Если это
          не так — переопределите вручную, старое начисление отменится, новое запишется, обе записи
          останутся в журнале.
        </span>
      </div>
      <label className="fld" style={{ marginTop: 12 }}>
        <textarea
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          rows={2}
          placeholder="Почему автоматика ошиблась (необязательно, попадёт в журнал)"
        />
      </label>
      <button
        className="pill ghost"
        style={{ marginTop: 12 }}
        type="button"
        disabled={override.isPending}
        onClick={() => override.mutate({ override: otherKind, comment: comment.trim() || undefined })}
      >
        Переопределить: {otherLabel}
      </button>
      <MutationError mutation={override} fallback="Не удалось переопределить" className="mt-2" />
    </div>
  );
}

/**
 * Ручная правка статуса — запасной путь, а не основной.
 *
 * Статус ставится автоматически по событиям (см. apps/api/src/lib/clientAutoStatus.ts),
 * и в 95% случаев трогать его не нужно. Но автоматика знает не всё: клиент мог
 * сказать агенту то, чего нет ни в звонке, ни в переписке. Поэтому правка
 * доступна — маленькой ссылкой, которая разворачивает список, а не постоянным
 * селектором, притягивающим взгляд и требующим решения на каждом заходе.
 *
 * После ручной правки автоматика неделю не вмешивается — об этом сказано прямо
 * в подсказке, чтобы человек не гадал, «переставится ли обратно».
 */
/**
 * Звонок голосовым роботом (28.09.2026) — шторка из меню «Ещё». Робот сам
 * набирает клиента и говорит с ним; при выбранном объекте рассказывает о нём.
 * Список объектов — тот же, что у подбора клиента (usePropertyPickerOptions),
 * «Без объекта» по умолчанию. Отказ сервера (нет права, линии, номера, идущий
 * звонок) приходит словами и показывается прямо здесь.
 */
function LiveVoiceCallSheet({ clientId, onClose }: { clientId: string; onClose: () => void }) {
  const [propertyId, setPropertyId] = useState("");
  const call = useLiveVoiceCall(clientId);
  // Поиск объекта по номеру/слову (05.10.2026): первые 20 свободных — не весь каталог.
  const [propertyQuery, setPropertyQuery] = useState("");
  const propertyQ = useDebouncedValue(propertyQuery.trim(), 250);
  const picker = usePropertyPickerOptions(clientId, propertyQ);
  const pickerList = picker.properties ?? [];
  // Выбранный объект остаётся в списке, даже когда новый поиск его не вернул.
  const chosenMissing = !!propertyId && !pickerList.some((p) => p.id === propertyId);
  const chosen = useProperty(chosenMissing ? propertyId : undefined);
  const pickerOptions = chosenMissing && chosen.data ? [chosen.data, ...pickerList] : pickerList;

  if (call.isSuccess) {
    return (
      <Rh2Sheet
        title="Звонок роботом"
        onClose={onClose}
        footer={
          <button className="pill" type="button" onClick={onClose}>
            Готово
          </button>
        }
      >
        <p className="cd-note">Робот набирает клиента. В хронологии карточки появилась запись о звонке; расшифровка и запись разговора — в разделе «Звонки», в списке живого голоса.</p>
      </Rh2Sheet>
    );
  }

  return (
    <Rh2Sheet
      title="Звонок роботом"
      onClose={onClose}
      onSubmit={() => call.mutate(propertyId || null)}
      footer={
        <>
          <button className="pill" type="submit" disabled={call.isPending}>
            <Phone className="i" />
            {call.isPending ? "Соединяю…" : "Позвонить"}
          </button>
          <button className="pill ghost" type="button" disabled={call.isPending} onClick={onClose}>
            Отмена
          </button>
        </>
      }
    >
      <p className="cd-note">
        Голосовой помощник сам наберёт клиента, представится и поговорит. Агент в разговоре не участвует.
      </p>
      <div className="cd-fld">
        <label htmlFor={`live-voice-property-${clientId}`}>О каком объекте рассказать</label>
        <input
          type="search"
          className="inp"
          value={propertyQuery}
          disabled={call.isPending}
          onChange={(e) => setPropertyQuery(e.target.value)}
          placeholder="Номер ОБ-…, название или адрес"
          aria-label="Поиск объекта"
        />
        <select
          id={`live-voice-property-${clientId}`}
          className="inp"
          value={propertyId}
          disabled={call.isPending}
          onChange={(e) => setPropertyId(e.target.value)}
        >
          <option value="">Без объекта</option>
          {pickerOptions.map((p) => (
            <option key={p.id} value={p.id}>
              {`№${p.shortId} · ${p.title}${p.district?.name ? `, ${p.district.name}` : ""}`}
            </option>
          ))}
        </select>
      </div>
      <MutationError mutation={call} variant="rh2" fallback="Робот не смог позвонить. Попробуйте позже." />
    </Rh2Sheet>
  );
}

/**
 * Выбор типа карточки (Покупатель / Продавец / Прочее) — шторка из меню «Ещё».
 * Выбор не применяется сразу: он уходит в общее подтверждение смены типа
 * (kindChangeTarget), где сказано, что произойдёт с карточкой.
 */
function ClientKindSheet({
  current,
  onPick,
  onClose,
}: {
  current: ClientKind;
  onPick: (kind: ClientKind) => void;
  onClose: () => void;
}) {
  return (
    <Rh2Sheet title="Тип карточки" onClose={onClose}>
      <p className="cd-note">Если ИИ определил направление неверно, поправьте. Держатель карточки получит уведомление.</p>
      <div className="cd-menu">
        <div className="cd-mg" role="radiogroup" aria-label="Тип карточки">
          {CLIENT_KINDS.map((k) => (
            <button
              key={k}
              type="button"
              role="radio"
              aria-checked={k === current}
              className="cd-mi"
              onClick={() => (k === current ? onClose() : onPick(k))}
            >
              <span className="cd-mi-t">
                <b>{CLIENT_KIND_LABELS[k]}</b>
              </span>
              {k === current && <CircleCheck className="i cd-mi-ok" aria-hidden="true" />}
            </button>
          ))}
        </div>
      </div>
    </Rh2Sheet>
  );
}
