/**
 * ТИП ЖИЛЬЯ В ПОДБОРЕ — ОДНО ПРАВИЛО (24.09.2026, проход по классам после
 * ОБ-000118). buildPropertyMatchWhere и обратный подбор (lib/propertyMatchFilter.ts)
 * фильтровали тип строго, а подбор для раздачи (routes/matching.ts::clientMatchesProperty)
 * тип не читал вовсе: покупатель дома «совпадал» на 100 баллов с квартирой и лид
 * уходил её агенту. Правило: тип не назван у клиента или у объекта — подходит
 * любой, назван у обоих — только тот же.
 *
 * Это ПОДБОР похожего, а не узнавание названного объекта: там тип — лишь
 * примета (lib/propertyMatch.ts::identifyProperty), здесь «человеку с участком
 * квартира не нужна». Отдельный файл без зависимостей — чтобы подбор для
 * раздачи не тянул за собой рассылку и пуши propertyMatchFilter.ts.
 */
export function propertyTypeMatches(clientType: string | null | undefined, propertyType: string | null | undefined): boolean {
  return !clientType || !propertyType || clientType === propertyType;
}

/** Запрос клиента, ещё не записанный в карточку (routes/matching.ts::findMatchingPropertiesForClient). */
export interface LeadRequirements {
  budgetMin?: number | null;
  budgetMax?: number | null;
  desiredDistrictId?: string | null;
  desiredRooms?: number | null;
  desiredType?: string | null;
}
