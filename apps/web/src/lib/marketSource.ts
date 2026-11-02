/** Площадка человеческим именем: "somon.tj" → "Somon". */
export function marketSourceName(source: string): string {
  const s = source.toLowerCase();
  if (s.includes("somon")) return "Somon";
  if (s.includes("paydo")) return "Paydo";
  return source.replace(/\.tj$/i, "").replace(/^./, (c) => c.toUpperCase());
}
