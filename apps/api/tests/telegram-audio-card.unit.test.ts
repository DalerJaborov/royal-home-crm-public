import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 24.11.2026, карточка выбора голоса в Шабнам: аудио с названием в плеере, подписью и кнопками под ним (sendAudioCard) и
 * подмена файла в том же сообщении (editAudioCard). Здесь сами вызовы api.ts через подставной fetch: что именно уходит
 * в Telegram (file_id идёт JSON-ом, файл с диска и байты идут multipart), «не изменено» не ошибка, чужая ошибка проходит наружу.
 */
type Call = { method: string; json?: Record<string, unknown>; form?: FormData };
const calls: Call[] = [];
let respond: (method: string) => unknown = () => ({ ok: true, result: { message_id: 7, audio: { file_id: "fid-new" } } });

process.env.TELEGRAM_BOT_TOKEN = "123456:synthetic-test-token";
delete process.env.TELEGRAM_API_BASE_URL;
vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { body?: unknown }) => {
  const method = String(url).split("/").pop() ?? "";
  if (typeof init?.body === "string") calls.push({ method, json: JSON.parse(init.body) as Record<string, unknown> });
  else calls.push({ method, form: init?.body as FormData });
  return { json: async () => respond(method) } as unknown as Response;
}));
vi.resetModules();
const api = await import("../src/telegram/api.js");
afterAll(() => {
  vi.unstubAllGlobals();
  delete process.env.TELEGRAM_BOT_TOKEN;
});
beforeEach(() => { calls.length = 0; respond = () => ({ ok: true, result: { message_id: 7, audio: { file_id: "fid-new" } } }); });

const card = { filename: "sample-a.mp3", title: "Мадина", performer: "Образец голоса", caption: "🎙 Мадина\nЖенский голос · 1 из 4", buttons: [[{ text: "🎙 Озвучить этим голосом", callback_data: "fnr:p:x" }]] };

describe("sendAudioCard", () => {
  it("уже загруженный файл уходит по file_id одним JSON-запросом: название, исполнитель, подпись и кнопки в нём", async () => {
    const sent = await api.sendAudioCard("5001", { fileId: "fid-old" }, card);
    expect(sent).toMatchObject({ message_id: 7, audio: { file_id: "fid-new" } });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("sendAudio");
    expect(calls[0]!.json).toMatchObject({ chat_id: "5001", audio: "fid-old", title: "Мадина", performer: "Образец голоса", caption: card.caption });
    expect(calls[0]!.json!.reply_markup).toEqual({ inline_keyboard: card.buttons });
  });

  it("байты уходят файлом (multipart) с именем, названием и кнопками", async () => {
    await api.sendAudioCard("5001", Buffer.from([0x49, 0x44, 0x33, 1]), card);
    expect(calls[0]!.method).toBe("sendAudio");
    const form = calls[0]!.form!;
    expect(form.get("chat_id")).toBe("5001");
    expect(form.get("title")).toBe("Мадина");
    expect(JSON.parse(String(form.get("reply_markup")))).toEqual({ inline_keyboard: card.buttons });
    const file = form.get("audio") as File;
    expect(file.name).toBe("sample-a.mp3");
  });

  it("подпись длиннее предела Telegram обрезается, а не отвергается целиком", async () => {
    await api.sendAudioCard("5001", { fileId: "f" }, { ...card, caption: "я".repeat(3000) });
    expect(String(calls[0]!.json!.caption).length).toBeLessThanOrEqual(1024);
  });
});

describe("editAudioCard", () => {
  it("подменяет файл, подпись и кнопки в том же сообщении по file_id", async () => {
    const res = await api.editAudioCard("5001", 42, { fileId: "fid-old" }, card);
    expect(res?.audio?.file_id).toBe("fid-new");
    expect(calls[0]!.method).toBe("editMessageMedia");
    expect(calls[0]!.json).toMatchObject({ chat_id: "5001", message_id: 42, media: { type: "audio", media: "fid-old", title: "Мадина", caption: card.caption } });
    expect(calls[0]!.json!.reply_markup).toEqual({ inline_keyboard: card.buttons });
  });

  it("новый файл идёт multipart: media ссылается на приложенное audio", async () => {
    await api.editAudioCard("5001", 42, Buffer.from([1, 2, 3]), card);
    const form = calls[0]!.form!;
    expect(calls[0]!.method).toBe("editMessageMedia");
    expect(form.get("message_id")).toBe("42");
    expect(JSON.parse(String(form.get("media")))).toMatchObject({ type: "audio", media: "attach://audio", title: "Мадина" });
    expect((form.get("audio") as File).name).toBe("sample-a.mp3");
  });

  it("«message is not modified» (двойной тап) — не ошибка, а null; любая другая ошибка проходит наружу", async () => {
    respond = () => ({ ok: false, error_code: 400, description: "Bad Request: message is not modified: specified new message content and reply markup are exactly the same as a current content and reply markup of the message" });
    expect(await api.editAudioCard("5001", 42, { fileId: "f" }, card)).toBeNull();
    respond = () => ({ ok: false, error_code: 400, description: "Bad Request: message to edit not found" });
    await expect(api.editAudioCard("5001", 42, { fileId: "f" }, card)).rejects.toThrow(/message to edit not found/);
  });
});
