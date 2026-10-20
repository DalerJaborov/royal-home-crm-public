import { describe, expect, it } from "vitest";
import { metaLimiterSender } from "../src/routes/webhooks.js";

/**
 * Аудит 23.09.2026, круг 3, №70: лимит вебхука Meta (30 в минуту на отправителя)
 * считал отправителем первую запись тела — и эхо НАШИХ ответов всем клиентам
 * копилось в одном ведре нашего же аккаунта. Больше 30 ответов в минуту — и Meta
 * получала 429 на тело, где за эхом лежали сообщения живых клиентов.
 */
const PAGE = "17841400000000001";
const CLIENT = "6500000000000042";

const echo = (to: string) => ({ sender: { id: PAGE }, recipient: { id: to }, message: { mid: "m1", text: "Здравствуйте", is_echo: true } });
const fromClient = (id: string) => ({ sender: { id }, recipient: { id: PAGE }, message: { mid: "m2", text: "Сколько стоит?" } });

describe("лимит вебхука Meta считает только реплики клиентов", () => {
  it("эхо наших ответов не считается ничьей репликой — лимит его пропускает", () => {
    expect(metaLimiterSender({ object: "instagram", entry: [{ id: PAGE, messaging: [echo(CLIENT), echo("65000000000099")] }] })).toBeNull();
  });

  it("эхо первым, клиент следом — ключ по клиенту, а не по нашему аккаунту", () => {
    expect(metaLimiterSender({ entry: [{ messaging: [echo(CLIENT)] }, { messaging: [fromClient(CLIENT)] }] })).toBe(CLIENT);
  });

  it("«прочитано» без сообщения не считается", () => {
    expect(metaLimiterSender({ entry: [{ messaging: [{ sender: { id: CLIENT }, read: { mid: "m1" } }] }] })).toBeNull();
  });

  it("статусы доставки WhatsApp без сообщений не считаются", () => {
    const body = { entry: [{ changes: [{ field: "messages", value: { statuses: [{ id: "wamid.1", status: "read", recipient_id: "992900000000" }] } }] }] };
    expect(metaLimiterSender(body)).toBeNull();
  });

  it("живые реплики считаются по-прежнему: Instagram, кнопка, WhatsApp, комментарий", () => {
    expect(metaLimiterSender({ entry: [{ messaging: [fromClient(CLIENT)] }] })).toBe(CLIENT);
    expect(metaLimiterSender({ entry: [{ messaging: [{ sender: { id: CLIENT }, postback: { payload: "X" } }] }] })).toBe(CLIENT);
    expect(metaLimiterSender({ entry: [{ changes: [{ value: { messages: [{ from: "992900000001" }] } }] }] })).toBe("992900000001");
    expect(metaLimiterSender({ entry: [{ changes: [{ field: "comments", value: { from: { id: "c-1" } } }] }] })).toBe("c-1");
  });

  it("мусор в теле не роняет лимитер", () => {
    expect(metaLimiterSender(null)).toBeNull();
    expect(metaLimiterSender({ entry: "x" })).toBeNull();
    expect(metaLimiterSender({ entry: [null, { messaging: [null] }] })).toBeNull();
  });
});
