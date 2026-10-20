import { useQuery } from "@tanstack/react-query";
import type { SellerObjectSummary } from "@royal-home/shared";
import { api } from "../lib/api";

/**
 * ПОЛОСА «ОБЪЕКТ ПРОДАВЦА» В ЧАТЕ (владелец 21.09.2026, макет «Объект из
 * переписки») — GET /clients/:id/seller-object, без вызова ИИ: факты копит
 * фоновое задание (apps/api/src/lib/sellerFacts.ts), здесь только чтение.
 *
 * staleTime минута — полоса открывается на КАЖДЫЙ заход в чат (переключение
 * между диалогами списком слева гоняет этот запрос постоянно), а данные
 * меняются не чаще, чем фоновое задание разбирает новое сообщение (с
 * дребезгом +15 мин, см. брифинг). Частый рефетч не нужен и просто грузит API.
 */
export function useSellerObject(clientId: string | null | undefined, options?: { enabled?: boolean }) {
  return useQuery<SellerObjectSummary>({
    queryKey: ["seller-object", clientId],
    queryFn: () => api<SellerObjectSummary>(`/clients/${clientId}/seller-object`),
    enabled: !!clientId && (options?.enabled ?? true),
    staleTime: 60_000,
  });
}

/** «8 фото, планировка» — что уже есть в переписке, коротко (полоса, кнопка
 *  ещё не нажата). Пустая строка — вложений ещё нет вовсе. */
export function sellerMediaSummary(s: SellerObjectSummary): string {
  const bits: string[] = [];
  if (s.photoCount > 0) bits.push(`${s.photoCount} фото`);
  if (s.planCount > 0) bits.push("планировка");
  if (s.videoCount > 0) bits.push(`${s.videoCount} видео`);
  return bits.join(", ");
}

/** «3 комн., 86 м², 85 000 $» — только то, что реально известно, без выдумки
 *  пустых мест (макет: «Текст говорит, что уже есть в переписке»). */
export function sellerFactsSummary(s: SellerObjectSummary): string {
  const f = s.facts;
  if (!f) return "";
  const bits: string[] = [];
  if (f.rooms) bits.push(`${f.rooms} комн.`);
  if (f.areaSqm) bits.push(`${f.areaSqm} м²`);
  else if (f.landAreaSotka) bits.push(`${f.landAreaSotka} сот.`);
  if (f.price) {
    const money = f.price.toLocaleString("ru-RU");
    bits.push(f.currency === "USD" ? `${money} $` : `${money} с.`);
  }
  return bits.join(", ");
}
