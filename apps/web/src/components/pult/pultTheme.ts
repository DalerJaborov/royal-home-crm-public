import { Banknote, Bot, Briefcase, HeartPulse, Home, Megaphone, PhoneCall, UserCheck, Users, type LucideIcon } from "lucide-react";
import type { PultAreaId, PultTone } from "@royal-home/shared";

/** Значок и пастельный акцент каждой области — только для значка, не для фона плитки
 *  (правило макета: пастели — акценты, семантика ok/warn/crit отдельно). */
export const AREA_ICON: Record<PultAreaId, { icon: LucideIcon; chip: string }> = {
  clients: { icon: Users, chip: "bg-blue/10 text-blue" },
  team: { icon: UserCheck, chip: "bg-violet/10 text-violet" },
  money: { icon: Banknote, chip: "bg-green/10 text-green" },
  properties: { icon: Home, chip: "bg-blue/10 text-blue" },
  calls: { icon: PhoneCall, chip: "bg-green/10 text-green" },
  ads: { icon: Megaphone, chip: "bg-amber/10 text-amber" },
  bot: { icon: Bot, chip: "bg-violet/10 text-violet" },
  deals: { icon: Briefcase, chip: "bg-green/10 text-green" },
  system: { icon: HeartPulse, chip: "bg-blue/10 text-blue" },
};

export const TONE_DOT: Record<PultTone, string> = { ok: "bg-green", warn: "bg-amber", crit: "bg-red" };
export const TONE_STROKE: Record<PultTone, string> = { ok: "stroke-green", warn: "stroke-amber", crit: "stroke-red" };
export const TONE_TEXT: Record<PultTone, string> = { ok: "text-gray-500", warn: "text-amber", crit: "text-red" };
