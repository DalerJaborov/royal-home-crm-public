import type { ObjIconName } from "./ObjIcon";

/**
 * Смысл пилюли состояния в новом виде. Берётся из того же класса чипа, что у
 * прежнего вида (`statusChipClass`/`propertyStageChip`), своих правил нет.
 * Срочное, внимание и норма различаются яркостью и значком, не только оттенком.
 */
export type ObjTone = "crit" | "warn" | "ok" | "neutral";

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
  crit: "flame",
  warn: "circle-alert",
  ok: "check",
  neutral: null,
};

/**
 * ПЛАШКА ЭТАПА НА КАРТОЧКЕ ОБЪЕКТА (владелец 20.11.2026: «На проверке, 60 дн.» красная с огнём — тревожно для обычного
 * статуса). Красное с огнём — только когда этап ушёл за срок в три раза и больше; просто просрочка — спокойный жёлтый
 * значок. Текст понятный: «На проверке · 60 дн. (срок 3)» вместо «На проверке, 60 дн.».
 */
export function stagePillView(
  chip: { tone: string; label: string },
  stage: { inPipeline?: boolean; daysInStage?: number; limitDays?: number | null; overdue?: boolean } | null | undefined,
): { tone: ObjTone; label: string } {
  const base = toneFromChipTone(chip.tone === "crit" ? "warn" : chip.tone);
  const days = stage?.inPipeline ? stage.daysInStage ?? 0 : 0;
  const withoutDays = chip.label.replace(/,\s*\d+\s*дн\.$/, "");
  if (!days || withoutDays === chip.label) return { tone: base, label: chip.label };
  if (!stage?.overdue) return { tone: base, label: `${withoutDays} · ${days} дн.` };
  const limit = stage.limitDays && stage.limitDays > 0 ? stage.limitDays : null;
  const label = `${withoutDays} · ${days} дн.${limit ? ` (срок ${limit})` : ""}`;
  return { tone: limit && days >= limit * 3 ? "crit" : "warn", label };
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
