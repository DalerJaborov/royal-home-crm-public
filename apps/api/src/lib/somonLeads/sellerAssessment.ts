/** Evidence for a review queue, never proof of legal ownership. */
export type SellerEvidence = {
  businessAccount: boolean | null;
  distinctApartments: number | null;
  name: string;
  description: string;
};
export type SellerAssessment = { status: "likely_owner" | "review" | "agency"; reasons: string[] };

export function assessSeller(e: SellerEvidence): SellerAssessment {
  const name = e.name.toLocaleLowerCase("ru");
  const text = e.description.toLocaleLowerCase("ru");
  const agencyName = /агентств|риелтор|риэлтор|realtor|real\s*estate|недвижимость|агентии амвол/.test(name);
  if (e.businessAccount === true || agencyName) return { status: "agency", reasons: ["Признак агентства в профиле"] };
  if (/(?:я|мы|наше)\s+(?:риелтор|риэлтор|агентств)/.test(text)) return { status: "agency", reasons: ["Продавец представился посредником"] };
  if (e.distinctApartments !== null && e.distinctApartments > 2) {
    return { status: "review", reasons: ["Более двух разных квартир — проверить продавца"] };
  }
  const combined = `${name} ${text}`;
  if (/не\s+(?:собственник|хозяин)/.test(combined)) {
    return { status: "review", reasons: ["Автор указывает, что не является собственником"] };
  }
  const owner = /собственник|хозяин|соҳибхона|сохибхона|соҳибмулк|сохибмулк/.test(combined);
  if (owner && e.businessAccount === false && e.distinctApartments !== null && e.distinctApartments >= 1) {
    return { status: "likely_owner", reasons: ["Есть указание на собственника", "Не более двух известных квартир"] };
  }
  return { status: "review", reasons: [e.distinctApartments === null ? "Количество квартир неизвестно" : "Собственник не подтверждён"] };
}
