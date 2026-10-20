import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { projectCustomerPropertyFacts, renderCustomerPropertyFacts } from "../src/lib/customerPropertyFacts.js";
import { classifyCustomerPropertyFactIntent } from "../src/lib/customerPropertyFactIntent.js";
import { customerPropertyCharacteristicLines } from "@royal-home/shared";

const card = () => ({ id: randomUUID(), shortId: 321, price: "750000", currency: "TJS", status: "AVAILABLE" as const,
  deletedAt: null, offSite: false, publishedOnSite: true, publishedChannels: [], instagramUrl: null, siteListingId: 321,
  updatedAt: new Date("2026-10-17T00:00:00Z"), district: { name: "Сино", city: "Душанбе" },
  type: "APARTMENT" as const, rooms: 2, areaSqm: "64.5", landAreaSotka: null, floor: 5, totalFloors: 9,
  condition: "EXCELLENT" as const, marketType: "SECONDARY" as const, stage: "BUILT" as const,
  address: "Секретная улица 55, квартира 33", ownerContact: "+992987654321", landmark: "Дом55, квартира33" });

describe("public customer property characteristics", () => {
  it.each(["Какая площадь?", "Этаж?", "Сколько комнат?", "Бо таъмир?", "Масоҳаташ чанд?", "Чанд ошёна?"])("routes %s without requesting phone", text => {
    expect(classifyCustomerPropertyFactIntent(text)).toEqual(["characteristics"]);
  });
  it("projects structured CRM fields but never address, contacts or free-text landmarks", () => {
    const row = card(), facts = projectCustomerPropertyFacts(row, "INSTAGRAM");
    expect(facts).toMatchObject({ characteristics: { type: "APARTMENT", rooms: 2, areaSqm: "64.5", floor: 5, totalFloors: 9 } });
    expect(JSON.stringify(facts)).not.toMatch(/Секретная|987654321|квартира33/);
  });
  it("renders real fields in RU and TG and binds changes to freshness signature", () => {
    const row = card(), facts = projectCustomerPropertyFacts(row, "INSTAGRAM")!;
    // The public tool args are asserted by runtime schemas as well.
    const kinds = ["characteristics"] as Parameters<typeof renderCustomerPropertyFacts>[1];
    expect(renderCustomerPropertyFacts(facts, kinds, "ru")).toMatch(/64[,.]5.*м²/);
    expect(renderCustomerPropertyFacts(facts, kinds, "ru")).toMatch(/5.*9/);
    expect(renderCustomerPropertyFacts(facts, kinds, "tg")).toMatch(/64[,.]5/);
    expect(projectCustomerPropertyFacts({ ...row, floor: 6 }, "INSTAGRAM")!.signature).not.toBe(facts.signature);
  });
  it("does not turn missing or inapplicable floor and rooms into invented values", () => {
    const facts = projectCustomerPropertyFacts({ ...card(), type: "LAND", rooms: null, floor: null, totalFloors: null, landAreaSotka: "6" }, "INSTAGRAM")!;
    const text = renderCustomerPropertyFacts(facts, ["characteristics"] as Parameters<typeof renderCustomerPropertyFacts>[1], "ru");
    expect(text).toContain("6"); expect(text).not.toMatch(/Этаж|Комнат|ремонт/i);
  });
  it("answers the actual floor question and acknowledges missing data instead of listing unrelated facts", () => {
    const facts = projectCustomerPropertyFacts(card(),"INSTAGRAM")!;
    const text = customerPropertyCharacteristicLines(facts.characteristics,"ru","Какой этаж?").join(" ");
    expect(text).toContain("5 из 9"); expect(text).not.toMatch(/Комнат|Площадь|Состояние/);
    expect(customerPropertyCharacteristicLines({...facts.characteristics!,floor:null},"ru","Этаж?").join(" ")).toContain("не указано");
  });
  it("preserves basement floors and treats unfilled zero measurements as unknown without losing price",()=>{
    const facts=projectCustomerPropertyFacts({...card(),floor:-1,rooms:0,areaSqm:"0",totalFloors:0},"INSTAGRAM");
    expect(facts).toMatchObject({price:"750000",characteristics:{floor:-1,rooms:null,areaSqm:null,totalFloors:null}});
  });
});
