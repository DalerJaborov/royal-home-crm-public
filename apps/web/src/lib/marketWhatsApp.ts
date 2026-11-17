import { marketSourceName } from "./marketSource";
import { digitsOf } from "./phone";

/** Текст первого сообщения продавцу объявления (владелец 02.11.2026). */
export function marketWhatsAppText(source: string, title: string, sourceUrl: string): string {
  const name = marketSourceName(source);
  const subject = title.trim() ? ` «${title.trim().slice(0, 120)}»` : "";
  return `Здравствуйте! Интересует объявление${subject} на ${name}: ${sourceUrl}`;
}

/** wa.me принимает только цифры с кодом страны; 9-значный местный номер дополняем 992. */
export function marketWhatsAppUrl(phone: string, text: string): string | null {
  let digits = digitsOf(phone);
  if (digits.length === 9) digits = `992${digits}`;
  if (digits.length < 11 || digits.length > 15) return null;
  return `https://wa.me/${digits}?text=${encodeURIComponent(text)}`;
}
