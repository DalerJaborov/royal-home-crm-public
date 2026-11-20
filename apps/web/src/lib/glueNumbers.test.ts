import { describe, expect, it } from "vitest";
import { glueNumbers, glueRange } from "./glueNumbers";

const N = " ";
const J = "⁠";
describe("glueNumbers — число не отрывается от единицы", () => {
  it("бюджет клиента: «1,1–1,3 млн с.» и «330–440 тыс. с.»", () => {
    expect(glueNumbers("1,1–1,3 млн с.")).toBe(`1,1${J}–${J}1,3${N}млн${N}с.`);
    expect(glueNumbers("330–440 тыс. с.")).toBe(`330${J}–${J}440${N}тыс.${N}с.`);
    expect(glueNumbers("от 1,2 млн с.")).toBe(`от 1,2${N}млн${N}с.`);
  });
  it("даты и сроки: «10 нояб.», «4 дн.»", () => {
    expect(glueNumbers("10 нояб.")).toBe(`10${N}нояб.`);
    expect(glueNumbers("4 дн.")).toBe(`4${N}дн.`);
  });
  it("промежуток дат — одним куском", () => {
    expect(glueRange("10 нояб.", "19 нояб.")).toBe(`10${N}нояб.${N}—${N}19${N}нояб.`);
  });
  it("обычные слова не трогает", () => {
    expect(glueNumbers("3 сотрудника")).toBe("3 сотрудника");
    expect(glueNumbers("112 мкр после ремонта")).toBe("112 мкр после ремонта");
    expect(glueNumbers("в 2 марта")).toBe(`в 2${N}марта`);
    expect(glueNumbers("4 дн. с тратами")).toBe(`4${N}дн. с тратами`);
  });
});
