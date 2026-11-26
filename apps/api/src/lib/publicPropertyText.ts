/**
 * Что из названия и описания объекта можно показать по личной ссылке /l/<токен> (26.11.2026).
 *
 * Страница открыта без входа, а ссылку теперь получает любой собеседник, в том числе до разговора
 * с агентом. В названии и описании агенты пишут улицу, телефон и имя собственника, поэтому наружу
 * идёт собранное название (тип, район) и описание без телефонов, почты, @-имён, адреса и контакта.
 */
import { PROPERTY_TYPE_LABELS } from "../ai/agencyVoice.js";
import { maskPhonesInFreeText } from "./clientPhone.js";

export function publicPropertyTitle(p: { rooms: number | null; type: string; district?: { name: string } | null }): string {
  const kind = p.rooms ? `${p.rooms}-комн` : PROPERTY_TYPE_LABELS[p.type] ?? "Объект";
  return p.district?.name ? `${kind}, ${p.district.name}` : kind;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const STREET_RE = /(?:^|[\s,(])(?:ул\.?|улица|пр-т|проспект|пр\.|к-р|кучаи|кӯча|махалла|дом|д\.)\s*[№#]?\s*[\p{L}\p{N}-]+(?:\s+[\p{N}][\p{N}/-]*)?/giu;

export function publicPropertyDescription(
  text: string | null | undefined,
  p: { address?: string | null; ownerContact?: string | null }
): string | null {
  if (!text) return text ?? null;
  let out = text;
  for (const secret of [p.address, p.ownerContact]) {
    const s = secret?.trim() ?? "";
    if (s.length >= 3) out = out.replace(new RegExp(escapeRe(s), "gi"), "");
    // Имя собственника без телефона: каждое слово контакта длиннее двух букв, с падежным окончанием («Рустаму»).
    for (const word of s.split(/[\s,;+()]+/).filter((w) => w.length > 2 && !/\d/.test(w))) {
      out = out.replace(new RegExp(String.raw`(?<![\p{L}])${escapeRe(word)}[\p{L}]{0,3}(?![\p{L}])`, "giu"), "");
    }
  }
  out = maskPhonesInFreeText(out)
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "")
    .replace(/@[\w.]{3,}/g, "")
    .replace(STREET_RE, "");
  return out.replace(/[ \t]{2,}/g, " ").replace(/\s+([,.;])/g, "$1").trim();
}
