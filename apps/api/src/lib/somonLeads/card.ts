export interface SomonCard {
  title: string;
  price: string | null;
  location: string | null;
  phone: string | null;
  sourceUrl: string;
  assessment: "likely_owner" | "review";
}

export function normalizeSomonPhone(phone: string): string | null {
  const digits = phone.replace(/\D/g, "");
  if (/^992\d{9}$/.test(digits)) return digits;
  if (/^0\d{9}$/.test(digits)) return `992${digits.slice(1)}`;
  if (/^\d{9}$/.test(digits)) return `992${digits}`;
  return null;
}

/** Text only: no photos are copied to CRM storage. Availability of WhatsApp is not inferred. */
export function formatSomonCard(card: SomonCard): string {
  const url = new URL(card.sourceUrl);
  if (url.protocol !== "https:" || url.hostname !== "somon.tj" || !/^\/adv\/\d+_[\w%-]+\/$/.test(url.pathname) || url.href.length > 260 || url.search || url.hash) {
    throw new Error("Invalid Somon listing URL");
  }
  const international = card.phone ? normalizeSomonPhone(card.phone) : null;
  const line = (value: string, max: number) => value.replace(/\s+/g, " ").trim().slice(0, max);
  const lines = [
    "🏠 ОБЪЯВЛЕНИЕ · ДУШАНБЕ",
    "",
    line(card.title, 120),
    ...(card.price ? [`💰 ${line(card.price, 60)}`] : []),
    ...(card.location ? [`📍 ${line(card.location, 100)}`] : []),
    "",
    card.assessment === "likely_owner" ? "👤 Вероятно собственник — уточните при звонке" : "👤 Продавца нужно проверить",
    international ? `📞 +${international}` : "📞 Телефон не получен — откройте объявление",
    ...(international ? [`💬 WhatsApp: https://wa.me/${international}`] : []),
    `🔗 ${url.href}`,
  ];
  return lines.join("\n");
}
