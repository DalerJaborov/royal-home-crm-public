/**
 * Просьба о звонке из переписки (22.09.2026, баг на проде): модель считала просьбой
 * о звонке любой оставленный номер, и АТС набирала дежурного оператора. Теперь поле
 * засчитывается только при явной просьбе клиента, а оператору достаются лишь звонки АТС.
 */
import { describe, expect, it } from "vitest";
import { acceptCallbackRequest, hasExplicitCallbackAsk } from "../src/ai/callbackRequest.js";
import { isOperatorCallbackChannel } from "../src/lib/telephony/callbackConnect.js";

describe("hasExplicitCallbackAsk — явная просьба о звонке", () => {
  it.each([
    "Позвоните мне пожалуйста",
    "перезвоните через час",
    "Можно с оператором поговорить?",
    "дайте менеджера",
    "хочу с живым человеком",
    "ты бот?",
    "занг занед лутфан",
    "Ба ман занг занад",
    "zang zaned",
    "бо одами зинда гап задан мехоҳам",
    "наберите меня",
    "свяжитесь со мной",
  ])("ловит: %s", (text) => {
    expect(hasExplicitCallbackAsk(text)).toBe(true);
  });

  it.each([
    "+992 93 123 45 67",
    "Продаю дачу в Варзобе, мой номер 931234567",
    "Вот видео квартиры",
    "Делаем сайты и лендинги недорого, пишите 900000000",
    "Здравствуйте, хочу у вас работать, мне 25 лет",
    "звонок",
    "",
  ])("не ловит: %s", (text) => {
    expect(hasExplicitCallbackAsk(text)).toBe(false);
  });
});

describe("acceptCallbackRequest — поле модели лишь кандидат", () => {
  it("номер без просьбы — не звонок", () => {
    expect(acceptCallbackRequest("Клиент оставил номер", "931234567")).toBeNull();
  });
  it("явная просьба — тема модели проходит", () => {
    expect(acceptCallbackRequest("по продаже квартиры", "позвоните мне")).toBe("по продаже квартиры");
  });
  it("кандидат на вакансию — никогда", () => {
    expect(acceptCallbackRequest("вакансия", "позвоните мне", { isJobApplication: true })).toBeNull();
  });
  it("модель не заполнила поле — ничего", () => {
    expect(acceptCallbackRequest(null, "позвоните")).toBeNull();
  });
});

describe("оператору — только звонки АТС", () => {
  it.each(["WHATSAPP", "INSTAGRAM", "FACEBOOK", "TELEGRAM", "TELEGRAM_DIRECT", "", null])(
    "%s — не оператору",
    (channel) => {
      expect(isOperatorCallbackChannel(channel)).toBe(false);
    }
  );
  it("LIVE_VOICE — оператору можно", () => {
    expect(isOperatorCallbackChannel("LIVE_VOICE")).toBe(true);
  });
});
