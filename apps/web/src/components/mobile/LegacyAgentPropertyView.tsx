import { ShellOwnHeader } from "../rh2/ShellOwnHeader";
import { MobileLinkButtons, MobileParamTiles, MobilePriceCard, MobilePropertyHeader, MobilePropertyHero } from "./PropertyMobileBlocks";
import { propertyParams } from "../../lib/propertyParams";
import { MutationError } from "../MutationError";
import { formatPropertyCode } from "../../lib/clientFormat";
import { PropertyPhotoManager } from "../PropertyPhotoManager";
import { PropertyClipVideoCard } from "../PropertyClipVideoCard";
import { PropertyHistoryCard } from "../PropertyHistoryCard";
import { AgentVideoStatus, PropertyVideoFixCard, FacebookGroupShareBlock, RepostBlock, SocialExtrasBlock } from "../PropertyVideoFixCard";
import { PropertyCoverStatus } from "../PropertyCoverStatus";
import { PropertyStatsCard } from "../PropertyStatsCard";
import { PropertyVoiceDisclosure } from "../PropertyVoiceCard";
import { OwnerReportCard } from "../OwnerReportCard";
import { PropertyShareLink } from "../property/PropertyShareLink";
import { ShowingQuickForm } from "../ShowingQuickForm";
import { useState, type ComponentType, type ReactNode, type Dispatch, type SetStateAction } from "react";
import { propertyFloorsLabel } from "@royal-home/shared";
import type { Property } from "../../types";
import type { useCan } from "../../lib/permissions";
import type { useUpdateProperty } from "../../hooks/useProperties";
import type { PendingPropertyDeleteRequest } from "../../hooks/useDeleteRequests";

type Can = ReturnType<typeof useCan>;
type Update = ReturnType<typeof useUpdateProperty>;
type Toggle = Dispatch<SetStateAction<boolean>>;
/** Shared page helpers stay owned by the page; this view owns only the legacy phone layout. */
interface ViewParts {
  InlineDoneButton: ComponentType<{ onClick: () => void }>;
  InlineEditLink: ComponentType<{ label: string; onClick: () => void }>;
  DemandLine: ComponentType<{ count: number | undefined; onOpen: () => void }>;
  DescriptionBlock: ComponentType<{ property: Property; canEdit: boolean; isTrashed: boolean; can: Can; updateProperty: Update; onSaved?: () => void }>;
}
interface ViewSlots {
  trashedNotice: ReactNode; addressNotice: ReactNode; lockedNotice: ReactNode;
  reelsBlock: ReactNode; promotionBlock: ReactNode; shareOpensBlock: ReactNode;
  matchDialog: ReactNode; deleteDialog: ReactNode; requestDeleteDialog: ReactNode;
}
interface Props {
  property: Property; can: Can; updateProperty: Update;
  isTrashed: boolean; canEnterEdit: boolean; canInlineEdit: boolean;
  editingPhotos: boolean; setEditingPhotos: Toggle; onEditParams: () => void; onInlineDone: () => void;
  showSolve: boolean; viewSolve: ReactNode; dealSlot?: ReactNode; fieldsBlock: ReactNode;
  role: string | undefined; canMarkGroupShare: boolean; changeRequestBlock: ReactNode; sourcesBlock: ReactNode;
  isResponsibleForProperty: boolean; docsBlock: ReactNode;
  /** То же право, что у «Назначить показ» на ПК (PropertyPriceCard.onSchedule). */
  canSchedule?: boolean;
  deleteMode: "delete" | "request" | null; pendingDeleteRequest: PendingPropertyDeleteRequest | null;
  setRequestDeleteOpen: Toggle; setDeleteOpen: Toggle; setMatchOpen: Toggle;
  placeLine: (property: Property) => string;
  parts: ViewParts; slots: ViewSlots;
}

export function LegacyAgentPropertyView({ property, can, updateProperty, isTrashed, canEnterEdit, onEditParams, canInlineEdit, editingPhotos, setEditingPhotos, onInlineDone, showSolve, viewSolve, dealSlot, fieldsBlock, role, canMarkGroupShare, changeRequestBlock, sourcesBlock, isResponsibleForProperty, docsBlock, deleteMode, pendingDeleteRequest, setRequestDeleteOpen, setDeleteOpen, setMatchOpen, placeLine, canSchedule = false, parts, slots }: Props) {
  const { InlineDoneButton, InlineEditLink, DemandLine, DescriptionBlock } = parts;
  const [showingOpen, setShowingOpen] = useState(false);
  const canShare = !!property.siteUrl;
  const photos = property.photos ?? [];
  const floorsInfo = propertyFloorsLabel(property);
  const floorLabel = floorsInfo ? (floorsInfo.label === "Этаж" ? `, ${floorsInfo.value} этаж` : `, ${floorsInfo.value}`) : "";
  return (
      <div className="rh2 screens">
        <ShellOwnHeader />
        <div className="scr">
          <MutationError mutation={updateProperty} fallback="Не удалось сохранить изменение" />
          {slots.trashedNotice}
          <MobilePropertyHeader
            // Номер объекта — мелкой строкой, а не в заголовке: «ОБ-000086 · длинное
            // название» не помещалось в шапку телефона (разбор 24.09.2026, пункт 13).
            title={property.title}
            subtitle={`${formatPropertyCode(property.shortId)} · ${placeLine(property)}. ${property.areaSqm} м²${floorLabel}`}
            backTo="/properties"
            // Карандаш в шапке — форма параметров (цена, площадь, адрес). Остальное
            // правится на месте, кнопкой у своего блока (пункт 17 разбора).
            onEdit={canEnterEdit ? onEditParams : null}
          />
          {slots.addressNotice}
          {slots.lockedNotice}
          <MobilePropertyHero photos={photos} />
          {/* Фото на телефоне правятся на месте (пункт 17 разбора): сетка-редактор
              появляется только по «Изменить фото» и уходит по «Готово» — в
              просмотре её нет (владелец 21.09: «как будто их можно удалять»). */}
          {canInlineEdit &&
            (editingPhotos ? (
              <div className="card">
                <div className="sec-h stack">
                  <h2>Фотографии</h2>
                </div>
                <PropertyPhotoManager propertyId={property.id} shortId={property.shortId} photos={property.photos} readOnly={false} embedded />
                <InlineDoneButton
                  onClick={() => {
                    setEditingPhotos(false);
                    onInlineDone();
                  }}
                />
              </div>
            ) : (
              <InlineEditLink label="Изменить фото" onClick={() => setEditingPhotos(true)} />
            ))}
          <MobilePriceCard property={property} canSeeMatch={!isTrashed && can("clients.viewAll")} />
          {/* Действия под ценой — те же, что на ПК (17.11.2026, аудит F1-2: агент
              на показе не мог ни скинуть клиенту ссылку, ни назначить показ с
              карточки объекта). Компоненты общие с ПК: PropertyShareLink и
              ShowingQuickForm; сторож lib/__tests__/cardActionParity.test.ts. */}
          {(canSchedule || canShare) && (
            <div className="card tight">
              {/* Не `.wrap`: в теме это обёртка страницы с отступом 28px. */}
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {canSchedule && (
                  <button type="button" className="pill" onClick={() => setShowingOpen(true)}>
                    Назначить показ
                  </button>
                )}
                <PropertyShareLink className="pill ghost" label="Поделиться ссылкой" property={property} />
              </div>
            </div>
          )}
          <MobileParamTiles items={propertyParams(property)} />
          {!isTrashed && can("clients.viewAll") && <DemandLine count={property.demandCount} onOpen={() => setMatchOpen(true)} />}
          {property.instagramUrl && <MobileLinkButtons instagramUrl={property.instagramUrl} />}

          {showSolve && viewSolve}
          {dealSlot}

          {/* Порядок на телефоне (24.09.2026): фото → цена → параметры → что решить
              → кто ведёт и описание → ролик, статистика, история. Раньше «Кто ведёт
              объект» и «Описание» стояли после пяти карточек статистики, и до
              собственника приходилось листать через весь экран. */}
          {fieldsBlock}

          {(property.description || canInlineEdit) && (
            <div className="card">
              <div className="sec-h stack">
                <h2>Описание</h2>
              </div>
              <DescriptionBlock property={property} canEdit={canInlineEdit} isTrashed={isTrashed} can={can} updateProperty={updateProperty} onSaved={onInlineDone} />
            </div>
          )}

          {/* Ролик уже выпущен и с ним что-то не так — четыре способа исправить,
              не заполняя карточку заново (19.09.2026). Панель прячется сама,
              пока публиковать было нечего. */}
          {role === "AGENT" ? (
            <>
              <AgentVideoStatus property={property} />
              <FacebookGroupShareBlock property={property} readOnly={isTrashed} canEdit={canMarkGroupShare} />
            </>
          ) : (
            <>
            <PropertyVideoFixCard property={property} readOnly={isTrashed} canEdit={canEnterEdit} />
            <FacebookGroupShareBlock property={property} readOnly={isTrashed} canEdit={canMarkGroupShare} />
            <RepostBlock property={property} readOnly={isTrashed} canEdit={canEnterEdit} />
            <SocialExtrasBlock property={property} readOnly={isTrashed} />
            <PropertyCoverStatus property={property} readOnly={isTrashed} />
            </>
          )}
          {changeRequestBlock}
          {/* Статистика объекта — тот же компонент, что вкладка «Статистика» на
              компьютере: на телефоне вкладок нет, секции идут стопкой. */}
          {/* «Отчёт владельцу» — тот же компонент и то же условие, что вкладка
              «Статистика» на ПК: ведущий объект, не в корзине. */}
          {isResponsibleForProperty && !isTrashed && <OwnerReportCard propertyId={property.id} />}
          <PropertyStatsCard propertyId={property.id} />
          {/* «Голос рынка» и диагноз — тот же компонент, что вкладка на компьютере; на
              телефоне свёрнут, чтобы не грузить шесть секций, пока их не открыли. */}
          <PropertyVoiceDisclosure propertyId={property.id} />

          {slots.reelsBlock}
          {slots.promotionBlock}

          {/* ФОТО ЗДЕСЬ БОЛЬШЕ НЕТ (21.09.2026). Владелец: «и тут есть фото, и
              внизу карточки есть фото, причём как будто их можно удалять — они
              так выглядят». Те же снимки уже показаны лентой в шапке
              (MobilePropertyHero, листается пальцем и открывается во весь
              экран), а здесь стояла сетка-редактор в режиме «только смотреть»:
              она сохраняет вид редактора (рамки кадров, значки), поэтому и
              читается как «сейчас удалю». Загрузка и порядок фотографий живут
              в режиме правки этой же страницы — второго места им не нужно. */}
          <div className="card">
            <div className="sec-h stack">
              <h2>Видео</h2>
            </div>
            {sourcesBlock}
            <PropertyClipVideoCard property={property} readOnly={!canInlineEdit} />
          </div>

          {slots.shareOpensBlock}

          <PropertyHistoryCard
            propertyId={property.id}
            status={property.status}
            isResponsible={isResponsibleForProperty}
            assignedAgentName={property.assignedAgent?.fullName}
            intakeAgentName={property.intakeAgent?.fullName}
          />

          {docsBlock}
          {deleteMode === "request" && (
            <div className="card tight">
              {pendingDeleteRequest ? <p className="sub keep">Заявка на удаление отправлена, ждёт решения директора.</p> : <button type="button" className="pill ghost" onClick={() => setRequestDeleteOpen(true)}>Направить на удаление</button>}
            </div>
          )}
          {deleteMode === "delete" && <button type="button" className="pill ghost" onClick={() => setDeleteOpen(true)}>Удалить объект</button>}
        </div>
        {slots.matchDialog}
        {showingOpen && <ShowingQuickForm initialPropertyId={property.id} onClose={() => setShowingOpen(false)} />}
        {slots.deleteDialog}
        {slots.requestDeleteDialog}
      </div>
    );
}
