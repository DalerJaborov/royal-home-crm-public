/**
 * ОБЗОРНЫЕ ЭКРАНЫ ШИРЕ (пачка B «одна оболочка», 20.11.2026). На 1440–1920 в «Новом
 * виде» содержимое стоит по центру колонкой 1280 px (theme-look-royal.css), а
 * главная и отчёты — 1600 px: им есть что поставить в ряд, остальным экранам
 * лишняя ширина только растягивает строки. Признак ставит AppLayout атрибутом
 * `data-ry-wide` на рамке оболочки.
 */
const WIDE_ROUTES = ["/", "/reports", "/sources", "/insights", "/funnel"];

export function isWideRoute(pathname: string): boolean {
  return WIDE_ROUTES.includes(pathname);
}
