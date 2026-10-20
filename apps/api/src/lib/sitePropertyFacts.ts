import {
  PROPERTY_STAGE_LABELS, propertyFieldShown, propertyHasCondition, propertyHasMarket,
  type PropertyType, type PropertyCondition, type PropertyStage, type MarketType,
} from '@royal-home/shared';

type Source = {
  type: PropertyType; floor: number | null; totalFloors: number | null;
  condition: PropertyCondition; stage: PropertyStage | null; marketType: MarketType | null; urgent: boolean;
};

/** CRM facts only. Explicit null clears stale site defaults; unknown is never a renovation. */
export function sitePropertyFacts(p: Source) {
  const totalFloors = propertyFieldShown(p.type, 'totalFloors') ? p.totalFloors ?? null : null;
  const floor = propertyFieldShown(p.type, 'floor') && p.floor != null
    ? `${p.floor}${totalFloors != null ? `/${totalFloors}` : ''}` : null;
  const market = propertyHasMarket(p.type);
  const repair = !propertyHasCondition(p.type) ? null
    : p.condition === 'NEEDS_REPAIR' ? 'Требует ремонта'
    : p.condition === 'GOOD' ? 'Хорошее состояние'
    : p.condition === 'EXCELLENT' ? 'Отличное состояние'
    : market && p.stage === 'SHELL' ? 'Без отделки'
    : market && p.stage === 'ROUGH_FINISH' ? 'Черновые работы сделаны' : null;
  const type = market && p.marketType === 'SECONDARY' ? 'Вторичка' as const
    : market && (p.marketType === 'NEW_BUILD' || p.marketType === 'FOUNDATION_PIT' || p.condition === 'NEW_BUILDING')
      ? 'Новостройки' as const : undefined;
  return {
    floor, totalFloors, repair, stage: market && p.stage ? PROPERTY_STAGE_LABELS[p.stage] : null,
    ...(type ? { type } : {}), urgent: p.urgent,
  };
}
