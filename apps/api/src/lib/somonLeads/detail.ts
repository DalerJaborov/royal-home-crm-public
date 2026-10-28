import { z } from "zod";
import { assessSeller } from "./sellerAssessment.js";

const cardSchema = z.object({
  id: z.number().int().positive(),
  name: z.string().min(1).max(500),
  description: z.string().max(20000).nullable().optional(),
  price: z.object({ price: z.string().max(120).nullable().optional() }).nullable().optional(),
  location: z.object({ name: z.string().max(500).nullable().optional() }).nullable().optional(),
  gallery: z.object({ preview: z.array(z.string()).optional() }).nullable().optional(),
  user: z.object({ id: z.number().int().positive().optional(), name: z.string().max(500).nullable().optional(), active_adverts: z.string().max(100).nullable().optional(), is_business_account: z.boolean().nullable().optional(), is_company: z.boolean().nullable().optional() }),
  categories: z.array(z.object({ slug: z.string() })).max(20),
  is_closed: z.boolean(),
});

export function parseSomonDetail(value: unknown, expectedId: string) {
  const result = cardSchema.safeParse(value);
  if (!result.success || String(result.data.id) !== expectedId) throw new Error("Invalid Somon card response");
  const x = result.data;
  const count = /^(\d+)\b/u.exec(x.user.active_adverts ?? "");
  // Total active ads is a conservative upper bound on distinct active apartments.
  const total = count ? Number(count[1]) : null;
  const business = x.user.is_business_account === true || x.user.is_company === true ? true : x.user.is_business_account === false && x.user.is_company === false ? false : null;
  const assessment = assessSeller({ businessAccount: business, distinctApartments: total, name: x.user.name ?? "", description: x.description ?? "" });
  const rawImage = x.gallery?.preview?.[0];
  let image: string | null = null;
  if (rawImage) { try { const url = new URL(rawImage); if (url.protocol === "https:" && url.hostname === "cdntj.somon.tj") image = url.href; } catch { /* invalid image is omitted */ } }
  const inScope = x.location?.name?.trim().toLocaleLowerCase("ru") === "душанбе" && x.categories.some(c => c.slug === "nedvizhimost") && x.categories.some(c => c.slug === "prodazha-kvartir");
  return { title: x.name, price: x.price?.price ?? null, location: x.location?.name ?? null, image, isClosed: x.is_closed === true, inScope, assessment, seller: { id: x.user.id ?? null, total, business, name: x.user.name ?? "", description: x.description ?? "" } };
}
