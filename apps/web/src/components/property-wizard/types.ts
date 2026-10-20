import {
  PROPERTY_DETAIL_KEYS,
  floorRuleError,
  propertyDetailShown,
  propertyFieldRequired,
  propertyFieldShown,
  propertyHasMarket,
  type Currency,
  type MarketType,
  type PropertyCondition,
  type PropertyDetailKey,
  type PropertyStage,
  type PropertyType,
} from "@royal-home/shared";

/** Готовые варианты «Документов» — те же, что в PropertyFormModal.tsx
 *  (DOCUMENT_PRESETS): менять список в одном месте и не расходиться со старой
 *  формой, пока обе существуют. */
export const DOCUMENT_PRESETS = ["Договор", "Техпаспорт", "Договор + техпаспорт", "Нет документов"] as const;
/** Значение select'а «нет данных» для характеристики — отличимо от "" (пусто
 *  и валидно как «не указано» для сервера), но само на сервер не уходит. */
export const DETAIL_NOT_SET = "__not_set__";

/**
 * МАСТЕР ДОБАВЛЕНИЯ ОБЪЕКТА — общее состояние пяти шагов.
 *
 * Числа держим строками: агент заполняет форму стоя в квартире, поле бывает
 * пустым в середине набора, а `number | ""` в каждом втором месте требует
 * ветвления. Приведение к числу — один раз, в момент отправки (buildCreateBody).
 *
 * Файлов здесь нет НАРОЧНО: черновик уезжает в localStorage, а File туда не
 * кладётся в принципе. Что именно черновик не хранит — сказано агенту прямо на
 * первом шаге, а не подразумевается.
 */
export interface WizardValues {
  type: PropertyType;
  rooms: string;
  areaSqm: string;
  /** Сотки — только у ДОМА и УЧАСТКА (владелец 21.09.2026: «сотки — отдельное
   *  поле объекта», как в договоре). Сервер уже знает поле (propertyCreateSchema,
   *  propertyWizardDraftValuesSchema, Property.landAreaSotka) — здесь то же имя. */
  landAreaSotka: string;
  floor: string;
  totalFloors: string;
  windowCount: string;
  price: string;
  currency: Currency;
  condition: PropertyCondition;
  /** Новостройка/Вторичка — необязательная ось, отдельная от типа объекта. */
  marketType: MarketType | "";
  districtId: string;
  address: string;
  /** Ориентир — короткая фраза вроде «рядом с ТЦ Садбарг», «за Овиром» (пункт 10
   *  владельца, 23.09.2026): необязательна, свободный текст. */
  landmark: string;
  lat: number | null;
  lng: number | null;
  /** Выбранная карточка продавца, если он уже заведён в CRM. */
  sellerClientId: string;
  /** Имя продавца, которого в CRM ещё нет — сервер заведёт карточку сам. */
  sellerName: string;
  /** Телефон продавца — уходит в ownerContact. */
  sellerPhone: string;
  /**
   * Кто принял объект у продавца (0.5% со сделки). Рядовому агенту сервер
   * подставляет его самого и поле не показывается; руководителю оно
   * обязательно — иначе POST /properties отвечает 400 «Укажите, кто принял
   * объект» (routes/properties/crud.ts).
   */
  intakeAgentId: string;
  /**
   * Несайтовый объект — «только для своих клиентов» (владелец 12.09.2026:
   * этого выбора в мастере не было вовсе, хотя сервер его принимает —
   * propertyCreateSchema.offSite). Не поле формы, а состояние: чип в шапке
   * мастера (WizardShell), а не вопрос где-то в середине шагов. При true шаг
   * «Где» остаётся (район/адрес обязательны для ЛЮБОГО объекта), но прячется
   * карта — см. StepPlace.
   */
  offSite: boolean;
  /**
   * 13 характеристик объекта (details) — добавлено 15.09.2026 поверх облика
   * артефакта (владелец: «свёрнутый блок характеристик не должен отличаться от
   * его других полей вообще никак» — те же `.f`/`.segs`, без своей рамки).
   * Ключи и опции взяты из PropertyFormModal.tsx, второй раз не выдумываются.
   * `DETAIL_NOT_SET` — «не указано», сервер такое значение не получает вовсе.
   */
  details: Record<PropertyDetailKey, string>;
  /** Документы — только для сотрудников (владелец: «чтобы знать, что говорить
   *  клиенту»), на сайт и клиенту не показывается. Пресет + своя строка на
   *  «Другое», как в PropertyFormModal.tsx. */
  documentsPreset: (typeof DOCUMENT_PRESETS)[number] | "" | "Другое";
  documentsOther: string;
  /** Стадия стройки — только у новостройки и котлована (packages/shared/src/propertyFinish.ts). */
  stage: PropertyStage | "";
}

/**
 * ПРОДАВЕЦ — ПЕРВЫЙ ШАГ (владелец 21.09.2026, «объект продавца заполняется
 * сам»). Раньше шаг стоял последним, и мастер мог довести агента до конца, так
 * и не спросив, чей это объект. Теперь без продавца — существующей карточки
 * ИЛИ имени с телефоном — дальше «Фото» не пройти (validateStep("seller") ниже
 * по-прежнему требует ровно одно из двух; варианта «без продавца» в мастере
 * никогда и не было — только порядок шагов изменился). Это же место, с уже
 * известным продавцом, — точка входа `?fromClient=` из чата (PropertyWizard.tsx)
 * и подтягивания фактов при ручном выборе продавца (StepSeller.tsx).
 */
export const WIZARD_STEPS = [
  { key: "seller", title: "Продавец" },
  { key: "media", title: "Фото и видео" },
  { key: "main", title: "Главное" },
  { key: "place", title: "Где" },
  { key: "review", title: "Проверка" },
] as const;

export type WizardStepKey = (typeof WIZARD_STEPS)[number]["key"];

/**
 * Индекс шага по его ключу — а не магическое число (21.09.2026, после переноса
 * «Продавца» на первое место). Три места (PropertyWizard.tsx::save при
 * недогруженных файлах, StepReview.tsx — «к какому шагу ведёт строка») раньше
 * держали порядковые номера шагов буквально, и перестановка «Продавца» вперёд
 * молча ломала их все: «Часть файлов не ушла, откройте первый шаг» уводила бы
 * теперь на «Продавца», а не на «Фото». Ключ не переставить незаметно —
 * WizardStepKey это ловит на этапе типов.
 */
export function stepIndexOf(key: WizardStepKey): number {
  return WIZARD_STEPS.findIndex((s) => s.key === key);
}

export const EMPTY_WIZARD_VALUES: WizardValues = {
  type: "APARTMENT",
  rooms: "",
  areaSqm: "",
  landAreaSotka: "",
  floor: "",
  totalFloors: "",
  windowCount: "",
  price: "",
  currency: "TJS",
  condition: "GOOD",
  marketType: "",
  districtId: "",
  address: "",
  landmark: "",
  lat: null,
  lng: null,
  sellerClientId: "",
  sellerName: "",
  sellerPhone: "",
  intakeAgentId: "",
  offSite: false,
  details: Object.fromEntries(PROPERTY_DETAIL_KEYS.map((k) => [k, DETAIL_NOT_SET])) as Record<
    PropertyDetailKey,
    string
  >,
  documentsPreset: "",
  documentsOther: "",
  stage: "",
};

/** Комнаты есть у всех, кроме участка (у коммерции — необязательны). Что у
 *  какого типа — одна таблица, packages/shared/src/propertyTypeFields.ts. */
export function needsRooms(type: PropertyType): boolean {
  return propertyFieldShown(type, "rooms");
}

/** Сотки — только у ДОМА и УЧАСТКА (владелец 21.09.2026); у квартиры и
 *  коммерции своя площадь м² и так есть, вторая цифра только путала бы. */
export function needsLandArea(type: PropertyType): boolean {
  return propertyFieldShown(type, "landAreaSotka");
}

/**
 * СМЕНА ТИПА В МАСТЕРЕ (владелец 08.10.2026): поля, которых у нового типа нет,
 * очищаются сразу — иначе этаж квартиры, набранный до переключения на «Дом»,
 * молча уезжал бы на сервер, а «Новостройка» оставалась у участка.
 */
export function valuesForTypeChange(v: WizardValues, type: PropertyType): Partial<WizardValues> {
  const patch: Partial<WizardValues> = { type };
  for (const f of ["rooms", "areaSqm", "landAreaSotka", "floor", "totalFloors", "windowCount"] as const) {
    if (!propertyFieldShown(type, f)) patch[f] = "";
  }
  if (!propertyHasMarket(type)) {
    patch.marketType = "";
    patch.stage = "";
    if (v.condition === "NEW_BUILDING") patch.condition = "GOOD";
  }
  const details = { ...v.details };
  let detailsChanged = false;
  for (const k of PROPERTY_DETAIL_KEYS) {
    if (!propertyDetailShown(type, k) && details[k] !== DETAIL_NOT_SET) {
      details[k] = DETAIL_NOT_SET;
      detailsChanged = true;
    }
  }
  if (detailsChanged) patch.details = details;
  return patch;
}

export function isWizardEmpty(v: WizardValues): boolean {
  return (
    !v.rooms &&
    !v.areaSqm &&
    !v.landAreaSotka &&
    !v.floor &&
    !v.totalFloors &&
    !v.windowCount &&
    !v.price &&
    !v.districtId &&
    !v.address.trim() &&
    !v.landmark.trim() &&
    v.lat === null &&
    !v.sellerClientId &&
    !v.sellerName.trim() &&
    !v.sellerPhone.trim() &&
    !v.intakeAgentId &&
    v.type === EMPTY_WIZARD_VALUES.type &&
    v.condition === EMPTY_WIZARD_VALUES.condition &&
    !v.marketType &&
    v.offSite === EMPTY_WIZARD_VALUES.offSite &&
    !v.stage &&
    !v.documentsPreset &&
    !v.documentsOther.trim() &&
    PROPERTY_DETAIL_KEYS.every((k) => v.details[k] === DETAIL_NOT_SET)
  );
}

/** Только цифры номера — для сравнения телефонов и проверки длины. */
export function phoneDigits(value: string): string {
  return value.replace(/\D/g, "");
}

/** Шаги, у которых validateStep реально проверяет обязательные поля — «Фото» и
 *  «Проверка» своих обязательных полей не имеют (фото не требует validateStep
 *  вовсе, «Проверка» их только показывает). Общий список для двух функций ниже,
 *  чтобы они не разъехались между собой. */
const VALIDATED_STEP_KEYS = ["seller", "main", "place"] as const satisfies readonly WizardStepKey[];

/**
 * ПЕРВЫЙ НЕЗАПОЛНЕННЫЙ ШАГ ЧЕРНОВИКА (владелец 21.09.2026, DraftGate.tsx:
 * «Продолжить» ведёт туда, где реально нужно дописать, а не на сохранённый
 * шаг/0). Переиспользует validateStep — те же правила обязательности, что и
 * при сохранении, второй раз не выдумываются. Всё заполнено — «Проверка».
 */
export function firstIncompleteStep(v: WizardValues, options: { requireIntakeAgent?: boolean } = {}): number {
  for (const key of VALIDATED_STEP_KEYS) {
    if (Object.keys(validateStep(key, v, options)).length > 0) return stepIndexOf(key);
  }
  return stepIndexOf("review");
}

/**
 * Тексты ошибок обязательных полей черновика по ВСЕМ шагам сразу — «Чего не
 * хватает» на DraftGate.tsx. Та же validateStep, чтобы список не разошёлся с
 * тем, что реально блокирует сохранение объекта.
 */
export function incompleteFieldMessages(v: WizardValues, options: { requireIntakeAgent?: boolean } = {}): string[] {
  const out: string[] = [];
  for (const key of VALIDATED_STEP_KEYS) out.push(...Object.values(validateStep(key, v, options)));
  return out;
}

/**
 * Планка неправдоподобности цены — последняя страховка от бага с потерянным
 * разделителем тысяч (StepMain.tsx, sanitizeNumericInput): `positive()` ниже
 * пропускает любое число больше нуля, а «1,200» → 1.2 такое число и есть.
 *
 * Значение общее для сомони и долларов: недвижимости дешевле сотни единиц
 * валюты не бывает ни в одной из них (курс ~11 сомони/$, то есть даже самый
 * дешёвый объект в долларах на два-три порядка выше). Порог нарочно низкий,
 * чтобы не отсекать реальные дешёвые объекты (доля в участке, гараж) — он
 * ловит только явную порчу ввода, а не подозрительно низкую, но настоящую
 * цену.
 */
const MIN_PLAUSIBLE_PRICE = 100;

/**
 * Ошибки шага. Пустой объект — шаг пройден.
 *
 * Проверки повторяют серверные (propertyCreateSchema), а не выдумывают свои:
 * расхождение здесь означало бы 400 в конце мастера, когда агент уже ушёл из
 * квартиры. Обязательные поля объекта: тип, площадь, цена, валюта, район,
 * адрес, состояние; комнаты, этаж, этажность и окна — по типу
 * (propertyTypeFields.ts); плюс продавец (карточка либо имя с телефоном).
 */
export function validateStep(
  step: WizardStepKey,
  v: WizardValues,
  options: { requireIntakeAgent?: boolean } = {}
): Record<string, string> {
  const errors: Record<string, string> = {};
  const positive = (raw: string) => {
    const n = Number(raw);
    return raw.trim() !== "" && Number.isFinite(n) && n > 0;
  };

  if (step === "main") {
    // У ЗАКРЫТОГО объекта обязательна одна цена (владелец 15.09.2026: «закрытый
    // объект не имеет обязательных пунктов, кроме как цена и продавец»).
    // Площадь, комнаты, этаж, этажность и окна агент дописывает потом из
    // карточки: он заводит такой объект стоя в нём, и восемь обязательных чисел
    // означают, что объект не заведут вовсе. Те же правила на сервере —
    // packages/shared/src/schemas.ts, propertyCreateSchema.
    if (!positive(v.price)) errors.price = "Укажите цену";
    else if (Number(v.price) < MIN_PLAUSIBLE_PRICE) errors.price = "Проверьте цену — сумма выглядит слишком маленькой";
    // Площадь сервер требует у ЛЮБОГО объекта (колонка в базе обязательная), и
    // закрытый без неё получал «Неверные данные» без слова, какое поле не так.
    // У участка площадь — сотки.
    if (v.type === "LAND") {
      if (!positive(v.landAreaSotka)) errors.landAreaSotka = "Укажите площадь участка в сотках";
    } else if (!positive(v.areaSqm)) {
      errors.areaSqm = "Укажите площадь";
    }
    const floorError = floorRuleError(
      v.floor.trim() === "" ? null : Number(v.floor),
      v.totalFloors.trim() === "" ? null : Number(v.totalFloors)
    );
    if (floorError && propertyFieldShown(v.type, "floor")) errors.floor = floorError;
    if (v.offSite) return errors;
    // Что обязательно у типа — та же таблица, что на сервере (propertyTypeFields.ts):
    // у дома нет «этажа», у коммерции комнаты необязательны, у участка ничего из этого.
    if (propertyFieldRequired(v.type, "rooms") && !positive(v.rooms)) errors.rooms = "Укажите комнаты";
    if (propertyFieldRequired(v.type, "floor") && !errors.floor && (v.floor.trim() === "" || !Number.isFinite(Number(v.floor)))) {
      errors.floor = "Укажите этаж";
    }
    if (propertyFieldRequired(v.type, "totalFloors") && !positive(v.totalFloors)) errors.totalFloors = "Укажите этажность";
    if (propertyFieldRequired(v.type, "windowCount")) {
      const windows = Number(v.windowCount);
      if (v.windowCount.trim() === "" || !Number.isInteger(windows) || windows < 0 || windows > 100) {
        errors.windowCount = "Укажите количество окон";
      }
    }
  }

  if (step === "place" && !v.offSite) {
    if (!v.districtId) errors.districtId = "Выберите район";
    if (v.address.trim().length < 2) errors.address = "Укажите адрес";
  }

  if (step === "seller") {
    if (options.requireIntakeAgent && !v.intakeAgentId) errors.intakeAgentId = "Укажите, кто принял объект";
    if (!v.sellerClientId) {
      if (!v.sellerName.trim()) errors.sellerName = "Укажите имя продавца";
      if (phoneDigits(v.sellerPhone).length < 9) errors.sellerPhone = "Укажите телефон продавца";
    }
  }

  return errors;
}

/** Все шаги разом — для кнопки «Сохранить» на последнем шаге. */
export function validateAll(
  v: WizardValues,
  options: { requireIntakeAgent?: boolean } = {}
): Record<string, string> {
  return {
    ...validateStep("main", v, options),
    ...validateStep("place", v, options),
    ...validateStep("seller", v, options),
  };
}

function numberIfFilled(key: string, raw: string): Record<string, number> {
  const n = Number(raw);
  return raw.trim() !== "" && Number.isFinite(n) ? { [key]: n } : {};
}

/**
 * Тело POST /properties. Название, описание и SEO-поля не шлём — сервер
 * формирует их сам (buildPropertyTitle + generateSeoFields).
 */
export function buildCreateBody(v: WizardValues): Record<string, unknown> {
  const shown = (f: "rooms" | "floor" | "totalFloors" | "windowCount") => propertyFieldShown(v.type, f);
  const documents = v.documentsPreset === "Другое" ? v.documentsOther.trim() : v.documentsPreset;
  // Только характеристики, которые есть у типа (лифта у дома нет, у участка — ни одной).
  const details = Object.fromEntries(
    PROPERTY_DETAIL_KEYS.filter((k) => propertyDetailShown(v.type, k) && v.details[k] && v.details[k] !== DETAIL_NOT_SET).map(
      (k) => [k, v.details[k]]
    )
  );
  const market = propertyHasMarket(v.type);
  return {
    type: v.type,
    // У участка м² считаем из соток (1 сотка = 100 м²) — поле м² у него не спрашиваем.
    areaSqm: v.type === "LAND" ? Math.round(Number(v.landAreaSotka) * 100) : Number(v.areaSqm),
    // Сотки — только у дома/участка, и только когда агент их вписал: сервер
    // (propertyCreateSchema.landAreaSotka) поле знает, но необязательное.
    ...(needsLandArea(v.type) && v.landAreaSotka.trim() ? { landAreaSotka: Number(v.landAreaSotka) } : {}),
    price: Number(v.price),
    currency: v.currency,
    // Закрытый объект (offSite) район/адрес может не иметь вовсе (владелец
    // 14.09.2026) — пустую строку в guid-поле сервер отклонит как невалидный
    // guid, поэтому пустое просто не отправляем, а не шлём "". Сервер сам
    // достроит недостающее по координатам телефона (см. lat/lng ниже).
    ...(v.districtId ? { districtId: v.districtId } : {}),
    ...(v.address.trim() ? { address: v.address.trim() } : {}),
    ...(v.landmark.trim() ? { landmark: v.landmark.trim() } : {}),
    condition: v.condition,
    offSite: v.offSite,
    amenities: [],
    // Только заполненное: у закрытого объекта эти поля необязательны, а пустое
    // поле раньше уходило нулём и сервер отвечал 400 («комнат 0»).
    ...(shown("rooms") ? numberIfFilled("rooms", v.rooms) : {}),
    ...(shown("floor") ? numberIfFilled("floor", v.floor) : {}),
    ...(shown("totalFloors") ? numberIfFilled("totalFloors", v.totalFloors) : {}),
    ...(shown("windowCount") ? numberIfFilled("windowCount", v.windowCount) : {}),
    // «Вторичка/Новостройка» — у квартиры и коммерции; у дома и участка её нет.
    ...(market && v.marketType ? { marketType: v.marketType } : {}),
    // Стадия — у новостройки и котлована (раскладка фазы — propertyFinish.ts).
    ...(market && v.marketType && v.marketType !== "SECONDARY" && v.stage ? { stage: v.stage } : {}),
    ...(documents ? { documents } : {}),
    ...(Object.keys(details).length > 0 ? { details } : {}),
    ...(v.intakeAgentId ? { intakeAgentId: v.intakeAgentId } : {}),
    // Координаты уходят только парой — иначе сервер их игнорирует и запускает
    // фоновое геокодирование поверх ручного выбора.
    ...(v.lat !== null && v.lng !== null ? { lat: v.lat, lng: v.lng } : {}),
    ...(v.sellerClientId
      ? { clientId: v.sellerClientId }
      : { sellerName: v.sellerName.trim(), ownerContact: v.sellerPhone.trim() }),
  };
}

/**
 * Поля, которые можно подтянуть из фактов уже известного продавца поверх
 * пустых — используется и при входе `?fromClient=` (сервер там сам стартует
 * с пустой формы, так что заполняется всё), и при выборе существующего
 * продавца ВНУТРИ мастера (StepSeller.tsx), когда агент мог уже вернуться на
 * шаг «Продавец» с заполненного «Главного».
 *
 * `type`/`currency`/`condition` сюда НЕ входят: их значение по умолчанию
 * (APARTMENT/TJS/GOOD) неотличимо от осмысленного выбора — «поле равно
 * значению по умолчанию» не значит «агент его не трогал», поэтому подтягивать
 * такие поля значило бы иногда молча стирать то, что агент выбрал сам.
 * Исключение — валюта вместе с пустой ценой (см. fillEmptyFromDraftValues).
 */
const FACTS_FILLABLE_KEYS = [
  "rooms",
  "areaSqm",
  "landAreaSotka",
  "floor",
  "totalFloors",
  "windowCount",
  "price",
  "districtId",
  "address",
  "landmark",
  "marketType",
] as const satisfies readonly (keyof WizardValues)[];

function isEmptyDraftField(v: string | number | null): boolean {
  return v === "" || v === null;
}

/**
 * Накладывает факты продавца ТОЛЬКО на пустые поля. `incoming` — то же
 * `draft.values`, что присылают оба серверных эндпоинта черновика (уже в
 * строковом формате мастера, см. propertyWizardDraftValuesSchema) — общий тип
 * с WizardValues позволяет не заводить отдельную числовую форму фактов.
 */
export function fillEmptyFromDraftValues(current: WizardValues, incoming: Partial<WizardValues>): WizardValues {
  const next = { ...current };
  // Все ключи из FACTS_FILLABLE_KEYS — строковые поля WizardValues; индексная
  // запись через явный cast, потому что TS не сужает `next[key] = ...` по
  // объединению литеральных ключей цикла (присвоение через `as` слева — не
  // синтаксис TS вовсе).
  const mutable = next as unknown as Record<(typeof FACTS_FILLABLE_KEYS)[number], string>;
  for (const key of FACTS_FILLABLE_KEYS) {
    const inc = incoming[key];
    if (inc === undefined || inc === null || inc === "") continue;
    if (isEmptyDraftField(mutable[key])) {
      mutable[key] = inc as string;
      // Цена и валюта — пара: сумма 100000 из USD-карточки без своей валюты
      // уйдёт как 100000 TJS. Валюту берём только вместе с самой ценой; если
      // цена уже введена агентом, не трогаем ни её, ни валюту (FORMS01).
      if (key === "price" && incoming.currency) next.currency = incoming.currency;
    }
  }
  if (next.lat === null && next.lng === null && incoming.lat != null && incoming.lng != null) {
    next.lat = incoming.lat;
    next.lng = incoming.lng;
  }
  return next;
}
