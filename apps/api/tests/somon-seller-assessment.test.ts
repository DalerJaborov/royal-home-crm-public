import { describe, expect, it } from "vitest";
import { assessSeller } from "../src/lib/somonLeads/sellerAssessment.js";

describe("Somon seller evidence", () => {
  it("does not treat a missing business flag as proof of ownership", () => {
    expect(assessSeller({ businessAccount: null, categoryAdverts: null, totalActiveAdverts: null, name: "", description: "" }).status).toBe("review");
  });
  const counted = (categoryAdverts: number | null, totalActiveAdverts: number | null = 1) => assessSeller({ businessAccount: false, categoryAdverts, totalActiveAdverts, name: "", description: "Собственник" }).status;
  it("uses the owner's claim only with exactly one advert in the category", () => {
    expect(counted(1)).toBe("likely_owner");
  });
  it("accepts a private profile with one advert in the category without an owner claim (PR56)", () => {
    expect(assessSeller({ businessAccount: false, categoryAdverts: 1, totalActiveAdverts: 1, name: "", description: "Продам квартиру" }).status).toBe("likely_owner");
    expect(assessSeller({ businessAccount: false, categoryAdverts: 1, totalActiveAdverts: 2, name: "", description: "" }).status).toBe("likely_owner");
  });
  it("keeps a self-described owner with two adverts in the category for review", () => {
    expect(counted(2)).toBe("review");
  });
  it("keeps an unknown category count for review", () => {
    expect(counted(null)).toBe("review");
  });
  it("uses the site-wide total only as a soft ceiling", () => {
    expect(counted(1, 5)).toBe("likely_owner");
    expect(counted(1, 6)).toBe("review");
    expect(counted(1, null)).toBe("review");
  });
  it("recognizes an explicit business profile", () => {
    expect(assessSeller({ businessAccount: true, categoryAdverts: 1, totalActiveAdverts: 1, name: "Собственник", description: "" }).status).toBe("agency");
  });
  it("does not interpret a negated owner claim as a positive signal", () => {
    expect(assessSeller({ businessAccount: false, categoryAdverts: 1, totalActiveAdverts: 1, name: "", description: "Я не собственник" }).status).toBe("review");
  });
  const owner = (description: string, name = "") => assessSeller({ businessAccount: false, categoryAdverts: 1, totalActiveAdverts: 1, name, description }).status;
  it("keeps negated commission and intermediary phrases as owner signals", () => {
    expect(owner("Собственник. Без комиссии, без посредников")).toBe("likely_owner");
    expect(owner("Хозяин, комиссии нет")).toBe("likely_owner");
    expect(owner("Собственник, бе комиссия, без риелторов")).toBe("likely_owner");
  });
  it("rejects only explicit self-presentation or a stated fee as an agency", () => {
    expect(owner("Собственник. Комиссия 2%")).toBe("agency");
    expect(owner("Комиссия 3 процента")).toBe("agency");
    expect(owner("Я риелтор, помогу купить")).toBe("agency");
    expect(owner("Мы агентство недвижимости")).toBe("agency");
    expect(owner("Агент по недвижимости, звоните в офис")).toBe("agency");
    expect(owner("Наша компания продаёт квартиры")).toBe("agency");
    expect(owner("Собственник", "Агентство Дом")).toBe("agency");
  });
  it("sends other intermediary mentions to review, not to a hard rejection", () => {
    expect(owner("Продаётся, работаю как посредник")).toBe("review");
    expect(owner("Квартира от риелтора")).toBe("review");
    expect(owner("Продаю через маклера")).toBe("review");
    expect(owner("Real estate Dushanbe")).toBe("review");
    expect(owner("Есть комиссия")).toBe("review");
  });
  it("does not mistake common owner phrases for an agency", () => {
    for (const phrase of ["Без комиссии и посредников", "без посредников и комиссии", "Без агентств и комиссий", "Комиссия не нужна", "без всяких риелторов", "Услуги риелтора не нужны", "не через агентство", "Риелторы - мимо", "Комиссионный магазин рядом", "Продаю, исключая посредников"]) {
      expect(owner(phrase), phrase).toBe("likely_owner");
    }
  });
  it("treats lists and 'do not disturb' phrases about intermediaries as owner signals", () => {
    expect(owner("Собственник, без посредников и риелторов")).toBe("likely_owner");
    expect(owner("Собственник. Риелторов не беспокоить")).toBe("likely_owner");
    expect(owner("Хозяин. Агентствам не звонить")).toBe("likely_owner");
    expect(owner("Собственник. Посредникам просьба не беспокоить")).toBe("likely_owner");
    expect(owner("Собственник. Риелторов/агентствам не звонить")).toBe("likely_owner");
    expect(owner("Собственник. Просьба риелторам не звонить")).toBe("likely_owner");
    expect(owner("Собственник, без услуг риелтора")).toBe("likely_owner");
    expect(owner("Собственник, без участия агентства")).toBe("likely_owner");
    expect(owner("Собственник, комиссию не берём")).toBe("likely_owner");
  });
  it("keeps 'commission included / not included' as an agency marker", () => {
    expect(owner("Собственник. Комиссия не включена")).toBe("agency");
    expect(owner("Собственник. Комиссия включена в цену")).toBe("agency");
    expect(owner("Собственник, без посредников, комиссия 2%")).toBe("agency");
  });
  it("does not automatically classify a mention of an agency as a private owner", () => {
    expect(assessSeller({ businessAccount: false, categoryAdverts: 1, totalActiveAdverts: 1, name: "", description: "Наше агентство оказывает услуги" }).status).not.toBe("likely_owner");
    expect(assessSeller({ businessAccount: false, categoryAdverts: 1, totalActiveAdverts: 1, name: "", description: "Продаю без риелтора" }).status).toBe("likely_owner");
    expect(assessSeller({ businessAccount: false, categoryAdverts: 1, totalActiveAdverts: 1, name: "", description: "Агентство недвижимости, без риелторов" }).status).not.toBe("likely_owner");
  });
});
