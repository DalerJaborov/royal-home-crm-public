/**
 * Our own marks, read from the CRM (17.11.2026, review #225 H3): company name, brand names and full usernames of our connected pages, the
 * public company line and active agents' phones. A caption / screenshot «Объект №N» counts only next to one of them
 * (lib/customerCaptionReference.ts). Cached for a minute: read on the bot turn, never in the pure webhook normalizer.
 */
import { prisma } from "../db.js";
import { PUBLIC_AGENCY_CONTACT } from "./publicAgencyContact.js";
import { customerCaptionReferenceMatchesCard, foldBrandName, type CustomerCaptionReference, type CustomerOwnBrandMarks } from "./customerCaptionReference.js";

const TTL_MS = 60_000;
let cached: { at: number; marks: CustomerOwnBrandMarks } | null = null;

export async function loadCustomerOwnBrandMarks(now = Date.now()): Promise<CustomerOwnBrandMarks> {
  if (cached && now - cached.at < TTL_MS) return cached.marks;
  const [settings, accounts, agents] = await Promise.all([
    prisma.settings.findUnique({ where: { id: "singleton" }, select: { companyName: true } }),
    prisma.messengerAccount.findMany({ where: { enabled: true }, select: { username: true, brandName: true } }),
    prisma.agent.findMany({ where: { isActive: true }, select: { phone: true } }),
  ]);
  const names = new Set<string>();
  // Review #225 N3: the company name, a page's brand name and its FULL username only. Never a page title (any wording) and
  // never a part of a username («royal.home.tj» ≠ «royal»): «ЖК Royal Park. Объект №45» is a foreign post, not our №45.
  for (const raw of [settings?.companyName, ...accounts.flatMap(a => [a.brandName, a.username])]) {
    const name = raw ? foldBrandName(raw) : null;
    if (name) names.add(name);
  }
  const phoneTails = new Set<string>();
  for (const phone of [PUBLIC_AGENCY_CONTACT.digits, ...agents.map(a => a.phone)]) {
    const digits = (phone ?? "").replace(/\D/g, "");
    if (digits.length >= 9) phoneTails.add(digits.slice(-9));
  }
  const marks = { names: [...names], phoneTails: [...phoneTails] };
  cached = { at: now, marks };
  return marks;
}
/** Tests only: drop the one-minute cache. */
export function resetCustomerOwnBrandMarksCache(): void { cached = null; }

/** The caption's number exists in the CRM and the fields it names (rooms, area, district) match that card. */
export async function customerCaptionReferenceVerified(reference: CustomerCaptionReference): Promise<boolean> {
  const row = await prisma.property.findUnique({ where: { shortId: reference.shortId },
    select: { rooms: true, areaSqm: true, deletedAt: true, district: { select: { name: true } } } });
  if (!row || row.deletedAt) return false;
  return customerCaptionReferenceMatchesCard(reference.fields, { rooms: row.rooms, areaSqm: row.areaSqm, districtName: row.district?.name ?? null });
}
