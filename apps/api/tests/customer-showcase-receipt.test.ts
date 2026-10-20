import { describe, expect, it } from "vitest";
import { reconcileCustomerShowcaseReply } from "../src/lib/customerShowcaseReceipt.js";
describe("showcase acknowledgement uses provider evidence without destroying facts", () => {
  const empty = { deliveryStatus: "not_sent" as const, attachments: [] };
  it("unknown/foreign history suppression does not become an already-shown or sent-photo claim", () => {
    const result = reconcileCustomerShowcaseReply({ reply: "Вот фото объекта. Цена 40 000 USD. Уточните район?" }, empty, "ru");
    expect(result.reply).toBe("Фотографии пока не отправились. Цена 40 000 USD. Уточните район?");
    expect(result.reply).not.toMatch(/уже|показывали/i);
  });
  it("keeps RU/TG new questions and prices when only the photo clause was false", () => {
    const result = reconcileCustomerShowcaseReply({ reply: "Ана расмҳояш. Нархаш 400 000 сомонӣ. Кадом ноҳия лозим?" }, empty, "tg");
    expect(result.reply).toBe("Расмҳо ҳоло фиристода нашуданд. Нархаш 400 000 сомонӣ. Кадом ноҳия лозим?");
  });
  it("unknown accepted-without-MID outcome is not falsely called sent or failed", () => {
    const result = reconcileCustomerShowcaseReply({ reply: "Отправил фото квартиры. Цена 40 000 USD." },
      { deliveryStatus: "unknown", attachments: [{ kind: "image", url: "fixture.jpg" }] }, "ru");
    expect(result.reply).toBe("Пока не могу подтвердить отправку фотографий. Цена 40 000 USD.");
  });
  it("an actual photo MID permits the affirmative statement", () => {
    const reply = "Вот фотографии квартиры.";
    expect(reconcileCustomerShowcaseReply({ reply }, { deliveryStatus: "sent", attachments: [{ kind: "image", url: "fixture.jpg", mid: "fixture-mid" }] }, "ru"))
      .toMatchObject({ reply, changed: false });
  });
  it("a confirmed link is acknowledged as a link while a prepared website card is a card", () => {
    expect(reconcileCustomerShowcaseReply({ reply: "Вот фото. Цена 100 USD." }, { deliveryStatus: "sent", attachments: [], linkMid: "fixture-mid" }, "ru").reply)
      .toBe("Вот ссылка на объект. Цена 100 USD.");
    expect(reconcileCustomerShowcaseReply({ reply: "Вот фото." }, { deliveryStatus: "prepared", attachments: [], websiteCard: { shortId: 101 } as never }, "ru").reply)
      .toBe("Вот карточка объекта.");
  });
  it("reported client/owner photos and an unrelated question stay intact", () => {
    const reply = "Клиент прислал фото. Собственник отправил фото. Где находится объект?";
    expect(reconcileCustomerShowcaseReply({ reply }, empty, "ru")).toEqual({ reply, changed: false });
  });
  it.each(["Это фото клиента. Цена 100 USD. Уточните район?", "Вот фото, которое прислал собственник. Можно осмотр?"])("ambiguous/reported media is not rewritten as our send: %s", reply => {
    expect(reconcileCustomerShowcaseReply({ reply }, empty, "ru")).toEqual({ reply, changed: false });
  });
  it("does not duplicate a failure note across two bubbles", () => {
    const result = reconcileCustomerShowcaseReply({ reply: "Вот фото. Цена 100 USD.", reply2: "Отправил фото. Можем показать?" }, empty, "ru");
    expect(result.reply).toContain("Цена 100 USD.");
    expect(result.reply2).toBe("Можем показать?");
    expect(`${result.reply} ${result.reply2}`.match(/не отправились/g)).toHaveLength(1);
  });
});
