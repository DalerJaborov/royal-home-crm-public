import { describe, expect, it } from "vitest";
import {
  PROPERTY_CHANGE_KINDS,
  createPropertyChangeRequestSchema,
  type PropertyChangeRequestDto,
} from "@royal-home/shared";
import {
  CHANGE_KIND_BUTTONS,
  UNPUBLISH_EMPTY_HINT,
  buildCardDataBody,
  buildOtherBody,
  buildPriceChangeBody,
  buildRemakeBody,
  buildUnpublishBody,
  cardDataInitial,
  changeRequestMode,
  changeResultView,
  consequenceLine,
  describeChangeRequest,
  isPublishedForChangeRequests,
  kindDisabledReason,
} from "../propertyChangeRequestView";

/**
 * Заявки на изменение опубликованного объекта (07.10.2026): видимость блока, сборка тел
 * запросов и тексты итога. jsdom в проекте нет — проверяем чистые функции; разметку
 * первого рендера смотрит components/__tests__/PropertyChangeRequestCard.test.tsx.
 */

const base = { isTrashed: false, isResponsible: true, canRequest: true, canDecide: false };

describe("changeRequestMode — кому показывать блок", () => {
  it("автор видит блок на опубликованном объекте", () => {
    for (const status of ["AVAILABLE", "RESERVED", "SOLD", "WITHDRAWN"]) {
      expect(changeRequestMode({ ...base, status })).toBe("author");
    }
  });

  it("на неопубликованном объекте (конвейер подготовки) блока нет", () => {
    for (const status of ["PENDING_REVIEW", "AWAITING_PHOTOS", "AWAITING_VIDEO", "EDITING"]) {
      expect(isPublishedForChangeRequests(status)).toBe(false);
      expect(changeRequestMode({ ...base, status })).toBeNull();
      expect(changeRequestMode({ ...base, status, canDecide: true })).toBeNull();
    }
  });

  it("директор видит режим решателя, а не режим автора, даже если у него есть и право просить", () => {
    expect(changeRequestMode({ ...base, status: "AVAILABLE", canDecide: true })).toBe("decider");
    expect(changeRequestMode({ ...base, status: "AVAILABLE", canDecide: true, canRequest: false })).toBe("decider");
  });

  it("без права просить, чужой объект или корзина — блока нет", () => {
    expect(changeRequestMode({ ...base, status: "AVAILABLE", canRequest: false })).toBeNull();
    expect(changeRequestMode({ ...base, status: "AVAILABLE", isResponsible: false })).toBeNull();
    expect(changeRequestMode({ ...base, status: "AVAILABLE", isTrashed: true })).toBeNull();
    expect(changeRequestMode({ ...base, status: "AVAILABLE", isTrashed: true, canDecide: true })).toBeNull();
  });
});

describe("кнопки заявок", () => {
  it("набор кнопок — ровно виды из shared", () => {
    expect([...CHANGE_KIND_BUTTONS]).toEqual([...PROPERTY_CHANGE_KINDS]);
  });

  it("«Убрать из соцсетей» неактивна, пока нет отметок о выходе ролика", () => {
    expect(kindDisabledReason("UNPUBLISH", [])).toBe(UNPUBLISH_EMPTY_HINT);
    expect(kindDisabledReason("UNPUBLISH", ["YOUTUBE"])).toBeNull();
    expect(kindDisabledReason("PRICE_CHANGE", [])).toBeNull();
  });
});

describe("сборка тела заявки проходит схему shared", () => {
  it("PRICE_CHANGE: число с пробелами и запятой, переключатель перемонтажа", () => {
    const r = buildPriceChangeBody({ newPrice: "89 000,5", remake: true, comment: " Торг " });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(createPropertyChangeRequestSchema.safeParse(r.body).success).toBe(true);
      expect(r.body).toEqual({ kind: "PRICE_CHANGE", payload: { newPrice: 89000.5, remake: true }, comment: "Торг" });
    }
    expect(buildPriceChangeBody({ newPrice: "", remake: false, comment: "" }).ok).toBe(false);
    expect(buildPriceChangeBody({ newPrice: "-5", remake: false, comment: "" }).ok).toBe(false);
  });

  const property = { areaSqm: "55.00", rooms: 2, floor: 3, totalFloors: 9, address: "ул. Рудаки 10", districtId: "d1" };
  const current = cardDataInitial(property);

  it("CARD_DATA: в patch идут только изменённые поля, числа приводятся к числам", () => {
    const edited = { ...current, areaSqm: "58", address: "ул. Рудаки 12" };
    const r = buildCardDataBody({ current, edited, remake: false, comment: "" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(createPropertyChangeRequestSchema.safeParse(r.body).success).toBe(true);
      expect(r.body).toEqual({
        kind: "CARD_DATA",
        payload: { patch: { areaSqm: 58, address: "ул. Рудаки 12" }, remake: false },
      });
    }
  });

  it("CARD_DATA: «55» против «55.00» не считается правкой; без правок и с пустым полем — отказ", () => {
    expect(current.areaSqm).toBe("55");
    expect(buildCardDataBody({ current, edited: { ...current }, remake: false, comment: "" }).ok).toBe(false);
    expect(buildCardDataBody({ current, edited: { ...current, rooms: "" }, remake: false, comment: "" }).ok).toBe(false);
    expect(buildCardDataBody({ current, edited: { ...current, rooms: "2.5" }, remake: false, comment: "" }).ok).toBe(false);
  });

  it("REMAKE_VIDEO: причина обязательна, комментарий — там, где требует shared", () => {
    expect(buildRemakeBody({ reason: null, removeFromSocial: true, comment: "" }).ok).toBe(false);
    expect(buildRemakeBody({ reason: "OTHER", removeFromSocial: true, comment: "" }).ok).toBe(false);
    const r = buildRemakeBody({ reason: "OTHER", removeFromSocial: false, comment: "не та цена" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(createPropertyChangeRequestSchema.safeParse(r.body).success).toBe(true);
  });

  it("UNPUBLISH: все каналы — пустой payload, часть — список; нечего снимать — отказ", () => {
    const all = buildUnpublishBody({ selected: ["YOUTUBE", "TIKTOK"], available: ["YOUTUBE", "TIKTOK"], comment: "" });
    expect(all.ok && all.body).toEqual({ kind: "UNPUBLISH", payload: {} });
    const some = buildUnpublishBody({ selected: ["TIKTOK"], available: ["YOUTUBE", "TIKTOK"], comment: "" });
    expect(some.ok && some.body).toEqual({ kind: "UNPUBLISH", payload: { channels: ["TIKTOK"] } });
    expect(buildUnpublishBody({ selected: [], available: ["YOUTUBE"], comment: "" }).ok).toBe(false);
    expect(buildUnpublishBody({ selected: [], available: [], comment: "" }).ok).toBe(false);
  });

  it("OTHER: от 10 символов", () => {
    expect(buildOtherBody({ text: "коротко" }).ok).toBe(false);
    expect(buildOtherBody({ text: "Нужно заменить фото на обложке" }).ok).toBe(true);
  });
});

function dto(partial: Partial<PropertyChangeRequestDto>): PropertyChangeRequestDto {
  return {
    id: "r1",
    propertyId: "p1",
    propertyShortId: 82,
    kind: "PRICE_CHANGE",
    status: "PENDING",
    payload: { newPrice: 89000, remake: false },
    comment: null,
    author: { id: "a1", fullName: "Агент" },
    decidedBy: null,
    decidedAt: null,
    decisionNote: null,
    result: null,
    error: null,
    createdAt: "2026-10-07T10:00:00Z",
    ...partial,
  };
}

describe("тексты заявок", () => {
  const prop = { price: "95000.00", currency: "TJS" as const };

  it("цена ждущей заявки — «было → стало»; решённой — только новая", () => {
    const pending = describeChangeRequest(dto({}), prop);
    expect(pending).toContain("→");
    expect(pending).toContain("с.");
    const done = describeChangeRequest(dto({ status: "APPROVED" }), prop);
    expect(done).not.toContain("→");
  });

  it("«что произойдёт» дописывает перемонтаж, когда его просили", () => {
    const plain = consequenceLine(dto({}));
    const withRemake = consequenceLine(dto({ payload: { newPrice: 89000, remake: true } }));
    expect(withRemake).toBe(`${plain} Ролик уйдёт на перемонтаж.`);
  });
});

describe("итог заявки", () => {
  it("принятая с остатком руками отдаёт manual отдельным списком", () => {
    const v = changeResultView(
      dto({
        status: "APPROVED",
        result: {
          applied: ["Цена на сайте обновлена"],
          manual: [{ channel: "INSTAGRAM", text: "поправьте цену" }],
          remakeQueued: false,
        },
      })
    );
    expect(v?.applied).toEqual(["Цена на сайте обновлена"]);
    expect(v?.manual).toHaveLength(1);
    expect(v?.failed).toBeNull();
  });

  it("FAILED несёт текст ошибки; у ждущей и отклонённой итога нет", () => {
    expect(changeResultView(dto({ status: "FAILED", error: "Facebook не ответил" }))?.failed).toBe("Facebook не ответил");
    expect(changeResultView(dto({ status: "FAILED", error: null }))?.failed).toBeTruthy();
    expect(changeResultView(dto({ status: "PENDING" }))).toBeNull();
    expect(changeResultView(dto({ status: "REJECTED" }))).toBeNull();
  });
});
