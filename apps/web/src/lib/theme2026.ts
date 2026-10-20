import type { PropertyStageState, PropertyStatus } from "@royal-home/shared";
import { PROPERTY_STATUS_LABELS } from "./format";

/**
 * Соответствие «состояние объекта → вид пилюли эталона».
 *
 * Значения берутся из прототипа темы «Royal Home 2026»
 * (docs/pult/theme-2026/screens/properties.html и property-detail.html), где
 * каждому состоянию сопоставлен свой класс `.chip`:
 *   «В продаже» → chip ok, «На монтаже» → chip warn, «На проверке» → chip hot,
 *   «Ждём фото» → голая chip, «Резерв» → chip mute.
 * Остальные состояния попадают в тот же ряд по смыслу: «Ждём видео» — соседняя
 * стадия ожидания (голая), «Продано» и «Снято» — вышедшие из оборота (mute).
 *
 * Просрочка этапа — `chip crit`: в прототипе критичное всегда красное с рамкой.
 *
 * Своего класса здесь не заведено ни одного: только имена, которые уже есть в
 * theme-2026-proto.css. Отдельный модуль, а не правка StatusBadge, потому что
 * StatusBadge носят ещё десяток экранов старого облика — там ничего не меняем.
 */
const STATUS_CHIP: Record<PropertyStatus, string> = {
  PENDING_REVIEW: "chip hot",
  AWAITING_PHOTOS: "chip",
  AWAITING_VIDEO: "chip",
  EDITING: "chip warn",
  AVAILABLE: "chip ok",
  RESERVED: "chip mute",
  SOLD: "chip mute",
  WITHDRAWN: "chip mute",
};

export function statusChipClass(status: PropertyStatus, stage?: PropertyStageState | null): string {
  return stage?.overdue === true ? "chip crit" : STATUS_CHIP[status];
}

/**
 * Подпись пилюли: базовая — из общего словаря (один источник правды на всю CRM),
 * к конвейерным состояниям прототип дописывает срок («На монтаже, 4 дня»).
 * Дни приходят с сервера готовым признаком (stage.daysInStage) — своей арифметики
 * по датам здесь нет, иначе список и карточка разошлись бы в цифрах.
 */
export function statusChipLabel(status: PropertyStatus, stage?: PropertyStageState | null): string {
  const base = PROPERTY_STATUS_LABELS[status];
  if (!stage?.inPipeline || !stage.daysInStage) return base;
  return `${base}, ${stage.daysInStage} дн.`;
}

/**
 * Сегменты стадий каталога объектов.
 *
 * Было девять пилюль (прототип screens/properties.html: «Все» и восемь
 * состояний). Владелец 21.09.2026: «удали лишние разделы — на проверке, ждём
 * фото, ждём видео и так далее». Четыре этапа подготовки — это внутренняя
 * очередь маркетинга, а не то, чем ищут объект; на телефоне они занимали
 * половину ряда и ряд приходилось прокручивать вбок, чтобы добраться до «В
 * продаже».
 *
 * Они свёрнуты в одну пилюлю «В подготовке» (`inPrep`, фильтрует по всем
 * четырём разом — см. propertyQuerySchema в @royal-home/shared), а не удалены:
 * очередь подготовки маркетингу нужна, и без неё пришлось бы искать такие
 * объекты пролистыванием. Пустое `value` у «Все» сохранено — на него завязан
 * сброс фильтра.
 */
export const STAGE_SEGMENTS: { value: string; label: string; inPrep?: true }[] = [
  { value: "", label: "Все" },
  { value: "", label: "В подготовке", inPrep: true },
  { value: "AVAILABLE", label: "В продаже" },
  { value: "RESERVED", label: "Резерв" },
  { value: "SOLD", label: "Продано" },
  { value: "WITHDRAWN", label: "Снято" },
];

/** Инициалы для кружка `.av` — как в прототипе (две буквы, заглавные). */
export function initials(name: string | null | undefined): string {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  return (parts[0][0] + (parts[1]?.[0] ?? "")).toUpperCase();
}
