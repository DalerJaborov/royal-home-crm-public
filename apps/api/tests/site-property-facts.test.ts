import { describe, expect, it } from 'vitest';
import { sitePropertyFacts } from '../src/lib/sitePropertyFacts.js';

describe('public website property facts', () => {
  const apartment = { type: 'APARTMENT' as const, floor: 16, totalFloors: 18, condition: 'NEW_BUILDING' as const, stage: 'SHELL' as const, marketType: 'NEW_BUILD' as const, urgent: false };
  it('sends the floor, building height and actual unfinished condition', () => {
    expect(sitePropertyFacts(apartment)).toEqual({ floor: '16/18', totalFloors: 18, repair: 'Без отделки', stage: 'Коробка, черновые не сделаны', type: 'Новостройки', urgent: false });
  });
  it.each([
    ['NEEDS_REPAIR', 'Требует ремонта'], ['GOOD', 'Хорошее состояние'], ['EXCELLENT', 'Отличное состояние'],
  ] as const)('maps %s without inventing a new renovation', (condition, repair) => {
    expect(sitePropertyFacts({ ...apartment, condition, stage: null, marketType: 'SECONDARY' })).toMatchObject({ repair, stage: null, type: 'Вторичка' });
  });
  it('does not infer a renovation from the new-building market alone', () => {
    expect(sitePropertyFacts({ ...apartment, stage: null, floor: null, totalFloors: null })).toMatchObject({ floor: null, totalFloors: null, stage: null, repair: null });
    expect(sitePropertyFacts({ ...apartment, stage: 'ROUGH_FINISH' }).repair).toBe('Черновые работы сделаны');
  });
  it('does not publish inapplicable stale fields for houses or land', () => {
    expect(sitePropertyFacts({ ...apartment, type: 'HOUSE', condition: 'GOOD', totalFloors: 2 })).toEqual({ floor: null, totalFloors: 2, repair: 'Хорошее состояние', stage: null, urgent: false });
    expect(sitePropertyFacts({ ...apartment, type: 'LAND' })).toEqual({ floor: null, totalFloors: null, repair: null, stage: null, urgent: false });
  });
});
