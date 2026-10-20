import { describe, expect, it } from "vitest";
import { clientDisplayName } from "@royal-home/shared";

/**
 * «Имя · Якорь» (владелец 21.09.2026): агенты дописывали ориентир прямо в имя
 * клиента вручную («Джахонгир Маяковский», «Зоир стадион Спартак») — эта функция
 * делает то же самое автоматически, из настоящих полей карточки, и не трогает
 * fullName в базе. Базы этот файл не касается вовсе — чистая функция.
 */

describe("Заглушки имени заменяются на «Роль из канала»", () => {
  it("«Продавец ПР-000388» → «Продавец из WhatsApp»", () => {
    expect(clientDisplayName({ kind: "SELLER", fullName: "Продавец ПР-000388", source: "WHATSAPP" })).toBe(
      "Продавец из WhatsApp"
    );
  });

  it("«Покупатель ПК-000353» → «Покупатель из Instagram»", () => {
    expect(clientDisplayName({ kind: "BUYER", fullName: "Покупатель ПК-000353", source: "INSTAGRAM" })).toBe(
      "Покупатель из Instagram"
    );
  });

  it("«Продавец №0155» → «Продавец из …» по каналу", () => {
    expect(clientDisplayName({ kind: "SELLER", fullName: "Продавец №0155", source: "TELEGRAM" })).toBe(
      "Продавец из Telegram"
    );
  });

  it("«Клиент Instagram» (OTHER) → «Клиент из Instagram»", () => {
    expect(clientDisplayName({ kind: "OTHER", fullName: "Клиент Instagram", source: "INSTAGRAM" })).toBe(
      "Клиент из Instagram"
    );
  });

  it("голое «Продавец»/«Покупатель»/«Тел» — тоже заглушки", () => {
    expect(clientDisplayName({ kind: "SELLER", fullName: "Продавец", source: "WHATSAPP" })).toBe(
      "Продавец из WhatsApp"
    );
    expect(clientDisplayName({ kind: "BUYER", fullName: "Покупатель", source: null })).toBe("Покупатель");
    expect(clientDisplayName({ kind: "BUYER", fullName: "Тел", source: "PHONE_CALL" })).toBe(
      "Покупатель со звонка"
    );
  });

  it("пусто и «только телефон» — тоже заглушки", () => {
    expect(clientDisplayName({ kind: "BUYER", fullName: "", source: "WEBSITE" })).toBe("Покупатель с сайта");
    expect(clientDisplayName({ kind: "BUYER", fullName: "   ", source: null })).toBe("Покупатель");
    expect(clientDisplayName({ kind: "SELLER", fullName: "+992 90 000 00 01", source: "REFERRAL" })).toBe(
      "Продавец по рекомендации"
    );
    expect(clientDisplayName({ kind: "SELLER", fullName: "900000001", source: null })).toBe("Продавец");
  });

  it("канал неизвестен — только роль, без «из …»", () => {
    expect(clientDisplayName({ kind: "SELLER", fullName: "Продавец", source: undefined })).toBe("Продавец");
  });
});

describe("Настоящее имя остаётся как есть — заглушкой не считается", () => {
  it("«Продавец приёмки» — не заглушка (второе слово не код и не канал)", () => {
    expect(clientDisplayName({ kind: "SELLER", fullName: "Продавец приёмки" })).toBe("Продавец приёмки");
  });

  it("обычное ФИО не трогается", () => {
    expect(clientDisplayName({ kind: "BUYER", fullName: "Далер Джаббаров" })).toBe("Далер Джаббаров");
  });
});

describe("Эмодзи убираются из имени", () => {
  it("хвостовой эмодзи вырезается вместе с лишним пробелом", () => {
    expect(clientDisplayName({ kind: "BUYER", fullName: "Зарина 😊" })).toBe("Зарина");
  });
});

describe("Якорь продавца — ориентир объекта, приоритет как в задании", () => {
  it("Property.address (facts) главнее Client.address", () => {
    const out = clientDisplayName(
      { kind: "SELLER", fullName: "Умед Каримов", address: "ул. Рудаки 5" },
      { propertyAddress: "Маяковского 45" }
    );
    expect(out).toBe("Умед Каримов · Маяковского 45");
  });

  it("без Property.address — берём Client.address", () => {
    const out = clientDisplayName({ kind: "SELLER", fullName: "Умед Каримов", address: "ул. Рудаки 5" });
    expect(out).toBe("Умед Каримов · ул. Рудаки 5");
  });

  it("без адреса вовсе — район", () => {
    const out = clientDisplayName({
      kind: "SELLER",
      fullName: "Умед Каримов",
      desiredDistrict: { name: "Сино" },
    });
    expect(out).toBe("Умед Каримов · Сино");
  });

  it("совсем ничего — якоря нет, имя без « · »", () => {
    expect(clientDisplayName({ kind: "SELLER", fullName: "Умед Каримов" })).toBe("Умед Каримов");
  });
});

describe("Якорь покупателя — «ищет …» из желаемого", () => {
  it("комнаты + район + бюджет", () => {
    const out = clientDisplayName({
      kind: "BUYER",
      fullName: "Далер Джаббаров",
      desiredRooms: 2,
      desiredDistrict: { name: "Сино" },
      budgetMax: 800_000,
      currency: "TJS",
    });
    expect(out).toBe("Далер Джаббаров · ищет 2к Сино до 800к с.");
  });

  it("только бюджет в долларах", () => {
    const out = clientDisplayName({
      kind: "BUYER",
      fullName: "Далер Джаббаров",
      budgetMax: 45000,
      currency: "USD",
    });
    expect(out).toBe("Далер Джаббаров · ищет до $45к");
  });

  it("ничего не заполнено — якоря нет", () => {
    expect(clientDisplayName({ kind: "BUYER", fullName: "Далер Джаббаров" })).toBe("Далер Джаббаров");
  });
});

describe("Якорь не дублируется, если агент уже дописал его в имя", () => {
  it("«Зоир стадион Спартак» + якорь «стадион Спартак» — не повторяем", () => {
    const out = clientDisplayName(
      { kind: "SELLER", fullName: "Зоир стадион Спартак" },
      { propertyAddress: "стадион Спартак" }
    );
    expect(out).toBe("Зоир стадион Спартак");
  });

  it("сравнение без регистра", () => {
    const out = clientDisplayName(
      { kind: "SELLER", fullName: "Зоир СТАДИОН спартак" },
      { propertyAddress: "стадион Спартак" }
    );
    expect(out).toBe("Зоир СТАДИОН спартак");
  });
});

describe("Обрезка якоря по слову, не длиннее ~28 символов", () => {
  it("длинный адрес обрезается по границе слова с многоточием", () => {
    const out = clientDisplayName(
      { kind: "SELLER", fullName: "Умед" },
      { propertyAddress: "улица Маяковского, дом 45, корпус 2, квартира 118" }
    );
    const anchor = out.split(" · ")[1]!;
    expect(anchor.length).toBeLessThanOrEqual(29);
    expect(anchor.endsWith("…")).toBe(true);
    // Обрезка по слову — не должна обрывать слово серединой без многоточия сразу за буквой чужого слова.
    expect(anchor).not.toMatch(/[а-яё]…[а-яё]/i);
  });
});
