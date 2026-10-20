import { ShellOwnHeader } from "../rh2/ShellOwnHeader";
import { useRef, type ReactNode } from "react";
import { CalendarClock, Home, MessageSquare, MoreVertical, Pencil } from "lucide-react";
import { Rh2Sheet } from "../rh2/Rh2Sheet";
import { CallPhoneChooser, type CallPhoneOption } from "../CallPhoneChooser";
import { ClientAvatar } from "../ClientAvatar";
import { ClientMoreMenu, countMoreItems, type MoreGroup } from "../ClientMoreMenu";
import type { ClientConversation } from "../ClientChatPanel";
import { ClientInsight } from "../ClientInsight";
import { ClientDesiredPlacesMap } from "../ClientDesiredPlacesMap";
import { InteractionTimeline } from "../InteractionTimeline";
import { useDismissSimilarClient, type SimilarNotesClient } from "../../hooks/useDuplicates";
import { relativeTime } from "../../lib/format";
import type { Client } from "../../types";
import { ClientCardFacts } from "../ClientCardContext";

/**
 * Карточка клиента на телефоне — облик артефакта владельца
 * `docs/pult/theme-2026/artifact-c99db05f-mobile-nav.html`, функция `renderClient`:
 * `.chead` (аватар/имя/плашки), `.qa` (быстрые действия), четыре секции
 * `.sec`/`.card-s` — «Коротко», «Телефоны», «Объекты», «Последние события».
 * Стили уже перенесены в theme-2026-mobile-home.css (область `.rh2 .mh`).
 *
 * Вынесено из ClientDetail.tsx 15.09.2026 (владелец, «выдели мобильную ветку в
 * отдельный файл, десктоп не трогай»): вся логика, права, мутации и модальные
 * окна остаются в ClientDetail — сюда приходят уже готовые данные и обработчики,
 * этот файл только рисует. Реальных возможностей на карточке больше, чем в
 * упрощённом макете (переписка, полная история, редкие действия). С 21.09.2026
 * «Последние события» — это ОДИН свёрнутый раздел, показывающий всю хронологию
 * на месте, а «Ещё» из шапки — второстепенные действия и справка «О карточке»,
 * которых в макете не было вовсе.
 */
export interface MobileClientCardProps {
  client: Client;
  locked: boolean;
  pending: boolean;
  isSeller: boolean;
  canBuy: boolean;
  propertyWorkspace: ReactNode;
  isOther: boolean;
  canCallTransferred: boolean;
  mainStatusChip: ReactNode;
  editingName: boolean;
  nameDraft: string;
  onStartEditName: () => void;
  onNameDraftChange: (v: string) => void;
  onCancelEditName: () => void;
  onSubmitName: (v: string) => void;
  savingName: boolean;
  /** Общие блоки, одинаковые на ПК и телефоне (решить сейчас, сигналы,
   *  проверка безопасности, «Где сделка») — тот же узел, что и в десктопной
   *  разметке, просто вставленный сюда, а не второй источник. */
  commonMiddle: ReactNode;
  /** Готовые узлы из ClientDetail.tsx — см. пояснение у аргументов ниже. */
  propertyCounts: ReactNode;
  similarWarning: ReactNode;
  phoneOptions: CallPhoneOption[];
  conversations: ClientConversation[];
  interactions: NonNullable<Client["interactions"]>;
  lastPropertiesSent: { at: string; count: number } | null;
  /** Одна кнопка «Подбор · N» везде (17.09.2026 вечер, docs/match-policy-plan-17-09.md
   *  §6) — заменяет прежние `matchCountButton`+`onSelectProperty`: клик открывает
   *  ту же панель `MatchPanel`, что и на ПК. Показывается по тем же условиям,
   *  что были у «Выбрать объект» (locked/isSeller/isOther уже переданы отдельно). */
  onOpenMatch: () => void;
  /** `total` из `useClientMatch` — пока не загрузился, кнопка просто «Подбор». */
  matchTotal: number | undefined;
  canMerge: boolean;
  similarNotes: SimilarNotesClient[] | undefined;
  onOpenChat: () => void;
  onShowInteraction: () => void;
  onMerge: (client: SimilarNotesClient | true) => void;
  moreGroups: MoreGroup[];
  /** Причина отказа последнего действия из меню (перевод в кандидаты). */
  moreError: string | null;
  showMoreSheet: boolean;
  onShowMoreSheet: (v: boolean) => void;
}

export function MobileClientCard({
  client,
  locked,
  pending,
  isSeller,
  canBuy,
  propertyWorkspace,
  isOther,
  canCallTransferred,
  mainStatusChip,
  editingName,
  nameDraft,
  onStartEditName,
  onNameDraftChange,
  onCancelEditName,
  onSubmitName,
  savingName,
  onOpenMatch,
  matchTotal,
  commonMiddle,
  // Спорные счётчики объектов и предупреждение о похожих записях приходят
  // ГОТОВЫМИ УЗЛАМИ, а не компонентами по импорту: они живут в ClientDetail.tsx,
  // который сам подключает этот файл, и импорт обратно замыкал круг
  // (audit:deps ловит такое ошибкой — порядок инициализации становится
  // неявным, и правка на одном конце отзывается на другом).
  propertyCounts,
  similarWarning,
  phoneOptions,
  conversations,
  interactions,
  lastPropertiesSent,
  canMerge,
  similarNotes,
  onOpenChat,
  onShowInteraction,
  onMerge,
  moreGroups,
  moreError,
  showMoreSheet,
  onShowMoreSheet,
}: MobileClientCardProps) {
  const dismissSimilar = useDismissSimilarClient(client.id);
  const propertiesRef = useRef<HTMLElement>(null);

  return (
    <div className="rh2 mh">
      <ShellOwnHeader />
      {/* Шапка карточки: аватар, имя, плашки статуса. Правка имени (форма или
          кнопка-карандаш) — тот же `nameBlock`, что и на ПК, готовый узел из
          ClientDetail, чтобы поле имени не жило в двух местах. */}
      <div className="chead">
        <span className="av">
          <ClientAvatar fullName={client.fullName} avatarUrl={client.avatarUrl} size={96} />
        </span>
        {editingName ? (
          <form
            className="wrap"
            onSubmit={(e) => {
              e.preventDefault();
              onSubmitName(nameDraft);
            }}
          >
            <input
              className="inp"
              autoFocus
              value={nameDraft}
              onChange={(e) => onNameDraftChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") onCancelEditName();
              }}
              aria-label="Имя клиента"
            />
            <button className="pill sm" type="submit" disabled={savingName || nameDraft.trim().length < 2}>
              Сохранить
            </button>
            <button className="pill ghost sm" type="button" onClick={onCancelEditName}>
              Отмена
            </button>
          </form>
        ) : (
          <div className="cd-name-row">
            <h1 className="n">
              {client.fullName}
              {client.lastName ? ` ${client.lastName}` : ""}
            </h1>
            {!locked && (
              <button type="button" className="cd-name-edit" onClick={onStartEditName} aria-label="Изменить имя">
                <Pencil className="i" />
              </button>
            )}
          </div>
        )}
        <div className="tags">
          {mainStatusChip}
          <span className="chip mute">{isOther ? "Прочее обращение" : isSeller ? canBuy ? "Продаёт и покупает" : "Продавец" : "Покупатель"}</span>
          {pending && <span className="chip warn">Ждёт принятия</span>}
        </div>
        <p className="client-card-meta">{client.assignedAgent ? `Агент ${client.assignedAgent.fullName}` : "Агент не назначен"}<br />Последний контакт {relativeTime(client.lastContactAt)}</p>
      </div>

      {/* Быстрые действия — «Позвонить» через CallPhoneChooser (сам решает: один
          номер звонит сразу, 2–4 открывают шторку выбора). «Написать» ведёт в
          обычный чат (решение владельца), а не в шторку-пузырь — не менять. */}
      <div className="qa" role="group" aria-label="Быстрые действия">
        {(!locked || canCallTransferred) && (
          <CallPhoneChooser
            clientId={client.id}
            phones={phoneOptions}
            variant="full"
            label="Позвонить"
            title="Позвонить через CRM, разговор запишется и попадёт в хронологию"
            className="main"
          />
        )}
        {!locked && (
          <>
            <button
              type="button"
              disabled={conversations.length === 0}
              onClick={onOpenChat}
              title={conversations.length > 0 ? "Открыть переписку" : "Клиент ещё не писал ни в один канал"}
            >
              <MessageSquare className="i" />
              Написать
            </button>
            <button type="button" onClick={canBuy ? onOpenMatch : () => propertiesRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })}>
              <Home className="i" />
              {canBuy ? "Подбор" : "Объекты"}
            </button>
          </>
        )}
        {countMoreItems(moreGroups) > 0 && (
          <button type="button" aria-haspopup="dialog" onClick={() => onShowMoreSheet(true)}>
            <MoreVertical className="i" />
            Ещё
          </button>
        )}
      </div>

      {commonMiddle}

      {pending && locked ? (
        <section className="sec">
          <div className="card-s big brief">
            Запрос клиента, бюджет и история откроются, когда вы примете лид.
          </div>
        </section>
      ) : (
        <>
          {/* Коротко: одна сводка ИИ обо всём (владелец 29.09.2026). Строка-суть,
              плашки «Что просит», запрос своими словами и отдельный раздел
              «Телефоны» убраны: всё это ИИ вплетает в сводку, а номер
              выбирается в кнопке «Позвонить» (два и больше — шторка выбора). */}
          <section className="sec">
            <div className="sec-t">
              <h2>Коротко</h2>
              <span className="cnt">собрано автоматически</span>
            </div>
            <div className="card-s" style={{ padding: "12px 16px" }}>
              <ClientCardFacts client={client} />
              <ClientInsight client={client} />
              {propertyCounts}
              {client.desiredPlaces && client.desiredPlaces.length > 0 && (
                <details className="cd-about" style={{ marginTop: 12 }}>
                  <summary>Где ищет</summary>
                  <div style={{ marginTop: 10 }}>
                    <ClientDesiredPlacesMap places={client.desiredPlaces} />
                  </div>
                </details>
              )}
            </div>
          </section>

          {/* Объекты: подбор живёт отдельным окном, здесь только итог отправки. */}
          <section className="sec" ref={propertiesRef}>
            <div className="sec-t">
              <h2>{isSeller ? "Объекты продавца" : "Подбор и интерес"}</h2>
            </div>
            <div className="card-s" style={{ padding: "12px 16px" }}>
              {propertyWorkspace}
            </div>
          </section>

          {/* Последние события — ОДИН свёрнутый раздел на всю хронологию.
              Владелец 21.09.2026: «последние события должны быть аккуратно как
              раздел, причём закрытый, который при нажатии потом открывается, он
              не обязательный» и «в „Ещё“ отображается вся история — то же самое,
              что и в последних событиях, будто это дубль какой-то».

              Дублем это и было: секция печатала верхушку тех же `interactions`,
              а шторка «Ещё → Вся история» — их же целиком. Две записи об одном
              событии на одном экране читаются как два события. Теперь список
              один, лежит закрытым и разворачивается тем же `.cd-about`, что и
              остальные сворачиваемые строки карточки; кнопка «Вся история» и
              блок в шторке убраны, второго места у истории не осталось. */}
          <section className="sec">
            <div className="card-s" style={{ padding: "4px 16px 12px" }}>
              {interactions.length > 0 ? (
                <details className="cd-about" style={{ borderTop: 0, marginTop: 0 }}>
                  <summary>
                    Последние события
                    <span className="s" style={{ marginLeft: 6, fontWeight: 400 }}>
                      {client.interactionsTotal ?? interactions.length}
                    </span>
                  </summary>
                  <div style={{ marginTop: 10 }}>
                    {/* Число — всей истории (interactionsTotal), не двухсот пришедших
                        с карточкой; старшие догружает сама хронология (02.10.2026). */}
                    <InteractionTimeline
                      interactions={interactions}
                      clientId={client.id}
                      total={client.interactionsTotal}
                      truncated={(client.interactionsTotal ?? 0) > interactions.length}
                    />
                  </div>
                </details>
              ) : (
                <p className="s" style={{ margin: "10px 0 0" }}>
                  Взаимодействий пока не было.
                </p>
              )}
            </div>
          </section>
        </>
      )}

      {showMoreSheet && (
        <Rh2Sheet title="Ещё" onClose={() => onShowMoreSheet(false)}>
          {canMerge && !locked && similarNotes && similarNotes.length > 0 && <div>{similarWarning}</div>}
          <ClientMoreMenu groups={moreGroups} error={moreError} onPick={() => onShowMoreSheet(false)} />
        </Rh2Sheet>
      )}
    </div>
  );
}
