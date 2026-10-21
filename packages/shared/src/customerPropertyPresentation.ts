import type { CustomerPropertyCharacteristics, CustomerPropertyFacts } from "./customerPropertyContext.js";
import { propertyFloorsLabel } from "./propertyTypeFields.js";
import { propertyFinishSummary } from "./propertyFinish.js";

/** Called only with the server's validated, current public property facts. */
export function customerPropertyAvailabilityLine(facts: Pick<CustomerPropertyFacts, "availability" | "shortId">, language: "ru" | "tg"): string {
  if (facts.availability === "RESERVED") return language === "tg"
    ? `Объекти №${facts.shortId} ҳоло дар брон аст.` : `Объект №${facts.shortId} сейчас в брони.`;
  return language === "tg" ? `Бале, объекти №${facts.shortId} ҳоло дастрас аст.` : `Да, объект №${facts.shortId} ещё доступен.`;
}

/** Closed public CRM fields only. No descriptions, contacts or address strings. */
export function customerPropertyCharacteristicLines(c: CustomerPropertyCharacteristics | undefined, language: "ru" | "tg", question = ""): string[] {
  const tg = language === "tg";
  if (!c) return [tg ? "Хусусиятҳо дар карточка нишон дода нашудаанд." : "Характеристики в карточке не указаны."];
  const lines: string[] = [];
  const requested = { rooms: /комнат|[ҳх]у[ҷч]ра|хонаг[ӣи]/iu.test(question), area: /площад|метраж|масо[ҳх]ат|сот[кыи]/iu.test(question),
    floor: /этаж|ош[ёе]на/iu.test(question), finish: /ремонт|состояни|таъмир/iu.test(question) };
  const all = !Object.values(requested).some(Boolean);
  const absent = tg ? "дар карточка нишон дода нашудааст" : "в карточке не указано";
  if ((all || requested.rooms) && c.type !== "LAND") {
    if (c.rooms !== null) lines.push(`${tg ? "Ҳуҷраҳо" : "Комнат"}: ${c.rooms}.`);
    else if (requested.rooms) lines.push(`${tg ? "Шумораи ҳуҷраҳо" : "Количество комнат"} ${absent}.`);
  }
  if ((all || requested.area) && c.type !== "LAND") {
    if (c.areaSqm) lines.push(`${tg ? "Масоҳат" : "Площадь"}: ${c.areaSqm.replace(".", ",")} м².`);
    else if (requested.area) lines.push(`${tg ? "Масоҳат" : "Значение площади"} ${absent}.`);
  }
  if ((all || requested.area) && ["LAND", "HOUSE"].includes(c.type) && c.landAreaSotka) lines.push(`${tg ? "Масоҳати замин" : "Участок"}: ${c.landAreaSotka.replace(".", ",")} ${tg ? "сотиқ" : "соток"}.`);
  const floors = propertyFloorsLabel(c);
  if ((all || requested.floor) && floors) lines.push(tg ? c.type === "HOUSE" ? `Шумораи ошёнаҳо: ${c.totalFloors}.`
    : `Ошёна: ${c.floor}${c.totalFloors ? ` аз ${c.totalFloors}` : ""}.` : `${floors.label}: ${floors.value}.`);
  else if (requested.floor && c.type !== "LAND") lines.push(`${tg ? "Ошёна" : "Значение этажа"} ${absent}.`);
  const finish = propertyFinishSummary(c);
  if ((all || requested.finish) && finish) {
    if (!tg) lines.push(`Состояние: ${finish}.`);
    else {
      const condition = { NEEDS_REPAIR: "таъмирталаб", GOOD: "ҳолати хуб", EXCELLENT: "ҳолати аъло", NEW_BUILDING: "бинои нав" };
      const stage = { FOUNDATION: "марҳилаи таҳкурсӣ", SHELL: "коробка", UNDER_CONSTRUCTION: "дар ҳоли сохтмон", ROUGH_FINISH: "корҳои сиёҳ анҷом ёфтаанд", BUILT: "сохта шудааст" };
      lines.push(`Ҳолат: ${[c.stage ? stage[c.stage] : null, c.condition ? condition[c.condition] : null].filter(Boolean).join(", ") || "нишон дода нашудааст"}.`);
    }
  }
  return lines.length ? lines : [tg ? "Хусусиятҳо дар карточка нишон дода нашудаанд." : "Характеристики в карточке не указаны."];
}
