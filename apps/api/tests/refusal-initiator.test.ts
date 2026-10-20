import { describe, expect, it } from "vitest";
import { clientRefuseSchema } from "@royal-home/shared";

/**
 * Форма «Клиент отказался» — спецификация владельца от 31.07 и уточнение 01.08.2026.
 *
 * Три требования, которых не было:
 *  - «кто инициировал» — от него зависит, уйдёт карточка следующему агенту или в
 *    службу безопасности. Поля не существовало вовсе, и развилку решала одна причина;
 *  - при «купил/продал через другое агентство» обязательно название конкурента —
 *    иначе разбор потерь строить не на чем;
 *  - комментарий НЕОБЯЗАТЕЛЕН при любой причине (было обязательным с 11.08.2026,
 *    отменено 18.08.2026 владельцем: «упрости максимум» — обязательный текст при
 *    каждом отказе оказался лишней преградой, агенты застревали на форме).
 */

const base = { reason: "EXPENSIVE" as const, initiator: "CLIENT" as const, comment: "тестовый комментарий" };

describe("Кто завершил работу — обязательное поле", () => {
  it("без инициатора форма не принимается", () => {
    expect(clientRefuseSchema.safeParse({ reason: "EXPENSIVE" }).success).toBe(false);
  });

  it("все четыре инициатора допустимы", () => {
    for (const initiator of ["CLIENT", "AGENT", "OWNER", "COMPANY"] as const) {
      expect(clientRefuseSchema.safeParse({ ...base, initiator }).success).toBe(true);
    }
  });

  it("посторонний инициатор отвергается", () => {
    expect(clientRefuseSchema.safeParse({ ...base, initiator: "КТО-ТО" }).success).toBe(false);
  });
});

describe("Название агентства-конкурента", () => {
  it("обязательно, когда сделка ушла на сторону", () => {
    for (const reason of [
      "BOUGHT_VIA_OTHER_AGENCY",
      "SOLD_VIA_OTHER_AGENCY",
      "BOUGHT_ELSEWHERE",
    ] as const) {
      expect(clientRefuseSchema.safeParse({ ...base, reason, competitorName: undefined }).success).toBe(false);
      expect(
        clientRefuseSchema.safeParse({ ...base, reason, competitorName: "Другое агентство" }).success
      ).toBe(true);
    }
  });

  it("на обычных причинах не спрашивается", () => {
    expect(clientRefuseSchema.safeParse(base).success).toBe(true);
  });

  it("не спрашивается у «купил/продал сам» — конкурента там нет", () => {
    for (const reason of ["BOUGHT_SELF", "SOLD_SELF"] as const) {
      expect(clientRefuseSchema.safeParse({ ...base, reason }).success).toBe(true);
    }
  });

  it("пробелы за название не считаются", () => {
    expect(
      clientRefuseSchema.safeParse({ ...base, reason: "BOUGHT_ELSEWHERE", competitorName: "   " }).success
    ).toBe(false);
  });
});

describe("Комментарий необязателен при любой причине", () => {
  it("без комментария принимается", () => {
    expect(clientRefuseSchema.safeParse({ reason: "OTHER", initiator: "AGENT" }).success).toBe(true);
    expect(clientRefuseSchema.safeParse({ reason: "EXPENSIVE", initiator: "AGENT" }).success).toBe(true);
  });

  it("пустой и пробельный комментарий тоже принимаются", () => {
    expect(clientRefuseSchema.safeParse({ ...base, comment: "" }).success).toBe(true);
    expect(clientRefuseSchema.safeParse({ ...base, comment: "   " }).success).toBe(true);
  });

  it("с комментарием тоже принимается при любой причине", () => {
    expect(
      clientRefuseSchema.safeParse({ reason: "OTHER", initiator: "AGENT", comment: "уехал из страны" }).success
    ).toBe(true);
    expect(clientRefuseSchema.safeParse(base).success).toBe(true);
  });
});
