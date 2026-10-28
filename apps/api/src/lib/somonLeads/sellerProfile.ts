import { z } from "zod";

/** Reject incomplete, inconsistent or changed profile markup rather than guess. */
export function parseSellerProfile(html: string, sellerId: number, currentId: string, expected: number): string[] | null {
  if (!Number.isSafeInteger(sellerId) || sellerId <= 0 || expected < 3 || expected > 30 || html.length > 4 * 1024 * 1024) return null;
  if (!html.includes(`/items/author/${sellerId}/`)) return null;
  const count = /Найдено\s+(\d+)\s+объявлен/i.exec(html);
  if (!count || Number(count[1]) !== expected) return null;
  // A page link means this single response may not contain every advertisement.
  if (/href=["'][^"']*\/items\/author\/\d+\/\?[^"']*\bpage=\d+/i.test(html)) return null;
  const tags = [...html.matchAll(/<div\b[^<>]{0,2048}\bdata-advert-id=["'](\d{1,20})["'][^<>]{0,2048}>/gi)];
  if (tags.length !== expected) return null;
  const slugs: string[] = [];
  for (let i = 0; i < tags.length; i++) {
    const id = tags[i][1];
    const part = html.slice(tags[i].index!, i + 1 < tags.length ? tags[i + 1].index : undefined);
    const paths = [...part.matchAll(/href=["']\/adv\/(\d+_[\w%-]{1,180})\/["']/gi)].map(m => m[1]);
    const slug = paths.find(path => path.startsWith(`${id}_`));
    if (!slug || paths.some(path => !path.startsWith(`${id}_`))) return null;
    slugs.push(slug);
  }
  if (new Set(tags.map(tag => tag[1])).size !== expected || !tags.some(tag => tag[1] === currentId)) return null;
  return slugs.filter(slug => !slug.startsWith(`${currentId}_`));
}

const siblingSchema = z.object({ id: z.number().int().positive(), is_closed: z.boolean(), user: z.object({ id: z.number().int().positive() }), categories: z.array(z.object({ slug: z.string().min(1) })).min(1).max(20) });
const roots = new Set(["nedvizhimost", "transport", "vakansii", "telefonyi-i-svyaz", "detskij-mir", "odezhda-i-obuv", "kompyuteryi-i-orgtehnika", "elektronika-i-tehnika", "vse-dlya-doma", "stroitelstvo-syrye-i-remont", "hobbi", "zhivotnyie-i-rasteniya", "biznes-i-uslugi", "vsyo-dlya-biznesa", "otdam-darom"]);
export function parseSiblingCategory(value: unknown, sellerId: number, slug: string): boolean | null {
  const parsed = siblingSchema.safeParse(value);
  if (!parsed.success || parsed.data.is_closed || parsed.data.user.id !== sellerId || !slug.startsWith(`${parsed.data.id}_`)) return null;
  const slugs = parsed.data.categories.map(category => category.slug);
  const root = slugs[0];
  if (!roots.has(root) || slugs.slice(1).some(x => roots.has(x))) return null;
  return root === "nedvizhimost";
}
