import type { ObjIconName } from "./ObjIcon";
import { propertyStageChip } from "../../../lib/propertyStageChip";
import { pillTone, type PillTone } from "../tileTone";

/**
 * Смысл пилюли состояния в новом виде. Берётся из того же класса чипа, что у
 * прежнего вида (`statusChipClass`/`propertyStageChip`), своих правил нет.
 * Срочное, внимание и норма различаются яркостью и значком, не только оттенком.
 */
export type ObjTone = PillTone;

export function toneFromChipClass(chipClass: string): ObjTone {
  if (/\bcrit\b/.test(chipClass)) return "crit";
  if (/\b(warn|hot)\b/.test(chipClass)) return "warn";
  if (/\bok\b/.test(chipClass)) return "ok";
  return "neutral";
}

export function toneFromChipTone(tone: string): ObjTone {
  if (tone === "crit") return "crit";
  if (tone === "warn" || tone === "sky" || tone === "lav") return "warn";
  if (tone === "ok") return "ok";
  return "neutral";
}

export const TONE_ICON: Record<ObjTone, ObjIconName | null> = {
  // Красная плашка без огня (ревью #338): огонь — это тревога, а просрочку этапа объясняет текст.
  crit: "circle-alert",
  warn: "circle-alert",
  ok: "check",
  neutral: null,
};

/**
 * ПЛАШКА ЭТАПА — ОДНА ФУНКЦИЯ НА СПИСОК И КАРТОЧКУ (владелец 20.11.2026: «На проверке, 60 дн.» красная с огнём — тревожно для
 * обычного статуса; ревью #338: список и карточка красили один объект по-разному).
 *  · обычный этап — нейтральная плашка без значка тревоги, «На проверке · 3 дн.»;
 *  · срок прошёл — жёлтая: «На проверке · срок прошёл на 1 дн.»;
 *  · срок превышен втрое и больше — красная, но без огня и без паники: «На проверке · просрочено на 57 дн.».
 * «В продаже» остаётся зелёной (это не этап подготовки).
 */
export function stagePillView(
  chip: { tone: string; label: string },
  stage: { inPipeline?: boolean; daysInStage?: number; limitDays?: number | null; overdue?: boolean } | null | undefined,
): { tone: ObjTone; label: string } {
  const base: ObjTone = pillTone(chip.tone === "ok" ? "good" : "info");
  const days = stage?.inPipeline ? stage.daysInStage ?? 0 : 0;
  const withoutDays = chip.label.replace(/,\s*\d+\s*дн\.$/, "");
  if (!days || withoutDays === chip.label) return { tone: base, label: chip.label };
  if (!stage?.overdue) return { tone: base, label: `${withoutDays} · ${days} дн.` };
  const limit = stage.limitDays && stage.limitDays > 0 ? stage.limitDays : null;
  if (!limit) return { tone: pillTone("today"), label: `${withoutDays} · срок прошёл` };
  const late = Math.max(1, days - limit);
  return days >= limit * 3
    ? { tone: pillTone("overdue"), label: `${withoutDays} · просрочено на ${late} дн.` }
    : { tone: pillTone("today"), label: `${withoutDays} · срок прошёл на ${late} дн.` };
}

/** Плашка объекта для списка и карточки: тот же этап, тот же тон, тот же текст. */
export function propertyStagePill(property: Parameters<typeof propertyStageChip>[0], role?: string, now: number = Date.now()): { tone: ObjTone; label: string } {
  return stagePillView(propertyStageChip(property, now, role), property.pipeline);
}

/**
 * Район в карточке один раз (владелец 20.11.2026: «Исмоили Сомони» стоял под ценой, в заголовке и в адресе).
 * Если район уже назван в заголовке, под ценой и в адресе его нет; иначе он стоит в адресе, а под ценой — только цена за метр.
 */
export function districtOnce(
  title: string,
  district: string | null | undefined,
  address: string | null | undefined,
  landmark?: string | null,
): { inTitle: boolean; place: string } {
  const d = district?.trim() ?? "";
  const a = address?.trim() ?? "";
  const inTitle = d !== "" && title.toLocaleLowerCase("ru").includes(d.toLocaleLowerCase("ru"));
  // Адрес, который сам начинается с названия района («Исмоили Сомони, 12»), район повторно не получает.
  const addrHasDistrict = d !== "" && a.toLocaleLowerCase("ru").includes(d.toLocaleLowerCase("ru"));
  const base = inTitle || addrHasDistrict ? a : [d, a].filter(Boolean).join(", ");
  const place = base || (d && !inTitle ? d : "");
  const withLandmark = landmark?.trim() ? (place ? `${place} — ${landmark.trim()}` : landmark.trim()) : place;
  return { inTitle, place: withLandmark };
}
