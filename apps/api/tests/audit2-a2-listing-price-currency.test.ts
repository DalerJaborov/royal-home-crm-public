import { describe, expect, it } from "vitest";
import { parseListingFacts } from "../src/lib/listingAd.js";

/**
 * CRM-LISTING01 (аудит 04.10.2026): правило «число меньше 10 000 это тысячи»
 * придумано под сомони по обычаю Душанбе, но применялось и к явным долларам:
 * «Цена 9000 USD» превращалась в 9 000 000 USD, и подбор покупателей исключал всех.
 */
describe("parseListingFacts: единицы цены зависят от валюты (CRM-LISTING01)", () => {
  it.each([
    ["Цена 9000 USD", 9000, "USD"],
    ["Цена 9000 $", 9000, "USD"],
    ["Продаётся земля. Цена 4500 долларов", 4500, "USD"],
    ["Цена 85 000 $", 85000, "USD"],
    ["Цена 120 тыс $", 120000, "USD"],
    ["Цена 580 хазор сомон", 580000, "TJS"],
    ["Нарх 580", 580000, "TJS"],
    ["Цена 1,2 млн сомони", 1_200_000, "TJS"],
  ])("%s -> %d %s", (text, price, currency) => {
    const facts = parseListingFacts(text);
    expect(facts.price).toBe(price);
    expect(facts.currency).toBe(currency);
  });
});
