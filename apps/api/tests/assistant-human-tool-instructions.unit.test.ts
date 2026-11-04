import { VIDEO_REMAKE_REASONS } from "@royal-home/shared";
import { describe, expect, it, vi } from "vitest";
import { assistantStyle } from "../src/ai/assistant/personaStyle.js";
import { changePropertyStatusPlugin } from "../src/ai/assistant/tools/changePropertyStatus.js";
import { deletePropertyPlugin } from "../src/ai/assistant/tools/deletePropertyTool.js";
import { requestPropertyChangePlugin } from "../src/ai/assistant/tools/requestPropertyChange.js";
import { sendToRemakePlugin } from "../src/ai/assistant/tools/sendToRemake.js";

vi.mock("../src/db.js", () => ({ prisma: { $disconnect: async () => {} } }));

describe("assistant user-facing tool instructions", () => {
  it("keeps remake reason codes in the argument enum and gives one human clarification", () => {
    const properties = sendToRemakePlugin.parameters?.properties as Record<string, { enum?: string[]; description: string }>;
    expect(properties.reason.enum).toEqual([...VIDEO_REMAKE_REASONS]);
    const prose = [sendToRemakePlugin.description, ...Object.values(properties).map(field => field.description)].join(" ");
    for (const reason of VIDEO_REMAKE_REASONS) expect(prose).not.toContain(reason);
    expect(prose).toContain("Что поправить в ролике?");
    expect(prose).toContain("Если из слов сотрудника или контекста ясно");
  });

  it("keeps optional deletion reasons and request types out of response guidance", () => {
    expect(deletePropertyPlugin.description).not.toMatch(/DUPLICATE|TEST_CARD|WRONG_DATA/);
    expect(requestPropertyChangePlugin.description).not.toMatch(/CARD_DATA|UNPUBLISH|OTHER/);
    expect(changePropertyStatusPlugin.description).not.toMatch(/AVAILABLE|RESERVED|SOLD|WITHDRAWN/);
    expect(assistantStyle("telegram")).toContain("Никогда не перечисляй их сотруднику");
    expect(assistantStyle("telegram")).toContain("Дар навор чиро ислоҳ кунам?");
  });
});
