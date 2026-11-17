import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * ОТПРАВКА КЛИЕНТУ — ТОЛЬКО ЧЕРЕЗ lib/clientSend.ts (17.11.2026, аудит F2-4).
 *
 * Обрыв связи + второе «Отправить» давали клиенту два одинаковых сообщения: ни
 * одна отправка не передавала серверу ключ повтора. Сторож не пускает прямой
 * `api(…, { method: "POST" })` на адреса отправки клиенту мимо `sendToClient`,
 * которая этот ключ ставит сама.
 */
const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");

const SEND_PATH = String.raw`/(?:reply|reply-voice|reply-media|send-properties|message|message-voice|sms-share|whatsapp-first)`;
const DIRECT_CALL = new RegExp(String.raw`\bapi\s*(?:<[^>(]*>)?\s*\(\s*\x60[^\x60]*${SEND_PATH}\x60[\s\S]{0,160}?method:\s*"POST"`, "g");

function directSends(source: string): number {
  return source.match(DIRECT_CALL)?.length ?? 0;
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

describe("отправка клиенту — одна дверь с ключом повтора", () => {
  it("никто не шлёт клиенту прямым api(…, POST) мимо sendToClient", () => {
    const offenders = sourceFiles(SRC)
      .filter((file) => !file.endsWith(path.join("lib", "clientSend.ts")))
      .filter((file) => directSends(fs.readFileSync(file, "utf8")) > 0)
      .map((file) => path.relative(SRC, file));
    expect(offenders).toEqual([]);
  });

  it("сторож краснеет на прямой отправке (поломка нарочно)", () => {
    expect(directSends("api(`/conversations/${id}/reply`, { method: \"POST\", body: { text } })")).toBe(1);
    expect(
      directSends("api<{ ok: boolean }>(`/clients/${clientId}/message-voice`, {\n  method: \"POST\",\n  body: form,\n})"),
    ).toBe(1);
    // Чтение статуса тем же адресом — не отправка.
    expect(directSends("api<WaFirstContactStatus>(`/clients/${clientId}/whatsapp-first`)")).toBe(0);
  });
});

describe("sendToClient: один ключ на намерение", () => {
  afterEach(() => {
    vi.doUnmock("../api");
    vi.resetModules();
  });

  async function load(apiImpl: (path: string, options: { idempotencyKey?: string }) => Promise<unknown>) {
    vi.resetModules();
    const calls: { path: string; key?: string }[] = [];
    vi.doMock("../api", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../api")>()),
      api: (p: string, options: { idempotencyKey?: string }) => {
        calls.push({ path: p, key: options.idempotencyKey });
        return apiImpl(p, options);
      },
    }));
    const mod = await import("../clientSend");
    const { ApiError } = await import("../apiError");
    return { ...mod, ApiError, calls };
  }

  it("повтор после обрыва связи идёт с ТЕМ ЖЕ ключом", async () => {
    let attempt = 0;
    const { SendIntent, sendToClient, calls } = await load(async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("Связь пропала — попробуем ещё раз");
      return { ok: true };
    });
    const intent = new SendIntent();
    await expect(sendToClient(intent, "/conversations/c1/reply", { text: "Здравствуйте" })).rejects.toThrow();
    await sendToClient(intent, "/conversations/c1/reply", { text: "Здравствуйте" });
    expect(calls).toHaveLength(2);
    expect(calls[0].key).toBeTruthy();
    expect(calls[1].key).toBe(calls[0].key);
  });

  it("исправленный текст — новый ключ (иначе сервер отдал бы ответ первой попытки)", async () => {
    let attempt = 0;
    const { SendIntent, sendToClient, calls } = await load(async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("Связь пропала — попробуем ещё раз");
      return { ok: true };
    });
    const intent = new SendIntent();
    await expect(sendToClient(intent, "/conversations/c1/reply", { text: "Здраствуйте" })).rejects.toThrow();
    await sendToClient(intent, "/conversations/c1/reply", { text: "Здравствуйте" });
    expect(calls[1].key).not.toBe(calls[0].key);
  });

  it("после ответа сервера то же сообщение ещё раз — новое намерение, новый ключ", async () => {
    const { SendIntent, sendToClient, calls } = await load(async () => ({ ok: true }));
    const intent = new SendIntent();
    await sendToClient(intent, "/conversations/c1/reply", { text: "Ок" });
    await sendToClient(intent, "/conversations/c1/reply", { text: "Ок" });
    expect(calls[1].key).not.toBe(calls[0].key);
  });

  it("«ещё выполняется» (409 inProgress) — ключ держим", async () => {
    let attempt = 0;
    const holder: { ApiError?: new (m: string, s: number, d: unknown) => Error } = {};
    const loaded = await load(async () => {
      attempt += 1;
      if (attempt === 1) throw new holder.ApiError!("Этот запрос уже выполняется", 409, { inProgress: true });
      return { ok: true };
    });
    holder.ApiError = loaded.ApiError;
    const intent = new loaded.SendIntent();
    await expect(loaded.sendToClient(intent, "/clients/k1/send-properties", { propertyIds: ["p1"] })).rejects.toThrow();
    await loaded.sendToClient(intent, "/clients/k1/send-properties", { propertyIds: ["p1"] });
    expect(loaded.calls[1].key).toBe(loaded.calls[0].key);
  });

  it("голосовое: тот же файл при повторе — тот же отпечаток, другая запись — другой", async () => {
    const { sendFingerprint } = await load(async () => ({ ok: true }));
    const blob = new Blob(["запись"], { type: "audio/webm" });
    // Каждый повтор собирает НОВУЮ FormData (append заворачивает blob в новый File).
    const form = (b: Blob) => {
      const f = new FormData();
      f.append("audio", b, "voice.webm");
      return f;
    };
    expect(sendFingerprint("/x/reply-voice", form(blob))).toBe(sendFingerprint("/x/reply-voice", form(blob)));
    expect(sendFingerprint("/x/reply-voice", form(blob))).not.toBe(
      sendFingerprint("/x/reply-voice", form(new Blob(["другая запись"], { type: "audio/webm" }))),
    );
  });
});
