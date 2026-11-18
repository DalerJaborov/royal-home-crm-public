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
