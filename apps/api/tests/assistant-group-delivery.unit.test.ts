import { readFileSync } from "node:fs";
import { STAFF_TOOL_NAMES } from "../src/ai/assistant/tools/staffToolNames.js";
import { runInNewContext } from "node:vm";
import * as shared from "@royal-home/shared";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import * as assistantReply from "../src/telegram/assistantReply.js";
import * as participation from "../src/telegram/assistantGroupParticipation.js";

vi.mock("../src/db.js", async importOriginal => ({
  ...(await importOriginal<typeof import("../src/db.js")>()),
  prisma: { $disconnect: vi.fn() },
}));

const deliverySource = ts.transpileModule(
  readFileSync(new URL("../src/telegram/assistantDelivery.ts", import.meta.url), "utf8"),
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } },
).outputText;

class TelegramApiError extends Error {
  readonly errorCode = 400;
}

function fixture() {
  const html = vi.fn(async () => ({}));
  const plain = vi.fn(async () => ({}));
  const voice = vi.fn(async () => true);
  const dependencies: Record<string, unknown> = {
    "@royal-home/shared": shared,
    "../ai/assistant/tools/index.js": { listAssistantToolPlugins: () => [
      { name: "send_to_remake", parameters: { properties: { reason: {}, comment: {}, removeFromSocial: {} } } },
      { name: "get_property_work_status" },
    ] },
    // Сотрудники и права (10.11.2026): список имён — настоящий, код Google Authenticator — инертная заглушка.
    "../ai/assistant/tools/staffToolNames.js": { STAFF_TOOL_NAMES },
    "./assistantStepUp.js": { bundleNeedsStepUp: () => false, cancelStepUpForBundle: async () => {} },
    "./api.js": { sendHtmlMessage: html, sendMessage: plain, sendMessageWithButtons: plain, TelegramApiError },
    "./assistantReply.js": assistantReply,
    "./assistantGroupParticipation.js": participation,
    "./assistantVoice.js": { sendAssistantVoiceReply: voice },
  };
  const delivery = {} as typeof import("../src/telegram/assistantDelivery.js");
  runInNewContext(deliverySource, { exports: delivery, require: (name: string) => dependencies[name] ?? {} });
  return { delivery, html, plain, voice };
}

describe("Telegram model reply guard", () => {
  it("does not expose internal work-phase identifiers", () => {
    const { delivery } = fixture();
    expect(delivery.assistantGroupClarification("ОБ-000132: EDITOR_DELIVERY_UNCONFIRMED", "ru"))
      .toBe("Что уточнить по ОБ-000132?");
  });
  it("replaces a group reason menu with one question and keeps the object reference", async () => {
    const { delivery, html, plain, voice } = fixture();
    const raw = "По ОБ-000132 выберите причину: `WRONG_CAPTION`, NO_MUSIC, CARD_DATA_CHANGED или OTHER.";
    await delivery.sendAssistantReply("-1", raw, { scope: "group", mode: "voice", requestLanguage: "tg", replyTo: 42, written: [] });
    expect(html).toHaveBeenCalledExactlyOnceWith("-1", "Дар навори <code>ОБ-000132</code> чиро иваз кунем?", 42);
    expect(plain).not.toHaveBeenCalled();
    expect(voice).not.toHaveBeenCalled();
  });

  it.each(["reason=OTHER", '{"status":"AVAILABLE"}', "Статус: EDITING", "PENDING_REVIEW, AWAITING_VIDEO"])(
    "recognizes a related internal parameter or enum dump: %s",
    raw => {
      const { delivery } = fixture();
      expect(delivery.assistantGroupClarification(raw, "ru")).toBe("Что именно нужно уточнить?");
    },
  );

  it("uses registered tool names and camelCase fields without treating currency and networks as codes", () => {
    const { delivery } = fixture();
    expect(delivery.assistantGroupClarification("Укажи removeFromSocial", "ru")).toBe("Что нужно поправить в ролике?");
    expect(delivery.assistantGroupClarification("get_property_work_status(ref)", "ru")).toBe("Что именно нужно уточнить?");
    expect(delivery.assistantGroupClarification("Цена ОБ-000132 — 810 000 TJS. Фото в CRM и Telegram. Ссылка https://test.invalid/WRONG_CAPTION", "ru")).toBeNull();
  });

  it("keeps a clean group reply and the existing private delivery behavior", async () => {
    const { delivery, html } = fixture();
    const clean = "ОБ-000132 сейчас на монтаже.";
    await delivery.sendAssistantReply("-1", clean, { scope: "group", mode: "text", written: [] });
    expect(html).toHaveBeenCalledWith("-1", "<code>ОБ-000132</code> сейчас на монтаже.", undefined);
    await delivery.sendAssistantReply("1", "Причина WRONG_CAPTION.", { scope: "private", mode: "text", written: [] });
    expect(html).toHaveBeenLastCalledWith("1", "Причина WRONG_CAPTION.", undefined);
  });
});


describe("Telegram forum delivery", () => {
  it("keeps plain fallback messages in the topic after HTML rejection", async () => {
    const { delivery, html, plain } = fixture();
    html.mockRejectedValue(new TelegramApiError("Bad Request: can't parse entities"));
    expect(await delivery.sendAssistantReply("-1", "Уточни время. ||| Проверь адрес.", {
      scope: "group", mode: "text", replyTo: 42, messageThreadId: 41, written: [],
    })).toBe(true);
    expect(plain.mock.calls).toEqual([
      ["-1", "Уточни время.", 42, undefined, { messageThreadId: 41 }],
      ["-1", "Проверь адрес.", undefined, undefined, { messageThreadId: 41 }],
    ]);
  });
});
