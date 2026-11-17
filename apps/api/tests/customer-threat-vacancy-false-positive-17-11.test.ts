import { describe, expect, it } from "vitest";
import { customerDmAbuseKind } from "../src/ai/customerAgentAbuse.js";
import { customerRecruitmentRequested, customerRecruitmentTopic } from "../src/ai/customerAgentRecruitmentProtocol.js";

describe("threat: only a threat aimed at us (audit 17.11.2026)", () => {
  it.each(["Квартира бомба!", "Ну цены просто убивают", "Это бомба, а не цена", "Дом взорвали в прошлом году", "Убитая квартира, цена?", "бомбическая планировка"])(
    "%s is ordinary talk", text => expect(customerDmAbuseKind(text)).toBeNull());
  it.each(["Я вас убью", "взорву ваш офис", "мы вас найдем и сожжем", "хочу убить вас", "i will kill you", "убьём вас всех", "Бомбу подложу в офис"])(
    "%s is a threat", text => expect(customerDmAbuseKind(text)).toBe("threat"));
});

describe("vacancy: «по работе» alone is not a job inquiry (audit 17.11.2026)", () => {
  it.each(["Я по работе переехал, ищу 2-комнатную", "Мне по работе нужна квартира в аренду", "Здравствуйте, по работе приехал, хочу снять квартиру",
    "Хочу купить квартиру, я по работе в Душанбе", "Продаю дом, переезжаю по работе"])(
    "%s is a property inquiry", text => {
      expect(customerRecruitmentRequested(text)).toBe(false);
      expect(customerRecruitmentTopic(text, "unknown")).not.toBe("job");
    });
  it.each(["Здравствуйте, я по работе", "Вопрос о работе", "Хочу узнать о работе у вас", "Есть ли у вас вакансии?", "Ищу работу, но и квартиру тоже", "Насчёт работы"])(
    "%s stays a job inquiry", text => expect(customerRecruitmentRequested(text)).toBe(true));
});
