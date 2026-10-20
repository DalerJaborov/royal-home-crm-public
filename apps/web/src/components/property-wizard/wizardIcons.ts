import {
  Armchair, ArrowUpDown, Bath, BedDouble, BrickWall, Building2, CalendarDays,
  CarFront, ClipboardCheck, Fence, FileText, Flame, Images, Layers, MapPin,
  MoveVertical, PanelsTopLeft, Refrigerator, Ruler, ShieldCheck, UserRound,
  Wallet, Wifi, Wrench,
} from "lucide-react";
import type { PropertyDetailKey } from "@royal-home/shared";
import type { WizardStepKey } from "./types";

export const WIZARD_STEP_ICONS = {
  seller: UserRound, media: Images, main: Building2, place: MapPin, review: ClipboardCheck,
} satisfies Record<WizardStepKey, typeof Building2>;

export const WIZARD_FIELD_ICONS = {
  rooms: BedDouble, areaSqm: Ruler, landAreaSotka: Ruler, floor: Layers,
  totalFloors: Building2, windowCount: PanelsTopLeft, price: Wallet,
} as const;

export const WIZARD_DETAIL_ICONS = {
  balcony: Fence, bathroom: Bath, ceilingHeight: MoveVertical, windows: PanelsTopLeft,
  heating: Flame, elevator: ArrowUpDown, parking: CarFront, security: ShieldCheck,
  yearBuilt: CalendarDays, material: BrickWall, internet: Wifi, furniture: Armchair,
  appliances: Refrigerator,
} satisfies Record<PropertyDetailKey, typeof Building2>;

export { Building2, FileText, Wrench };
