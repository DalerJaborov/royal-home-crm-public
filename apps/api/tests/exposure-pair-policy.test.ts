import { describe, expect, it } from 'vitest';
import { evaluateExposurePair, type ExposurePairFacts } from '../src/lib/exposurePairPolicy.js';
const day = 86_400_000;
const anchor = new Date('2026-10-01T10:00:00Z');
const facts = (patch: Partial<ExposurePairFacts> = {}): ExposurePairFacts => ({
  exposureId: 'stand-exposure', buyerClientId: 'stand-buyer', propertyId: 'stand-property',
  sentAt: anchor, assignedAt: new Date(anchor.getTime() - day), now: new Date(anchor.getTime() + 8 * day),
  sourceVerified: true, sourceCoverageKnown: true, lastBuyerSpeechAt: null, buyerPauseExplained: false,
  leftSaleAt: new Date(anchor.getTime() + 3 * day), isOffMarket: true, hasNonCancelledDeal: false, reserved: false,
  sellerSpeechBefore: true, sellerSpeechAfter: false, agentStationOrDeliveryBefore: false,
  agentStationOrDeliveryAfter: null, agentHadRedEvidence: false, agentSilenceAvailable: true, ...patch,
});
describe('exposure-only pair policy', () => {
  it('uses seven days and a real removal within thirty days without inventing a showing', () => {
    expect(evaluateExposurePair(facts())).toMatchObject({ state: 'SUSPECTED', mayAskOwner: true,
      signals: ['property_left_sale', 'both_silent', 'seller_stopped_answering'] });
    expect(evaluateExposurePair(facts({ now: new Date(anchor.getTime() + 7 * day - 1) })).state).toBe('WAITING');
  });
  it.each([{ hasNonCancelledDeal: true }, { reserved: true }, { buyerPauseExplained: true },
    { lastBuyerSpeechAt: new Date(anchor.getTime() + day) }])('independent explanation or deal closes the circle %j', patch => {
    expect(evaluateExposurePair(facts(patch))).toMatchObject({ state: 'CLEAR', mayAskOwner: false });
  });
  it.each([{ sourceVerified: false }, { sourceCoverageKnown: false }, { buyerPauseExplained: null },
    { leftSaleAt: null }, { assignedAt: new Date(anchor.getTime() + 1) }])('unknown facts cannot authorise an owner probe %j', patch => {
    expect(evaluateExposurePair(facts(patch))).toMatchObject({ state: 'UNKNOWN', mayAskOwner: false });
  });
  it('does not count missing seller evidence as silence', () => {
    expect(evaluateExposurePair(facts({ sellerSpeechAfter: null }))).toMatchObject({ state: 'SUSPECTED',
      mayAskOwner: false, signals: ['property_left_sale'] });
  });
  it('does not count agent silence during unavailable work window', () => {
    const verdict = evaluateExposurePair(facts({ sellerSpeechAfter: null, agentStationOrDeliveryBefore: true,
      agentStationOrDeliveryAfter: false, agentSilenceAvailable: false }));
    expect(verdict.signals).not.toContain('agent_stopped_seller');
    expect(verdict.mayAskOwner).toBe(false);
  });
  it('requires removal after exposure and within the specified window', () => {
    for (const leftSaleAt of [new Date(anchor.getTime() - 1), new Date(anchor.getTime() + 30 * day + 1)])
      expect(evaluateExposurePair(facts({ leftSaleAt })).state).toBe('CLEAR');
  });
});
