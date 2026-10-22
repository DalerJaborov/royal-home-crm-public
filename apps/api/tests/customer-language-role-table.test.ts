import { describe, expect, it } from "vitest";
import { detectClientLanguage } from "../src/ai/clientLanguage.js";
import { customerDmLanguagePreference } from "../src/ai/customerDmLanguage.js";
import { customerAgentIntake } from "../src/ai/customerAgentIntake.js";
import { customerRecruitmentTopic, selectedRecruitmentPosition } from "../src/ai/customerAgentRecruitmentProtocol.js";
import { recruitmentPositionTemplates } from "../src/lib/recruitmentPositionTemplates.js";

// Probes of 23.10.2026 on origin/main: each row was `unknown` or the wrong role.

describe("language: colloquial Tajik words are Tajik", () => {
  it.each(["Ма уруси намефамум", "Маош чи???", "Кор", "Асалом", "Нарх", "Нархаш", "Чанпул аст?", "Хуб ака, мешид"])(
    "%s -> tg", text => expect(detectClientLanguage(text)).toBe("tg"));
  it("still reads plain Russian as Russian", () => {
    expect(detectClientLanguage("Сколько стоит квартира в центре?")).toBe("ru");
    expect(detectClientLanguage("Не подходит, он дорогой")).toBe("ru");
  });
});

describe("language: links, handles, e-mails and phones are not words of the customer", () => {
  it.each([
    "https://www.instagram.com/reel/DAbc123xyz/", "https://www.instagram.com/to/abc123/", "www.instagram.com/p/XyZ/",
    "instagram.com/reel/Abc/?igsh=1", "@dalerj", "dalerj@gmail.com", "+992 900 12 34 56", "https://t.me/dalerj @dalerj",
  ])("%s -> unknown", text => expect(detectClientLanguage(text)).toBe("unknown"));
  it("keeps the customer's own words around a link", () => {
    expect(detectClientLanguage("Рахмат https://www.instagram.com/reel/DAbc123xyz/")).toBe("tg");
    expect(detectClientLanguage("Сколько стоит? https://www.instagram.com/reel/DAbc123xyz/ @dalerj")).toBe("ru");
  });
});

describe("language: 'I do not understand Russian' is an explicit request", () => {
  it.each(["Я не понимаю русский", "Я не понимаю по-русски", "по-русски не понимаю", "Ма уруси намефамум", "Ман русӣ намефаҳмам",
    "Наметавонам бо русӣ", "Русӣ намедонам", "Не знаю русский язык"])("%s -> tg", text => expect(customerDmLanguagePreference(text)).toBe("tg"));
  it.each(["Не понимаю по-таджикски", "Я не знаю таджикский"])("%s -> ru", text => expect(customerDmLanguagePreference(text)).toBe("ru"));
  it.each(["Вы не понимаете по-русски?", "Он не понимает русский", "Намефаҳмам", "Я знаю русский"])(
    "%s is not a request", text => expect(customerDmLanguagePreference(text)).toBeNull());
});

const SELLING = [
  "Ман Хонаи. Фуруши. Дорам", "Мо. Хонаи. Фуруши. Дорем. Дар шахри Душанбе", "Хонаи Фуруши доштм", "Хавли дорам ,рекламатон чанпул?",
  "Продам квартиру", "Продаётся дом", "Продается квартира, 3 комнаты", "Мехоҳам хонаамро фурӯшам", "Хонаро мефурошем",
  "Ҳавлӣ дорам, мехоҳам фурӯшам", "Продаю участок", "Хочу продать квартиру",
];
const LANDLORD = ["Хочу сдать квартиру", "Сдаю квартиру в центре", "Ман хонаамро ба иҷора медиҳам", "Сдам дом"];
const topicOf = (text: string, previous: "buyer" | "seller" | "job" | "rent" | "unknown" = "unknown") => customerRecruitmentTopic(text, previous);
const intakeRole = (text: string) => customerAgentIntake([], text).role;

describe("role: selling", () => {
  it.each(SELLING)("%s -> seller", text => {
    expect(topicOf(text)).toBe("seller");
    expect(intakeRole(text)).toBe("seller");
  });
});

describe("role: renting out is carried as seller and keeps the rent wording", () => {
  it.each(LANDLORD)("%s -> seller", text => {
    expect(topicOf(text)).toBe("seller");
    expect(intakeRole(text)).toBe("seller");
  });
  it("keeps the 'аренда' fact in the customer's own words", () => {
    expect(customerAgentIntake([], "Хочу сдать квартиру").statements).toEqual(["Хочу сдать квартиру"]);
  });
  it("a tenant is still a tenant", () => {
    expect(topicOf("Ищу квартиру в аренду")).toBe("rent");
    expect(topicOf("Хона ба иҷора лозим", "job")).toBe("rent");
    expect(topicOf("Хочу снять квартиру")).toBe("rent");
  });
});

describe("role: false positives of the old regexes", () => {
  it("a buyer's question is not an offer to sell", () => {
    for (const text of ["Продаются квартиры у вас?", "Продается ли эта квартира?", "Что у вас продается?"]) {
      expect(topicOf(text)).toBe("buyer");
      expect(intakeRole(text)).toBe("buyer");
    }
  });
  it("a job seeker or an employer is not a buyer", () => {
    expect(topicOf("Ман кор меҷӯям")).toBe("job");
    expect(intakeRole("Ман кор меҷӯям")).toBe("unknown");
    expect(topicOf("Ищу домработницу")).toBe("unknown");
    expect(intakeRole("Ищу домработницу")).toBe("unknown");
  });
  it("a negation keeps the earlier topic", () => {
    for (const text of ["Намефурӯшам", "Не хочу купить", "Не хочу продавать", "Намехоҳам хонаамро фурӯшам", "Не хочу сдавать квартиру"]) {
      expect(topicOf(text, "unknown")).toBe("unknown");
      expect(topicOf(text, "job")).toBe("job");
      expect(intakeRole(text)).toBe("unknown");
    }
  });
  it("a name that merely contains a verb is not the speaker", () => {
    expect(topicOf("Осман мефурӯшад")).toBe("unknown");
    expect(intakeRole("Осман мефурӯшад")).toBe("unknown");
  });
  it("a job request is read before buying and selling", () => {
    const text = "Продаю недвижимость 3 года, ищу работу";
    expect(topicOf(text, "seller")).toBe("job");
    expect(intakeRole(text)).toBe("unknown");
  });
  it("a plain buyer is still a buyer", () => {
    for (const text of ["Хочу купить квартиру", "Куплю дом в Душанбе", "Ищу квартиру", "Ман хона меҷӯям", "Мехарам хона"]) {
      expect(topicOf(text)).toBe("buyer");
      expect(intakeRole(text)).toBe("buyer");
    }
  });
});

describe("recruitment: a vacancy is chosen by its own words only", () => {
  const positions = recruitmentPositionTemplates().map(row => ({ ...row, isOpen: true, revision: 1 }));
  const realtor = positions.find(row => row.titleRu.startsWith("Агент"))!;
  const smm = positions.find(row => /SMM/u.test(row.titleRu))!;
  it("picks the role by a whole word with an ending", () => {
    expect(selectedRecruitmentPosition(positions, "Вакансия видеографа актуальна?")?.key).toBe(smm.key);
    expect(selectedRecruitmentPosition(positions, "Контент-менеджер")?.key).toBe(smm.key);
    expect(selectedRecruitmentPosition(positions, "Нужен SMM")?.key).toBe(smm.key);
    expect(selectedRecruitmentPosition(positions, "Хочу стать агентом по недвижимости")?.key).toBe(realtor.key);
  });
  it("does not pick a role by a part of another word or by a generic word", () => {
    expect(selectedRecruitmentPosition(positions, "Хочу работать в агентстве")).toBeNull();
    expect(selectedRecruitmentPosition(positions, "Ищу специалиста по ремонту")).toBeNull();
    expect(selectedRecruitmentPosition(positions, "Нужна работа")).toBeNull();
    expect(selectedRecruitmentPosition(positions, "Дар бораи кор маълумот диҳед")).toBeNull();
  });
});
