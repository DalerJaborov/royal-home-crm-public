import { describe, expect, it } from "vitest";
import { formatLocalDialNumber, isDialable, toLocalDialDigits } from "@royal-home/shared";

/**
 * Разбор и показ номера в наборщике.
 *
 * Жалоба владельца 14.08.2026: «если +992 написано там и я продолжаю набирать, то
 * код исчезает». Причина была в том, что поле хранило сырую строку вместе с кодом
 * страны — теперь код нарисован отдельной меткой, а хранятся ТОЛЬКО цифры
 * абонента, и вся арифметика номера живёт здесь, в общем пакете: наборщик и сервер
 * обязаны понимать номер одинаково, иначе звонок уходит не туда молча.
 */
describe("номер в наборщике", () => {
  it("понимает номер в любом виде, каким его копируют люди", () => {
    expect(toLocalDialDigits("+992 93 000 10 01")).toBe("930001001");
    expect(toLocalDialDigits("992930001001")).toBe("930001001");
    expect(toLocalDialDigits("0930001001")).toBe("930001001");
    expect(toLocalDialDigits("930001001")).toBe("930001001");
    // Из WhatsApp номер приходит со скобками и дефисами — это тот же номер.
    expect(toLocalDialDigits("+992 (93) 000-10-01")).toBe("930001001");
  });

  it("короткий набор не режет: внутренний номер и служебный код — законны", () => {
    expect(toLocalDialDigits("1006")).toBe("1006");
    expect(toLocalDialDigits("*43")).toBe("43");
  });

  it("показывает номер привычными группами", () => {
    expect(formatLocalDialNumber("930001001")).toBe("93 000 10 01");
    // Набор по одной цифре: группы появляются по мере ввода, номер не «прыгает».
    expect(formatLocalDialNumber("9")).toBe("9");
    expect(formatLocalDialNumber("93")).toBe("93");
    expect(formatLocalDialNumber("934")).toBe("93 4");
    expect(formatLocalDialNumber("93467")).toBe("93 467");
    expect(formatLocalDialNumber("9346771")).toBe("93 467 71");
  });

  it("звонить можно с полного номера, внутреннего и служебного кода", () => {
    expect(isDialable("930001001")).toBe(true);
    expect(isDialable("1006")).toBe(true);
    expect(isDialable("100")).toBe(true);
    expect(isDialable("*43")).toBe(true);
  });

  it("незаконченный набор кнопку не включает", () => {
    expect(isDialable("")).toBe(false);
    expect(isDialable("93")).toBe(false);
    expect(isDialable("93467717")).toBe(false);
  });
});
