export type ComparableListing = { id: string; shortId: number; price: number; currency: string; areaSqm: number; updatedAt: string };
/** Internal asking prices only. No currency conversion, external market claims or transaction appraisal. */
export function summarizeComparableListings(subject: { price: number; currency: string; areaSqm: number }, listings: ComparableListing[], totalCandidates: number, now = new Date()) {
  const usable = listings.filter(p => p.currency === subject.currency && Number.isFinite(p.price) && p.price > 0 && Number.isFinite(p.areaSqm) && p.areaSqm > 0 && Number.isFinite(Date.parse(p.updatedAt)));
  const values = usable.map(p => p.price / p.areaSqm).sort((a,b) => a-b);
  const mid = Math.floor(values.length / 2);
  const median = values.length ? values.length % 2 ? values[mid] : (values[mid-1]+values[mid])/2 : null;
  const subjectPerSqm = subject.areaSqm > 0 && Number.isFinite(subject.price) && subject.price > 0 ? subject.price / subject.areaSqm : null;
  return { source: "CRM" as const, basis: "ASKING_PRICES" as const, currency: subject.currency, comparedAt: now.toISOString(), totalCandidates,
    sampledCount: listings.length, usableCount: usable.length, truncated: totalCandidates > listings.length,
    medianPricePerSqm: median, subjectPricePerSqm: subjectPerSqm,
    differencePercent: median && subjectPerSqm ? (subjectPerSqm / median - 1) * 100 : null,
    oldestUpdatedAt: usable.length ? usable.map(p => p.updatedAt).sort()[0] : null,
    newestUpdatedAt: usable.length ? usable.map(p => p.updatedAt).sort().at(-1)! : null,
    listings: usable.map(p => ({ ...p, pricePerSqm: p.price / p.areaSqm, ageDays: Math.max(0, Math.floor((now.getTime()-Date.parse(p.updatedAt))/86400000)) })),
    limitation: "Цены предложений в CRM, не цены сделок и не оценка всего рынка. Дата изменения карточки не подтверждает актуальность цены у продавца." };
}
