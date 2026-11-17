import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readCleanChatDraft, writeCleanChatDraft } from "../cleanChatDraft";

/**
 * ЧЕРНОВИК ОТВЕТА КЛИЕНТУ — ВО ВСЕХ ОБОЛОЧКАХ (17.11.2026, аудит F2-5).
 *
 * Черновик по диалогу был включён только в чистой оболочке (`enabled: clean`), а
 * агент на телефоне её не получает никогда (hooks/shellDevicePolicy.ts). Он
 * набирал ответ, уходил в карточку клиента проверить цену — и возвращался к
 * пустому полю. Сторож держит оба места набора ответа на безусловном черновике.
 */
const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");
const COMPOSERS = ["pages/Messages.tsx", "components/mobile/MobileChatView.tsx"];

describe("черновик ответа в чате — во всех оболочках", () => {
  for (const file of COMPOSERS) {
    it(`${file}: черновик по диалогу включён без условий`, () => {
      const source = fs.readFileSync(path.join(SRC, file), "utf8");
      expect(source).toMatch(/useCleanChatDraft\(\{\s*enabled:\s*true,\s*conversationId:\s*id,/);
    });
  }

  it("черновик одного диалога не попадает в другой и пропадает после отправки", () => {
    const data = new Map<string, string>();
    const storage = {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
      removeItem: (k: string) => void data.delete(k),
    };
    writeCleanChatDraft("agent-1", "chat-a", "Цена 450 тысяч, могу показать завтра", storage);
    expect(readCleanChatDraft("agent-1", "chat-a", storage)).toBe("Цена 450 тысяч, могу показать завтра");
    expect(readCleanChatDraft("agent-1", "chat-b", storage)).toBeNull();
    expect(readCleanChatDraft("agent-2", "chat-a", storage)).toBeNull();
    // Отправка обнуляет поле — хук пишет пустую строку, черновик исчезает.
    writeCleanChatDraft("agent-1", "chat-a", "", storage);
    expect(readCleanChatDraft("agent-1", "chat-a", storage)).toBeNull();
  });
});
