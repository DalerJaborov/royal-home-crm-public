import { useCleanShell } from "../hooks/useCleanShell";
import { CleanPropertyDetailHeader, CleanPropertyDetailLayout, CleanPropertyDetailSkeleton, CleanPropertySlot, CleanPropertySummary, cleanPropertyDetailScale } from "../components/clean/CleanPropertyDetailLayout";
import { useLegacyAgentMobile } from "../hooks/useLegacyAgentMobile";
import { LegacyAgentPropertyView } from "../components/mobile/LegacyAgentPropertyView";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ChevronLeft, MoreHorizontal } from "lucide-react";
import { useDebouncedValue } from "../hooks/useDebouncedValue";
import { useRetryKey } from "../hooks/useRetryKey";
import { RequestChangeSlot } from "../components/RequestChangeSlot";
import { agentReelLinkClosed, isInstagramLink, MIN_PROPERTY_PHOTOS, PROPERTY_EDIT_LOCKED_MESSAGE, propertyEditLocked, propertyFieldShown, propertyFinishSummary } from "@royal-home/shared";
import { useCan, useIsReadOnly } from "../lib/permissions";
import { floorsMismatch } from "../lib/descriptionFloors";
import { propertyParams } from "../lib/propertyParams";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { ApiError } from "../lib/apiError";
import { MutationError } from "../components/MutationError";
import {
  useApprovePropertyMaterial,
  useCompleteEditing,
  useDeleteProperty,
  useProperty,
  useRegenerateReelsCaption,
  useRejectPropertyMaterial,
  useSyncToSite,
  useUpdateProperty,
  useFinishPropertyEdit,
  finishEditSummary,
  usePropertyVideos,
} from "../hooks/useProperties";
import { dushanbeDayKey, PROPERTY_PIPELINE_STATUSES, type PropertyStatus } from "@royal-home/shared";
import { formatPropertyCode } from "../lib/clientFormat";
import { propertyStatusOptions } from "../lib/propertyStatusOptions";
import { statusChipClass, statusChipLabel } from "../lib/theme2026";
import { useClients } from "../hooks/useClients";
import { useCreateDeal } from "../hooks/useDeals";
import { useAgents, type AgentListItem } from "../hooks/useAgents";
import { useGenerateListing } from "../hooks/useAi";
import { useAuthStore } from "../store/auth";
import { toast } from "../store/toast";
import { VoiceNoteButton, type VoiceNote } from "../components/VoiceNoteButton";
import { VoiceNotePlayer } from "../components/VoiceNotePlayer";
import { PropertyAdBadge } from "../components/ads/PropertyAdBadge";
import { PropertyPhotoManager } from "../components/PropertyPhotoManager";
import { PropertyVideoManager } from "../components/PropertyVideoManager";
import { PropertyClipVideoCard } from "../components/PropertyClipVideoCard";
import { PropertyCardSkeleton } from "../components/rh2/Skeleton";
import { PropertyShareOpensCard } from "../components/PropertyShareOpensCard";
import { MatchPanel } from "../components/match/MatchPanel";
import { PropertyHistoryCard } from "../components/PropertyHistoryCard";
import { PhoneInput } from "../components/FormField";
import { ShareButton } from "../components/ShareButton";
import { RequestDeletePropertyModal } from "../components/RequestDeletePropertyModal";
import { PropertyChangeRequestCard } from "../components/PropertyChangeRequestCard";
import { changeRequestMode } from "../lib/propertyChangeRequestView";
import { usePendingPropertyDeleteRequest, type PendingPropertyDeleteRequest } from "../hooks/useDeleteRequests";
import { useChannelsStatus } from "../hooks/useMarketing";
import { useTikTokManualPublish } from "../hooks/useTikTok";
import { ShowingQuickForm } from "../components/ShowingQuickForm";
import { PropertyGallery } from "../components/property/PropertyGallery";
import { PropertyPriceCard } from "../components/property/PropertyPriceCard";
import { PropertyActionSheet, type ActionSheetItem } from "../components/property/PropertyActionSheet";
import { Button } from "../components/rh2/Button";
import { Card } from "../components/rh2/Card";
import { PageHeader } from "../components/rh2/PageHeader";
import { List, Row } from "../components/rh2/Row";
import { Rh2Screen } from "../components/rh2/Rh2Screen";
import { Tabs, type TabOption } from "../components/rh2/Tabs";
import { videoStageLine } from "../lib/propertyVideoStage";
import { propertyStageChip } from "../lib/propertyStageChip";
import { Chip } from "../components/rh2/Chip";
import { formatMoney, pluralizeRu, PROPERTY_CONDITION_LABELS, PROPERTY_STATUS_LABELS, PROPERTY_TYPE_LABELS, relativeTime } from "../lib/format";
import { dushanbeDate } from "../lib/date";
import type { Client, Property } from "../types";
import { AgentVideoStatus, PropertyVideoFixCard, FacebookGroupShareBlock, RepostBlock, SocialExtrasBlock } from "../components/PropertyVideoFixCard";
import { canMarkFacebookGroupShare } from "../lib/groupShareAccess";
import { acceptedDateToSave } from "../lib/acceptedDate";
import { PropertyCoverStatus } from "../components/PropertyCoverStatus";
import { PropertyPeople } from "../components/PropertyPeople";
import { PropertyOwnerCard } from "../components/PropertyOwnerCard";
import { PropertyDocumentsCard, PropertyDocumentsField } from "../components/PropertyDocuments";
import { PropertyStatsCard } from "../components/PropertyStatsCard";
import { PropertyVoiceCard, PropertyVoiceDisclosure } from "../components/PropertyVoiceCard";
import { PropertyPriceDemandCard } from "../components/PropertyPriceDemandCard";
import { OwnerReportCard } from "../components/OwnerReportCard";
import { moderationVisible, pipelineHintsVisible, sitePublishVisible, solveHasContent, tiktokVisible } from "../lib/propertySolve";

/**
 * Что можно выбрать в селекторе статуса.
 *
 * Состояния конвейера подготовки идут первыми и только пока объект в нём: у
 * проданной квартиры выбор «Ждём фото» — это не возможность, а способ сломать
 * себе отчёт. Обратный список тоже несимметричен: объект, вышедший в продажу,
 * назад в конвейер не возвращается — для доработки есть «Снято с продажи».
 *
 * «РЕЗЕРВ» И «ПРОДАНО» РУКАМИ НЕ СТАВЯТСЯ (08.08.2026). Их ставит сделка:
 * заведена — резерв, завершена — продано, отменена — снова в продаже (см.
 * routes/deals.ts и lib/propertyAutoStatus.ts). Выбор их руками означал ровно
 * одно — объект уходил из продажи, а сделки под ним не было: комиссия не
 * считалась, доля агента не начислялась, отчёт по продажам не сходился с
 * карточками. Сервер такие правки уже отвергал при открытой сделке (409), но
 * когда сделки не было вовсе — молча принимал.
 */
/** Состояния, которыми распоряжается сделка, а не человек. */
const DEAL_DRIVEN_STATUSES = ["RESERVED", "SOLD"] as const;

/**
 * Ведёт ли этот человек объект: тот же набор, что `canManageProperty` на сервере
 * (routes/properties/shared.ts): право правки чужих объектов, ответственный,
 * интейкер или создатель карточки. Одна функция на карточку и на запросы, которые
 * сервер отдаёт только этому кругу (`/videos`, `/delete-request`): запрос от
 * постороннего это 403 в консоли на каждое открытие чужой карточки (06.10.2026).
 */
function leadsProperty(
  property: Pick<Property, "assignedAgent" | "intakeAgentId" | "createdById"> | undefined,
  can: ReturnType<typeof useCan>,
  agentId: string | undefined,
): boolean {
  if (!property) return false;
  return (
    can("properties.editForeign") ||
    property.assignedAgent?.id === agentId ||
    property.intakeAgentId === agentId ||
    property.createdById === agentId
  );
}

export function PropertyDetail() {
  const { id } = useParams();
  const location = useLocation();
  // Хук прав — вместе с остальными хуками, ДО ранних возвратов: ниже по коду
  // есть выходы «Загрузка…» и «Объект не найден», и вызов после них ломал порядок
  // хуков React — карточка объекта падала целиком.
  const can = useCan();
  const readOnly = useIsReadOnly();
  const role = useAuthStore((s) => s.agent?.role);
  const agentId = useAuthStore((s) => s.agent?.id);
  const { data: property, isLoading, isError, error: propertyError, refetch: refetchProperty } = useProperty(id);
  const clean = useCleanShell();
  /**
   * Заявка на удаление объекта (31.08.2026, зеркало ClientDetail.tsx) — хук
   * вызван здесь, ДО ранних возвратов ниже (isLoading/isError/!property), по
   * тому же правилу, что и остальные хуки в этом компоненте: порядок хуков
   * React не должен зависеть от того, что именно вернул сервер.
   */
  const canRequestDeletePropertyPerm = can("properties.requestDelete");
  // Чужому объекту (не ведёт, нет права править чужие) сервер на `/delete-request`
  // отвечает 403: запрос не отправляем, а кнопки «Направить на удаление» у него нет.
  const { data: propertyDeleteRequestState } = usePendingPropertyDeleteRequest(
    property?.id,
    !!property &&
      !property.deletedAt &&
      (canRequestDeletePropertyPerm || can("properties.delete")) &&
      leadsProperty(property, can, agentId)
  );
  const pendingPropertyDeleteRequest = propertyDeleteRequestState?.request ?? null;
  // Роут теперь короткий числовой shortId (/properties/1042) — мутации адресуют
  // настоящий UUID с уже загруженной карточки, а не парсят его заново из URL.
  const updateProperty = useUpdateProperty(property?.id ?? "");
  const finishEdit = useFinishPropertyEdit(property?.id ?? "");
  /** «Готово» у блока карточки: разослать обновлённую подпись и сайт (владелец
   *  23.09.2026). Блок закрывается сразу — рассылка идёт следом и отчитывается
   *  всплывашкой; сервер сам не ходит в соцсети, если с прошлого раза ничего не
   *  поменяли. */
  const finishInlineEdit = () => {
    finishEdit.mutate(undefined, {
      onSuccess: (r) => {
        const text = finishEditSummary(r);
        if (text) toast.success(text);
      },
      onError: () => toast.error("Правки сохранены, но подписи в соцсетях обновить не удалось"),
    });
  };
  // Кто реально ведёт клиентов и сделки по объекту — директор, админ, менеджер,
  // агент. Маркетинг и монтажёр видят все объекты (конвейер подготовки), но у
  // них нет ни своих клиентов, ни права clients.viewAll — блок «Назначить
  // клиенту» им ни к чему (см. тот же разбор ролей в Sidebar.tsx). СБ видит
  // клиентов и сделки целиком, но только чтобы проверять причины закрытия, не
  // менять их — создавать сделку из карточки объекта не её работа.
  const canManageDealsForProperty =
    !readOnly && role !== "MARKETING" && role !== "EDITOR" && role !== "SECURITY";
  // Покупатели для сделки теперь ищутся на сервере прямо в AssignClientCard
  // (05.10.2026): справочник «первые 200» не находил остальных. Блок монтируется
  // только для ролей с доступом к клиентам (canManageDealsForProperty), так что
  // 403 для маркетинга/монтажёра/СБ по-прежнему не уходит.
  // Справочник агентов нужен только руководителю (селект «Ответственный агент»).
  // Безусловный вызов давал рядовому агенту 403 при каждом открытии карточки объекта
  // и писал ошибку в журнал — из-за него журнал ошибок наполнялся мусором.
  //
  // Условие — ПРАВО, а не «роль не AGENT»: маркетинг и монтажёр тоже не AGENT и
  // тоже без доступа к справочнику, поэтому они получали тот же 403 на каждое
  // открытие карточки, а селект «Ответственный агент» рисовался пустым — с одним
  // пунктом «— Не назначен —», выбрать в нём было нечего. Те же три права
  // перечислены у GET /api/v1/agents (routes/agents.ts).
  //
  // Сам селект — только руководству (владелец 02.10.2026, «да, по советам»): кто
  // ведёт объект, меняет тот, кто правит чужие объекты И распределяет работу,
  // как и на сервере (routes/properties/shared.ts::canReassignPropertyAgents).
  // Раньше селект видела и СБ (team.viewFull) — сохранить его она всё равно не
  // могла; у маркетинга и монтажёра сервер поле молча отбрасывает.
  const canListAgents = can("agents.manage") || can("clients.assign") || can("team.viewFull");
  const canAssignAgent = canListAgents && can("properties.editForeign") && can("clients.assign");
  const { data: agents } = useAgents({ enabled: canAssignAgent });
  const navigate = useNavigate();
  /**
   * «Завершить сделку» на карточке клиента приводит сюда через
   * `navigate(..., { state: { openDealAssign, clientId } })`
   * (CloseDealChoiceModal.tsx) именно затем, чтобы агент увидел форму
   * «Назначить клиенту» сразу, без ручного клика по карандашу «Изменить» —
   * без этого блок ниже (`canManageDealsForProperty`) вообще не
   * рисовался, и переход с карточки клиента утыкался в пустую страницу
   * просмотра (жалоба владельца 18.09, клиент Умед/ОБ-000086). Эффект, а не
   * инициализатор `useState`, потому что `location.state` появляется уже
   * после первого рендера этого маршрута (React Router кладёт его в history
   * до монтирования, но читать его нужно на каждый заход с новым state, а не
   * только на самый первый рендер компонента).
   */
  const dealAssignState = location.state as { openDealAssign?: boolean; clientId?: string; clientName?: string } | null;
  // С 23.09.2026 блок сделки виден и в просмотре (см. AssignClientCard ниже),
  // поэтому режим правки ради него больше не включается: раньше переход
  // «Сделка» с карточки клиента открывал чужой объект в режиме правки. Здесь
  // только подводим экран к форме.
  useEffect(() => {
    if (!dealAssignState?.openDealAssign) return;
    const t = window.setTimeout(
      () => document.getElementById("deal-assign")?.scrollIntoView({ behavior: "smooth", block: "center" }),
      300
    );
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dealAssignState?.openDealAssign]);

  // Ссылка по настоящему id (пуши «Новый ролик на монтаж» и др., аудит
  // 23.09.2026 №12) — после загрузки адрес заменяется на короткий номер.
  useEffect(() => {
    if (property && id && id !== String(property.shortId)) {
      navigate(`/properties/${property.shortId}${location.search}${location.hash}`, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [property, id]);

  if (isLoading) return clean ? <CleanPropertyDetailSkeleton /> : <PropertyCardSkeleton />;
  /**
   * ОТКАЗ СЕТИ ≠ «ОБЪЕКТ УДАЛИЛИ» (найдено аудитом 22.08.2026, тот же баг, что
   * в ClientDetail.tsx). Любой отказ запроса — не только настоящий 404 — падал
   * в ветку «Объект не найден» ниже без разбора причины.
   */
  const notFoundError = isError && propertyError instanceof ApiError && propertyError.status === 404;
  /**
   * 403 — ДРУГАЯ ПРИЧИНА, ЧЕМ 404, и текст обязан её называть (docs/TASKS.md,
   * Пачка D): объект существует, но именно этому сотруднику его смотреть
   * нельзя. Раньше любой отказ, кроме 404, падал в общее «не удалось
   * загрузить» с намёком проверить соединение — человек лез перезагружать
   * страницу и разбираться с сетью там, где дело было в правах.
   */
  const forbiddenError = isError && propertyError instanceof ApiError && propertyError.status === 403;
  if (isError && !notFoundError && !forbiddenError) {
    return (
      <PropertyDeadEnd
        title="Не удалось загрузить объект"
        hint={propertyError instanceof Error ? propertyError.message : "Проверьте соединение и попробуйте ещё раз."}
        action={
          <button className="pill ghost" type="button" onClick={() => refetchProperty()}>
            Повторить
          </button>
        }
      />
    );
  }
  if (forbiddenError) {
    return (
      <PropertyDeadEnd
        title="Нет доступа"
        hint="У вас нет прав смотреть этот объект. Если это ошибка, обратитесь к руководителю."
        action={
          <Link className="pill ghost" to="/properties">
            К объектам
          </Link>
        }
      />
    );
  }
  // Тот же тупик, что и в карточке клиента: серая строка без выхода. Сюда
  // попадают по ссылке из ленты правок сайта или из переписки с ботом.
  if (!property)
    return (
      <PropertyDeadEnd
        title="Объект не найден"
        hint="Его могли удалить или снять с продажи. Удалённые объекты лежат в корзине раздела «Архив», оттуда их можно вернуть."
        action={
          <Link className="pill ghost" to="/properties">
            К объектам
          </Link>
        }
      />
    );

  // Условие совпадает с серверным canManageProperty: агент правит объект, если он
  // назначенный риелтор ИЛИ принял объект. Раньше проверялся только назначенный, а
  // он появляется лишь в момент сделки — свежезаведённый объект агент не мог
  // отредактировать вообще, хотя сервер это разрешал.
  // Объект в корзине открывается только для просмотра: посмотреть, что именно
  // восстанавливаешь. Публиковать его на сайт, заводить по нему сделку или
  // править поля бессмысленно — он не существует ни в одном списке.
  const isTrashed = !!property.deletedAt;


  // Монтажёру — урезанная карточка (решение владельца 17.08.2026): ему не нужны
  // ни фотографии объекта, ни контакт владельца, ни документы, ни история цены —
  // только сырое видео, параметры объекта для наложения на ролик, ответственный
  // агент и поля, которые монтажёр сам заполняет (ссылка на Reels, подпись,
  // «Готово»). Полная карточка ниже писалась для риелтора и маркетинга и тащит
  // за собой блоки, монтажёру не нужные и по спецификации закрытые.
  if (role === "EDITOR") {
    return (
      <EditorPropertyDetail property={property} isTrashed={isTrashed} updateProperty={updateProperty} navigate={navigate} />
    );
  }

  // Тот же набор людей, что и canEdit, но без исключения корзины — историю
  // своего объекта агент вправе видеть и после того, как объект удалили.
  // Тот же набор, что canManageProperty на сервере (routes/properties/shared.ts):
  // право правки чужих объектов, ответственный, интейкер или создатель карточки.
  // Раньше здесь стояло «не агент», и часть ролей видела кнопку и получала отказ,
  // а агент, который сам завёл объект, кнопки не видел вовсе.
  const isResponsibleForProperty = leadsProperty(property, can, agentId);
  const canEdit = !readOnly && !isTrashed && isResponsibleForProperty;
  // Замок после публикации — правило одно с сервером (@royal-home/shared).
  // До публикации (проверка, монтаж) агент правит свободно, монтажёр и модератор
  // получают уведомление об изменении.
  const editLocked = canEdit && propertyEditLocked(property, can("properties.editForeign"));
  // Права, а не роли: директор раздаёт их галочками, и сотрудник с выданным правом
  // должен видеть кнопку, а менеджер без него — не должен (сервер всё равно откажет).
  const canPublish = !isTrashed && can("properties.publish");
  // Объект ещё в конвейере подготовки — публиковать его сервер не даст (409).
  const inPipeline = (PROPERTY_PIPELINE_STATUSES as readonly string[]).includes(property.status);
  const canDelete = !isTrashed && can("properties.delete");
  /**
   * Заявка на удаление объекта (31.08.2026, зеркало ClientDetail.tsx) — тому,
   * кто и так может удалить сам (canDelete), просить не у кого. Сам запрос
   * (usePendingPropertyDeleteRequest) вызван ВЫШЕ, до ранних возвратов — правило
   * хуков React не позволяет вызывать его здесь, после трёх `if (...) return`.
   */
  // Чужому объекту заявка тоже недоступна: сервер просит, чтобы заявку заводил тот,
  // кто объект ведёт (routes/properties/deleteRequests.ts), иначе была кнопка с 403.
  const canRequestDeleteProperty =
    !isTrashed && canRequestDeletePropertyPerm && !canDelete && isResponsibleForProperty;
  // Статусом распоряжается сделка — селектор здесь показывать нечестно (см.
  // DEAL_DRIVEN_STATUSES наверху файла).
  const isDealDriven = (DEAL_DRIVEN_STATUSES as readonly string[]).includes(property.status);

  /* Ссылки «открыть в Яндекс/Google/2ГИС» с карточки убраны (решение владельца
     11.09.2026). Точку объекта CRM теперь ставит сама — мастером добавления на
     своей карте OpenStreetMap, — и уводить агента в чужое приложение, чтобы
     посмотреть то, что он только что отметил, незачем. Координаты по-прежнему
     хранятся в lat/lng и показываются общей картой объектов. */

  /**
   * ОДНА КАРТОЧКА (пункт 17 разбора, 24.09.2026). Раньше у объекта было два
   * экрана: просмотр (PropertyViewCard, решение владельца 23.08.2026 «хочу
   * отдельно, красиво, как на сайте») и режим правки — та же страница другой
   * раскладкой, куда вела кнопка «Редактировать»; человек нажимал её и терял,
   * где что. Теперь правка — на месте: у каждого блока своя кнопка «Изменить»
   * и «Готово», а форма параметров (цена, площадь, адрес) — отдельной страницей
   * `/properties/:id/edit`, как и была.
   */
  return (
    <PropertyViewCard
      clean={clean}
      property={property}
      can={can}
      canEdit={canEdit}
      editLocked={editLocked}
      canPublish={canPublish}
      inPipeline={inPipeline}
      isDealDriven={isDealDriven}
      isTrashed={isTrashed}
      isResponsibleForProperty={isResponsibleForProperty}
      onEditParams={() => navigate(`/properties/${property.shortId}/edit`)}
      onInlineDone={finishInlineEdit}
      canAssignAgent={canAssignAgent}
      agents={agents}
      canSchedule={canManageDealsForProperty && !isTrashed && !["SOLD", "WITHDRAWN"].includes(property.status)}
      dealSlot={
        canManageDealsForProperty && !isTrashed && !["SOLD", "WITHDRAWN"].includes(property.status) ? (
          <AssignClientCard
            property={property}
            preselectClientId={dealAssignState?.clientId}
            preselectClientName={dealAssignState?.clientName}
          />
        ) : null
      }
      deleteMode={canDelete ? "delete" : canRequestDeleteProperty ? "request" : null}
      pendingDeleteRequest={pendingPropertyDeleteRequest}
    />
  );
}

/**
 * Просмотр объекта — отдельно нарисованная карточка (решение владельца
 * 23.08.2026: «хочу отдельно, красиво, как на сайте»), а не форма редактирования
 * с отключёнными полями. По умолчанию видит любой, у кого canEdit — единственное
 * действие в её сторону кроме рабочего процесса (модерация/публикация/«Готово»,
 * см. MaterialsModerationCard/SitePublishToggle/CompleteEditingButton — им
 * режим просмотра не мешает) — кнопка «Редактировать», переводящая на полную
 * форму (return ниже в PropertyDetail). С 06.10.2026 дерево одно на ПК и телефон:
 * фото-лента (`PropertyGallery`) показана один раз и выглядит как витрина
 * объявления, а не как список файлов с кнопками удаления.
 */
/**
 * Строка «где это» в шапке карточки — честная, без выдумывания. Закрытый
 * объект («только для своих», владелец 14.09.2026) может остаться без района
 * и/или адреса, если координаты с телефона агента не определились или сервер
 * не смог найти по ним ни улицу, ни район (lookupGeoPoint, routes/properties/
 * crud.ts) — тогда показываем то, что реально есть, а не склеенную строку с
 * дырой из null/undefined.
 */
function placeLine(property: Property): string {
  const district = property.district?.name;
  const address = property.address;
  const base = district && address ? `${district}, ${address}` : district || address || "Адрес не указан";
  // Ориентир — короткой припиской к строке адреса/района (пункт 10 владельца,
  // 23.09.2026), а не отдельным полем шапки: он всегда дополняет адрес, никогда
  // не заменяет его, и на телефоне/десктопе шапка использует одну и ту же строку.
  return property.landmark ? `${base} — ${property.landmark}` : base;
}

/**
 * Тихое предупреждение (§6.1 договора дизайна — `.quiet`, без цветных
 * баннеров, решение владельца 03.09.2026): у объекта нет ни адреса, ни
 * района — он не попадёт ни на карту, ни в «Подбор объекта», ни в поиск по
 * улице (owner: «сделай так, чтобы не было никаких минусов» — минус остаётся
 * ровно до тех пор, пока адрес не заполнят). Ссылка ведёт в ту же форму
 * редактирования, что и кнопка «Редактировать».
 */
function MissingAddressNotice({ onEdit }: { onEdit: (() => void) | null }) {
  return (
    <div className="quiet" data-testid="missing-address-notice">
      <span className="dot" />
      <span className="txt">
        Нет адреса и района — объект не виден на карте и не участвует в подборе покупателю.
        {onEdit && (
          <>
            {" "}
            <button type="button" className="lnk" onClick={onEdit}>
              Заполнить адрес
            </button>
          </>
        )}
      </span>
    </div>
  );
}

/** Почему кнопки правки нет (владелец 07.10.2026): объект опубликован, править его
 *  может только директор или админ; агенту остаётся заявка (слот ниже). */
function EditLockedNotice() {
  return (
    <>
      <div className="quiet" data-testid="property-edit-locked">
        <span className="dot" />
        <span className="txt">{PROPERTY_EDIT_LOCKED_MESSAGE}</span>
      </div>
      <RequestChangeSlot href="#change-requests" />
    </>
  );
}

/** Вкладки нижней части карточки (контракт 06.10.2026: три общих, две только ответственному). */
type PropertyTab = "short" | "media" | "hist" | "stats" | "voice";

/** Прокрутить к блоку после того, как он появился (вкладка переключилась, правка открылась). */
function jumpTo(id: string) {
  window.setTimeout(() => document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" }), 60);
}

function PropertyViewCard({
  clean,
  property,
  can,
  canEdit: canEditAny,
  editLocked,
  canPublish,
  inPipeline,
  isDealDriven,
  isTrashed,
  isResponsibleForProperty,
  canSchedule,
  onEditParams,
  onInlineDone,
  dealSlot,
  deleteMode,
  pendingDeleteRequest,
  canAssignAgent,
  agents,
}: {
  clean: boolean;
  /** Блок «Сделка по объекту» (AssignClientCard) — в просмотре, а не только
   *  в режиме правки (23.09.2026): иначе агент не видел, где заводится сделка. */
  dealSlot?: ReactNode;
  property: Property;
  can: ReturnType<typeof useCan>;
  canEdit: boolean;
  /** Объект опубликован — вход в правку закрыт (propertyEditLocked). Статус
   *  (зарезервирован / продан / снят) и рабочие шаги конвейера остаются. */
  editLocked: boolean;
  canPublish: boolean;
  inPipeline: boolean;
  isDealDriven: boolean;
  isTrashed: boolean;
  isResponsibleForProperty: boolean;
  /** «Назначить показ» главной кнопкой: тем, кто ведёт клиентов, и пока объект
   *  в продаже (не в архиве, не продан и не снят). */
  canSchedule: boolean;
  /** Форма параметров объекта (цена, площадь, адрес) — отдельная страница. */
  onEditParams: () => void;
  /** «Готово» у блока: разослать подпись в соцсети и сайт (finish-edit). */
  onInlineDone: () => void;
  /** Что умеет этот человек с удалением: удалить сам, попросить директора или ничего. */
  deleteMode: "delete" | "request" | null;
  /** Заявка на удаление уже подана и ждёт решения (вместо кнопки «Направить»). */
  pendingDeleteRequest: PendingPropertyDeleteRequest | null;
  /** Для правки «Кто ведёт объект» прямо в просмотре (пункт 17 разбора). */
  canAssignAgent: boolean;
  agents: AgentListItem[] | undefined;
}) {
  // Кнопки входа в правку закрыты после публикации; остальное, что гейтит canEdit
  // (просмотр видео, ссылки клиентам, «Завершить монтаж»), от замка не зависит.
  const accountReadOnly = useIsReadOnly();
  const canEdit = canEditAny && !accountReadOnly;
  const canEnterEdit = canEdit && !editLocked;
  // «Выложено»/«Отменить» в раздаче по группам — по правилу сервера, а не по
  // общему canEdit (F9, 02.10.2026): менеджер с правом правки чужих объектов и
  // назначенный агент при заполненном интейкере видели кнопки и получали 403.
  const myRole = useAuthStore((s) => s.agent?.role);
  const myId = useAuthStore((s) => s.agent?.id);
  const canMarkGroupShare = !accountReadOnly && !isTrashed && canMarkFacebookGroupShare(myRole, myId, property);

  const legacyAgentMobile = useLegacyAgentMobile();
  const photos = property.photos ?? [];
  // ОДНА КАРТОЧКА НА ПК И ТЕЛЕФОН (контракт 06.10.2026, раздел 6). Раньше было две
  // раскладки (`useMobileUx()` рисовал отдельное дерево с лентой, плитками и
  // стопкой секций), и всё, что добавляли на одну, было невидимо на другой.
  // Теперь дерево одно, две колонки на ПК и столбик на телефоне делает CSS
  // (`.rh-pcard`, theme-royal-home-2026.css), блоки идут в порядке «объявления»:
  // фото, цена и действия, кто ведёт, ролик, что решить, описание; редкое
  // (сведения, документы, фото и видео, история, статистика) вкладками ниже.
  // `?tab=stats` — ссылка из «Объекты, которым нужна помощь» (Обзор маркетинга):
  // открывает карточку сразу на «Статистике», но только тому, кому вкладка видна.
  const { search } = useLocation();
  // Единая панель заявок: агент просит, руководство с нужным правом решает.
  const changeRequestBlock = (
    <div id="change-requests">
      <PropertyChangeRequestCard
        property={property}
        mode={changeRequestMode({
          status: property.status,
          isTrashed,
          isResponsible: isResponsibleForProperty,
          canRequest: can("properties.requestChange"),
          canDecide: can("properties.delete"),
        })}
        highlightId={new URLSearchParams(search).get("changeRequest")}
      />
    </div>
  );
  const [tab, setTab] = useState<PropertyTab>(() => {
    const wanted = new URLSearchParams(search).get("tab");
    return (wanted === "stats" || wanted === "voice") && isResponsibleForProperty ? wanted : "short";
  });
  // Панель «Подбор» модалкой (строка «Ждут N покупателей · Предложить»).
  const [matchOpen, setMatchOpen] = useState(false);
  const [showingOpen, setShowingOpen] = useState(false);
  const [editMenuOpen, setEditMenuOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [requestDeleteOpen, setRequestDeleteOpen] = useState(false);
  const daysSinceAccepted = Math.max(
    0,
    Math.floor((Date.now() - new Date(property.listingAcceptedAt ?? property.createdAt).getTime()) / 86_400_000),
  );
  // «Решить сейчас» — только когда в блоке есть что показать (lib/propertySolve.ts):
  // у агента на объекте в продаже от блока оставался один заголовок.
  const role = useAuthStore((s) => s.agent?.role);
  const marketingRole = role === "MARKETING" || role === "DIRECTOR" || role === "ADMIN";
  const { data: channelsStatus } = useChannelsStatus(marketingRole);
  // Статус меняется и из просмотра (24.09.2026, пункт 5 разбора): тем же, кому
  // открыта правка, и тем же списком, что в правке.
  const updateProperty = useUpdateProperty(property.id);
  // «Ещё» на телефоне живёт в шапке оболочки (контракт: назад, «Объект №24», «Ещё»),
  // на компьютере кнопкой в карточке цены. Один узел, `useMemo`: шапка перезаписывает
  // заявку при каждой смене узла, а обработчик (`setMoreOpen`) стабилен.
  const headerActions = useMemo(
    () => (
      <Button variant="icon" aria-label="Ещё" onClick={() => setMoreOpen(true)}>
        <MoreHorizontal className="i" aria-hidden />
      </Button>
    ),
    [],
  );
  // ОДНА КАРТОЧКА С КАРАНДАШАМИ (пункт 17 разбора, Dan 24.09 «продолжаем»): блок
  // правится на месте, без перехода в отдельный режим правки с другой раскладкой.
  const canInlineEdit = canEnterEdit && !isTrashed;
  const [editingFields, setEditingFields] = useState(false);
  const [editingDocs, setEditingDocs] = useState(false);
  const [editingPhotos, setEditingPhotos] = useState(false);
  const [editingVideo, setEditingVideo] = useState(false);
  // Исходники монтажёру (сырое видео): загрузка прямо в карточке, по кнопке
  // «Изменить исходники» — случайное нажатие в просмотре не должно отправить
  // объект на проверку (загрузка при AWAITING_VIDEO двигает конвейер). Готовый
  // ролик — отдельно, в «Что-то не так с роликом» (PropertyVideoFixCard).
  const sourcesBlock =
    canEdit && !property.offSite ? (
      <PropertyVideoManager
        propertyId={property.id}
        readOnly={!(editingVideo && canInlineEdit)}
        handoffStatus={property.videoHandoffStatus}
        inPipeline={!!property.pipeline?.inPipeline}
        onStartEdit={canInlineEdit ? () => setEditingVideo(true) : undefined}
        onDone={() => {
          setEditingVideo(false);
          onInlineDone();
        }}
      />
    ) : null;
  const fieldsBlock =
    editingFields && canInlineEdit ? (
      <AgentFieldsCard
        property={property}
        canAssignAgent={canAssignAgent}
        agents={agents}
        isTrashed={isTrashed}
        can={can}
        updateProperty={updateProperty}
        onDone={() => {
          setEditingFields(false);
          onInlineDone();
        }}
      />
    ) : (
      <div className="card">
        <PropertyOwnerCard property={property} showIntakeShare={can("finance.view")} />
        {canInlineEdit && <InlineEditLink label="Изменить" onClick={() => setEditingFields(true)} />}
      </div>
    );
  const docsBlock = (
    <div className="card">
      {editingDocs && canInlineEdit ? (
        <>
          <div className="sec-h stack">
            <h2>Документы</h2>
            <span className="note">Видны только сотрудникам</span>
          </div>
          <PropertyDocumentsField
            key={property.documents ?? ""}
            documents={property.documents}
            onSave={(documents) => updateProperty.mutate({ documents })}
          />
          <InlineDoneButton
            onClick={() => {
              setEditingDocs(false);
              onInlineDone();
            }}
          />
        </>
      ) : (
        <>
          <PropertyDocumentsCard documents={property.documents} />
          {canInlineEdit && <InlineEditLink label="Отметить документы" onClick={() => setEditingDocs(true)} />}
        </>
      )}
    </div>
  );
  const statusOptions = propertyStatusOptions(property.status as PropertyStatus, can("properties.moderate"));
  // Статус остаётся открытым и после публикации (зарезервирован / продан / снят,
  // PROPERTY_FIELDS_OPEN_AFTER_PUBLISH) — поэтому canEditAny, а не canEnterEdit.
  const canChangeStatus = canEditAny && !isTrashed && !isDealDriven && statusOptions.length > 1;
  const showSolve =
    canChangeStatus ||
    solveHasContent(property, {
      canModerate: can("properties.moderate"),
      canPublish,
      canEdit,
      isTrashed,
      isDealDriven,
      marketingRole,
      tiktokConnected: !!channelsStatus?.channels.TIKTOK.connected,
    });
  // Один блок: раньше он был набран дважды (телефон и компьютер).
  const viewSolve = (
    <section className="card">
      <div className="sec-h stack">
        <h2>Решить сейчас</h2>
      </div>
      {canChangeStatus && (
        <StatusRow
          property={property}
          isTrashed={isTrashed}
          isDealDriven={isDealDriven}
          statusOptions={statusOptions}
          updateProperty={updateProperty}
        />
      )}
      <PipelineHints property={property} />
      <MaterialsModerationCard property={property} can={can} canManage={!accountReadOnly && isResponsibleForProperty} />
      <SitePublishToggle property={property} canPublish={canPublish} inPipeline={inPipeline} isTrashed={isTrashed} />
      {canEdit && !isTrashed && property.status === "EDITING" && <CompleteEditingButton propertyId={property.id} />}
      {!isTrashed && <TikTokPublishButton property={property} />}
      {isDealDriven && (
        <div className="quiet">
          <span className="dot" />
          <span className="txt">
            Этот статус ставит сделка:{" "}
            {property.status === "RESERVED"
              ? "объект освободится сам, когда сделку завершат или отменят."
              : "объект продан по закрытой сделке."}
          </span>
        </div>
      )}
    </section>
  );

  // Ролик одной строкой, этап с сервера (`videoHandoff`, `status`), права правки не участвуют.
  const videoLine = videoStageLine(property);

  // Меню «Изменить»: что именно править. Блоки правятся на месте, поэтому пункт не
  // открывает отдельный экран, а включает правку блока и прокручивает к нему.
  const editItems: ActionSheetItem[] = canEnterEdit
    ? [
        { id: "params", title: "Цена, площадь, адрес", line: "Форма параметров объекта", onSelect: onEditParams },
        {
          id: "photos",
          title: "Фотографии",
          line: "Добавить, поменять порядок, удалить",
          onSelect: () => {
            setTab("media");
            setEditingPhotos(true);
            jumpTo("rh-photos");
          },
        },
        ...(sourcesBlock
          ? [
              {
                id: "video",
                title: "Исходные видео",
                line: "Загрузить ролики для монтажёра",
                onSelect: () => {
                  setTab("media");
                  setEditingVideo(true);
                  jumpTo("rh-video-sources");
                },
              },
            ]
          : []),
        {
          id: "people",
          title: "Кто ведёт объект и контакты",
          line: "Ответственный агент, телефон собственника, ссылка на ролик",
          onSelect: () => {
            setEditingFields(true);
            jumpTo("rh-people");
          },
        },
        {
          id: "docs",
          title: "Документы",
          line: "Отметить, какие документы готовы",
          onSelect: () => {
            setTab("short");
            setEditingDocs(true);
            jumpTo("rh-docs");
          },
        },
      ]
    : [];

  // Меню «Ещё»: редкое и разрушительное. Удаление не в зоне пальца и не на виду; чужому
  // объекту (без права) пункта нет вовсе, а не кнопка, которая отвечает 403.
  const moreItems: ActionSheetItem[] = [
    {
      id: "history",
      title: "История изменений",
      onSelect: () => {
        setTab("hist");
        jumpTo("rh-pcard-tabs");
      },
    },
    ...(deleteMode === "delete"
      ? [
          {
            id: "delete",
            title: "Удалить объект",
            line: "Снимется с сайта и уйдёт в корзину раздела «Архив»",
            onSelect: () => setDeleteOpen(true),
          },
        ]
      : []),
    ...(deleteMode === "request" && !pendingDeleteRequest
      ? [
          {
            id: "request-delete",
            title: "Направить на удаление",
            line: "Удалить объект сами вы не можете: решает директор",
            onSelect: () => setRequestDeleteOpen(true),
          },
        ]
      : []),
  ];

  const tabOptions: TabOption<PropertyTab>[] = [
    { id: "short", label: "Коротко" },
    { id: "media", label: "Фото и видео" },
    { id: "hist", label: "История" },
    // Статистика и «Голос рынка» — тому, кто ведёт объект (review-pc.md, п. «Вкладки»).
    ...(isResponsibleForProperty
      ? ([
          { id: "stats", label: "Статистика" },
          { id: "voice", label: "Голос рынка" },
        ] as TabOption<PropertyTab>[])
      : []),
  ];

  const summaryProps = {
    property,
    onSchedule: canSchedule ? () => setShowingOpen(true) : null,
    onEdit: canEnterEdit ? () => setEditMenuOpen(true) : null,
    onMore: () => setMoreOpen(true),
  };
  const descriptionContent = (property.description || canInlineEdit) && (
            <CleanPropertySlot enabled={clean} area="description"><div className="rh-pcard-desc">
              <Card title="Описание">
                <DescriptionBlock
                  property={property}
                  canEdit={canInlineEdit}
                  isTrashed={isTrashed}
                  can={can}
                  updateProperty={updateProperty}
                  onSaved={onInlineDone}
                />
              </Card>
            </div></CleanPropertySlot>
          );
  const demandContent = !isTrashed && can("clients.viewAll") ? <DemandLine count={property.demandCount} onOpen={() => setMatchOpen(true)} /> : null;
  // Shared leaves keep permission gates and dialog callbacks owned by this controller.
  const trashedNotice = isTrashed && <TrashedBanner />;
  const addressNotice = (!property.district || !property.address) && <MissingAddressNotice onEdit={canEnterEdit ? onEditParams : null} />;
  const lockedNotice = editLocked && <EditLockedNotice />;
  const reelsBlock = can("properties.aiListing") && !isTrashed && !editLocked && (
    <div className="card tight">
      <ReelsCaptionBlock propertyId={property.id} initialCaption={property.reelsCaption} collapsible />
    </div>
  );
  const promotionBlock = <>
    <PropertyAdBadge propertyId={property.id} />
    {!isTrashed && property.status === "AVAILABLE" && <PropertyPriceDemandCard propertyId={property.id} />}
    <PriceHistoryBlock property={property} />
  </>;
  const shareOpensBlock = canEdit && !isTrashed && <PropertyShareOpensCard propertyId={property.id} />;
  const matchDialog = matchOpen && <MatchPanel mode="property" property={property} open={matchOpen} onClose={() => setMatchOpen(false)} />;
  const deleteDialog = !accountReadOnly && deleteOpen && <DeletePropertyDialog propertyId={property.id} onClose={() => setDeleteOpen(false)} />;
  const requestDeleteDialog = !accountReadOnly && requestDeleteOpen && <RequestDeletePropertyModal propertyId={property.id} propertyTitle={property.title} onClose={() => setRequestDeleteOpen(false)} />;

  if (legacyAgentMobile) {
    return <LegacyAgentPropertyView
      {...{ property, can, updateProperty, isTrashed, canEnterEdit, onEditParams, canInlineEdit, editingPhotos, setEditingPhotos, onInlineDone, showSolve, viewSolve, dealSlot, fieldsBlock, role, canMarkGroupShare, changeRequestBlock, sourcesBlock, isResponsibleForProperty, docsBlock, deleteMode, pendingDeleteRequest, setRequestDeleteOpen, setDeleteOpen, setMatchOpen, placeLine }}
      slots={{ trashedNotice, addressNotice, lockedNotice, reelsBlock, promotionBlock, shareOpensBlock, matchDialog, deleteDialog, requestDeleteDialog }}
      parts={{ InlineDoneButton, InlineEditLink, DemandLine, DescriptionBlock }}
    />;
  }

  return (
    <Rh2Screen title={`Объект №${property.shortId}`} back="/properties" actions={headerActions}>
      <MutationError mutation={updateProperty} fallback="Не удалось сохранить изменение" />
      {trashedNotice}

      {/* Заголовок страницы только на компьютере: на телефоне его несёт шапка оболочки. */}
      <div className="only-wide">
        {clean ? <CleanPropertyDetailHeader code={formatPropertyCode(property.shortId)} place={placeLine(property)} /> : <PageHeader
          title={`Объект №${property.shortId}`}
          sub={placeLine(property)}
          actions={
            <Link className="pill rh-btn ghost" to="/properties">
              <ChevronLeft className="i" aria-hidden />
              Объекты
            </Link>
          }
        />}
      </div>

      {addressNotice}
      {lockedNotice}

      <CleanPropertyDetailLayout enabled={clean}>
        <div className="rh-pcard-main" style={clean ? { display: "contents" } : undefined}>
          <CleanPropertySlot enabled={clean} area="gallery"><PropertyGallery photos={photos} /></CleanPropertySlot>
          {!clean && descriptionContent}
        </div>

        <div className="rh-pcard-side" style={clean ? { display: "contents" } : undefined}>
          {clean ? <CleanPropertySummary {...summaryProps}>{demandContent}</CleanPropertySummary> : <PropertyPriceCard
            property={property}
            onSchedule={canSchedule ? () => setShowingOpen(true) : null}
            onEdit={canEnterEdit ? () => setEditMenuOpen(true) : null}
            onMore={() => setMoreOpen(true)}
          >
            {demandContent}
          </PropertyPriceCard>}

          {clean && descriptionContent}

          {/* Кто ведёт и собственник. Тем, кому собственник закрыт, его блока нет:
              остаётся «кто ведёт» (PropertyPeople). */}
          <CleanPropertySlot enabled={clean} area="people"><div id="rh-people">{fieldsBlock}</div></CleanPropertySlot>

          <CleanPropertySlot enabled={clean} area="work">{videoLine && (
            <Card tight title="Ролик" data-testid="property-video-stage">
              <div className="quiet">
                <span className={videoLine.tone === "neutral" ? "dot" : `dot ${videoLine.tone}`} />
                <span className="txt">{videoLine.text}</span>
              </div>
            </Card>
          )}</CleanPropertySlot>

          <CleanPropertySlot enabled={clean} area="work">{showSolve && viewSolve}</CleanPropertySlot>
          <CleanPropertySlot enabled={clean} area="work">{dealSlot}</CleanPropertySlot>
          <CleanPropertySlot enabled={clean} area="work">{changeRequestBlock}</CleanPropertySlot>
        </div>
      </CleanPropertyDetailLayout>

      <div id="rh-pcard-tabs" className="rh-pcard-tabs" style={clean ? cleanPropertyDetailScale : undefined}>
        <div className="rh-tabs-scroll">
          <Tabs aria-label="Разделы карточки объекта" options={clean ? tabOptions.map((option) => option.id === "short" ? { ...option, label: "Обзор" } : option) : tabOptions} value={tab} onChange={setTab} />
        </div>

        <div className="rh-pcard-tabbody">
          {tab === "short" && (
            <>
              {/* Сведения, которым не место на первом экране: когда принят, номер,
                  сайт (review-mobile.md, п. 4 «Меньше информации: что под раскрытие»). */}
              <Card title="Сведения">
                <List>
                  <Row
                    title="Принят"
                    line={`${daysSinceAccepted} ${pluralizeRu(daysSinceAccepted, ["день", "дня", "дней"])} с приёма объекта`}
                    meta={dushanbeDate(property.listingAcceptedAt ?? property.createdAt, { day: "numeric", month: "long" })}
                  />
                  <Row title="Номер объекта" meta={formatPropertyCode(property.shortId)} />
                  <Row title="Сайт royalhome.tj" meta={property.publishedOnSite ? "Опубликован" : "Не опубликован"} />
                  {property.viewsCount > 0 && <Row title="Показов клиентам" meta={String(property.viewsCount)} />}
                  {!!property.demandCount && !can("clients.viewAll") && (
                    <Row title="Покупателей ждут такой объект" meta={String(property.demandCount)} />
                  )}
                </List>
                {property.instagramUrl && (
                  <div className="quiet">
                    <span className="spacer" />
                    <a className="lnk" href={property.instagramUrl} target="_blank" rel="noreferrer">
                      Смотреть в Instagram
                    </a>
                  </div>
                )}
              </Card>

              <div id="rh-docs">{docsBlock}</div>

              {/* Кто открыл присланную ссылку. Форма «создать ссылку» отсюда
                  убрана насовсем (#1016), остался только показ. */}
              {shareOpensBlock}

              {promotionBlock}

              {/* Черновик подписи — тихая строка, не карточка. */}
              {reelsBlock}
            </>
          )}

          {tab === "media" && (
            <>
              {/* Ролик уже выпущен и с ним что-то не так — четыре способа исправить,
                  не заполняя карточку заново (19.09.2026). Панель прячется сама,
                  пока публиковать было нечего. */}
              {role === "AGENT" ? (
                <>
                  <AgentVideoStatus property={property} />
                  <FacebookGroupShareBlock property={property} readOnly={accountReadOnly || isTrashed} canEdit={canMarkGroupShare} />
                </>
              ) : (
                <>
                  <PropertyVideoFixCard property={property} readOnly={accountReadOnly || isTrashed} canEdit={canEnterEdit} />
                  <FacebookGroupShareBlock property={property} readOnly={accountReadOnly || isTrashed} canEdit={canMarkGroupShare} />
                  <RepostBlock property={property} readOnly={accountReadOnly || isTrashed} canEdit={canEnterEdit} />
                  <SocialExtrasBlock property={property} readOnly={accountReadOnly || isTrashed} />
                  <PropertyCoverStatus property={property} readOnly={accountReadOnly || isTrashed} />
                </>
              )}
              {/* Фото правятся на месте (пункт 17 разбора): редактор открывается пунктом
                  «Фотографии» меню «Изменить» (или ссылкой здесь), «Готово» закрывает. */}
              <div id="rh-photos" className="rh-pcard-stack">
                <PropertyPhotoManager
                  propertyId={property.id}
                  shortId={property.shortId}
                  photos={property.photos}
                  readOnly={isTrashed ? "trashed" : !canInlineEdit ? "view" : editingPhotos ? false : "locked"}
                />
                {canInlineEdit &&
                  (editingPhotos ? (
                    <InlineDoneButton
                      onClick={() => {
                        setEditingPhotos(false);
                        onInlineDone();
                      }}
                    />
                  ) : (
                    <InlineEditLink label="Изменить фото" onClick={() => setEditingPhotos(true)} />
                  ))}
              </div>
              <div id="rh-video-sources">{sourcesBlock}</div>
              <PropertyClipVideoCard property={property} readOnly={!canInlineEdit} />
            </>
          )}

          {tab === "hist" && (
            <PropertyHistoryCard
              propertyId={property.id}
              status={property.status}
              isResponsible={isResponsibleForProperty}
              assignedAgentName={property.assignedAgent?.fullName}
              intakeAgentName={property.intakeAgent?.fullName}
              showEmpty
            />
          )}

          {tab === "stats" && isResponsibleForProperty && (
            <>
              {/* «Отчёт владельцу» (03.10.2026): публичная страница с цифрами для собственника.
                  Видна тем же людям, что делятся объектом (серверный canManageProperty). */}
              {!isTrashed && <OwnerReportCard propertyId={property.id} />}
              <PropertyStatsCard propertyId={property.id} />
            </>
          )}

          {tab === "voice" && isResponsibleForProperty && <PropertyVoiceCard propertyId={property.id} />}
        </div>
      </div>

      {matchDialog}
      {showingOpen && <ShowingQuickForm clean={clean} initialPropertyId={property.id} onClose={() => setShowingOpen(false)} />}
      {editMenuOpen && <PropertyActionSheet title="Изменить" items={editItems} onClose={() => setEditMenuOpen(false)} />}
      {moreOpen && (
        <PropertyActionSheet title="Ещё" items={moreItems} onClose={() => setMoreOpen(false)}>
          {property.siteUrl && (
            <div className="rh-sheet-share">
              <ShareButton
                className="pill soft"
                label="Поделиться ссылкой"
                title={property.title}
                text={`${property.title}, ${formatMoney(property.price, property.currency)}, ${property.district?.name ?? ""}`}
                url={property.siteUrl}
              />
            </div>
          )}
          {deleteMode === "request" && pendingDeleteRequest && (
            <div className="quiet">
              <span className="dot" />
              <span className="txt">
                Заявка на удаление отправлена{" "}
                {new Date(pendingDeleteRequest.createdAt).toLocaleDateString("ru-RU", {
                  timeZone: "Asia/Dushanbe",
                  day: "numeric",
                  month: "long",
                })}
                , ждёт решения директора.
              </span>
            </div>
          )}
        </PropertyActionSheet>
      )}
      {deleteDialog}
      {requestDeleteDialog}
    </Rh2Screen>
  );
}

/**
 * «Объект в корзине» — тихая строка эталона, а не карточка-уведомление
 * (§6.1 договора дизайна: срочное = `.quiet`, кричащих плашек нет). Общая для
 * обеих раскладок; `.card.tight` даёт строке подложку, чтобы она не сливалась
 * с фоном экрана.
 */
function TrashedBanner() {
  return (
    <div className="card tight">
      <div className="quiet warn">
        <span className="dot warn" />
        <span className="txt">
          <b>Объект в корзине.</b> Он не показывается в списках и на сайте. Вернуть или стереть
          навсегда можно в корзине раздела «Архив».
        </span>
        <Link className="lnk" to="/archive">
          В Архив
        </Link>
      </div>
    </div>
  );
}

/**
 * Тупик карточки: объект не найден или не загрузился. Блок `.empty` эталона
 * (пиктограмма 48, текст, подпись, одна кнопка) вместо общего EmptyState —
 * тот носит старое оформление, а экран целиком переехал на макет.
 */
function PropertyDeadEnd({ title, hint, action }: { title: string; hint: string; action: ReactNode }) {
  return (
    <div className="rh2 screens">
      <div className="scr">
        <div className="card">
          <div className="empty">
            <span className="ic">
              <svg className="i" viewBox="0 0 24 24">
                <path d="M3 11 12 3l9 8v10H3z" />
                <path d="M9 21v-6h6v6" />
              </svg>
            </span>
            <p>{title}</p>
            <p className="sub">{hint}</p>
            {action}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Строка «Состояние объекта» с выбором статуса в блоке «Решить сейчас»
 * (`viewSolve` в PropertyViewCard): до 24.09.2026 статус
 * менялся только в правке, и агент не находил, куда нажать, чтобы снять объект
 * с продажи (разбор карточки, пункт 5).
 */
function StatusRow({
  property,
  isTrashed,
  isDealDriven,
  statusOptions,
  updateProperty,
}: {
  property: Property;
  isTrashed: boolean;
  isDealDriven: boolean;
  statusOptions: PropertyStatus[];
  updateProperty: ReturnType<typeof useUpdateProperty>;
}) {
  const [statusError, setStatusError] = useState<string | null>(null);

  return (
    <>
      {/* Строка решения эталона `.mod.solve`: слева что решаем, справа сам
          выбор. Резерв и продажа выбору не подлежат — их держит сделка:
          показываем пилюлю состояния и объясняем, где им управлять, вместо
          селектора, который всё равно нечем было бы наполнить честно. */}
      <div className="mod solve">
        <div className="t">
          <b>Состояние объекта</b>
          {isDealDriven ? (
            <span>
              Этот статус ставит сделка:{" "}
              {property.status === "RESERVED"
                ? "объект освободится сам, когда сделку завершат или отменят."
                : "объект продан по закрытой сделке."}
            </span>
          ) : !isTrashed && statusOptions.length <= 1 ? (
            <span>
              Дальше объект двигает маркетинг, кнопками «Одобрить» и «Вернуть с причиной».
            </span>
          ) : (
            <span>Где объект сейчас: готовится к продаже или уже продаётся.</span>
          )}
        </div>
        <div className="acts">
          {isDealDriven ? (
            <span className={statusChipClass(property.status, property.pipeline)}>
              {statusChipLabel(property.status, property.pipeline)}
            </span>
          ) : (
            <label className="fld" style={{ minWidth: 200 }}>
              <span className="lab">Статус</span>
              <select
                value={property.status}
                disabled={isTrashed || statusOptions.length <= 1}
                onChange={(e) => {
                  setStatusError(null);
                  updateProperty.mutate(
                    { status: e.target.value },
                    { onError: (err) => setStatusError(err instanceof Error ? err.message : "Не удалось изменить статус") }
                  );
                }}
              >
                {statusOptions.map((s) => (
                  <option key={s} value={s}>
                    {PROPERTY_STATUS_LABELS[s]}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
      </div>
      {statusError && (
        <div className="quiet crit">
          <span className="dot crit" />
          <span className="txt">{statusError}</span>
        </div>
      )}
    </>
  );
}

/** Подсказки под статусом — чего не хватает для продажи, причина возврата на
 *  доработку, в блоке «Решить сейчас» карточки — сам по себе не поле
 *  карточки, а объяснение состояния. */
function PipelineHints({ property }: { property: Property }) {
  if (!pipelineHintsVisible(property)) return null;
  return (
    <>
      {/* Чего не хватает для выхода в продажу — прямо под селектором, а не
          после нажатия. Сервер всё равно откажет (409), но узнавать о
          недостающем видео из ошибки — значит каждый раз пробовать наугад. */}
      {property.pipeline?.inPipeline && (
        <div className="quiet">
          <span className="dot" />
          <span className="txt">
            <b>Объект готовится.</b> В продажу он выйдет, когда будут фотографии и ссылка на
            готовый видео-обзор в Instagram — его публикует монтажёр, это последний этап
            подготовки. Сейчас:{" "}
            {property.photos?.length ? `${property.photos.length} фото` : "фотографий нет"},{" "}
            {/*
              НАХОДКА 12.09.2026: «видео нет» здесь означало «нет ссылки на готовый Reels»,
              а не «файл не дошёл» — но агент, только что загрузивший сырое видео, читал
              это как сбой загрузки. videoCount (сколько сырых роликов уже на карточке)
              приходит только с GET одного объекта — здесь мы всегда на этой карточке.
            */}
            {property.instagramUrl
              ? "готовый ролик есть"
              : (property.videoCount ?? 0) > 0
              ? "сырое видео на карточке, ждём готовый ролик от монтажёра"
              : "сырое видео ещё не загружено"}
            .
          </span>
        </div>
      )}

      {/* Причина возврата — почему объект сейчас у агента, а не у маркетинга. */}
      {(property.status === "AWAITING_PHOTOS" || property.status === "AWAITING_VIDEO") &&
        property.reviewRejectionReason && (
          <div className="quiet warn">
            <span className="dot warn" />
            <span className="txt">
              <b>Материалы возвращены на доработку:</b> {property.reviewRejectionReason}
              {property.reviewRejectionVoiceUrl && <VoiceNotePlayer url={property.reviewRejectionVoiceUrl} />}
            </span>
          </div>
        )}
    </>
  );
}

/**
 * «Одобрить фото/видео» / «Запросить новые» — рабочий процесс конвейера, не
 * поле карточки (спецификация, Этап 6): видно и в просмотре, и в
 * редактировании, решение владельца 23.08.2026. Только на проверке: до неё
 * одобрять нечего, после — решение уже принято. Видит и может вызвать строго
 * тот, у кого есть properties.moderate (маркетинг, директор, админ — см.
 * packages/shared/permissions.ts) — обычный агент даже владелец своего
 * объекта эту кнопку видеть не должен.
 *
 * Одобрение видео с 04.09.2026 просто одобряет: автомонтаж удалён, а передачу
 * ролика монтажёру (queueVideoHandoff) сервер запускает сам, когда одобрены
 * ОБА материала, — фронту дёргать нечего.
 */
function MaterialsModerationCard({
  property,
  can,
  canManage,
}: {
  property: Property;
  can: ReturnType<typeof useCan>;
  /** Ведёт ли человек объект (`leadsProperty`): список сырых роликов сервер отдаёт только
   *  им, остальным 403. */
  canManage: boolean;
}) {
  const approveMaterial = useApprovePropertyMaterial(property.id);
  const rejectMaterial = useRejectPropertyMaterial(property.id);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [rejectFormFor, setRejectFormFor] = useState<"photos" | "video" | null>(null);
  const [rejectReason, setRejectReason] = useState("");
  const [rejectVoiceNote, setRejectVoiceNote] = useState<VoiceNote | null>(null);
  /* Без звука — задание C (23.09.2026, объект №127): модератор одобрял видео
     вслепую, звук пропадал уже на монтаже. Тот же запрос, что уже делает
     PropertyVideoManager ниже на этой же странице (одинаковый queryKey в
     TanStack Query — второго похода на сервер не будет). */
  // Запрос уходит только когда блок реально рисуется И сервер ответит: раньше он шёл
  // при каждом открытии любой карточки и давал 403 чужому агенту (06.10.2026).
  const showModeration = moderationVisible(property, can("properties.moderate"));
  const { data: videosForModeration } = usePropertyVideos(property.id, showModeration && canManage);

  if (!showModeration) return null;

  const silentVideos = (videosForModeration ?? []).filter((v) => v.hasAudio === false);

  return (
    <>
      {(["photos", "video"] as const).map((material) => {
        const approvedAt = material === "photos" ? property.photosApprovedAt : property.videoApprovedAt;
        const photoCount = property.photos?.length ?? 0;
        /* Условия обязаны совпадать с сервером (properties.ts, review/approve).
           На проверке маркетинг смотрит СЫРЫЕ РОЛИКИ агента, а не готовый
           Reels: ссылку делает монтажёр двумя этапами позже (владелец
           17.08.2026). Экран, требовавший ссылку здесь, гасил кнопку навсегда. */
        const ready = material === "photos" ? photoCount >= MIN_PROPERTY_PHOTOS : (property.videoCount ?? 0) > 0;
        /* Почему кнопка серая — видимым текстом, а не подсказкой при наведении:
           с телефона наведения нет вовсе, и «Одобрить» выглядела сломанной. */
        const blockedReason = ready
          ? null
          : material === "photos"
            ? `Мало фотографий: ${photoCount} из ${MIN_PROPERTY_PHOTOS}. Одобрять можно, когда агент догрузит остальные.`
            : "Агент ещё не загрузил видео объекта. Одобрять можно, когда ролики появятся в блоке «Видео» ниже.";
        return (
          /* Строка решения эталона: `.mod.solve` — слева что решаем, справа
             кнопка и «Вернуть с причиной» ссылкой, форма причины — `.why`. */
          <div key={material} className="mod solve">
            <div className="t">
              <b>{material === "photos" ? "Фото" : "Видео"}</b>
              <span>
                {approvedAt
                  ? "Одобрено."
                  : blockedReason
                    ? blockedReason
                    : material === "photos"
                      ? `${photoCount} снимков, нужно не меньше ${MIN_PROPERTY_PHOTOS}.`
                      : "Ролики загружены, ждут решения."}
              </span>
              {/* Одобрение НЕ блокируем (владелец: звук досняли бы всё равно
                  не здесь) — только предупреждаем, чтобы решение об одобрении
                  было осознанным, а не «на глаз». */}
              {material === "video" && silentVideos.length > 0 && (
                <div className="quiet warn" style={{ marginTop: 6 }}>
                  <span className="dot warn" />
                  <span className="txt">
                    Видео {silentVideos.map((v) => v.filename).join(", ")} без звука — монтажёр наложит музыку, но
                    проверьте, не потерян ли звук при съёмке.
                  </span>
                </div>
              )}
              {rejectFormFor === material && (
                <div className="why" style={{ marginTop: 10 }}>
                  <textarea
                    value={rejectReason}
                    onChange={(e) => setRejectReason(e.target.value)}
                    rows={2}
                    maxLength={500}
                    placeholder="Агент увидит эту причину в своей карточке объекта"
                    aria-label="Причина возврата"
                  />
                  <VoiceNoteButton uploadUrl="/me/voice-notes" value={rejectVoiceNote} onChange={setRejectVoiceNote} />
                  <button className="lnk" type="button" onClick={() => setRejectFormFor(null)}>
                    Отмена
                  </button>
                  <button
                    className="pill sm"
                    type="button"
                    disabled={!rejectReason.trim() || rejectMaterial.isPending}
                    onClick={() => {
                      setReviewError(null);
                      rejectMaterial.mutate(
                        {
                          material,
                          reason: rejectReason.trim(),
                          reasonVoiceUrl: rejectVoiceNote?.url ?? null,
                          reasonVoiceTranscript: rejectVoiceNote?.transcript ?? null,
                        },
                        {
                          onSuccess: () => setRejectFormFor(null),
                          onError: (err) =>
                            setReviewError(err instanceof Error ? err.message : "Не удалось вернуть на доработку"),
                        }
                      );
                    }}
                  >
                    Вернуть на доработку
                  </button>
                </div>
              )}
            </div>
            {!approvedAt && (
              <div className="acts">
                <button
                  className="pill sm"
                  type="button"
                  disabled={!ready || approveMaterial.isPending}
                  onClick={() => {
                    setReviewError(null);
                    approveMaterial.mutate(material, {
                      onError: (err) => setReviewError(err instanceof Error ? err.message : "Не удалось одобрить"),
                    });
                  }}
                  title={blockedReason ?? undefined}
                >
                  {material === "photos" ? "Одобрить фото" : "Одобрить видео"}
                </button>
                <button
                  className="lnk"
                  type="button"
                  onClick={() => {
                    setReviewError(null);
                    setRejectFormFor(rejectFormFor === material ? null : material);
                    setRejectReason("");
                    setRejectVoiceNote(null);
                  }}
                >
                  Вернуть с причиной
                </button>
              </div>
            )}
            {approvedAt && <span className="chip ok">Одобрено</span>}
          </div>
        );
      })}
      {reviewError && (
        <div className="quiet crit">
          <span className="dot crit" />
          <span className="txt">{reviewError}</span>
        </div>
      )}
    </>
  );
}

/** «Опубликовать на сайт» / «Снять с публикации» + «Отправить клиенту» —
 *  рабочий процесс, не поле карточки: видно и в просмотре, и в редактировании. */
function SitePublishToggle({
  property,
  canPublish,
  inPipeline,
  isTrashed,
}: {
  property: Property;
  canPublish: boolean;
  inPipeline: boolean;
  /** В корзине — блок «Сайт royalhome.tj» показываем строкой, без кнопки. */
  isTrashed?: boolean;
}) {
  const syncToSite = useSyncToSite();
  const [syncError, setSyncError] = useState<string | null>(null);

  // СНЯТЫЙ С ПРОДАЖИ ИЛИ ЗАРЕЗЕРВИРОВАННЫЙ ОБЪЕКТ КНОПКОЙ НЕ ПУБЛИКУЕМ (ночная
  // проверка 24.09.2026, №129) — сервер и так ответит 409, гасим кнопку тем же
  // приёмом, что у inPipeline. SOLD сюда не входит — плашка «Продано» на сайте
  // это отдельный, разрешённый случай (см. комментарий в moderation.ts).
  const notSellable = property.status === "WITHDRAWN" || property.status === "RESERVED";

  async function handleToggleSitePublish() {
    setSyncError(null);
    try {
      const result = await syncToSite.mutateAsync({
        ids: [property.id],
        action: property.publishedOnSite ? "unpublish" : "publish",
      });
      const failed = result.results.find((r) => !r.ok);
      if (failed) setSyncError(failed.error ?? "Не удалось синхронизировать с сайтом");
    } catch (err) {
      setSyncError(err instanceof Error ? err.message : "Не удалось синхронизировать с сайтом");
    }
  }

  if (!sitePublishVisible(property, canPublish)) return null;

  return (
    /* Блок «Сайт royalhome.tj» эталона: `.mod.solve` — слева объяснение, справа
       решение одной кнопкой. */
    <div className="mod solve">
      <div className="t">
        <b>Сайт royalhome.tj</b>
        <span>
          {property.publishedOnSite
            ? "Объект опубликован: карточка видна на сайте и в поиске."
            : inPipeline
              ? "Объект ещё готовится: на сайт он выйдет после видео-обзора."
              : notSellable
                ? "Объект не в продаже — снят с продажи или зарезервирован."
                : "Объект на сайте не опубликован."}
        </span>
        {syncError && (
          <div className="quiet crit">
            <span className="dot crit" />
            <span className="txt">{syncError}</span>
          </div>
        )}
      </div>
      <div className="acts">
      {canPublish && !isTrashed && (
        <button
          className="pill sm"
          type="button"
          onClick={handleToggleSitePublish}
          /**
           * Объект в конвейере публиковать нельзя — сервер отвечает 409 «Ещё
           * готовятся, публиковать рано». Кнопка при этом была живой и синей:
           * человек жал её и получал отказ, ничего не сделав неправильно.
           * Снятие с публикации не блокируем никогда: убрать лишнее с сайта
           * должно быть можно в любой момент.
           */
          disabled={syncToSite.isPending || (!property.publishedOnSite && (inPipeline || notSellable || property.offSite))}
          title={
            !property.publishedOnSite && inPipeline
              ? "Объект ещё готовится: на сайт он выйдет после видео-обзора"
              : !property.publishedOnSite && notSellable
                ? "Объект не в продаже — снят с продажи или зарезервирован"
                : !property.publishedOnSite && property.offSite
                  ? "Закрытый объект: на сайте не показывается"
                  : undefined
          }
        >
          {syncToSite.isPending
            ? "Отправляем…"
            : property.publishedOnSite
              ? "Снять с публикации"
              : "Опубликовать"}
        </button>
      )}
      {/**
       * «Отправить клиенту» — системное меню «Поделиться»: объект уходит в
       * WhatsApp или Telegram одним нажатием, вместе с ценой и районом (точного
       * адреса в этой строке нет и не было — ночная проверка 24.09.2026, №9,
       * поправила только неверный комментарий, текст ниже уже брал district.name).
       *
       * Раньше агент копировал адрес из строки браузера. В установленном
       * приложении строки браузера НЕТ вовсе — скопировать ссылку было
       * физически неоткуда, и объект пересылали скриншотом.
       *
       * Только у опубликованного объекта: у остальных страницы на сайте не
       * существует (siteUrl приходит null), и отправлять нечего. Права
       * отдельного не требует — ссылка публичная, её видит любой прохожий.
       */}
      {property.siteUrl && (
        <ShareButton
          className="lnk"
          title={property.title}
          text={`${property.title}, ${formatMoney(property.price, property.currency)}, ${property.district?.name ?? ""}`}
          url={property.siteUrl}
        />
      )}
      </div>
    </div>
  );
}

/**
 * Описание объекта с генерацией ИИ. Вынесено из карточки «Параметры»: на
 * десктопе живёт внутри неё, на телефоне — отдельной карточкой «Описание»
 * (в мобильных плитках параметров описанию места нет).
 */
function DescriptionBlock({
  property,
  canEdit,
  isTrashed,
  can,
  updateProperty,
  onSaved,
}: {
  property: Property;
  canEdit: boolean;
  isTrashed: boolean;
  can: ReturnType<typeof useCan>;
  updateProperty: ReturnType<typeof useUpdateProperty>;
  /** После сохранения текста — разослать подпись и сайт, как «Готово» у блоков. */
  onSaved?: () => void;
}) {
  const [editingDescription, setEditingDescription] = useState(false);
  const [descriptionDraft, setDescriptionDraft] = useState("");
  const [descriptionError, setDescriptionError] = useState<string | null>(null);
  // Варианты описания от ИИ: показываем списком и даём выбрать, а не подставляем
  // молча — текст уходит на публичный сайт, и последнее слово за человеком.
  const generateListing = useGenerateListing();
  const [aiVariants, setAiVariants] = useState<string[]>([]);
  const [aiError, setAiError] = useState<string | null>(null);

  async function handleSaveDescription() {
    setDescriptionError(null);
    try {
      await updateProperty.mutateAsync({ description: descriptionDraft });
      setEditingDescription(false);
      onSaved?.();
    } catch (err) {
      setDescriptionError(err instanceof Error ? err.message : "Не удалось сохранить описание");
    }
  }

  /** Просит у ИИ варианты описания. Ничего не сохраняет и не подставляет сам —
   *  текст уходит на публичный сайт, поэтому выбирает человек. */
  async function handleGenerateDescription(language: "ru" | "tj") {
    setAiError(null);
    setAiVariants([]);
    try {
      const res = await generateListing.mutateAsync({ propertyId: property.id, language });
      const variants = (res.variants ?? []).filter((v) => v.trim().length > 0);
      if (variants.length === 0) {
        setAiError("Модель вернула пустой ответ, попробуйте ещё раз");
        return;
      }
      setAiVariants(variants);
    } catch (err) {
      setAiError(err instanceof Error ? err.message : "Не удалось получить описание");
    }
  }

  if (editingDescription) {
    return (
      <>
        {/* Поле — `.fld` эталона: внутри `.rh2` правило `font:inherit` перебивает
            размеры Tailwind, поэтому размер и рамку задаёт сам макет, а не классы. */}
        <label className="fld">
          <span className="lab">Текст объявления</span>
          <textarea
            value={descriptionDraft}
            onChange={(e) => setDescriptionDraft(e.target.value)}
            rows={5}
            autoFocus
          />
          {descriptionError && <span className="msg">{descriptionError}</span>}
        </label>

        {/* Описание от ИИ. Кнопка появляется только у тех, кому выдано право
            «Генерировать описание ИИ» — до 10.08.2026 право выдавалось, но
            нажать было нечего. Языка два: объявления публикуются и по-русски,
            и по-таджикски, а сервер уже умеет оба. Строка тихая, как черновик
            описания в эталоне, а не карточка-уведомление. */}
        {can("properties.aiListing") && !isTrashed && (
          <div className="quiet">
            <span className="dot gold" />
            <span className="txt">
              Черновик можно попросить у помощника. Ничего не сохранится, пока вы не выберете вариант.
            </span>
            <button
              className="pill ghost sm"
              type="button"
              onClick={() => handleGenerateDescription("ru")}
              disabled={generateListing.isPending}
            >
              {generateListing.isPending ? "Пишем…" : "Написать черновик"}
            </button>
            <button
              className="lnk"
              type="button"
              onClick={() => handleGenerateDescription("tj")}
              disabled={generateListing.isPending}
            >
              Тоҷикӣ
            </button>
          </div>
        )}

        {aiError && (
          <div className="quiet crit">
            <span className="dot crit" />
            <span className="txt">{aiError}</span>
          </div>
        )}

        {aiVariants.length > 0 && (
          <div className="list">
            {aiVariants.map((variant, i) => (
              <div className="row" key={i}>
                <div className="t">
                  <b>Вариант {i + 1}</b>
                  <span>{variant}</span>
                </div>
                <div className="act">
                  <button
                    className="pill ghost sm"
                    type="button"
                    onClick={() => {
                      setDescriptionDraft(variant);
                      setAiVariants([]);
                    }}
                  >
                    Подставить
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="quiet">
          <span className="spacer" />
          <button
            className="lnk"
            type="button"
            onClick={() => {
              setEditingDescription(false);
              setDescriptionError(null);
            }}
          >
            Отмена
          </button>
          <button
            className="pill sm"
            type="button"
            onClick={handleSaveDescription}
            disabled={isTrashed || updateProperty.isPending}
          >
            Сохранить
          </button>
        </div>
      </>
    );
  }

  const staleFloors = propertyFieldShown(property.type, "totalFloors")
    ? floorsMismatch(property.description, property.totalFloors)
    : null;

  return (
    <>
      {property.description ? (
        <p>{property.description}</p>
      ) : (
        <p className="sub">Описание не заполнено. На сайт объект уходит вместе с ним.</p>
      )}
      {staleFloors != null && (
        <div className="quiet crit">
          <span className="dot crit" />
          <span className="txt">
            В описании этажность {staleFloors}, а в параметрах {property.totalFloors}. Описание при смене параметров само не
            меняется — проверьте текст.
          </span>
        </div>
      )}
      {canEdit && (
        <div className="quiet">
          <span className="spacer" />
          <button
            className="lnk"
            type="button"
            onClick={() => {
              setDescriptionDraft(property.description ?? "");
              setDescriptionError(null);
              setEditingDescription(true);
            }}
          >
            {property.description ? "Изменить описание" : "Добавить описание"}
          </button>
        </div>
      )}
    </>
  );
}

/** История цены — карточка есть только у объектов, чью цену уже меняли.
 *  Строки эталона `.list`/`.row`: слева что произошло, справа когда. */
function PriceHistoryBlock({ property, className }: { property: Property; className?: string }) {
  if (!property.priceHistory?.length) return null;
  return (
    <div className={`card ${className ?? ""}`}>
      <div className="sec-h stack">
        <h2>История цены</h2>
      </div>
      <div className="list">
        {property.priceHistory.map((h) => (
          <div className="row" key={h.id}>
            <div className="t">
              <b>
                {formatMoney(h.oldPrice, h.oldCurrency)} на {formatMoney(h.newPrice, h.newCurrency)}
              </b>
            </div>
            <span className="meta">{relativeTime(h.createdAt)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** «Назначить клиенту» — сделка из карточки объекта. Своё состояние и мутация,
 *  чтобы блок одинаково жил в правой колонке десктопа и в мобильном столбце. */
function AssignClientCard({
  property,
  preselectClientId,
  preselectClientName,
}: {
  property: Property;
  /** Имя того же клиента — на случай, если его нет среди найденных по
   *  поиску: без него подстановка молча не срабатывала. */
  preselectClientName?: string;
  /** Клиент, с которым только что закрыли показ (переход из «Завершить
   *  сделку» на карточке клиента) — подставляется в селект один раз, чтобы
   *  агент не искал того же человека заново среди сотен покупателей. */
  preselectClientId?: string;
}) {
  const clean = useCleanShell();
  const createDealKey = useRetryKey();
  const createDeal = useCreateDeal(createDealKey);
  const navigate = useNavigate();
  const [assignClientId, setAssignClientId] = useState("");
  const [assignError, setAssignError] = useState<string | null>(null);
  const myId = useAuthStore((s) => s.agent?.id);
  // На кого заведётся сделка (F1, 02.10.2026): сервер без явного выбора пишет
  // её на агента покупателя, а не на того, кто нажал кнопку. Руководителю,
  // заводящему сделку по чужому покупателю, говорим это вслух — иначе не
  // видно, к кому уйдут объект и баллы за закрытие.
  const [assignQuery, setAssignQuery] = useState("");
  // Серверный поиск (05.10.2026): имя, телефон или номер ПК-… — по всей базе, а не
  // фильтр по первым 200 покупателям. kind: BUYER — продавцов сюда не показываем,
  // иначе сделку можно было создать между объектом и продавцом.
  const q = useDebouncedValue(assignQuery.trim(), 250);
  const { data: found, isLoading: searching } = useClients({ kind: "BUYER", q: q || undefined, pageSize: 20 });
  const foundItems = found?.items ?? [];
  // Выбранного клиента запоминаем целиком: он остаётся в списке и после нового
  // поиска, который его уже не возвращает.
  const [picked, setPicked] = useState<Client | null>(null);
  const pickedClient = foundItems.find((c) => c.id === assignClientId) ?? (picked?.id === assignClientId ? picked : undefined);
  const dealOwnerName =
    pickedClient?.assignedAgent && pickedClient.assignedAgent.id !== myId ? pickedClient.assignedAgent.fullName : null;

  // Клиент, пришедший с карточки (preselect), может не попасть в выдачу поиска:
  // тогда добавляем его строкой сами, иначе выбор молча сбрасывался на «Выберите
  // клиента…». Выбранный вручную — тоже всегда в списке.
  const keep: { id: string; fullName: string }[] = [];
  if (pickedClient) keep.push({ id: pickedClient.id, fullName: pickedClient.fullName });
  else if (assignClientId && assignClientId === preselectClientId && preselectClientName)
    keep.push({ id: assignClientId, fullName: preselectClientName });
  const options = [...keep.filter((k) => !foundItems.some((c) => c.id === k.id)), ...foundItems];

  useEffect(() => {
    if (preselectClientId) setAssignClientId(preselectClientId);
  }, [preselectClientId]);

  async function handleAssign() {
    if (!assignClientId) return;
    setAssignError(null);
    try {
      await createDeal.mutateAsync({ clientId: assignClientId, propertyId: property.id, stage: "NEGOTIATION" });
      setAssignClientId("");
      // Раньше здесь сделка тихо заводилась и агент оставался на этой же
      // странице — весь дальнейший путь (движение по этапам, «отправить на
      // закрытие» с фактической ценой и комиссией, одобрение у директора)
      // живёт на доске сделок, а не здесь, и агент об этом не догадывался:
      // жалоба владельца 18.09 «нажимаю завершить сделку, выбираю объект,
      // и дальше ничего нет». Сразу ведём туда, где сделку можно довести до
      // конца.
      toast.success("Сделка создана — теперь ведите её на доске «Сделки»");
      navigate("/deals");
    } catch (err) {
      setAssignError(err instanceof Error ? err.message : "Не удалось создать сделку");
    }
  }

  const content = (
    <>
      <div className="sec-h stack">
        {!clean && <h2>Сделка по объекту</h2>}
        <span className="note">Выберите покупателя, сделка появится на доске «Сделки»</span>
      </div>
      <div className="mod solve">
        <div className="t">
          <label className={assignError ? "fld bad" : "fld"}>
            <span className="lab">Покупатель</span>
            <input
              type="search"
              placeholder="Имя, телефон или номер ПК-…"
              value={assignQuery}
              onChange={(e) => setAssignQuery(e.target.value)}
              aria-label="Поиск покупателя"
              style={{ marginBottom: "var(--s2)" }}
            />
            <select
              value={assignClientId}
              onChange={(e) => {
                setAssignClientId(e.target.value);
                setPicked(foundItems.find((c) => c.id === e.target.value) ?? null);
              }}
            >
              <option value="">
                {searching ? "Ищу…" : q && foundItems.length === 0 ? "Никого не нашли" : "Выберите клиента…"}
              </option>
              {options.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.fullName}
                </option>
              ))}
            </select>
            {assignError && <span className="msg">{assignError}</span>}
            {!assignError && dealOwnerName && (
              <span className="quiet">Сделку поведёт агент покупателя: {dealOwnerName}</span>
            )}
          </label>
        </div>
        <div className="acts">
          <button className="pill sm" type="button" onClick={handleAssign} disabled={!assignClientId || createDeal.isPending}>
            Создать сделку
          </button>
        </div>
      </div>
    </>
  );
  return clean ? (
    <details className="card clean-property-deal-disclosure" id="deal-assign" open={Boolean(preselectClientId)}>
      <summary className="cursor-pointer py-2 text-[17px] font-semibold text-ink" style={{ minHeight: 44 }}>Начать сделку</summary>
      <div className="pt-4">{content}</div>
    </details>
  ) : <div className="card" id="deal-assign">{content}</div>;
}

/**
 * «Кто ведёт объект» в правке (пункт 17 разбора): ответственный агент и
 * служебные поля (контакт владельца, ссылка на Reels, дата приёма) прямо в
 * карточке, с кнопкой «Готово». Документы, подпись Reels и «Готово — в продажу»
 * живут в своих блоках карточки. Раньше карточка целиком не рендерилась, пока
 * агент не назначен — единственный способ назначить агента впервые (не
 * переназначить) не существовал в UI вообще.
 */
function AgentFieldsCard({
  property,
  canAssignAgent,
  agents,
  isTrashed,
  can,
  updateProperty,
  onDone,
}: {
  property: Property;
  canAssignAgent: boolean;
  agents: AgentListItem[] | undefined;
  isTrashed: boolean;
  can: ReturnType<typeof useCan>;
  updateProperty: ReturnType<typeof useUpdateProperty>;
  onDone: () => void;
}) {
  const badInstagram = !!property.instagramUrl && !isInstagramLink(property.instagramUrl);
  // До одобрения ссылку на ролик агент не вставляет (то же правило на сервере,
  // routes/properties/crud.ts): поле показываем, но не даём править.
  const instagramClosed = agentReelLinkClosed(
    property.status,
    can("properties.editForeign") || can("properties.moderate")
  );
  return (
    <div className="card">
      <PropertyOwnerCard
        property={property}
        showIntakeShare={can("finance.view")}
        ownerPhoneInField={can("properties.viewOwners") && !isTrashed}
      />

      <h3 className="sec-t">Поля карточки</h3>
      <div className="fgrid">
        {canAssignAgent && (
          <label className="fld">
            <span className="lab">Ответственный агент</span>
            <select
              value={property.assignedAgent?.id ?? ""}
              onChange={(e) => e.target.value && updateProperty.mutate({ assignedAgentId: e.target.value })}
              disabled={updateProperty.isPending}
            >
              <option value="" disabled>
                Не назначен
              </option>
              {agents
                ?.filter((a) => a.role === "AGENT" && (a.isActive || a.id === property.assignedAgent?.id))
                .map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.fullName}
                  </option>
                ))}
            </select>
          </label>
        )}

        {/* Слой 3 (08.09.2026): properties.viewAll разошлось на две половины —
            properties.viewOwners (контакты собственника) и правку самой карточки.
            Сервер уже режет поле ownerContact без права; здесь дублируем на
            клиенте, чтобы поле не мигало пустым инпутом тем, у кого его нет вовсе. */}
        {can("properties.viewOwners") && (
          <div className="fld">
            <span className="lab">Телефон собственника</span>
            <OwnerContactField
              value={property.ownerContact ?? ""}
              disabled={isTrashed}
              // null, а не undefined: undefined выпадает из JSON, и поле молча
              // оставалось со старым значением.
              onSave={(v) => updateProperty.mutate({ ownerContact: v || null })}
            />
            <span className="msg">Номер видят руководитель и агент этого объекта. Исправите номер — он поправится и в карточке продавца.</span>
          </div>
        )}

        <label className={badInstagram ? "fld bad wide" : "fld wide"}>
          <span className="lab">Видео в Instagram</span>
          <input
            defaultValue={property.instagramUrl ?? ""}
            disabled={isTrashed || instagramClosed}
            placeholder="https://www.instagram.com/reel/..."
            onBlur={(e) => {
              if (e.target.value !== (property.instagramUrl ?? "")) {
                updateProperty.mutate({ instagramUrl: e.target.value || null });
              }
            }}
          />
          {/* Хранить чужую ссылку МОЖНО (решение владельца 13.08.2026) — но молча
              нельзя: у 17 прод-карточек здесь лежали t.me/YouTube, узнавание
              пересланных рилсов по ним не работало никогда, и агент узнавал об этом
              из утренней сводки ошибок у директора, а не в момент ввода. */}
          {instagramClosed && <span className="msg">Ссылку на ролик можно вставить после одобрения объекта.</span>}
          {badInstagram && (
            <span className="msg">
              Это не ссылка на Instagram: узнавание пересланных рилсов и KPI «Видео» её не засчитают.
            </span>
          )}
        </label>

        <label className="fld">
          <span className="lab">Дата принятия объекта</span>
          <input
            type="date"
            // День по Душанбе, а не по UTC: вечерний приём (после 19:00 UTC)
            // иначе показывался в поле вчерашним числом.
            defaultValue={property.listingAcceptedAt ? dushanbeDayKey(property.listingAcceptedAt) : undefined}
            disabled={isTrashed}
            // По уходу из поля, а не на каждое изменение (F11, 02.10.2026): набор
            // года с клавиатуры давал серию запросов с промежуточными датами.
            onBlur={(e) => {
              const saved = property.listingAcceptedAt ? dushanbeDayKey(property.listingAcceptedAt) : null;
              const next = acceptedDateToSave(e.target.value, saved);
              if (next) updateProperty.mutate({ listingAcceptedAt: next });
            }}
          />
        </label>
      </div>

      <InlineDoneButton onClick={onDone} />
    </div>
  );
}

/** «Изменить» у блока в просмотре — тот же тихий ряд, что у описания
 *  (DescriptionBlock): ссылка справа, без рамки. */
function InlineEditLink({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <div className="quiet">
      <span className="spacer" />
      <button className="lnk" type="button" onClick={onClick}>
        {label}
      </button>
    </div>
  );
}

/** «Готово» — закрыть правку блока. Поля сохраняются сами (по уходу из поля или
 *  по галочке), кнопка только возвращает блок к просмотру. */
function InlineDoneButton({ onClick }: { onClick: () => void }) {
  return (
    <div className="quiet">
      <span className="spacer" />
      <button className="pill sm" type="button" onClick={onClick}>
        Готово
      </button>
    </div>
  );
}

/** Полное удаление объекта — только admin/director; сервер снимет объект
 *  с сайта и сотрёт фото. Объект со сделками сервер удалять откажется.
 *  Подтверждение (`alertdialog`) открывается из меню «Ещё»: разрушительное не в
 *  зоне пальца и не на виду (контракт 06.10.2026). Ошибка — всплывашкой, окно
 *  остаётся открытым, пока идёт запрос, и закрывается по его итогу. */
function DeletePropertyDialog({ propertyId, onClose }: { propertyId: string; onClose: () => void }) {
  const deleteProperty = useDeleteProperty();
  const navigate = useNavigate();
  return (
    <ConfirmDialog
      title="Удалить объект?"
      description="Объект снимется с сайта и уйдёт в корзину раздела «Архив». Оттуда его можно вернуть или стереть навсегда."
      confirmLabel={deleteProperty.isPending ? "Удаление…" : "Удалить"}
      confirmDisabled={deleteProperty.isPending}
      danger
      onConfirm={async () => {
        try {
          await deleteProperty.mutateAsync(propertyId);
          navigate("/properties");
        } catch (err) {
          toast.error(err instanceof Error ? err.message : "Не удалось удалить объект");
          onClose();
        }
      }}
      onCancel={onClose}
    />
  );
}

/**
 * «N покупателей ждут такой объект · Открыть подбор» — строкой, а не голой
 * кнопкой «Подбор · N» между блоками без заголовка (разбор 24.09.2026, пункт 14).
 * Только тем, кому открыты чужие клиенты: в подборе имена.
 */
function DemandLine({ count, onOpen }: { count: number | undefined; onOpen: () => void }) {
  const n = count ?? 0;
  return (
    <div className="quiet">
      <span className="dot" />
      <span className="txt">
        {n > 0 ? (
          <>
            <b>
              {n} {pluralizeRu(n, ["покупатель", "покупателя", "покупателей"])}
            </b>{" "}
            {pluralizeRu(n, ["ждёт", "ждут", "ждут"])} такой объект.
          </>
        ) : (
          "Покупателей под такой объект пока нет."
        )}
      </span>
      <button className="lnk" type="button" onClick={onOpen}>
        Предложить
      </button>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="fld">
      <span className="lab">{label}</span>
      <b style={{ fontFamily: "var(--ff-head)", fontSize: "var(--fs-15)", color: "var(--ink)" }}>{value}</b>
    </div>
  );
}

/**
 * Карточка объекта для роли EDITOR (владелец 17.08.2026).
 *
 * Монтажёр не ведёт клиентов, не видит фотографии объекта и контакт владельца —
 * его работа целиком про видео: скачать сырые ролики, смонтировать вне CRM,
 * вставить ссылку на готовый Reels и подпись, нажать «Готово». Параметры объекта
 * (тип, площадь, цена и т.д.) оставлены — это тот текст, который монтажёр
 * накладывает на видео, а не конфиденциальные данные.
 */
function EditorPropertyDetail({
  property,
  isTrashed,
  updateProperty,
  navigate,
}: {
  property: Property;
  isTrashed: boolean;
  updateProperty: ReturnType<typeof useUpdateProperty>;
  navigate: ReturnType<typeof useNavigate>;
}) {
  const badInstagram = !!property.instagramUrl && !isInstagramLink(property.instagramUrl);
  const stage = propertyStageChip(property);
  return (
    // Одна шапка (контракт 06.10.2026): на телефоне заголовок и «Назад» несёт оболочка,
    // на компьютере страница рисует свой `.pg-h`. Раньше стояли обе.
    <Rh2Screen title={`Объект №${property.shortId}`} back="/properties">
        <MutationError mutation={updateProperty} fallback="Не удалось сохранить изменение" />

        <div className="only-wide">
          <PageHeader
            title={`Объект №${property.shortId}`}
            sub={
              <>
                {property.title} <Chip tone={stage.tone}>{stage.label}</Chip>
              </>
            }
            actions={
              <Link className="pill rh-btn ghost" to="/properties">
                <ChevronLeft className="i" aria-hidden />
                Объекты
              </Link>
            }
          />
        </div>

        <PropertyVideoFixCard property={property} readOnly={isTrashed} canEdit={false} viewer="montajer" />

        <PropertyVideoManager
          propertyId={property.id}
          readOnly
          handoffStatus={property.videoHandoffStatus}
          inPipeline={!!property.pipeline?.inPipeline}
        />

        <div className="card">
          <div className="sec-h stack">
            <h2>Параметры</h2>
            <span className="note">Для наложения на видео</span>
          </div>
          <div className="fgrid" style={{ gap: "var(--s3)" }}>
            {/* Тот же набор, что в плитках карточки, — по типу объекта. */}
            {propertyParams(property)
              .filter((row) => row.label !== "Район")
              .map((row) => (
                <Field key={row.label} label={row.label} value={row.value} />
              ))}
            <Field label="Цена" value={formatMoney(property.price, property.currency)} />
          </div>
        </div>

        <div className="card">
          <div className="sec-h stack">
            <h2>Кто ведёт объект</h2>
          </div>
          {/*
           * Риелтор сделки, если уже назначен, иначе тот, кто принял объект у
           * продавца (владелец 21.08.2026: «к нему прикрепилось и везде видно»).
           * До сделки assignedAgent пуст почти всегда — а объект в монтаж попадает
           * ДО сделки, поэтому монтажёр раньше видел «— не назначен —» на каждой
           * своей карточке, хотя интейкер у объекта всегда есть.
           */}
          <PropertyPeople property={property} showOwner={false} />

          <h3 className="sec-t">Ссылка на готовый обзор</h3>
          <div className="fgrid">
            <label className={badInstagram ? "fld bad wide" : "fld wide"}>
              <span className="lab">Видео в Instagram</span>
              <input
                defaultValue={property.instagramUrl ?? ""}
                disabled={isTrashed}
                placeholder="https://www.instagram.com/reel/..."
                onBlur={(e) => {
                  if (e.target.value !== (property.instagramUrl ?? "")) {
                    updateProperty.mutate({ instagramUrl: e.target.value || null });
                  }
                }}
              />
              <span className="msg">
                {badInstagram
                  ? "Это не ссылка на Instagram: узнавание пересланных рилсов и KPI «Видео» её не засчитают."
                  : "Без неё объект в продажу не выйдет."}
              </span>
            </label>
          </div>

          <ReelsCaptionBlock propertyId={property.id} initialCaption={property.reelsCaption} />

          {!isTrashed && property.status === "EDITING" && <CompleteEditingButton propertyId={property.id} />}

          <div className="quiet">
            <span className="dot" />
            <span className="txt">
              Автомонтажа нет: готовый ролик загружает монтажёр, CRM публикует его по каналам.
            </span>
          </div>
        </div>
    </Rh2Screen>
  );
}

/**
 * «Готово» — монтажёр завершает подготовку одной кнопкой (спецификация,
 * Этап 7/9): CRM сама переводит объект в продажу и публикует на сайт. Сервер
 * отказывает (409), если ещё нет фото или ссылки на видео — та же проверка,
 * что и у ручного перехода в «В продаже» через выпадающий список статуса,
 * только с автопубликацией, которой у обычного PATCH нет.
 */
function CompleteEditingButton({ propertyId }: { propertyId: string }) {
  const complete = useCompleteEditing(propertyId);
  const [siteWarning, setSiteWarning] = useState<string | null>(null);

  async function handleClick() {
    setSiteWarning(null);
    try {
      const result = await complete.mutateAsync();
      if (result.siteSyncError) setSiteWarning(result.siteSyncError);
    } catch {
      // Ошибка (нет фото/видео) уже показана через MutationError ниже.
    }
  }

  return (
    /* Строка решения эталона (property-detail.html, панель монтажёра):
       слева что произойдёт, справа главная чёрная кнопка `.pill`. */
    <>
      <div className="mod solve">
        <div className="t">
          <b>Готово, в продажу</b>
          <span>CRM переведёт объект в продажу и опубликует его на сайте.</span>
        </div>
        <div className="acts">
          <button className="pill sm" type="button" onClick={handleClick} disabled={complete.isPending}>
            {complete.isPending ? "Завершаем…" : "Готово, в продажу"}
          </button>
        </div>
      </div>
      <MutationError mutation={complete} fallback="Не удалось завершить подготовку" />
      {siteWarning && (
        <div className="quiet warn">
          <span className="dot warn" />
          <span className="txt">
            Объект переведён в продажу, но сайт отказал в публикации: {siteWarning}. Опубликуйте вручную кнопкой
            «Опубликовать», когда сайт снова доступен.
          </span>
        </div>
      )}
    </>
  );
}

/**
 * Публикация готового ролика в TikTok вручную (17.09.2026) — для демо-видео на
 * ревью приложения TikTok (нужен реальный клик в интерфейсе, автопубликация
 * этого не даёт) и для повторной отправки, когда объект уже опубликован в
 * остальных каналах, а TikTok — ещё нет.
 *
 * Гейт по роли — ТОЧНАЯ копия requireMarketingRole на сервере (MARKETING,
 * DIRECTOR, ADMIN), а не can("properties.aiListing"): это право есть и у
 * EDITOR (см. packages/shared/src/permissions.ts), которому сюда хода нет —
 * показать кнопку монтажёру значило бы дать ему нажать её и получить 403.
 *
 * channels.TIKTOK.connected — тот же /marketing/channels-status, что уже
 * дёргает вкладка «Каналы» кабинета маркетинга; второго запроса не заводим.
 */
function TikTokPublishButton({ property }: { property: Property }) {
  const readOnly = useIsReadOnly();
  const role = useAuthStore((s) => s.agent?.role);
  const canSeeMarketing = role === "MARKETING" || role === "DIRECTOR" || role === "ADMIN";
  const { data: channelsStatus } = useChannelsStatus(canSeeMarketing);
  const publish = useTikTokManualPublish(property.id);
  const [result, setResult] = useState<{ ok: boolean; note?: string; error?: string } | null>(null);

  // Корзину отсекает вызывающий; здесь — роль, готовый ролик и подключённый канал.
  if (!tiktokVisible(property, { marketingRole: canSeeMarketing, tiktokConnected: !!channelsStatus?.channels.TIKTOK.connected, isTrashed: false })) return null;

  if ((property.publishedChannels ?? []).includes("TIKTOK")) {
    return (
      <div className="quiet ok">
        <span className="dot ok" />
        <span className="txt">TikTok: опубликовано</span>
      </div>
    );
  }

  async function handleClick() {
    if (readOnly) return;
    setResult(null);
    try {
      const res = await publish.mutateAsync();
      setResult(res);
    } catch {
      // Сетевой/серверный отказ — MutationError ниже уже покажет текст.
    }
  }

  return (
    <>
      <div className="mod solve">
        <div className="t">
          <b>Опубликовать ролик в TikTok</b>
          <span>Только в TikTok, остальные площадки не трогаются.</span>
        </div>
        <div className="acts">
          <button className="pill sm" type="button" onClick={handleClick} disabled={readOnly || publish.isPending}>
            {publish.isPending ? "Публикуем…" : "Опубликовать в TikTok"}
          </button>
        </div>
      </div>
      <MutationError mutation={publish} fallback="Не удалось опубликовать в TikTok" />
      {result && (
        <div className={result.ok ? "quiet ok" : "quiet crit"} role="status">
          <span className={result.ok ? "dot ok" : "dot crit"} />
          <span className="txt">{result.ok ? result.note ?? "Опубликовано в TikTok" : result.error}</span>
        </div>
      )}
    </>
  );
}

/**
 * Подпись под Reels — сгенерирована по шаблону сразу при создании объекта
 * (решение владельца 04.08.2026: шаблоны вместо ИИ — дешевле и мгновенно),
 * хранится в карточке. «Перегенерировать» берёт другой случайный шаблон и
 * АКТУАЛЬНЫЕ данные карточки на момент нажатия — не то, что было при создании,
 * поэтому подпись не устаревает вместе с ценой. Монтажёр правит текст руками
 * и сохраняет отдельной кнопкой перед публикацией.
 */
function ReelsCaptionBlock({
  propertyId,
  initialCaption,
  collapsible = false,
}: {
  propertyId: string;
  initialCaption: string | null;
  /** В просмотре карточки подпись свёрнута в строку (24.09.2026): поле на шесть
   *  строк посреди карточки — работа маркетинга и монтажёра, а видели его все
   *  с правом на описание. В правке и у монтажёра поле раскрыто сразу. */
  collapsible?: boolean;
}) {
  const [open, setOpen] = useState(!collapsible);
  const regenerate = useRegenerateReelsCaption(propertyId);
  const update = useUpdateProperty(propertyId);
  const [caption, setCaption] = useState(initialCaption ?? "");
  const [copied, setCopied] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setCaption(initialCaption ?? "");
  }, [initialCaption]);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(caption);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Буфер обмена закрыт настройками браузера — текст остаётся в поле, его
      // выделяют руками. Ронять из-за этого блок нельзя.
    }
  }

  async function handleSave() {
    setSaved(false);
    await update.mutateAsync({ reelsCaption: caption || null });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  const dirty = caption !== (initialCaption ?? "");

  if (!open) {
    return (
      <div className="quiet">
        <span className="dot gold" />
        <span className="txt">Подпись для Reels{initialCaption ? " готова" : " ещё не написана"}.</span>
        <button className="lnk" type="button" onClick={() => setOpen(true)}>
          Открыть
        </button>
      </div>
    );
  }

  return (
    /* Подпись для Reels — тихая строка эталона (property-detail.html, «Черновик
       описания»): решение принимается ссылками, а не карточкой-уведомлением. */
    <>
      <div className="quiet">
        <span className="dot gold" />
        <span className="txt">
          Подпись для Reels{initialCaption ? " готова" : " ещё не сгенерирована"}.
          «Перегенерировать» сразу заменяет текст и сохраняет его; свою правку сохраняйте кнопкой «Сохранить правку».
        </span>
        <button className="lnk" type="button" disabled={regenerate.isPending} onClick={() => regenerate.mutate()}>
          {regenerate.isPending ? "Подбираем…" : "Перегенерировать"}
        </button>
      </div>
      <MutationError mutation={regenerate} fallback="Не удалось перегенерировать подпись" className="mt-1.5" />
      <div className="why">
        <textarea
          value={caption}
          onChange={(e) => setCaption(e.target.value)}
          rows={6}
          aria-label="Подпись для Reels"
        />
      </div>
      <div className="quiet">
        <span className="spacer" />
        <button className="pill ghost sm" type="button" onClick={handleCopy}>
          {copied ? "Скопировано" : "Скопировать"}
        </button>
        {dirty && (
          <button className="pill sm" type="button" onClick={handleSave} disabled={update.isPending}>
            {update.isPending ? "Сохраняем…" : saved ? "Сохранено" : "Сохранить правку"}
          </button>
        )}
      </div>
    </>
  );
}

/**
 * Контакт владельца. Поле правится прямо на карточке и сохраняется по потере
 * фокуса — отдельной кнопки «сохранить» здесь никогда не было и заводить её ради
 * одного поля не стоит. Через PhoneInput, чтобы плюс и код страны не набирали
 * руками (замечание владельца 08.08.2026) и чтобы скобки с дефисами из
 * скопированного номера не доезжали до базы.
 */
function OwnerContactField({
  value,
  disabled,
  onSave,
}: {
  value: string;
  disabled?: boolean;
  onSave: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  // Номер могли поправить в другом месте (например, мастером объекта) — карточка
  // перезапросила данные, и черновик должен подхватить свежее значение.
  useEffect(() => setDraft(value), [value]);
  return (
    <PhoneInput
      value={draft}
      disabled={disabled}
      placeholder="Телефон владельца"
      onChange={setDraft}
      onBlur={() => {
        if (draft !== value) onSave(draft);
      }}
    />
  );
}
