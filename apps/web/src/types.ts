import type {
  NotificationLevel,
  PropertyType,
  PropertyCondition,
  PropertyStatus,
  PropertyStage,
  MarketType,
  PropertyDetailKey,
  Currency,
  ClientStatus,
  ClientSource,
  InteractionType,
  InteractionOutcome,
  DealStage,
  CallTranscriptionStage,
  PropertyVideoHandoffCard,
  PropertyVideoHandoffBrief,
} from "@royal-home/shared";

export interface District {
  id: string;
  name: string;
  city: string;
}

/** Синоним ориентира (GeoAlias, targetType="landmark") — как его печатает агент. */
export interface LandmarkAlias {
  id: string;
  text: string;
}

/** Ориентир справочника (блок J, docs/geo-match-plan-12-09.md) — координаты
 *  приходят строкой (Prisma Decimal), как и у остальных lat/lng полей API. */
export interface Landmark {
  id: string;
  name: string;
  category: string;
  address: string | null;
  districtId: string | null;
  lat: string;
  lng: string;
  enabled: boolean;
  source: "import" | "agent";
  radiusM: number | null;
  createdById: string | null;
  updatedById: string | null;
  updatedAt: string;
  /** 0/50/100 — «обычный»/«важный»/«очень важный» (дополнение владельца
   *  12.09.2026): решает, какой ОДИН ориентир рядом назвал бы местный. */
  weight: number;
  /** Сколько раз название встретилось в разговорах — считается отдельным
   *  блоком добычи (блок O), здесь только показывается, если больше нуля. */
  mentions: number;
  /** «До центра города» — отдельная пометка для описания места. */
  isCityCenter: boolean;
  aliases: LandmarkAlias[];
}

export interface PropertyPhoto {
  id: string;
  url: string;
  thumbUrl: string;
  order: number;
  /** Кандидат улучшения ИИ, ждущий одобрения (пункт 7 очереди, 23.08.2026) —
   *  заполнены только между запуском и решением «одобрить»/«отклонить»,
   *  url/thumbUrl выше это не трогает (см. PropertyPhotoManager). */
  enhancedUrl?: string | null;
  enhancedThumbUrl?: string | null;
  enhancedRequestedAt?: string | null;
  enhancedRequestedBy?: string | null;
  /** Бэкап того, что было в url/thumbUrl до одобрения улучшения — заполняется
   *  только тогда, когда улучшение уже хоть раз одобрили. */
  originalUrl?: string | null;
  originalThumbUrl?: string | null;
}

export interface AgentRef {
  id: string;
  fullName: string;
  avatarUrl?: string | null;
}

export interface Property {
  id: string;
  /** Короткий числовой ID для URL (/properties/1042) — id остаётся настоящим для API-вызовов. */
  shortId: number;
  title: string;
  type: PropertyType;
  rooms: number | null;
  areaSqm: string;
  /** Площадь участка в сотках (дом, земля) — десятичная строка базы или null. */
  landAreaSotka?: string | null;
  floor: number | null;
  totalFloors: number | null;
  /** Количество окон — поле карточки из спецификации владельца. */
  windowCount: number | null;
  price: string;
  currency: Currency;
  // Закрытый объект («только для своих») может остаться без района/адреса
  // вовсе (владелец 14.09.2026) — сервер достраивает их по координатам
  // телефона, когда получится; не получилось — так и остаётся null.
  districtId: string | null;
  district: District | null;
  address: string | null;
  /** Ориентир — короткая фраза вроде «рядом с ТЦ Садбарг», «за Овиром» (пункт 10
   *  владельца, 23.09.2026): свободный текст, необязателен. */
  landmark: string | null;
  condition: PropertyCondition;
  amenities: string[];
  description: string | null;
  status: PropertyStatus;
  publishedOnSite: boolean;
  /** Несайтовый объект — не публикуется на сайте, минует конвейер модерации фото/видео,
   *  доступен клиенту только по приватной ссылке. Задаётся только при создании. */
  offSite: boolean;
  /** Публичный адрес объявления на royalhome.tj — им делятся с клиентом.
   *  Собирает сервер (api: lib/siteListingUrl.ts); null у неопубликованного
   *  объекта и в списках, где карточка приходит без этого поля. */
  siteUrl?: string | null;
  ownerContact: string | null;
  /** `true` — поле замаскировано правом `properties.viewOwners` (lib/ownerContact.ts
   *  на сервере), а не потому, что телефон правда не заполнен. Отличать эти два
   *  случая на клиенте нечем: оба дают `ownerContact: null` — честный флаг решает
   *  это на сервере, том же месте, где решается и сама маскировка. */
  ownerContactHidden?: boolean;
  /** Карточка продавца, к которой привязан объект (sellerClientId) — только в
   *  ответе GET /properties/:id и только тем, кому виден номер собственника.
   *  `canOpen` — откроется ли у этого сотрудника карточка клиента. */
  sellerClient?: { id: string; shortId: number; fullName: string; canOpen: boolean } | null;
  assignedAgentId: string | null;
  assignedAgent: AgentRef | null;
  /** Агент-интейкер (принял заявку продавца и отработал) — получает 0.5% со сделки. */
  intakeAgentId?: string | null;
  intakeAgent?: AgentRef | null;
  /** Передача объекта другому агенту (24.09.2026): пока handoverPendingSince не
   *  пуст — объект передан текущему хозяину и ещё не принят им; причина и
   *  прежний хозяин остаются как история последней передачи. */
  handoverPendingSince?: string | null;
  handoverFromAgentId?: string | null;
  handoverFromAgent?: AgentRef | null;
  handoverReason?: string | null;
  /** Кто завёл карточку — третий из тех, кому сервер разрешает её править
   *  (canManageProperty). Сервер отдаёт поле всегда (presentProperty). */
  createdById?: string | null;
  viewsCount: number;
  demandCount?: number;
  /** Балл совпадения с требованиями клиента (0..100) — только в ответе
   *  `GET /clients/:id/match` (панель «Подбор», режим клиента, 17.09.2026).
   *  Отсутствует/`null` в списках — там сравнивать не с кем. */
  score?: number | null;
  /** Расстояние до желаемого места клиента в метрах — тот же ответ, что и score.
   *  `null` — у клиента нет координаты желаемого места или объект без координат. */
  distanceM?: number | null;
  /** Этап конвейера подготовки — считает сервер (api: lib/propertyPipeline.ts).
   *  Имя pipeline, а не stage: stage у объекта — стадия строительства. */
  pipeline?: PropertyStageState | null;
  aiReason?: string | null;
  createdAt: string;
  updatedAt: string;
  soldAt: string | null;
  soldPrice: string | null;
  lat: string | null;
  lng: string | null;
  instagramUrl: string | null;
  /** Подпись под Reels — по шаблону (не ИИ), сгенерирована при создании,
   *  правится вручную или перегенерируется другим случайным шаблоном. */
  reelsCaption: string | null;
  /**
   * Этап передачи ролика монтажёру (api: lib/videoHandoff.ts, enum
   * PropertyVideoHandoffStatus). NONE — не передавали, QUEUED — стоит в
   * очереди за другим объектом, SENT_TO_EDITOR — у монтажёра, RECEIVED —
   * готовый ролик получен.
   *
   * Поле сервер отдавал с самого начала (карточка объекта возвращает запись
   * целиком, routes/properties/list.ts), но в этом типе его не было — и экран
   * рисовал блок «Сырое видео» с текстом «объект остаётся в подготовке» уже
   * после того, как ролик ушёл на монтаж. Жалоба владельца 21.09.2026.
   */
  videoHandoffStatus?: "NONE" | "QUEUED" | "SENT_TO_EDITOR" | "RECEIVED" | null;
  /** Блок «Монтаж» карточки (25.09.2026, задание C) — очередь, попытки
   *  отправки, доставка по каждому ролику, монтажёр. Приходит только с
   *  карточки одного объекта (GET /properties/:id); null у объектов, которые
   *  через хендофф вообще не проходили. См. PropertyVideoFixCard.tsx. */
  videoHandoff?: PropertyVideoHandoffCard | null;
  /** Компактное состояние монтажа для чипа в строке списка (25.09.2026,
   *  задание D) — приходит и в списках, и в карточке (lib/propertyListItem.ts).
   *  См. PropertyRow.tsx. */
  videoHandoffBrief?: PropertyVideoHandoffBrief;
  /** Объект вручную «открыт под готовый ролик» (POST .../video-handoff/manual,
   *  lib/publishedVideoFix.ts): SENT_TO_EDITOR, но бот его не вёз — сервер
   *  разрешает снова отправить на монтаж (lib/videoHandoff.ts::requeueVideoHandoff),
   *  и карточка обязана показать ту же кнопку. Поле сервер отдаёт целиком с
   *  записью, как и остальные videoHandoff*. */
  videoHandoffManualSince?: string | null;
  /** Готовый ролик от монтажёра (lib/videoHandoff.ts) — публичный /uploads/handoff/...
   *  путь, источник для автопубликации и ручной публикации в TikTok
   *  (POST /properties/:id/tiktok-publish). null — монтажёр ещё не прислал ролик. */
  videoHandoffFinalPath: string | null;
  /** Обложки ChatGPT (25.09.2026) и причина, если последняя не создана. */
  socialCoverSquareUrl?: string | null;
  socialCoverStoryUrl?: string | null;
  socialCoverError?: string | null;
  /** Слот, на который поставлена публикация принятого ролика (lib/publishSchedule.ts,
   *  расстановка публикаций по времени, 21.09.2026) — не «отложено вручную», а
   *  всегда, даже когда ролик уходит почти сразу. null — публикация ещё не
   *  поставлена (ролик не принят). */
  scheduledPublishAt?: string | null;
  /** Почему слот именно такой — человеческая фраза, которую написала сама
   *  расстановка (lib/publishSchedule.ts, 23.09.2026). Показывается в карточке
   *  и в разделе «Расписание» кабинета маркетинга. Считать причину на экране
   *  заново нельзя: она обязана совпадать с тем, что реально сделал сервер. */
  scheduledPublishReason?: string | null;
  /** Каналы, куда объект УЖЕ опубликован (lib/socialPublish.ts::PublishChannel) —
   *  повторная публикация в них отсюда не идёт, кнопка/строка канала смотрит сюда. */
  publishedChannels: string[];
  /** id/ссылка поста по каждому каналу, где он есть (lib/videoHandoff.ts) —
   *  ключи FACEBOOK/TELEGRAM/YOUTUBE/INSTAGRAM (+ FACEBOOK_POST, запасной
   *  идентификатор того же поста). Приходит только с карточки одного объекта. */
  publishedPostIds?: Record<string, string> | null;
  /** Свежая неразобранная причина отказа публикации по каналу (ОБ-000113,
   *  routes/properties/list.ts::loadPublishErrorsByChannel) — ключи те же пять
   *  каналов, что в publishedChannels. Приходит только с карточки одного объекта. */
  publishErrors?: Record<string, string>;
  /** Короткий сжатый ролик карточки объекта (docs/plan-18-08-private-listings-and-video.md
   *  §3) — НЕ сырое видео (videoCount ниже) и не instagramUrl. Один на объект. */
  clipVideoUrl: string | null;
  clipVideoStatus: "NONE" | "PROCESSING" | "READY" | "FAILED";
  clipVideoDurationSec: number | null;
  photosApprovedAt: string | null;
  videoApprovedAt: string | null;
  /** Сколько сырых роликов загрузил агент. Приходит только с карточки одного
   *  объекта (GET /properties/:id) — в списках его нет, отсюда `?`. */
  videoCount?: number;
  photosRejectionCount: number;
  videoRejectionCount: number;
  reviewRejectionReason: string | null;
  reviewRejectionVoiceUrl?: string | null;
  reviewRejectionVoiceTranscript?: string | null;
  documents: string | null;
  listingAcceptedAt: string;
  stage: PropertyStage | null;
  marketType: MarketType | null;
  urgent: boolean;
  details: Partial<Record<PropertyDetailKey, string>> | null;
  metaTitle: string | null;
  metaDescription: string | null;
  h1: string | null;
  seoDesc: string | null;
  photos: PropertyPhoto[];
  priceHistory?: {
    id: string;
    oldPrice: string;
    oldCurrency: Currency;
    newPrice: string;
    newCurrency: Currency;
    createdAt: string;
  }[];
  /** Мягкое удаление — заполнено только для записей из Корзины (GET /properties/trash). */
  deletedAt?: string | null;
  deletedBy?: { id: string; fullName: string } | null;
  /** Оптимистичная блокировка (13.09.2026) — отправляется обратно на PATCH, чтобы
   *  сервер отказал 409, если карточку успели изменить между чтением и сохранением
   *  формы. См. propertyUpdateSchema.version и routes/properties/crud.ts. */
  version?: number;
}

/**
 * Вложение, присланное клиентом в переписку (фото или голосовое).
 *
 * `file` — имя файла для GET /attachments/:name, а не готовый адрес: файл лежит в
 * закрытом хранилище и отдаётся только по праву messages.viewAttachments. У кого
 * права нет, тому сервер присылает null — интерфейс показывает пометку.
 */
// Описаны один раз в @royal-home/shared: их же держится сервер
// (apps/api/src/lib/messageAttachments.ts).
import type { ConversationMessage, PropertyStageState } from "@royal-home/shared";
export type { MessageAttachment, ConversationMessage } from "@royal-home/shared";

/**
 * Желаемое место поиска покупателя — координата с радиусом (владелец 12.09.2026,
 * docs/geo-match-plan-12-09.md). См. Client.desiredPlaces.
 */
export interface ClientDesiredPlace {
  id: string;
  lat: number;
  lng: number;
  radiusM: number;
  label?: string | null;
}

export interface Client {
  id: string;
  /** Короткий числовой ID для URL (/clients/1042) — id остаётся настоящим для API-вызовов. */
  shortId: number;
  fullName: string;
  /** «Имя · Якорь» (владелец 21.09.2026, clientDisplayName в @royal-home/shared) —
   *  готовая строка с сервера в списках, где приходит: считает районы/бюджет/адрес
   *  объекта продавца, которых в этом типе может не быть. Нет поля — значит эндпоинт
   *  его не отдаёт (Корзина, «Потерянные» и т.п.), там fullName/formatClientName как раньше. */
  displayName?: string;
  /** Фамилия отдельным полем — необязательна, у старых карточек не заполнена. */
  lastName?: string | null;
  phone: string;
  /** Номер, С КОТОРОГО клиент пишет в WhatsApp (wa_id). Подставляется автоматически,
   *  не дожидаясь, пока человек продиктует номер. Не то же самое, что phone: писать
   *  могут с личного номера, а просить перезвонить — на другой. Агенту приходит
   *  замаскированным, пока лид не принят, — как и phone. */
  whatsappPhone?: string | null;
  /** ЗАПАСНЫЕ номера клиента: с них он тоже может позвонить или написать
   *  (18.08.2026). Нужны ТОЛЬКО для узнавания входящего — звоним всегда по
   *  `phone`. Агенту без права видеть телефон приходят замаскированными, как и
   *  `phone` (см. presentClient в apps/api/src/routes/clients.ts). */
  extraPhones?: string[];
  email: string | null;
  status: ClientStatus;
  /**
   * РАБОЧИЙ статус — единственный, которым управляет сам агент (ТЗ п. 3):
   * ACTIVE — клиент в работе, занимает слот в лимите активных лидов;
   * INACTIVE — «Неактивный», работа приостановлена, слот освобождён.
   *
   * Не путать со `status` (Новый/Горячий/Холодный/Потерянный) — его ставит CRM
   * сама, агент его не трогает. До 14.08.2026 поле приходило с сервера, но нигде
   * не отображалось: агент нажимал «Неактивный» и не видел на карточке никакой
   * разницы, а вернуть клиента в работу не мог вовсе.
   */
  workStatus?: "ACTIVE" | "INACTIVE" | "DEFERRED";
  /** «Отложенные» (задача G, план 03-04.09.2026) — присутствуют только при
   *  workStatus="DEFERRED", см. Client.deferredAt/deferredReason/deferredUntil
   *  на сервере (apps/api/prisma/schema.prisma). */
  deferredAt?: string | null;
  deferredReason?: string | null;
  deferredUntil?: string | null;
  /**
   * Светофор неактивных (lib/inactiveTrafficLight.ts): цвет ставит СИСТЕМА по
   * причине перевода и факту реального контакта, не агент. GREEN — пауза по делу
   * (клиент сам сказал «думаю»/«отложил»), YELLOW — нарушенное обещание
   * («перезвоню позже» и пропал), RED — живого контакта не было вовсе. null —
   * клиент ни разу не был в Неактивных (или карточка старше 21.08.2026 и не
   * переходила в Неактивные после этой даты — значение не восстанавливается
   * задним числом).
   */
  inactiveLevel?: "GREEN" | "YELLOW" | "RED" | null;
  /**
   * Сколько раз клиент уже переходил между агентами — общий счётчик передач и
   * отказов, по нему же сервер решает, исчерпан ли предел (ТЗ п. 21,
   * Settings.leadMaxTransfers). Нужен окну передачи, чтобы показать «передача 2
   * из 3», а не сообщать о потере клиента постфактум.
   */
  refusalCount?: number;
  /** BUYER (покупатель) | SELLER (продавец) | OTHER (работа/аренда/прочее — не назначается агенту). */
  kind?: "BUYER" | "SELLER" | "OTHER";
  /** У клиента есть и вторая сторона тоже (продаёт и одновременно покупает) —
   *  владелец 06.09.2026, разбор слепых зон п.4. См. clientKindLabel в shared. */
  dualIntent?: boolean;
  /** Сколько объектов на продажу услышал ИИ из разговоров — пишет только ИИ,
   *  агент может подать заявку на пересмотр (владелец 06.09.2026, разбор слепых
   *  зон п.3). null — ИИ ещё ничего не услышал. */
  sellerDeclaredPropertyCount?: number | null;
  /** Симметрично выше, но для покупателя: сколько объектов хочет купить —
   *  услышал ИИ, не агент (владелец 07.09.2026, «пусть у покупателя будет то
   *  же самое»). null — обычный случай, купить одну квартиру, ИИ не отмечал. */
  buyerDesiredPropertyCount?: number | null;
  /** Фото профиля из мессенджера, уже скачанное к нам (`/uploads/avatars/...`).
   *  Нет — components/ClientAvatar.tsx рисует кружок с инициалами. */
  avatarUrl?: string | null;
  source: ClientSource;
  budgetMin: string | null;
  budgetMax: string | null;
  currency: Currency;
  desiredDistrictId: string | null;
  desiredDistrict: District | null;
  desiredRooms: number | null;
  /** Что именно ищет клиент — площадь и этаж (спецификация владельца 31.07.2026). */
  desiredAreaMin: number | null;
  desiredFloorMin: number | null;
  desiredFloorMax: number | null;
  desiredTotalFloors: number | null;
  /** Какое жильё ищет: по нему фильтруется подбор объектов. */
  desiredType: PropertyType | null;
  /**
   * Раздел M (03.09.2026, план вечерней сессии §M) — для какого kind в последний
   * раз ОСМЫСЛЕННО писали budgetMin/Max/desiredDistrictId/desiredRooms/desiredType
   * (поля общие для обеих ролей). Не совпадает с текущим kind — значит клиент
   * сменил тип, а эти цифры остались от прежней роли: ClientDetail.tsx показывает
   * пометку «устарело» вместо того, чтобы выдать их за текущий факт. null —
   * kind ни разу не менялся, доверяем как обычно.
   */
  requirementsFieldsKind?: "BUYER" | "SELLER" | "OTHER" | null;
  /**
   * Покупателю — ОРИЕНТИР, где он ищет жильё («напротив Зебунисо», «за рынком
   * Саховат»), а не адрес проживания: решение владельца 14.08.2026. Продавцу —
   * адрес его собственного объекта.
   */
  address?: string | null;
  /**
   * Несколько желаемых мест поиска — координата с радиусом (владелец 12.09.2026,
   * docs/geo-match-plan-12-09.md). Фундамент под гео-подбор объектов, сам подбор
   * делает другой блок. Пустой/отсутствующий массив — мест не задано, блок «Где
   * ищет» в карточке не рисуется вовсе.
   */
  desiredPlaces?: ClientDesiredPlace[];
  /** «Личный лид» — агент привёл клиента сам, не через каналы компании. */
  isPersonalLead?: boolean;
  requirementsNotes: string | null;
  /** null только для kind=OTHER — такие обращения не распределяются агентам. */
  assignedAgentId: string | null;
  assignedAgent: AgentRef | null;
  assignedAt: string;
  acceptedAt: string | null;
  /** Момент последнего ПОВТОРНОГО обращения по уже известному телефону (звонок
   *  или переписка) — значок «Клиент вернулся» в списке, пока не старше
   *  нескольких дней (см. useClients — форматирование там же, где остальной
   *  список, чтобы «сколько дней считать свежим» не разъезжалось по местам). */
  returnedAt?: string | null;
  /** Почему лид ушёл именно этому агенту вне очереди — "own_property_match" —
   *  запрос совпал с его объектом (7-й лид, Путь покупателя п.5.1-5.3). */
  assignReason?: string | null;
  /** Совпадение (0-100) с matchedPropertyId — считается сервером заново по
   *  текущим весам из Настроек, только пока лид ещё не принят. */
  matchScore?: number | null;
  /** «Почему лид ваш» до приёма: готовая строка сервера (lib/leadReason.ts) и
   *  объект для ссылки, если причина — ваш объект. null после приёма. */
  leadReason?: { text: string; propertyShortId: number | null } | null;
  /** Лид по объекту самого агента: не принял или отклонил — лид уходит
   *  руководителю, а не следующему агенту. Приходит с полной карточкой. */
  ownPropertyLead?: boolean;
  /** Срок первого звонка после приёма (задание 17.09.2026) — null, пока лид не
   *  принят или это «Прочее обращение» (kind=OTHER, правилу не подчиняется).
   *  Считает services/leads/firstCall.ts::firstCallStatus. */
  firstCallDueAt?: string | null;
  /** Обязанность позвонить закрыта (разговор дольше порога, а без телефонии —
   *  хоть какая-то ручная запись попытки) — таймер/баннер можно прятать. */
  firstCallDone?: boolean | null;
  /** Когда агент нажал «Я в работе» — отсчёт напоминаний о карточке начался заново. */
  workingMarkedAt?: string | null;
  /** Сколько раз лид автопереназначался (не принят вовремя). */
  reassignCount?: number;
  /** Проставлено, если лид эскалирован (никто не принял за N кругов). Вместе с
   * acceptedAt=null означает «⚠️ требует внимания». */
  escalatedAt?: string | null;
  /** Проверка службы безопасности: PENDING | CLEARED | CONFIRMED; null — не требовалась. */
  securityReview?: string | null;
  securityNote?: string | null;
  /** true = лид ждёт принятия агентом; для агента контакты замаскированы. */
  pendingAcceptance?: boolean;
  /**
   * Пачка 16 (11.09.2026, «осиротевшие спутники»): присутствует, только когда
   * карточку открывает агент, у которого клиента забрали (`lastAgentId` того же
   * агента, GET /clients/:id больше не отвечает 403). Карточка отдаётся целиком,
   * но только для чтения — кнопки действий на экране скрыты, см. ClientDetail.tsx.
   */
  access?: {
    readOnly: true;
    transferredTo: { id: string; fullName: string } | null;
    transferredAt: string;
    reason: string | null;
  };
  /**
   * Ближайшее невыполненное обещание агента по этому клиенту — что и когда.
   * Живёт в хронологии (Interaction.nextAction), в списке приходит отдельным
   * полем: без него список был перечнем людей, а работа на сегодня — в Календаре.
   * null = обещаний нет.
   */
  nextStep?: { nextAction: string | null; nextActionDate: string | null } | null;
  propertyActivitySummary?: import("@royal-home/shared").ClientPropertyActivitySummary | null;
  /** Клиент написал последним, и переписку ещё не открывали — красная точка на
   *  аватаре, как непрочитанное в вотсапе. Считается только в СВОЁМ списке
   *  клиентов (см. routes/clients/list.ts) — гаснет открытием карточки. */
  unread?: boolean;
  aiScore: number | null;
  aiScoreReason: string | null;
  /**
   * Короткая сводка «что с клиентом происходит» — 2–3 предложения по всей
   * переписке и хронологии (владелец 20.08.2026: «после принятия — имя и
   * короткий инсайт, не надо флудить огромными текстами»). Собирается тем же
   * вызовом модели, что и aiScore, то есть после каждого разговора.
   * До принятия лида приходит null — это пересказ закрытой переписки.
   */
  aiInsight: string | null;
  aiInsightAt: string | null;
  createdAt: string;
  lastContactAt: string;
  /**
   * Когда клиент САМ последний раз написал в переписке (не lastContactAt — тот
   * растёт и от исходящих сообщений агента). Тот же признак «был реальный
   * контакт», что у светофора неактивных и у досрочной «Передачи» — см.
   * apps/api/src/lib/inactiveTrafficLight.ts::countRealContacts. Поле сервер
   * отдавал всегда (GET /clients/:id читает Client целиком через `include`),
   * тип просто не знал о нём.
   */
  lastClientMessageAt?: string | null;
  /**
   * Первая ПОПЫТКА агента связаться (разговор или показ) — не путать с createdAt,
   * моментом появления карточки. Ставится один раз и участвует в Royal Score.
   * Сервер отдавал это поле всегда, а тип о нём не знал — карточка вынуждена была
   * объявлять локальное расширение, чтобы показать «первый контакт».
   */
  firstContactAt?: string | null;
  /** Последние 200 записей хронологии — старшие догружает InteractionTimeline. */
  interactions?: Interaction[];
  /** Сколько записей в хронологии всего (не только пришедших с карточкой). */
  interactionsTotal?: number;
  /** Факты истории, посчитанные сервером по ПОЛНОЙ таблице (карточка режет хронологию
   *  на 200): был ли проведённый показ, был ли разговор дольше порога, сколько звонков.
   *  Нет у старого ответа сервера (WEB-PAGES21, lib/clientHistoryFacts.ts). */
  hadConductedShowing?: boolean;
  hadRealCall?: boolean;
  callsCount?: number;
  deals?: Deal[];
  /** Диалоги в каналах Meta (WhatsApp/Instagram/Messenger) — МАССИВ (19.08.2026):
   *  у клиента может быть несколько одновременно (написал в Instagram, потом
   *  попросили написать в WhatsApp — раньше второй диалог не мог привязаться
   *  к той же карточке, теперь может). Отсортирован по свежести на сервере. */
  botConversation: {
    id: string;
    pausedUntil: string | null;
    channel: string;
    messages: ConversationMessage[];
  }[];
  /** Диалог в Telegram — своя таблица, но для агента это такая же переписка.
   *  Канал не хранится: у этой таблицы он всегда Telegram. */
  telegramConversation?: {
    id: string;
    pausedUntil: string | null;
    messages: ConversationMessage[];
  } | null;
  /** Мягкое удаление — заполнено только для записей из Корзины (GET /clients/trash). */
  deletedAt?: string | null;
  deletedBy?: { id: string; fullName: string } | null;
  /**
   * Почему карточка не находится в обычных списках (18.09.2026, задание В §f
   * п.2) — приходит ТОЛЬКО в срезе «Все мои» (`?scope=allMine`, computeHiddenReason
   * в apps/api/src/routes/clients/shared.ts). Тот же текст, что уходит в пуш при
   * тихом переходе — одна функция форматирования на сервере, не дублируем здесь.
   */
  hiddenReason?: {
    kind: "trashed" | "other" | "inactive" | "deferred" | "lost" | "dealClosed" | "archived" | "escalated" | "securityReview";
    label: string;
    detail?: string;
  } | null;
}

/**
 * Разбор разговора моделью: счёт, пройденные шаги, возражения и совет агенту.
 *
 * Живёт в общих типах, а не в hooks/useCalls: с 15.08.2026 разбор приходит и в
 * карточку клиента (в хронологию), и в раздел «Звонки». Два описания одного и того
 * же ответа сервера разошлись бы при первом же новом поле.
 */
export interface CallAnalysis {
  score: number;
  greeted: boolean;
  foundNeed: boolean;
  presentedValue: boolean;
  handledObjection: boolean;
  agreedNextStep: boolean;
  objections: string[];
  agreements: string[];
  summary: string;
  /** Та же суть по-таджикски — агенту, которому русский даётся тяжело. */
  summaryTj?: string | null;
  coaching: string | null;
}

export interface Interaction {
  id: string;
  clientId: string;
  /**
   * Nullable с 17.09.2026 (П-10, docs/audit/lead-ownership-17-09.md §2):
   * заполнено только когда `actorKind === "AGENT"`. Для SYSTEM/AI/BOT/CLIENT
   * — `null`, держатель карточки виден через `subjectAgent`.
   */
  agentId: string | null;
  agent?: { id?: string; fullName: string; avatarUrl?: string | null } | null;
  /** Кто действовал — см. lib/timeline.ts::TimelineActor на сервере. Не
   *  приходит у совсем старых незатронутых записей — читать как `"AGENT"`. */
  actorKind?: "AGENT" | "SYSTEM" | "AI" | "BOT" | "CLIENT";
  /** Кому адресована задача, когда актор не человек (subjectAgentId ?? agentId
   *  — тот же приём, что на сервере в lib/tasks.ts consumers). */
  subjectAgent?: { id?: string; fullName: string } | null;
  type: InteractionType;
  propertyId: string | null;
  notes: string;
  outcome: InteractionOutcome | null;
  nextAction: string | null;
  nextActionDate: string | null;
  /** Когда задачу отметили выполненной. У показа это признак «показ проведён» —
   *  по нему карточка решает, открывать ли «Передачу» и «Завершить сделку»
   *  (тот же признак, что на сервере: apps/api/src/lib/conductedShowing.ts). */
  completedAt?: string | null;
  createdAt: string;
  /** Подтверждение показа клиентом (см. apps/api/src/lib/showingConfirmation.ts).
   *  Все три пустые = показ ещё не спрашивали. Спросили и все молчит = «ждём
   *  ответа», и это НЕ отмена: молчание клиента отказом не считается. */
  confirmAskedAt?: string | null;
  confirmedAt?: string | null;
  declinedAt?: string | null;
  client?: { id?: string; shortId?: number; fullName: string; phone?: string; status?: ClientStatus };
  /** Цена/фото — только когда сервер их прислал (панель «Подбор», хронология,
   *  17.09.2026): позволяет нарисовать мини-карточку объекта вместо голой ссылки. */
  property?: {
    id?: string;
    shortId?: number;
    title: string;
    price?: string | null;
    currency?: Currency | null;
    photos?: { thumbUrl: string }[];
  };
  /**
   * Признаки записи разговора — сервер добавляет их в КАЖДУЮ запись хронологии
   * (lib/callTranscripts.ts), а тип о них не знал, поэтому карточка клиента не
   * могла показать «разговор записан», не приводя типы руками (аудит 09.08.2026).
   *
   * Сам факт записи видят все, а содержимое — только тот, кому этот разговор
   * открыт: свой (право calls.ownTranscripts) или любой (calls.transcripts).
   * Остальным transcript/transcriptRu/callAnalysis приходят пустыми — по этому
   * же признаку решает `canRead`.
   *
   * ЧТЕНИЕ И СЛУШАНИЕ РАЗВЕДЕНЫ (04.09.2026, lib/callTranscripts.ts). `canRead`
   * — можно ли увидеть текст/разбор (расшифровка, перевод, совет) — это то, что
   * раньше называлось `canHear`. `canHear` теперь ТОЛЬКО про звук (recordingUrl):
   * агент читает свой разговор, но не обязательно может его прослушать — эти
   * два флага у него теперь расходятся (canRead=true, canHear=false).
   */
  hasRecording?: boolean;
  hasTranscript?: boolean;
  /** Можно читать расшифровку/перевод/разбор — было `canHear` до 04.09.2026. */
  canRead?: boolean;
  /** Можно прослушать recordingUrl — отдельно от canRead с 04.09.2026. */
  canHear?: boolean;
  transcript?: string | null;
  /** Русский перевод расшифровки. null — разговор и так шёл по-русски. */
  transcriptRu?: string | null;
  recordingUrl?: string | null;
  /** Разбор качества разговора. null — разбора нет или он закрыт. */
  callAnalysis?: CallAnalysis | null;
  /**
   * Живой статус конвейера «запись → расшифровка → карточка» (владелец 15.08.2026).
   * Значения — CALL_TRANSCRIPTION_STAGES из @royal-home/shared. null — конвейер
   * этим звонком сейчас не занят (ещё не начал, уже закончил, или ждёт повтора
   * после отказа поставщика). Виден всем, вне зависимости от canHear: это факт о
   * том, что происходит, а не содержимое разговора.
   */
  transcriptionStage?: CallTranscriptionStage | null;
  /** Доля готовых кусков расшифровки (0–100). Осмысленна только при
   *  transcriptionStage === "TRANSCRIBING" и разговоре длиннее одного куска. */
  transcriptionProgress?: number | null;
  /** Длительность разговора в секундах — её пишет телефония по событиям станции. */
  recordingDurationSec?: number | null;
  /** Голосовая заметка агента к этой записи (01.09.2026) — файл как есть, путь
   *  /uploads/voice-notes/..., без presign: это не разговор с клиентом, слушать
   *  может любой, кому открыта хронология. */
  voiceNoteUrl?: string | null;
  /** Расшифровка voiceNoteUrl — сырьё для дополнения карточки, не замена notes. */
  voiceNoteTranscript?: string | null;
}

export interface Deal {
  id: string;
  clientId: string;
  client: { id: string; shortId: number; fullName: string; phone: string };
  propertyId: string;
  property: { id: string; shortId: number; title: string; price: string; currency: Currency; photos: PropertyPhoto[] };
  agentId: string;
  agent: AgentRef;
  stage: DealStage;
  commissionAmount: string | null;
  commissionPercent: string | null;
  /** Фактическая цена продажи — вводит агент при отправке на закрытие (PENDING_APPROVAL),
   *  почти всегда отличается от property.price (торг). */
  soldPrice: string | null;
  /** Комиссия суммой (не процентом), вводит агент при отправке на закрытие.
   *  commissionIntakeAmount («за приём объекта», отменено 11.09.2026) у новых
   *  сделок всегда 0/null — поле остаётся только как история старых сделок. */
  commissionIntakeAmount: string | null;
  commissionRealtorAmount: string | null;
  commissionCompanyAmount: string | null;
  /** Сделка по отказному лиду: агентская часть делится 70/30, а не поровну. */
  refusedLeadSplit?: boolean;
  /** Валюта комиссии — снапшот валюты объекта в момент создания сделки. */
  currency: Currency;
  startedAt: string;
  closedAt: string | null;
  notes: string | null;
  /** Сделка аннулирована руководством после закрытия (C10, 02.10.2026): стадия уже
   *  «Отменена», это отметка «не просто отменена, а аннулирована» — когда и почему. */
  annulledAt?: string | null;
  annulReason?: string | null;
  /** Оптимистичная блокировка (13.09.2026, см. Property.version) — колонка уже
   *  растёт на каждом PATCH, но канбан пока не шлёт её обратно (follow-up:
   *  useUpdateDeal/Deals.tsx имеют несколько мест вызова PATCH, вайринг versions
   *  через drag-and-drop и DealSubmitModal оставлен отдельным заходом). */
  version?: number;
}

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

/** Строка ленты уведомлений (GET /me/notifications) — зеркало модели Notification. */
export interface AppNotification {
  id: string;
  agentId: string;
  kind: string;
  /** Важность: URGENT | HIGH | NORMAL | LOW (владелец 09.09.2026, «Срочное»).
   *  Может отсутствовать у записей, созданных до появления поля. */
  level?: NotificationLevel;
  title: string;
  body: string;
  url: string | null;
  /** Сколько раз подряд повторилось это же событие (владелец 20.08.2026) — 1 — обычное. */
  count: number;
  read: boolean;
  /** Погашено системой (смена владельца/статуса клиента), а не прочитано
   *  агентом — Пачка 19, 12.09.2026. null/undefined — обычное уведомление. */
  retiredAt?: string | null;
  /** Причина гашения — «Клиент передан Иванову» и т.п., подпись рядом с меткой. */
  retiredReason?: string | null;
  createdAt: string;
}
