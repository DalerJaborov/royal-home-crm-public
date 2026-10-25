/** PDF §10/16: an exposure is a sent object, never proof that it was viewed. */
export type ExposurePairFacts = {
  exposureId: string; buyerClientId: string; propertyId: string;
  sentAt: Date; assignedAt: Date; now: Date;
  sourceVerified: boolean; sourceCoverageKnown: boolean;
  lastBuyerSpeechAt: Date | null; buyerPauseExplained: boolean | null;
  leftSaleAt: Date | null; isOffMarket: boolean; hasNonCancelledDeal: boolean; reserved: boolean;
  sellerSpeechBefore: boolean; sellerSpeechAfter: boolean | null;
  agentStationOrDeliveryBefore: boolean; agentStationOrDeliveryAfter: boolean | null;
  agentHadRedEvidence: boolean; agentSilenceAvailable: boolean;
};
export type ExposurePairDecision = {
  state: 'CLEAR' | 'WAITING' | 'UNKNOWN' | 'SUSPECTED';
  reasons: string[]; signals: string[]; mayAskOwner: boolean;
};
const DAY = 86_400_000;
export function evaluateExposurePair(f: ExposurePairFacts): ExposurePairDecision {
  const result = (state: ExposurePairDecision['state'], reasons: string[], signals: string[] = []): ExposurePairDecision =>
    ({ state, reasons, signals, mayAskOwner: state === 'SUSPECTED' && signals.length >= 3 });
  if (f.hasNonCancelledDeal || f.reserved) return result('CLEAR', ['DEAL_OR_RESERVATION']);
  if (f.buyerPauseExplained === true) return result('CLEAR', ['CLIENT_EXPLAINED_PAUSE']);
  if (f.lastBuyerSpeechAt && f.lastBuyerSpeechAt > f.sentAt) return result('CLEAR', ['CLIENT_SPOKE_AFTER_EXPOSURE']);
  if (f.sentAt < f.assignedAt) return result('UNKNOWN', ['EXPOSURE_PREDATES_ASSIGNMENT']);
  if (!f.sourceVerified || !f.sourceCoverageKnown || f.buyerPauseExplained === null)
    return result('UNKNOWN', ['SOURCE_OR_PAUSE_REVIEW_INCOMPLETE']);
  if (f.now.getTime() - f.sentAt.getTime() < 7 * DAY) return result('WAITING', ['SEVEN_DAYS_NOT_ELAPSED']);
  if (!f.isOffMarket) return result('CLEAR', ['OBJECT_STILL_AVAILABLE']);
  if (!f.leftSaleAt) return result('UNKNOWN', ['WITHDRAWAL_TIME_UNKNOWN']);
  if (f.leftSaleAt < f.sentAt || f.leftSaleAt.getTime() - f.sentAt.getTime() > 30 * DAY)
    return result('CLEAR', ['WITHDRAWAL_OUTSIDE_THIRTY_DAY_WINDOW']);
  const signals = ['property_left_sale'];
  if (f.sellerSpeechAfter === false) {
    signals.push('both_silent');
    if (f.sellerSpeechBefore) signals.push('seller_stopped_answering');
  }
  if (f.agentStationOrDeliveryBefore) {
    signals.push('agent_contacted_seller_before');
    if (f.agentStationOrDeliveryAfter === false && f.agentSilenceAvailable) signals.push('agent_stopped_seller');
  }
  if (f.agentHadRedEvidence) signals.push('agent_history');
  return result('SUSPECTED', signals.length >= 3 ? ['OWNER_VERIFICATION_ELIGIBLE'] : ['INSUFFICIENT_OWNER_PROBE_SIGNALS'], signals);
}
