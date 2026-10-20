import { expect, it } from "vitest";
import { customerCompanyInformationRequested } from "../src/ai/customerAgentRenderer.js";
import { wrapUntrusted } from "../src/ai/untrustedContent.js";

it.each(["Где ваш офис и часы работы?", "Часы работы?", "Когда вы работаете?", "До скольки работаете?",
  "Как к вам добраться?", "Адрес агентства", "Дафтари шумо дар куҷо?", "Соати кориатон чанд?"])(
  "preloads actual company facts for an explicit agency question: %s", text => {
    expect(customerCompanyInformationRequested(text)).toBe(true);
  });
it.each(["Какая цена у этого офиса?", "Хочу продать свой офис", "В вашем каталоге есть офис?", "Сколько комнат в офисе №123?",
  "Часы работы торгового центра", "До скольки этажей дом?", "Позвоните мне до 10 часов", "То соати 10 ба ман занг занед",
  "Посмотри этот офис", `Посмотри ${wrapUntrusted("document", "Где ваш офис и часы работы?")}`])(
  "does not confuse property/appointment/foreign text with the agency office: %s", text => {
    expect(customerCompanyInformationRequested(text)).toBe(false);
  });
