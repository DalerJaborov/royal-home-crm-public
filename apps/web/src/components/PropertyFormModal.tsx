import { useEffect, useMemo, useRef, useState } from "react";
import { useRetryKey } from "../hooks/useRetryKey";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { useCan } from "../lib/permissions";
import { MapPin, X, ImagePlus, Loader2, Sparkles } from "lucide-react";
import {
  PROPERTY_STAGES,
  MARKET_TYPES,
  CURRENCIES,
  PROPERTY_DETAIL_KEYS,
  PROPERTY_DETAIL_OPTIONS,
  PROPERTY_DETAIL_LABELS,
  NEW_BUILD_PHASES,
  SECONDARY_CONDITIONS,
  fieldsForNewBuildPhase,
  floorRuleError,
  propertyDetailShown,
  propertyFieldRequired,
  propertyFieldShown,
  propertyHasCondition,
  propertyHasMarket,
  propertyTypeFields,
  isInstagramLink,
  marketSideOf,
  MIN_PROPERTY_PHOTOS,
  newBuildPhaseOf,
  type NewBuildPhase,
  type PropertyDetailKey,
} from "@royal-home/shared";
import { useDistricts } from "../hooks/useDistricts";
import { useCreateProperty, useUpdateProperty } from "../hooks/useProperties";
import { usePropertyDraftFromClient } from "../hooks/useAi";
import { compressImage } from "../lib/compressImage";
import { propertyPhotosNote } from "../lib/propertyPhotosNote";
import { hasLandArea, landAreaFormValue, landAreaPayload } from "../lib/propertyLandArea";
import { enqueuePhotos } from "../lib/uploadQueue";
import { useAgents } from "../hooks/useAgents";
import { coordsPayload, instagramUrlPayload, versionForSave } from "../lib/propertyFormPayload";
import { PROPERTY_TYPE_LABELS, PROPERTY_CONDITION_LABELS } from "../lib/format";
import { digitsOf } from "../lib/phone";
import { PhoneInput } from "./FormField";
import { useSheetMode, useSwipeToDismiss } from "./BottomSheet";
import { useFocusTrap } from "../hooks/useFocusTrap";
import { LocationPicker } from "./LocationPicker";
import { usePointLandmarks } from "./property-wizard/usePointLandmarks";
import { SearchableSelect } from "./SearchableSelect";
import { SellerPicker } from "./SellerPicker";
import { PropertyPhotoManager } from "./PropertyPhotoManager";
import { usePanelPrefs } from "../hooks/usePanelPrefs";
import { useScrollLock } from "../hooks/useScrollLock";
import { ConfirmDialog } from "./ConfirmDialog";
import type { Property } from "../types";

const TYPES = ["APARTMENT", "HOUSE", "COMMERCIAL", "LAND"] as const;
const CONDITIONS = ["NEEDS_REPAIR", "GOOD", "EXCELLENT", "NEW_BUILDING"] as const;
/** Пресеты типа документа — «Другое» открывает свободный ввод, чтобы не потерять то,
 * что раньше вводили текстом (значение не входит ни в один пресет). */
const DOCUMENT_PRESETS = ["Договор", "Техпаспорт", "Договор + техпаспорт", "Нет документов"] as const;
const NOT_SET = "—";

// Готовые варианты для быстрого выбора (datalist — подсказка при вводе, но не
// запрещает вписать своё число, площадь/этаж слишком разные, чтобы жёстко ограничивать список).
const ROOMS_PRESETS = [1, 2, 3, 4, 5, 6];
const FLOOR_PRESETS = Array.from({ length: 25 }, (_, i) => i + 1);
const AREA_PRESETS = [30, 35, 40, 45, 50, 55, 60, 65, 70, 80, 90, 100, 120, 150, 200, 250, 300];

/**
 * ШАГИ МАСТЕРА (просьба владельца 06.08.2026): «сделай разделения шагами когда
 * что-то добавляется или задается вопрос или заполнить надо, с объяснениями чтобы
 * человек не думал что это такое». Раньше форма была одним полотном на 881 строку —
 * самая длинная в системе. Механика та же, что в AddInteractionModal.tsx (step,
 * TOTAL_STEPS, Назад/Далее/Сохранить, условный рендер) — не изобретаем свою.
 *
 * У каждого шага — короткая подпись живым языком: не просто название раздела, а
 * ответ на «зачем это спрашивают».
 */
const STEP_META = [
  {
    title: "Основное",
    hint: "Тип, район, цена и площадь: по ним объект попадёт в нужную рубрику каталога, и его можно будет найти поиском и фильтрами.",
  },
  {
    title: "Адрес",
    hint: "Точный адрес и точка на карте: чтобы покупатель понимал, куда едет, ещё до звонка, а такси/навигатор не промахнулись мимо дома.",
  },
  {
    title: "Детали",
    hint: "Состояние, стадия строительства и характеристики необязательны, но чем их больше, тем меньше вопросов на показе и тем убедительнее карточка на сайте.",
  },
  {
    title: "Фото и контакты",
    hint: "Контакт владельца видят только сотрудники, покупателю его не показываем. Фото можно добавить сейчас или позже, объект уже будет сохранён.",
  },
] as const;
const STEPS = STEP_META.map((s) => s.title);

interface SellerLeadPrefill {
  districtId?: string;
  price?: number;
  rooms?: number;
  currency?: (typeof CURRENCIES)[number];
  /** У продавца client.address — адрес ЕГО объекта (types.ts: «продавцу — адрес
   *  его собственного объекта»), а адрес — обязательное поле формы (validateStep).
   *  Без префилла агент, уже видевший адрес в карточке клиента, вбивал его заново
   *  вручную — источник ошибок и расхождений с advisory-lock на сервере. */
  address?: string;
  areaSqm?: number;
  /** Единственное значение «этаж» у объекта — из диапазона заявки (desiredFloorMin/Max)
   *  берём то, что заполнено, предпочитая нижнюю границу; ничего не выдумываем, если
   *  оба поля пустые. */
  floor?: number;
  totalFloors?: number;
  type?: (typeof TYPES)[number];
  /** Заявка продавца, из которой создаётся объект — уходит в clientId при создании,
   * чтобы сервер перенёс уже идущий таймер «Итог объекта» с клиента на карточку
   * (см. POST /properties). Только для создания, не для редактирования. */
  clientId?: string;
}

export function toForm(property?: Property, initialIntakeAgentId?: string, fromSeller?: SellerLeadPrefill) {
  const documentsValue = property?.documents ?? "";
  const isKnownDocumentPreset = (DOCUMENT_PRESETS as readonly string[]).includes(documentsValue);
  return {
    type: (property?.type ?? fromSeller?.type ?? "APARTMENT") as (typeof TYPES)[number],
    intakeAgentId: property?.intakeAgentId ?? initialIntakeAgentId ?? "",
    rooms: property?.rooms ? String(property.rooms) : fromSeller?.rooms ? String(fromSeller.rooms) : "",
    areaSqm: property?.areaSqm ?? (fromSeller?.areaSqm ? String(fromSeller.areaSqm) : ""),
    landAreaSotka: landAreaFormValue(property?.landAreaSotka),
    // Этаж 0 (цоколь) это значение: проверка на «истинность» превращала его в пустую
    // строку, и обычная правка цены стирала этаж (FORMS07).
    floor:
      property?.floor != null ? String(property.floor) : fromSeller?.floor != null ? String(fromSeller.floor) : "",
    totalFloors: property?.totalFloors
      ? String(property.totalFloors)
      : fromSeller?.totalFloors
        ? String(fromSeller.totalFloors)
        : "",
    windowCount: property?.windowCount != null ? String(property.windowCount) : "",
    price: property?.price ?? fromSeller?.price ?? "",
    currency: (property?.currency ?? fromSeller?.currency ?? "TJS") as (typeof CURRENCIES)[number],
    districtId: property?.districtId ?? fromSeller?.districtId ?? "",
    address: property?.address ?? fromSeller?.address ?? "",
    landmark: property?.landmark ?? "",
    condition: (property?.condition ?? "GOOD") as (typeof CONDITIONS)[number],
    ownerContact: property?.ownerContact ?? "",
    /** Выбранный продавец из своего списка. Пусто — объект нашли сами, продавца в
     *  CRM нет, и связь не заводится (уходит в clientId только при создании). */
    sellerClientId: fromSeller?.clientId ?? "",
    /** Имя продавца, которого ещё нет в CRM: вместе с телефоном (ownerContact)
     *  сервер сам заведёт карточку и свяжет с объектом. Для любого объекта, не
     *  только offSite (владелец 21.08.2026: «сосед — создать прямо при добавлении»). */
    sellerName: "",
    instagramUrl: property?.instagramUrl ?? "",
    // Пустая строка — без документов; известный пресет — сам пресет; что угодно
    // другое (в т.ч. старый свободный текст) — считаем «Другое» и подставляем в поле ниже.
    documentsPreset: documentsValue === "" ? "" : isKnownDocumentPreset ? documentsValue : "Другое",
    documentsOther: !isKnownDocumentPreset ? documentsValue : "",
    listingAcceptedAt: property?.listingAcceptedAt?.slice(0, 10) ?? "",
    stage: (property?.stage ?? "") as (typeof PROPERTY_STAGES)[number] | "",
    marketType: (property?.marketType ?? "") as (typeof MARKET_TYPES)[number] | "",
    urgent: property?.urgent ?? false,
    details: Object.fromEntries(
      PROPERTY_DETAIL_KEYS.map((key) => [key, property?.details?.[key] ?? NOT_SET])
    ) as Record<PropertyDetailKey, string>,
    /** «Только для показа своим клиентам» — только при СОЗДАНИИ (см. propertyUpdateSchema:
     *  PATCH это поле не принимает, задним числом не меняется). При редактировании
     *  читаем существующее значение объекта, но переключатель для него не рисуем. */
    offSite: property?.offSite ?? false,
  };
}

/** `property` включает режим редактирования: форма предзаполняется его данными
 * и сабмит уходит через PATCH вместо создания нового объекта.
 * `layout="page"` — форма раскрывается обычным разделом на всю страницу
 * (маршрут /properties/new), а не поверх контента модалкой. */
export function PropertyFormModal({
  onClose,
  property,
  initialIntakeAgentId,
  fromSeller,
  layout = "modal",
}: {
  onClose: () => void;
  property?: Property;
  /** Предзаполнить агента-интейкера (кто завёл объект) — при создании объекта из заявки продавца. */
  initialIntakeAgentId?: string;
  /** Район/цена/комнаты/адрес/площадь/этаж/этажность/тип, которые продавец уже
   * указал в своей заявке — раньше «Создать объект из заявки» открывало почти
   * пустую форму (даже обязательный адрес не подставлялся), хотя эти данные уже
   * были на карточке продавца. Только для создания — на редактировании не используется. */
  fromSeller?: SellerLeadPrefill;
  layout?: "modal" | "page";
}) {
  const isEdit = !!property;
  /**
   * ПОСЛЕ СОЗДАНИЯ — НА КАРТОЧКУ НОВОГО ОБЪЕКТА, А НЕ «ЗАКРЫТЬ И ЗАБЫТЬ».
   *
   * Раньше onClose() после успешного создания просто закрывал форму — что при
   * layout="modal" (карточка продавца) возвращало на ту же карточку клиента без
   * единого следа нового объекта, а при layout="page" (/properties/new) уводило
   * в общий список из сотен карточек. Агент, только что заведший объект, не мог
   * его найти и, главное, не мог сразу же загрузить фото — жалоба владельца
   * 23.08.2026: «фотографирует, чтобы фотографии добавлялись без ошибок» — а
   * без прямого перехода на карточку риск загрузить снимки не туда был реальным,
   * плюс ощущение «нажал — и как будто ничего не произошло» (только общий тост
   * «Сохранено»). Редактирование (isEdit) не трогаем — там onClose как был.
   */
  const navigate = useNavigate();
  /**
   * Пустое поле при РЕДАКТИРОВАНИИ обязано уехать как null, а не undefined.
   *
   * `undefined` выпадает из JSON.stringify — ключа в запросе просто нет, сервер
   * считает поле нетронутым и оставляет старое значение. Агент стирал контакт
   * владельца или этаж, видел зелёное «Сохранено» и находил в карточке прежние
   * данные. При СОЗДАНИИ наоборот: null отправлять незачем, поле и так пустое, а
   * часть схем не принимает null там, где значение необязательно.
   *
   * Тот же приём уже стоял в форме клиента (ClientFormModal) — в форме объекта его
   * не было.
   */
  const orNull = <T,>(v: T | undefined) => (isEdit ? (v ?? null) : v);
  const { data: districts } = useDistricts();
  const createKey = useRetryKey();
  const create = useCreateProperty(createKey);
  const update = useUpdateProperty(property?.id ?? "");
  const mutation = isEdit ? update : create;
  const propertyDraft = usePropertyDraftFromClient();
  // Ровно то же право, по которому ветвится сервер (properties.ts): он требует
  // указать интейк-агента у того, кто видит все объекты. По роли это расходилось —
  // агенту с выданным properties.viewAll форма не показывала поле, и создать объект
  // было нельзя вообще: сервер отвечал «Укажите, кто принял объект».
  const can = useCan();
  const isSupervisor = can("properties.editForeign");
  // «Кто принял объект» в ПРАВКЕ — только руководство (владелец 02.10.2026, «да,
  // по советам»): маркетинг и монтажёр правят чужие карточки, но долю за приём не
  // переносят — сервер это поле им молча отбрасывает
  // (routes/properties/shared.ts::canReassignPropertyAgents). При создании поле
  // по-прежнему обязательно для всех с editForeign — так требует сервер.
  const picksIntakeAgent = isSupervisor && (!isEdit || can("clients.assign"));
  const { data: agents } = useAgents({ enabled: picksIntakeAgent });
  const [error, setError] = useState<string | null>(null);
  const [initialForm] = useState(() => toForm(property, initialIntakeAgentId, fromSeller));
  const [form, setForm] = useState(initialForm);
  // Версия на момент открытия: поля формы взяты из того же состояния карточки (FORMS02).
  const [openedVersion] = useState(() => property?.version);
  const [confirmClose, setConfirmClose] = useState(false);
  /** Сообщение под кнопкой «Заполнить из переписки с продавцом» (задача K) — что
   *  именно подставилось, или почему нет. null — ещё не нажимали. */
  const [aiDraftNotice, setAiDraftNotice] = useState<string | null>(null);
  /** Комнаты/этаж/этажность/окна — обязательны при СОЗДАНИИ, кроме участка (LAND):
   *  у земли нет этажей и окон (см. propertyCreateSchema, packages/shared). При
   *  редактировании не требуем — старые карточки могли остаться без этих полей,
   *  и заставлять их заполнить заодно с несвязанной правкой было бы неуместно. */
  const fieldsRequired = !isEdit;
  /** Какие поля есть у выбранного типа — одна таблица на мастер, эту форму и
   *  сервер (packages/shared/src/propertyTypeFields.ts, владелец 08.10.2026):
   *  у дома нет «этажа» и «новостройки», у участка — комнат, этажей и окон. */
  const typeRules = propertyTypeFields(form.type);
  const shown = (f: "rooms" | "areaSqm" | "floor" | "totalFloors" | "windowCount") => propertyFieldShown(form.type, f);
  const required = (f: "rooms" | "floor" | "totalFloors" | "windowCount") =>
    fieldsRequired && propertyFieldRequired(form.type, f);
  // Координаты, выбранные вручную на карте (null — не трогали, работает автогеокодер).
  const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(() =>
    property?.lat != null && property?.lng != null ? { lat: Number(property.lat), lng: Number(property.lng) } : null
  );
  const [showMap, setShowMap] = useState(false);
  // Ориентир по точке (владелец 25.09.2026) — в форме правки только
  // предлагается кнопкой под пустым полем, сам не подставляется: открыть
  // объект и закрыть его не должно менять форму.
  const landmarkSuggestion = usePointLandmarks(coords);
  // Фото выбираются здесь, а реально загружаются после успешного создания/сохранения
  // объекта (эндпоинту /photos нужен уже существующий id) — см. handleSubmit.
  const [photoFiles, setPhotoFiles] = useState<File[]>([]);
  // Превью выбранных фото: blob-URL создаются РОВНО один раз на набор файлов и
  // освобождаются при его смене и при закрытии формы. Раньше URL.createObjectURL
  // вызывался прямо в разметке на каждый рендер контролируемой формы — то есть на
  // каждое нажатие клавиши в любом поле — и ни один URL не отзывался.
  const photoPreviews = useMemo(() => photoFiles.map((f) => URL.createObjectURL(f)), [photoFiles]);
  useEffect(() => () => photoPreviews.forEach((url) => URL.revokeObjectURL(url)), [photoPreviews]);
  /** Идёт сжатие снимков перед постановкой в очередь — сама отправка уже вне формы. */
  const [photosUploading, setPhotosUploading] = useState(false);
  const [isDraggingPhoto, setIsDraggingPhoto] = useState(false);
  /**
   * ГАЛОЧКИ «СРАЗУ ОПУБЛИКОВАТЬ НА САЙТ» ЗДЕСЬ БОЛЬШЕ НЕТ — убрана 14.08.2026.
   *
   * Она не могла сработать ни разу с 02.08.2026, когда владелец решил, что каждый
   * новый объект идёт через конвейер подготовки: routes/properties.ts создаёт его
   * со статусом PENDING_REVIEW всегда, а bulk-sync объекты в статусах конвейера
   * отклоняет (409 «Ещё готовятся, публиковать рано»). То есть галочка гарантированно
   * заканчивалась красной строкой «Объект создан, но не опубликован на сайт».
   *
   * Чинить это послаблением на сервере было бы неверно: правило конвейера — решение
   * владельца, а не недосмотр. Публикация живёт на карточке объекта, куда объект и
   * приходит после видео-обзора.
   */
  const photoInputRef = useRef<HTMLInputElement>(null);
  // Уважаем общий переключатель «Анимации» (панель предпочтений, localStorage) —
  // тот же флаг, что гасит набегание чисел на дашборде (AnimatedNumber). CSS-классы
  // ниже дополнительно завёрнуты в @media (prefers-reduced-motion: no-preference) в
  // index.css — здесь решается только осознанный выбор человека, системную настройку
  // читает браузер сам.
  const [panelPrefs] = usePanelPrefs();
  /**
   * МАСТЕР ШАГАМИ (просьба владельца, см. STEP_META выше): раньше вся форма была
   * одним полотном. Теперь на каждом шаге смонтирован только он сам — условный
   * рендер, а НЕ `hidden`: в этом репозитории `hidden` не скрывает элемент с классом
   * flex/grid (правило [hidden] лежит в слое base, а .flex/.grid — в utilities ниже,
   * см. тот же комментарий в AddInteractionModal.tsx). Состояние полей живёт в
   * useState формы, поэтому размонтирование шага ничего не теряет.
   */
  // Шторка снизу — только облик «Живая 2.0» на телефоне (см. components/BottomSheet.tsx).
  const sheetMode = useSheetMode();
  /**
   * ЗАЩИТА ОТ ПОТЕРИ ЗАПОЛНЕННОГО (аудит 22.08.2026, раунд 5).
   *
   * Самая большая форма в CRM (десятки полей плюс выбранные фото) закрывалась
   * смахиванием вниз БЕЗ вопроса: одно случайное движение пальцем — и вся
   * работа исчезала. Клик мимо окна здесь и так отключён нарочно, но жест
   * оставался лазейкой. ClientFormModal ровно эту защиту уже имеет — здесь её
   * просто не было, при том что терять тут заметно больше.
   *
   * Выбранные фото учитываем отдельно: они лежат не в форме, а в photoFiles,
   * и «ничего не менял, только приложил снимки» — тоже полная потеря работы.
   */
  const dirty =
    photoFiles.length > 0 ||
    (Object.keys(initialForm) as (keyof typeof initialForm)[]).some((k) => form[k] !== initialForm[k]);
  const requestClose = () => (dirty ? setConfirmClose(true) : onClose());
  const swipe = useSwipeToDismiss(sheetMode && layout !== "page", requestClose);
  // Tab не должен уводить из окна в интерфейс под ним. На странице (layout=page)
  // ловушка не нужна — там нет перекрытого фона.
  const trapRef = useFocusTrap<HTMLFormElement>(layout !== "page");
  // Прокрутку фона блокируем только когда это действительно окно: в режиме
  // страницы (layout === "page") под формой ничего нет, и фиксировать нечего.
  useScrollLock(layout !== "page");
  const isPage = layout === "page";
  /**
   * Слой 4 (layer-3-plan.md §4.3.4, задание «убрать старый степпер») снял флаг:
   * форма — ОДНА страница, все секции видны сразу, и в режиме страницы
   * (/properties/new, /properties/:id/edit), и в модалке (из карточки продавца).
   * Старый пошаговый мастер («Далее»/«Назад», один `step` за раз) удалён.
   * Логика валидации/сабмита не тронута — `step`/`STEPS` остаются только для
   * скролла к первой невалидной секции при ошибке (см. `focusOnStep` ниже).
   */
  const is2026 = true;

  /**
   * СНИМОК СПИСКА ДЕЛАЕМ СРАЗУ, А НЕ ВНУТРИ ОБНОВЛЕНИЯ СОСТОЯНИЯ.
   *
   * `FileList` — живая коллекция самого поля. Обработчик выбора файлов сразу после
   * этого вызова делает `e.target.value = ""` (чтобы повторный выбор того же файла
   * снова дал событие), и это поле опустошает. А функция-обновитель React выполняет
   * позже, уже после возврата из обработчика, — то есть `Array.from(files)` внутри
   * неё разворачивала УЖЕ ПУСТОЙ список.
   *
   * Итог был такой: выбранные через диалог фотографии не добавлялись вообще ни одна,
   * молча. Перетаскивание работало (у `dataTransfer` никто значение не чистит),
   * поэтому дефект и жил незамеченным. Найдено 14.08.2026 сквозным проходом.
   */
  function addPhotoFiles(files: FileList | null) {
    if (!files) return;
    const picked = Array.from(files);
    if (picked.length === 0) return;
    setPhotoFiles((prev) => [...prev, ...picked]);
  }

  function removePhotoFile(idx: number) {
    setPhotoFiles((prev) => prev.filter((_, i) => i !== idx));
  }


  function set<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm((f) => ({ ...f, [key]: value }));
    setError(null);
  }

  /** Смена типа очищает поля, которых у нового типа нет, — иначе этаж квартиры
   *  уезжал бы в карточку дома, а «новостройка» оставалась у участка. */
  function setType(type: (typeof TYPES)[number]) {
    setForm((f) => {
      const next = { ...f, type };
      if (!propertyFieldShown(type, "rooms")) next.rooms = "";
      if (!propertyFieldShown(type, "landAreaSotka")) next.landAreaSotka = "";
      if (!propertyFieldShown(type, "floor")) next.floor = "";
      if (!propertyFieldShown(type, "totalFloors")) next.totalFloors = "";
      if (!propertyFieldShown(type, "windowCount")) next.windowCount = "";
      if (!propertyHasMarket(type)) {
        next.marketType = "";
        next.stage = "";
        if (next.condition === "NEW_BUILDING") next.condition = "GOOD";
      }
      next.details = Object.fromEntries(
        PROPERTY_DETAIL_KEYS.map((key) => [key, propertyDetailShown(type, key) ? f.details[key] : NOT_SET])
      ) as typeof f.details;
      return next;
    });
    setError(null);
  }

  function setDetail(key: PropertyDetailKey, value: string) {
    setForm((f) => ({ ...f, details: { ...f.details, [key]: value } }));
    setError(null);
  }

  /**
   * ЗАДАЧА K: «Заполнить из переписки с продавцом» — ИИ читает переписку и звонки
   * с уже выбранным продавцом (form.sellerClientId) и предлагает черновик полей
   * объекта. Ничего не создаёт само: подставляет значения в форму, агент проверяет
   * и правит перед обычным сохранением (см. docs/audit-02-09-2026/19-plan-03-09-evening.md).
   *
   * Подставляем только НЕПУСТЫЕ поля — то, чего ИИ не нашёл, остаётся как было
   * (значение по умолчанию формы или то, что агент уже успел вписать руками), а
   * не затирается на null/пусто.
   */
  async function handleFillFromSeller() {
    if (!form.sellerClientId) return;
    setAiDraftNotice(null);
    try {
      const draft = await propertyDraft.mutateAsync(form.sellerClientId);
      // У продавца несколько объектов — сервер нарочно не подставляет ничего
      // (ai/propertyDraft.ts, 19.09.2026): смесь фактов двух квартир уехала бы
      // из карточки в подпись монтажёру и в текст на самом ролике. Форму не
      // трогаем вовсе, объясняем агенту почему.
      if (draft.ambiguityReason) {
        setAiDraftNotice(
          draft.ambiguityReason === "ALREADY_HAS_OBJECTS"
            ? `У этого продавца уже заведено объектов: ${draft.existingObjectsCount}. Автоматически подставить нельзя — по переписке не отличить новую квартиру от уже заведённой, заполните поля вручную.`
            : "Продавец рассказывал о нескольких своих объектах — какой из них вы заводите сейчас, по переписке не понять. Заполните поля вручную, чтобы данные разных квартир не перемешались."
        );
        return;
      }
      const filledLabels: string[] = [];
      setForm((f) => {
        const next = { ...f };
        if (draft.type) {
          next.type = draft.type;
          filledLabels.push("Тип");
        }
        if (draft.districtId) {
          next.districtId = draft.districtId;
          filledLabels.push("Район");
        }
        if (draft.price !== null) {
          next.price = draft.price;
          filledLabels.push("Цена");
        }
        if (draft.currency) next.currency = draft.currency;
        if (draft.areaSqm !== null) {
          // form.areaSqm — строка (Property.areaSqm сериализуется как Decimal-строка,
          // см. apps/web/src/types.ts), в отличие от price ниже, где есть числовая
          // ветка через fromSeller — здесь её нет, конвертируем явно.
          next.areaSqm = String(draft.areaSqm);
          filledLabels.push("Площадь");
        }
        if (draft.rooms !== null) {
          next.rooms = String(draft.rooms);
          filledLabels.push("Комнаты");
        }
        if (draft.floor !== null) {
          next.floor = String(draft.floor);
          filledLabels.push("Этаж");
        }
        if (draft.condition) {
          next.condition = draft.condition;
          filledLabels.push("Состояние");
        }
        if (draft.address) {
          next.address = draft.address;
          filledLabels.push("Адрес");
        }
        return next;
      });
      setAiDraftNotice(
        filledLabels.length > 0
          ? `Заполнено ИИ по переписке с продавцом, проверьте: ${filledLabels.join(", ")}.`
          : draft.aiUnavailable
            ? "ИИ сейчас недоступен — не удалось разобрать переписку. Заполните поля вручную."
            : "В переписке и звонках с продавцом не нашли параметров объекта — заполните поля вручную."
      );
    } catch (err) {
      setAiDraftNotice(err instanceof Error ? err.message : "Не удалось получить черновик из переписки");
    }
  }

  const selectedDistrictName = districts?.find((d) => d.id === form.districtId)?.name;

  /** Валидация ОДНОГО шага — общая для кнопки «Далее» (следующий шаг) и для
   * финального сабмита (все шаги по очереди, см. validate ниже). Раньше было два
   * почти одинаковых списка проверок, и добавленное сюда правило (окна/этаж/
   * комнаты обязательны при создании) легко забыть продублировать во втором. */
  function validateStep(current: number): string | null {
    if (current === 0) {
      if (picksIntakeAgent && !form.intakeAgentId) return "Укажите, кто принял объект";
      if (!form.districtId) return "Выберите район";
      if (!form.price || Number(form.price) <= 0) return "Укажите цену";
      if (shown("areaSqm")) {
        if (!form.areaSqm || Number(form.areaSqm) <= 0) return "Укажите площадь";
      } else if (!isEdit && !(Number(form.landAreaSotka) > 0)) {
        // У участка площадь — сотки, м² считаются из них.
        return "Укажите площадь участка в сотках";
      }
      const floorError =
        shown("floor") &&
        floorRuleError(
          form.floor === "" ? null : Number(form.floor),
          form.totalFloors === "" ? null : Number(form.totalFloors)
        );
      if (floorError) return floorError;
      if (required("rooms") && !form.rooms) return "Укажите количество комнат";
      if (required("floor") && form.floor === "") return "Укажите этаж";
      if (required("totalFloors") && !form.totalFloors) return "Укажите этажность";
      if (required("windowCount") && form.windowCount === "") return "Укажите количество окон";
    }
    if (current === 1 && !form.address.trim()) return "Укажите адрес";
    // Продавец: либо выбрана карточка (номер сервер возьмёт из неё сам), либо имя
    // и телефон нового — по ним CRM заведёт карточку. Имя обязательно (владелец
    // 21.08.2026): объект без понятного продавца — ничей объект.
    if (current === 3 && !isEdit && !form.sellerClientId) {
      if (!form.sellerName.trim()) return "Укажите имя продавца или выберите его из списка выше";
      // Та же проверка, что и у номера клиента (phoneDigits в ClientFormModal /
      // clientPhoneSchema на сервере) — девять значащих цифр после кода страны.
      if (!form.ownerContact.trim() || digitsOf(form.ownerContact).length < 9) {
        return "В номере должно быть девять цифр после кода страны";
      }
    }
    return null;
  }

  /** Все секции по очереди — используется перед сабмитом. При первой найденной
   * ошибке показывает её сообщение (все секции уже видны на одной странице —
   * слой 4 убрал переход между шагами, возвращать пользователя стало некуда). */
  function validate(): boolean {
    for (let s = 0; s < STEPS.length; s++) {
      const message = validateStep(s);
      if (message) {
        setError(message);
        return false;
      }
    }
    return true;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!validate()) return;
    try {
      const documents =
        form.documentsPreset === "Другое" ? form.documentsOther.trim() : form.documentsPreset;
      // Только реально выбранные характеристики — «—» значит «не задано», не отправляем его вовсе.
      const details = Object.fromEntries(
        PROPERTY_DETAIL_KEYS.filter((key) => form.details[key] && form.details[key] !== NOT_SET).map((key) => [
          key,
          form.details[key],
        ])
      );
      // description/metaTitle/metaDescription/h1/seoDesc не отправляем — сервер
      // всегда генерирует их сам по параметрам объекта (см. apps/api/src/ai/seoGenerator.ts).
      const saved = await mutation.mutateAsync({
        // Оптимистичная блокировка (13.09.2026): версия, прочитанная вместе с
        // карточкой при открытии формы (не живая из подписки: см. versionForSave) — сервер отказывает 409, если её успели
        // изменить между открытием и сохранением (см. propertyUpdateSchema.version).
        ...(isEdit ? { version: versionForSave(openedVersion, property!.version) } : {}),
        // title больше не передаём — сервер формирует его сам из типа/комнат/района.
        type: form.type,
        ...(picksIntakeAgent ? { intakeAgentId: form.intakeAgentId } : {}),
        // Поля, которых у типа нет, не отправляются вовсе: при смене типа сервер
        // сам очищает их в карточке (normalizePropertyPatchForType).
        ...(shown("rooms") ? { rooms: form.rooms ? Number(form.rooms) : orNull(undefined) } : {}),
        // У участка м² считаются из соток (1 сотка = 100 м²), как в мастере.
        ...(shown("areaSqm")
          ? { areaSqm: Number(form.areaSqm) }
          : Number(form.landAreaSotka) > 0
            ? { areaSqm: Math.round(Number(form.landAreaSotka) * 100) }
            : {}),
        ...landAreaPayload(form.type, form.landAreaSotka, isEdit),
        ...(shown("floor") ? { floor: form.floor !== "" ? Number(form.floor) : orNull(undefined) } : {}),
        ...(shown("totalFloors") ? { totalFloors: form.totalFloors ? Number(form.totalFloors) : orNull(undefined) } : {}),
        ...(shown("windowCount")
          ? { windowCount: form.windowCount !== "" ? Number(form.windowCount) : orNull(undefined) }
          : {}),
        price: Number(form.price),
        currency: form.currency,
        districtId: form.districtId,
        address: form.address,
        landmark: form.landmark.trim() || orNull(undefined),
        condition: form.condition,
        // Скрытый номер не отправляется вовсе: форма получила его пустым, и `null`
        // стёр бы номер собственника (аудит 23.09.2026, №31).
        ...(property?.ownerContactHidden ? {} : { ownerContact: form.ownerContact || orNull(undefined) }),
        // Стёртую ссылку при правке шлём как null, иначе ключа нет и она возвращается
        // (см. instagramUrlPayload).
        ...instagramUrlPayload(isEdit, form.instagramUrl, property?.instagramUrl),
        documents: documents || orNull(undefined),
        // БЕЗ orNull: в базе поле обязательное, очистить его нечем — только заменить
        // (см. комментарий в propertyUpdateSchema). null здесь дал бы отказ схемы.
        listingAcceptedAt: form.listingAcceptedAt || undefined,
        ...(propertyHasMarket(form.type)
          ? { stage: form.stage || orNull(undefined), marketType: form.marketType || orNull(undefined) }
          : {}),
        urgent: form.urgent,
        // При редактировании пустой набор — это «очистить всё», и слать надо явный {}.
        // undefined выпадает из JSON, ключ пропадает из PATCH, сервер считает поле
        // нетронутым — агент возвращал все 13 характеристик на «—», форма показывала
        // пустоту, а в карточке молча оставались старые значения. null здесь не годится:
        // схема details его не принимает (не .nullish()), запрос отвалился бы целиком.
        details: Object.keys(details).length > 0 ? details : isEdit ? {} : undefined,
        // Точку шлём, только если её правда поставили или сдвинули (23.09.2026).
        // Форма правки подставляет сохранённую точку в coords сразу, и раньше она
        // уходила в каждый PATCH: сервер читал её как «поставлено руками» и после
        // смены адреса не пересчитывал точку — метка оставалась на старом месте.
        // Сброс сохранённой точки уходит как lat/lng = null (см. coordsPayload).
        ...coordsPayload(isEdit, coords, property),
        // Продавец: выбранный в форме (SellerPicker) либо предзаполненный, когда
        // объект создают прямо из его карточки. Одно поле формы на оба случая —
        // раньше сюда попадал ТОЛЬКО fromSeller, и при обычном создании связь
        // оставалась пустой (0 из 36 объектов на проде).
        ...(isEdit
          ? {}
          : {
              amenities: [],
              offSite: form.offSite,
              ...(form.sellerClientId ? { clientId: form.sellerClientId } : {}),
              // Имя продавца имеет смысл, только пока карточка ещё не выбрана — сервер
              // сам заводит или находит карточку по нему и ownerContact (см. schemas.ts).
              // Для любого объекта, не только offSite (владелец 21.08.2026).
              ...(!form.sellerClientId && form.sellerName.trim()
                ? { sellerName: form.sellerName.trim() }
                : {}),
            }),
      });
      if (photoFiles.length > 0) {
        const targetId = isEdit ? property!.id : saved.id;
        /**
         * В очередь, а не напрямую (lib/uploadQueue.ts). Форма закрывается сразу
         * после сжатия: ждать здесь отправку значило бы держать агента у окна
         * минуту на мобильном интернете — и терять все снимки, если связь
         * оборвётся. Ход загрузки виден в карточке объекта, и она доводит
         * файлы сама, даже если приложение закрыть.
         */
        setPhotosUploading(true);
        try {
          await enqueuePhotos(targetId, photoFiles, compressImage, isEdit ? property!.shortId : saved.shortId);
        } catch {
          // Объект уже сохранён — фото можно дозагрузить прямо в карточке, не теряем данные.
          setError("Объект сохранён, но фото не удалось подготовить, добавьте их в карточке объекта");
          setPhotosUploading(false);
          return;
        }
        setPhotosUploading(false);
      }
      if (isEdit) {
        onClose();
      } else {
        // Карточка нового объекта: agent видит, что объект реально создан, и
        // может сразу дозагрузить/проверить фото на верном объекте.
        navigate(`/properties/${saved.shortId}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : isEdit ? "Не удалось сохранить объект" : "Не удалось создать объект");
    }
  }

  // Сетка полей и «во всю ширину» — классы эталона темы 2026 (.fgrid / .wide).
  const gridCls = "fgrid";
  const stepAnimCls = panelPrefs.animations ? "step-fade-in" : "";

  /* ФОТО СВЕРХУ — порядок эталона (property-form.html: «Фото сверху, ошибки под
     полем»). Раньше блок стоял последним в секции «Фото и контакты»; перенесён
     целиком, поведение выбора/перетаскивания/удаления не тронуто. Плитки и
     кнопка «Добавить фото» — сетка `.pgrid` эталона. */
  const photosSection = (
    <div className="card">
      <div className="sec-h stack">
        <h2>Фотографии</h2>
        <span className="note">
          {propertyPhotosNote(MIN_PROPERTY_PHOTOS)}
        </span>
      </div>
      {isEdit && property && (
        <PropertyPhotoManager propertyId={property.id} shortId={property.shortId} photos={property.photos} embedded />
      )}
      <div className="pgrid">
        {photoFiles.map((file, idx) => (
          <div key={idx} className="cell">
            {/* URL берётся из мемоизированного списка, а не создаётся в рендере:
                форма контролируемая, каждый символ в любом поле перерисовывал её
                и плодил новый blob-URL на каждое фото, ни один не освобождался. */}
            <img
              src={photoPreviews[idx]}
              alt=""
              style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }}
            />
            {idx === 0 && <span className="lead">Главное</span>}
            <button className="x" type="button" onClick={() => removePhotoFile(idx)} aria-label={`Убрать фото ${idx + 1}`}>
              <svg className="i" viewBox="0 0 24 24" style={{ width: 14, height: 14 }}>
                <path d="M6 6l12 12M18 6 6 18" />
              </svg>
            </button>
          </div>
        ))}
        {/* label вместо div+программного click(): нативный клик по label открывает
            выбор файла всегда. Раньше programmatic input.click() из onClick контейнера
            (input лежит внутри него же) в пустом состоянии не открывал диалог. */}
        <label
          className="add"
          onDragOver={(e) => {
            e.preventDefault();
            setIsDraggingPhoto(true);
          }}
          onDragLeave={() => setIsDraggingPhoto(false)}
          onDrop={(e) => {
            e.preventDefault();
            setIsDraggingPhoto(false);
            addPhotoFiles(e.dataTransfer.files);
          }}
          style={isDraggingPhoto ? { borderColor: "var(--ink)", color: "var(--ink)" } : undefined}
        >
          <svg className="i xl" viewBox="0 0 24 24">
            <path d="M12 5v14M5 12h14" />
          </svg>
          {isEdit ? "Добавить ещё фото" : "Добавить фото"}
          <input
            ref={photoInputRef}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={(e) => {
              addPhotoFiles(e.target.files);
              e.target.value = "";
            }}
          />
        </label>
      </div>
      {!isEdit && (
        <div className="quiet warn">
          <span className="dot warn" />
          <span className="txt">
            {form.offSite
              ? "Несайтовый объект: сразу «В продаже», без проверки Маркетингом и без публикации на сайте."
              : "Объект выйдет на сайт после конвейера подготовки: проверка карточки, фото, видео-обзор. " +
                "Опубликовать его можно будет из карточки объекта."}
          </span>
        </div>
      )}
    </div>
  );

  const formEl = (
      <form
        // Окно формы объекта тоже несёт role="dialog": по нему облик «Живая 2.0»
        // на телефоне превращает окно в шторку снизу (см. index.css), а хук ниже
        // добавляет закрытие смахиванием. На странице (isPage) роли нет — там это
        // обычный блок, а не окно.
        {...(isPage ? {} : { role: "dialog" as const, "aria-modal": true as const, "aria-label": isEdit ? "Изменить объект" : "Новый объект" })}
        {...(isPage ? {} : swipe.handlers)}
        ref={(node: HTMLFormElement | null) => {
          if (isPage) return;
          swipe.ref(node);
          trapRef.current = node;
        }}
        onClick={(e) => e.stopPropagation()}
        onSubmit={handleSubmit}
        /* `rh2` — область действия эталона темы «Royal Home 2026»: внутри неё
           работают .card/.sec-h/.fgrid/.fld/.pill из theme-2026-proto.css. Класс
           стоит и на странице, и в окне: форма одна и та же, разный только
           размер контейнера. */
        className={
          isPage
            // На странице область `.rh2` и `.scr` даёт обёртка страницы
            // (pages/PropertyForm.tsx) — второй `.scr` удвоил бы поля.
            ? "w-full"
            // На телефоне — во весь экран (как форма клиента): окно на 92% высоты с
            // полями и шагами внутри пролистывается, а не заполняется.
            : "rh2 shadow-lg w-full h-full max-h-dvh overflow-y-auto sm:h-auto sm:rounded-card sm:max-w-4xl sm:max-h-[92dvh]"
        }
      >
        {!isPage && (
          <div className="sheet-h">
            <h2>{isEdit ? "Изменить объект" : "Новый объект"}</h2>
            <button className="pill icon ghost" type="button" onClick={requestClose} aria-label="Закрыть">
              <svg className="i" viewBox="0 0 24 24">
                <path d="M6 6l12 12M18 6 6 18" />
              </svg>
            </button>
          </div>
        )}

        {/* Одна страница секциями (слой 4 — старый пошаговый мастер удалён):
            заголовок и подсказка каждого шага живут в своей секции ниже. */}

        <div className={isPage ? `flex flex-col gap-4 ${stepAnimCls}` : `scr ${stepAnimCls}`}>
        {photosSection}
        <div className="card">
        <div className="sec-h stack">
          <h2>{STEP_META[0].title}</h2>
          <span className="note">{STEP_META[0].hint}</span>
        </div>
        <div className={gridCls}>
          {/* Название не вводится — формируется автоматически («2-комн · Рудаки»). */}
          {/* Поля «Риелтор» здесь сознательно нет: риелтор назначается автоматически
              в момент сделки (агент клиента, выбравшего объект) — заранее закреплять
              объект за кем-то было бы нечестно к остальным агентам. */}
          {/* Переключатель стоит первым и сознательно на самом первом шаге, а не рядом
              с продавцом (было раньше) — от него зависит, какие поля вообще имеют
              смысл на следующих шагах (карта/адрес для сайта, Instagram, сырое видео).
              Владелец 19.08.2026: агент должен решить это ДО того, как заполнит то,
              что потом окажется ненужным, а не после. */}
          {!isEdit && (
            <div className="wide flex items-start gap-2.5 border border-line-soft rounded-lg p-3 bg-hover-tint">
              <input
                id="offSite"
                type="checkbox"
                checked={form.offSite}
                onChange={(e) => set("offSite", e.target.checked)}
                className="w-4 h-4 mt-0.5 rounded-sm border-line text-blue focus:ring-blue shrink-0"
              />
              <label htmlFor="offSite" className="text-[15px]">
                <span className="font-medium text-gray-700">Только для показа своим клиентам (не публиковать на сайте)</span>
                <span className="block text-[13px] text-gray-500 mt-0.5">
                  Объект нашли сами (сосед, знакомый): сразу «В продаже», без проверки фото/видео и
                  без конвейера Маркетинга. На сайт не попадёт никогда, карта и ссылка на Instagram
                  не нужны; клиенту можно будет отправить только персональную ссылку.
                </span>
              </label>
            </div>
          )}

          {/* ЗАДАЧА K: видна, только когда объект создаётся с привязкой к УЖЕ
              существующей карточке продавца (form.sellerClientId — заполняется либо
              из fromSeller при входе с карточки клиента, либо выбором в SellerPicker
              на шаге «Фото и контакты»). Продавца ещё нет в CRM (только sellerName) —
              читать нечего, кнопки нет. */}
          {!isEdit && form.sellerClientId && (
            <div className="sm:col-span-2 flex items-start gap-2.5 border border-line-soft rounded-lg p-3 bg-hover-tint">
              <Sparkles className="w-4 h-4 mt-0.5 text-blue shrink-0" />
              <div className="flex-1 min-w-0">
                <button
                  type="button"
                  onClick={handleFillFromSeller}
                  disabled={propertyDraft.isPending}
                  className="text-[15px] font-medium text-blue hover:underline disabled:opacity-60 disabled:no-underline inline-flex items-center gap-1.5"
                >
                  {propertyDraft.isPending && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                  Заполнить из переписки с продавцом
                </button>
                <p className="text-[13px] text-gray-500 mt-0.5">
                  ИИ прочитает переписку и звонки с этим продавцом и подставит площадь, комнаты, этаж,
                  состояние, цену и другие поля ниже — проверьте перед сохранением.
                </p>
                {aiDraftNotice && <p className="text-[13px] text-blue mt-1.5 font-medium">{aiDraftNotice}</p>}
              </div>
            </div>
          )}

          {picksIntakeAgent && (
            <div className="fld wide">
              <span className="lab">
                Кто принял объект *:{" "}
                <span className="text-gray-400 font-normal">
                  {/* Размер доли — финансовая информация, менеджеру не показываем. */}
                  агент, принявший продавца{can("finance.view") ? "; получит 0.5% со сделки" : ""}
                </span>
              </span>
              <SearchableSelect
                value={form.intakeAgentId}
                onChange={(v) => set("intakeAgentId", v)}
                placeholder="Выберите агента..."
                options={
                  agents?.filter((a) => a.isActive && a.role === "AGENT").map((a) => ({ value: a.id, label: a.fullName })) ?? []
                }
              />
            </div>
          )}

          <div className="fld">
            <span className="lab">Тип</span>
            <select
              value={form.type}
              onChange={(e) => setType(e.target.value as (typeof TYPES)[number])}
            >
              {TYPES.map((t) => (
                <option key={t} value={t}>
                  {PROPERTY_TYPE_LABELS[t]}
                </option>
              ))}
            </select>
          </div>

          <div className="fld">
            <span className="lab">Район *</span>
            <SearchableSelect
              value={form.districtId}
              onChange={(v) => set("districtId", v)}
              placeholder="Выберите..."
              options={districts?.map((d) => ({ value: d.id, label: d.name })) ?? []}
            />
          </div>

          <div className="fld">
            <span className="lab">Цена *</span>
            <div className="flex gap-1.5">
              <input
                type="number"
                inputMode="numeric"
                value={form.price}
                onChange={(e) => set("price", e.target.value)}
              />
              <select
                value={form.currency}
                onChange={(e) => set("currency", e.target.value as (typeof CURRENCIES)[number])}
              >
                {CURRENCIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {shown("areaSqm") && (
          <div className="fld">
            <span className="lab">Площадь, м² *</span>
            <input
              type="number"
              inputMode="numeric"
              list="area-presets"
              value={form.areaSqm}
              onChange={(e) => set("areaSqm", e.target.value)}
            />
            <datalist id="area-presets">
              {AREA_PRESETS.map((a) => (
                <option key={a} value={a} />
              ))}
            </datalist>
          </div>
          )}
          {hasLandArea(form.type) && (
            <div className="fld">
              <span className="lab">Участок, соток{form.type === "LAND" && !isEdit && " *"}</span>
              <input
                type="number"
                inputMode="decimal"
                min={0}
                step="any"
                value={form.landAreaSotka}
                onChange={(e) => set("landAreaSotka", e.target.value)}
              />
            </div>
          )}
          {shown("rooms") && (
          <div className="fld">
            <span className="lab">
              {typeRules.labels.rooms}{required("rooms") && " *"}
            </span>
            <input
              type="number"
              inputMode="numeric"
              list="rooms-presets"
              value={form.rooms}
              onChange={(e) => set("rooms", e.target.value)}
            />
            <datalist id="rooms-presets">
              {ROOMS_PRESETS.map((r) => (
                <option key={r} value={r} />
              ))}
            </datalist>
          </div>
          )}

          {shown("floor") && (
          <div className="fld">
            <span className="lab">
              Этаж{required("floor") && " *"}
            </span>
            <input
              type="number"
              inputMode="numeric"
              list="floor-presets"
              value={form.floor}
              onChange={(e) => set("floor", e.target.value)}
            />
          </div>
          )}
          {/* Подсказки этажей — общие для «Этажа» и «Этажности», поэтому вне условий. */}
          <datalist id="floor-presets">
            {FLOOR_PRESETS.map((f) => (
              <option key={f} value={f} />
            ))}
          </datalist>
          {shown("totalFloors") && (
          <div className="fld">
            <span className="lab">
              {typeRules.labels.totalFloors}{required("totalFloors") && " *"}
            </span>
            <input
              type="number"
              inputMode="numeric"
              list="floor-presets"
              value={form.totalFloors}
              onChange={(e) => set("totalFloors", e.target.value)}
            />
          </div>
          )}
          {/* Количество окон — обязательное поле карточки по спецификации владельца.
              Тип остекления («пластиковые») лежит в характеристиках и отвечает на
              другой вопрос; покупателя на показе интересует именно «сколько». */}
          {shown("windowCount") && (
          <div className="fld">
            <span className="lab">
              Окон{required("windowCount") && " *"}
            </span>
            <input
              type="number"
              inputMode="numeric"
              min={0}
              value={form.windowCount}
              onChange={(e) => set("windowCount", e.target.value)}
            />
          </div>
          )}

        </div>
        </div>

        <div className="card">
        <div className="sec-h stack">
          <h2>{STEP_META[1].title}</h2>
          <span className="note">{STEP_META[1].hint}</span>
        </div>
        <div className={gridCls}>
          <div className="fld wide">
            <span className="lab">Адрес *</span>
            <input
              value={form.address}
              onChange={(e) => set("address", e.target.value)}
            />
          </div>

          {/* Ориентир — короткая фраза вроде «рядом с ТЦ Садбарг», «за Овиром»
              (пункт 10 владельца, 23.09.2026): необязателен, помогает покупателю и
              сотрудникам понять расположение, когда точного адреса недостаточно. */}
          <div className="fld wide">
            <span className="lab">Ориентир</span>
            <input
              value={form.landmark}
              placeholder="Например: рядом с ТЦ Садбарг"
              onChange={(e) => set("landmark", e.target.value)}
            />
            {!form.landmark.trim() && landmarkSuggestion && (
              <button
                type="button"
                className="chip"
                style={{ marginTop: 8, alignSelf: "flex-start" }}
                data-testid="property-form-landmark-suggest"
                onClick={() => set("landmark", landmarkSuggestion)}
              >
                Подставить по карте: {landmarkSuggestion}
              </button>
            )}
          </div>

          {/* Карта — только для витрины сайта: несайтовый объект туда не попадает
              никогда (см. переключатель на первом шаге), координаты ему не нужны.

              Поле «вставьте ссылку на Яндекс/2ГИС/Google» отсюда убрано (решение
              владельца 11.09.2026): точку CRM теперь ставит своей картой — в
              мастере добавления она открывается сразу на месте агента, — а
              перекладывать координаты из чужого приложения больше незачем. */}
          {!form.offSite && (
            <div className="fld wide">
              <span className="lab">Точка на карте</span>
              <div className="flex items-center justify-between gap-2">
                <button
                  type="button"
                  onClick={() => setShowMap((v) => !v)}
                  disabled={!form.districtId}
                  className="flex items-center gap-1.5 text-[15px] font-semibold text-blue border border-blue/10 bg-blue/6 rounded-lg px-2.5 py-1.5 hover:bg-blue/10 disabled:opacity-50 disabled:cursor-not-allowed"
                  title={!form.districtId ? "Сначала выберите район" : undefined}
                >
                  <MapPin className="w-3.5 h-3.5" />
                  {coords ? "Точка задана, проверить на карте" : "Указать точку на карте"}
                </button>
                {coords && (
                  <button
                    type="button"
                    onClick={() => {
                      setCoords(null);
                      setShowMap(false);
                    }}
                    className="text-[15px] font-medium text-gray-500 hover:text-ink"
                  >
                    Сбросить
                  </button>
                )}
              </div>
              {showMap && (
                <div className="mt-2">
                  <LocationPicker value={coords} onChange={setCoords} districtName={selectedDistrictName} />
                  <p className="text-[13px] text-gray-400 mt-1.5">
                    Кликните по карте или перетащите метку на нужный дом. Без ручного выбора координаты
                    подберутся автоматически по адресу.
                  </p>
                </div>
              )}
            </div>
          )}

        </div>
        </div>

        <div className="card">
        <div className="sec-h stack">
          <h2>{STEP_META[2].title}</h2>
          <span className="note">{STEP_META[2].hint}</span>
        </div>
        <div className={gridCls}>
          {/* Вторичка/новостройка одним вопросом, у новостройки — одна фаза
              (владелец 23.09.2026). Раскладка в поля базы — та же таблица, что у
              мастера: packages/shared/src/propertyFinish.ts. */}
          {/* У дома и участка «вторички/новостройки» нет (владелец 08.10.2026). */}
          {propertyHasMarket(form.type) && (
          <div className="fld">
            <span className="lab">Вторичка / Новостройка</span>
            <select
              value={marketSideOf(form) ?? ""}
              onChange={(e) => {
                const side = e.target.value;
                if (side === "NEW") {
                  setForm((f) => ({ ...f, marketType: "NEW_BUILD", stage: "", condition: "NEW_BUILDING" }));
                } else if (side === "SECONDARY") {
                  setForm((f) => ({
                    ...f,
                    marketType: "SECONDARY",
                    stage: "",
                    condition: f.condition === "NEW_BUILDING" ? "GOOD" : f.condition,
                  }));
                } else {
                  setForm((f) => ({ ...f, marketType: "", stage: "" }));
                }
              }}
            >
              <option value="">не указано</option>
              <option value="SECONDARY">Вторичка</option>
              <option value="NEW">Новостройка</option>
            </select>
          </div>
          )}

          {propertyHasMarket(form.type) && marketSideOf(form) === "NEW" ? (
            <div className="fld">
              <span className="lab">Стадия и отделка</span>
              <select
                value={newBuildPhaseOf(form) ?? ""}
                onChange={(e) => {
                  const phase = e.target.value as NewBuildPhase | "";
                  if (phase) setForm((f) => ({ ...f, ...fieldsForNewBuildPhase(phase) }));
                }}
              >
                <option value="">не указано</option>
                {NEW_BUILD_PHASES.map((p) => (
                  <option key={p.key} value={p.key}>
                    {p.label}
                  </option>
                ))}
              </select>
            </div>
          ) : propertyHasCondition(form.type) ? (
            <div className="fld">
              <span className="lab">Состояние</span>
              <select
                value={form.condition === "NEW_BUILDING" ? "GOOD" : form.condition}
                onChange={(e) => set("condition", e.target.value as (typeof CONDITIONS)[number])}
              >
                {SECONDARY_CONDITIONS.map((c) => (
                  <option key={c} value={c}>
                    {PROPERTY_CONDITION_LABELS[c]}
                  </option>
                ))}
              </select>
            </div>
          ) : null}

          <div className="wide flex items-center gap-2.5">
            <input
              id="urgent"
              type="checkbox"
              checked={form.urgent}
              onChange={(e) => set("urgent", e.target.checked)}
              className="w-4 h-4 rounded-sm border-line text-blue focus:ring-blue"
            />
            <label htmlFor="urgent" className="text-[15px] font-medium text-gray-700">
              Срочное объявление
            </label>
          </div>

          {/* У участка характеристик здания нет — блок не показывается. */}
          {typeRules.details.length > 0 && (
          <div className="fld wide">
            <span className="lab">Характеристики</span>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 border border-line-soft rounded-lg p-3">
              {PROPERTY_DETAIL_KEYS.filter((key) => propertyDetailShown(form.type, key)).map((key) => (
                <div key={key}>
                  <label className="block text-[13px] text-gray-500 mb-1">{PROPERTY_DETAIL_LABELS[key]}</label>
                  <select
                    value={form.details[key]}
                    onChange={(e) => setDetail(key, e.target.value)}
                  >
                    <option value={NOT_SET}>не указано</option>
                    {PROPERTY_DETAIL_OPTIONS[key].map((opt) => (
                      <option key={opt} value={opt}>
                        {opt}
                      </option>
                    ))}
                  </select>
                </div>
              ))}
            </div>
          </div>
          )}

        </div>
        </div>

        <div className="card">
        <div className="sec-h stack">
          <h2>{STEP_META[3].title}</h2>
          <span className="note">{STEP_META[3].hint}</span>
        </div>
        <div className={gridCls}>
          {/*
            ОТКУДА ВЗЯЛСЯ ПРОДАВЕЦ — ДВА ЧЕСТНЫХ ПУТИ (владелец 17.08.2026).
            Дословно: «либо выберите продавца из вашего списка, либо введите номер
            вручную». Первый — когда продавец уже писал нам и заведён карточкой:
            тогда объект связывается с ней (sellerClientId), и в CRM видно, чей это
            объект. Второй — когда агент нашёл объект сам, продавца в CRM нет вовсе,
            и кроме номера про него сказать нечего.

            Раньше выбора не было ни одного: связь заполнялась ТОЛЬКО когда объект
            создавали из карточки продавца кнопкой, а при обычном создании оставалась
            пустой — на проде 0 из 36 объектов имели продавца.
          */}
          {/*
            ПРОДАВЕЦ ОБЪЕКТА — ОДИН ВОПРОС, ДВА ОТВЕТА (владелец 21.08.2026).
            Либо продавец уже в CRM — выбираем карточку, и номер сервер берёт из неё
            сам (копировать его на клиенте нельзя: агенту без права номер приходит
            замаскированным, и точки уезжали в «Контакт владельца» навсегда).
            Либо продавца в CRM нет (сосед, знакомый) — имя и телефон здесь же, и
            сервер сам заведёт карточку и свяжет с объектом. Раньше второй путь был
            только у несайтовых объектов, а на обычных агент упирался в тупик.
          */}
          {!isEdit && (
            <div className="wide">
              <SellerPicker
                clientId={form.sellerClientId}
                onPick={(seller) => {
                  set("sellerClientId", seller?.id ?? "");
                  // Недописанные руками имя/телефон при выборе карточки затираем:
                  // иначе полузаполненный номер уехал бы в «Контакт владельца»
                  // вместо настоящего номера из карточки (его подставляет сервер).
                  if (seller) {
                    set("sellerName", "");
                    set("ownerContact", "");
                  }
                  /**
                   * ПОДСКАЗКА «У ПРОДАВЦА УЖЕ ЕСТЬ СВОЙ АГЕНТ» (владелец 06.09.2026,
                   * разбор слепых зон п.1). «Кто принял объект» выбирается на шаге 1 —
                   * ДО того, как здесь, на шаге 3, станет известно, кто вообще продавец.
                   * Руководитель мог на шаге 1 указать кого угодно (например, себя),
                   * ещё не зная, что у этой карточки уже есть свой агент-покупатель.
                   * Подставляем его сюда сами — не жёстко, поле остаётся обычным
                   * селектом на шаге 1, его можно вернуть обратно.
                   */
                  if (picksIntakeAgent && seller?.assignedAgentId && seller.assignedAgentId !== form.intakeAgentId) {
                    set("intakeAgentId", seller.assignedAgentId);
                  }
                }}
              />
            </div>
          )}

          {(isEdit || !form.sellerClientId) && (
            <>
              {!isEdit && (
                <div className="fld">
                  <span className="lab">Имя продавца *</span>
                  <input
                    type="text"
                    value={form.sellerName}
                    onChange={(e) => set("sellerName", e.target.value)}
                    placeholder="Как зовут владельца"
                  />
                </div>
              )}
              <div className={isEdit ? "fld wide" : "fld"}>
                <span className="lab">
                  {isEdit ? "Контакт владельца" : "Телефон продавца *"}
                </span>
                {isEdit && property?.ownerContactHidden ? (
                  <p className="text-[15px] text-gray-500">Номер скрыт. Поменять его может тот, кому он виден.</p>
                ) : (
                  <PhoneInput
                    value={form.ownerContact}
                    onChange={(v) => set("ownerContact", v)}
                    placeholder="Телефон владельца объекта"
                  />
                )}
              </div>
              {!isEdit && (
                <p className="wide -mt-1 text-[13px] text-gray-500">
                  CRM сама заведёт карточку продавца по имени и номеру и свяжет с объектом. Если такой
                  номер уже есть в базе, привяжет существующую карточку, дубля не будет.
                </p>
              )}
            </>
          )}

          {/* Несайтовый объект не идёт в Instagram-конвейер — поле для него бессмысленно
              (см. переключатель «Только для показа своим клиентам» на этом же шаге). */}
          {!form.offSite && (
            <div className="fld wide">
              <span className="lab">
                Ссылка на видео в Instagram
              </span>
              <input
                type="url"
                value={form.instagramUrl}
                onChange={(e) => set("instagramUrl", e.target.value)}
                placeholder="https://www.instagram.com/reel/..."
              />
              {/* Не запрет (решение владельца 13.08.2026 — хранить чужую ссылку можно),
                  а предупреждение В МОМЕНТ ВВОДА: раньше агент узнавал о «не той»
                  ссылке из утренней сводки ошибок у директора. */}
              {form.instagramUrl.trim() !== "" && !isInstagramLink(form.instagramUrl) && (
                <p className="mt-1 text-[13px] text-amber">
                  Это не ссылка на Instagram, узнавание пересланных рилсов и KPI «Видео» её не засчитают.
                </p>
              )}
            </div>
          )}

          <div className="fld">
            <span className="lab">
              Документы <span className="text-gray-400 font-normal">(только для сотрудников)</span>
            </span>
            <select
              value={form.documentsPreset}
              onChange={(e) => set("documentsPreset", e.target.value)}
            >
              <option value="">не указано</option>
              {DOCUMENT_PRESETS.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
              <option value="Другое">Другое</option>
            </select>
            {form.documentsPreset === "Другое" && (
              <input
                value={form.documentsOther}
                onChange={(e) => set("documentsOther", e.target.value)}
                placeholder="Укажите документ"
              />
            )}
          </div>

          <div className="fld">
            <span className="lab">Дата принятия объекта</span>
            <input
              type="date"
              value={form.listingAcceptedAt}
              onChange={(e) => set("listingAcceptedAt", e.target.value)}
            />
          </div>

          <div className="wide border-t border-line-soft pt-3.5">
            <p className="text-[15px] text-gray-400">
              {form.offSite
                ? "Описание объекта формируется автоматически по параметрам выше, отдельно вводить не нужно. SEO-текст для сайта не нужен: объект на сайт не идёт."
                : "Описание объекта и SEO-текст для сайта формируются автоматически по параметрам выше, отдельно вводить не нужно."}
            </p>
          </div>

        </div>
        </div>
        </div>

        {error && (
          <div className="card tight">
            <div className="quiet crit">
              <span className="dot crit" />
              <span className="txt">{error}</span>
            </div>
          </div>
        )}

        <div className="sheet-f">
          <button className="pill ghost" type="button" onClick={requestClose}>
            Закрыть
          </button>
          {/* Слой 4: старый мастер («Назад»/«Далее» по шагам) удалён — форма одна
              страница, одна кнопка сабмита. */}
          <button
            type="submit"
            disabled={mutation.isPending || photosUploading}
            className="pill"
          >
            {photosUploading
              ? "Готовим фото..."
              : mutation.isPending
                ? "Сохранение..."
                : isEdit
                  ? "Сохранить"
                  : "Создать объект"}
          </button>
        </div>
      </form>
  );

  const confirmEl = confirmClose ? (
    <ConfirmDialog
      title="Закрыть без сохранения?"
      description="Заполненные поля и выбранные фото будут потеряны."
      confirmLabel="Закрыть"
      onConfirm={onClose}
      onCancel={() => setConfirmClose(false)}
    />
  ) : null;

  if (isPage)
    return (
      <>
        {formEl}
        {confirmEl}
      </>
    );
  // Портал в body: контейнер страницы анимируется трансформацией, а элемент с
  // transform перехватывает на себя position: fixed внутри — окно получало размеры
  // и отступы страницы вместо экрана и «съезжало». См. тот же разбор в ClientFormModal.
  return createPortal(
    <>
      {/* Клик по фону НЕ закрывает форму — иначе промах мимо полей терял весь ввод.
          Закрыть можно крестиком или «Отмена». */}
      <div className="fixed inset-x-0 top-0 h-dvh overlay-scrim flex items-stretch sm:items-center justify-center z-50 sm:p-4">
        {formEl}
      </div>
      {confirmEl}
    </>,
    document.body
  );
}
