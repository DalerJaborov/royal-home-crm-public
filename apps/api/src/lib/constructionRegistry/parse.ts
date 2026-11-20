/**
 * РАЗБОР ДАННЫХ РЕЕСТРА memor.pro (20.11.2026): список объектов (JSON) и страница объекта (HTML).
 * Чистые функции без сети и базы, чтобы их можно было проверить на образцах. Контакты не разбираем вовсе.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { isRegistryColor, type RegistryColor } from "@royal-home/shared";

export const REGISTRY_ORIGIN = "https://www.memor.pro";
export const REGISTRY_LIST_URL = `${REGISTRY_ORIGIN}/sokhtmon/get_data.php`;

const listItemSchema = z.object({
  id: z.union([z.string(), z.number()]).transform(String),
  title: z.string().default(""),
  customer: z.string().default(""),
  qaror: z.union([z.string(), z.number()]).transform(String).default(""),
  lat: z.coerce.number().finite(),
  lng: z.coerce.number().finite(),
  url: z.string().default(""),
  is_complete: z.boolean().default(false),
  color_status: z.string(),
  has_commission: z.boolean().default(false),
  category: z.string().default("residential"),
  edu_type: z.string().default(""),
});

export interface RegistryListItem {
  sourceId: string;
  title: string;
  customer: string;
  qaror: string;
  lat: number;
  lng: number;
  url: string;
  isComplete: boolean;
  color: RegistryColor;
  hasCommission: boolean;
  category: string;
  eduType: string | null;
  /** Хэш значимых полей строки: поменялся — перечитать страницу объекта. */
  hash: string;
}

export interface ParsedList {
  items: RegistryListItem[];
  /** Сколько строк не разобралось (битые координаты, неизвестный цвет): считаем и пишем, молча не теряем. */
  skipped: number;
}

/** Разбор списка. Не массив — ошибка (сторож здравого смысла в sync.ts не даст применить такое). */
export function parseRegistryList(raw: unknown): ParsedList {
  if (!Array.isArray(raw)) throw new Error("Реестр вернул не список");
  const items: RegistryListItem[] = [];
  let skipped = 0;
  const seen = new Set<string>();
  for (const row of raw) {
    const parsed = listItemSchema.safeParse(row);
    if (!parsed.success || !isRegistryColor(parsed.data.color_status)) {
      skipped += 1;
      continue;
    }
    const d = parsed.data;
    // Точка вне разумных границ (Таджикистан) — не доверяем, не рисуем на карте.
    if (d.lat < 36 || d.lat > 42 || d.lng < 66 || d.lng > 76 || seen.has(d.id)) {
      skipped += 1;
      continue;
    }
    seen.add(d.id);
    const color = d.color_status as RegistryColor;
    const hash = createHash("sha256")
      .update([d.id, d.title, d.customer, d.qaror, d.lat, d.lng, d.is_complete, color, d.has_commission, d.category, d.edu_type].join("|"))
      .digest("hex")
      .slice(0, 32);
    items.push({
      sourceId: d.id,
      title: d.title.trim(),
      customer: d.customer.trim(),
      qaror: d.qaror.trim(),
      lat: d.lat,
      lng: d.lng,
      url: d.url,
      isComplete: d.is_complete,
      color,
      hasCommission: d.has_commission,
      category: d.category || "residential",
      eduType: d.edu_type ? d.edu_type : null,
      hash,
    });
  }
  return { items, skipped };
}

/** Ссылка на страницу объекта; только на домене реестра, чужие адреса не принимаем. */
export function registryProjectUrl(relative: string): string {
  const url = new URL(relative.replace(/^\/+/, ""), `${REGISTRY_ORIGIN}/sokhtmon/`);
  if (url.origin !== REGISTRY_ORIGIN) throw new Error("Адрес страницы объекта вне домена реестра");
  return url.toString();
}

export interface ParsedProjectPage {
  address: string | null;
  description: string | null;
  floors: number | null;
  blocks: string[];
  documents: { name: string; ready: boolean }[];
  warning: string | null;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function text(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

/** Этажность из описания: «14 (чордаҳ) ошёна», «9 этажей». null — не нашли, не выдумываем. */
export function floorsFromDescription(description: string | null): number | null {
  if (!description) return null;
  const m = /(\d{1,2})\s*(?:\([^)]*\)\s*)?(?:ошёна|ошена|этаж|қабат)/i.exec(description);
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 1 && n <= 80 ? n : null;
}

/** Страница объекта: адрес, описание, блоки с разрешением, документы. Только то, что реально есть в разметке. */
export function parseRegistryProjectPage(html: string): ParsedProjectPage {
  const addressMatch = /<strong>[^<]*Суроға:?<\/strong>\s*([^<]+)</.exec(html);
  const descMatch = /<strong>Тавсифи лоиҳа:?<\/strong>\s*([^<]+)</.exec(html);
  const address = addressMatch ? text(addressMatch[1]!) || null : null;
  const description = descMatch ? text(descMatch[1]!) || null : null;

  const blocks = [...html.matchAll(/<div class="block-tag"[^>]*>([\s\S]*?)<\/div>/g)].map((m) => text(m[1]!)).filter(Boolean);

  const documents: { name: string; ready: boolean }[] = [];
  for (const m of html.matchAll(/<a\b[^>]*class="card([^"]*)"[^>]*>([\s\S]*?)<\/a>/g)) {
    const name = text(m[2]!);
    if (!name) continue;
    documents.push({ name, ready: /\buploaded\b/.test(m[1]!) && !/\bdisabled\b/.test(m[1]!) });
  }

  const warningMatch = /⚠️\s*([^<]+)</.exec(html);
  const warning = warningMatch ? text(warningMatch[1]!) || null : null;

  return { address, description, floors: floorsFromDescription(description), blocks, documents, warning };
}

/** Хэш разобранной страницы: по нему видно, что документы изменились, даже если цвет в списке тот же. */
export function hashProjectPage(page: ParsedProjectPage): string {
  return createHash("sha256").update(JSON.stringify(page)).digest("hex").slice(0, 32);
}
