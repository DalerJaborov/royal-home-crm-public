import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Три промаха бота с присланным клиентом (25.09.2026), журнал —
 * docs/journal/2026-09-25-bot-media-fixes.md.
 *
 * Чистые функции, база не нужна: журнал ошибок подменён, чтобы видеть, ЧТО
 * записали бы, а не лезть в базу.
 */
const logged = vi.hoisted(() => [] as { source: string; message: string; dedupKey?: string }[]);
vi.mock("../src/lib/systemError.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/systemError.js")>();
  return {
    ...actual,
    logSystemError: vi.fn(async (source: string, message: string, context?: { dedupKey?: string }) => {
      logged.push({ source, message, dedupKey: context?.dedupKey });
    }),
  };
});

import { isOwnButtonCardPayload, parseIncoming, templateAttachmentText } from "../src/messengers/meta.js";
import { extractPhoneOccurrences } from "../src/ai/leadQualifier.js";
import { stripRepeatedMediaApology, alreadyApologizedForMedia } from "../src/ai/mediaApology.js";
import {
  clientSharedPostCodes,
  CLIENT_SHARED_POST_TTL_MS,
  isClientOwnSharedPost,
  rememberClientSharedPost,
  resetClientSharedPosts,
} from "../src/messengers/clientSharedPosts.js";
import { aiDailyBudgetOf, VOICE_BUDGET_EXHAUSTED_LOG_PREFIX, dushanbeDayKey } from "../src/lib/aiDailyBudget.js";

beforeEach(() => {
  logged.length = 0;
});

const instagram = (message: unknown) => ({
  object: "instagram",
  entry: [
    {
      id: "our-ig",
      messaging: [{ sender: { id: "client-1" }, recipient: { id: "our-ig" }, message }],
    },
  ],
});

const whatsapp = (message: unknown) => ({
  object: "whatsapp_business_account",
  entry: [
    {
      changes: [
        {
          value: {
            metadata: { phone_number_id: "phone-1" },
            contacts: [{ wa_id: "992900000001", profile: { name: "Алишер" } }],
            messages: [{ from: "992900000001", ...(message as object) }],
          },
        },
      ],
    },
  ],
});

/** Карточка, которую клиент прислал сам: имя и номер, кнопка «позвонить». */
const clientCard = {
  template_type: "generic",
  elements: [
    {
      title: "Фирӯз Раҳимов",
      subtitle: "Тел: +992 93 555 44 33",
      image_url: "https://cdn.example/x.jpg",
      buttons: [{ type: "phone_number", title: "Позвонить", payload: "+992935554433" }],
    },
  ],
};

/** Наша карточка лид-магнита (sendButtonCard): кнопка postback с меткой lm:. */
const ourCard = {
  template_type: "generic",
  elements: [{ title: "Чек-лист покупателя", buttons: [{ type: "postback", title: "Хочу", payload: "lm:c1:want" }] }],
};

describe("1. Карточка клиента в Instagram — номер доходит до текста", () => {
  it("номер из карточки попадает в текст и находится разбором телефонов", () => {
    const [msg] = parseIncoming(
      instagram({ mid: "m.1", attachments: [{ type: "template", payload: clientCard }] })
    );
    expect(msg.attachmentType).toBe("template");
    expect(msg.text).toContain("Фирӯз Раҳимов");
    expect(msg.text).toContain("+992 93 555 44 33");
    // Адрес картинки — не слова клиента.
    expect(msg.text).not.toContain("cdn.example");
    const phones = extractPhoneOccurrences(msg.text).map((p) => p.phone.replace(/\D/g, ""));
    expect(phones.some((p) => p.endsWith("935554433"))).toBe(true);
  });

  it("текст клиента рядом с карточкой не теряется", () => {
    const [msg] = parseIncoming(
      instagram({ mid: "m.2", text: "вот мой номер", attachments: [{ type: "template", payload: clientCard }] })
    );
    expect(msg.text.startsWith("вот мой номер")).toBe(true);
    expect(msg.text).toContain("+992 93 555 44 33");
  });

  it("наша же карточка без флага эха остаётся без текста — вебхук узнаёт её как раньше", () => {
    const [msg] = parseIncoming(instagram({ mid: "m.3", attachments: [{ type: "template", payload: ourCard }] }));
    expect(msg.text).toBe("");
    expect(isOwnButtonCardPayload(ourCard)).toBe(true);
    expect(isOwnButtonCardPayload(clientCard)).toBe(false);
  });

  it("повторы в карточке не дублируются", () => {
    const text = templateAttachmentText({
      elements: [{ title: "+992935554433", buttons: [{ type: "phone_number", title: "+992935554433", payload: "+992935554433" }] }],
    });
    expect(text).toBe("+992935554433");
  });

  it("визитка WhatsApp: номер в тексте и находится разбором телефонов", () => {
    const [msg] = parseIncoming(
      whatsapp({
        id: "wamid.c1",
        type: "contacts",
        contacts: [{ name: { formatted_name: "Бародар" }, phones: [{ phone: "+992 90 111 22 33" }] }],
      })
    );
    expect(msg.attachmentType).toBe("contact");
    expect(msg.text).toContain("+992 90 111 22 33");
    const phones = extractPhoneOccurrences(msg.text).map((p) => p.phone.replace(/\D/g, ""));
    expect(phones.some((p) => p.endsWith("901112233"))).toBe(true);
  });
});

describe("2. Голосовое: повтор извинения вырезается, отказ виден в журнале", () => {
  const apology = "Бубахшед, паёми овозиро кушода наметавонам. Бо матн нависед";

  it.each([
    apology,
    "Узр, паёми овозиро шунида наметавонам.",
    "Извините, не могу прослушать голосовое.",
    "К сожалению, голосовое не открылось.",
  ])("«%s» узнаётся как извинение", (said) => {
    expect(alreadyApologizedForMedia([{ role: "assistant", content: said }])).toBe(true);
  });

  it("второй раз фраза вырезается, полезный хвост остаётся", () => {
    const history = [
      { role: "user" as const, content: "[вложение: audio]" },
      { role: "assistant" as const, content: apology },
    ];
    const out = stripRepeatedMediaApology([apology], history);
    expect(out.join(" ")).not.toMatch(/кушода наметавонам/);
    expect(out.join(" ")).toContain("Бо матн нависед");
  });

  it("обычная фраза бота извинением не считается", () => {
    expect(alreadyApologizedForMedia([{ role: "assistant", content: "Хона дар кадом ноҳия лозим?" }])).toBe(false);
  });

  it("кончились голосовые на сутки — строка в журнал с постоянным началом", () => {
    const today = dushanbeDayKey(new Date());
    const row = {
      id: "conv-voice",
      clientId: null,
      aiBudgetDate: today,
      aiTurnsToday: 1,
      aiVoiceToday: 100_000,
      aiPhotoToday: 0,
      aiVideoToday: 0,
      aiDocToday: 0,
      aiLimitNoticeAt: null,
    };
    expect(aiDailyBudgetOf(row).filesLeft.voice).toBe(0);
    const entry = logged.find((l) => l.message.startsWith(VOICE_BUDGET_EXHAUSTED_LOG_PREFIX));
    expect(entry?.dedupKey).toBe(VOICE_BUDGET_EXHAUSTED_LOG_PREFIX);
  });

  it("пока голосовые есть — журнал молчит", () => {
    aiDailyBudgetOf({
      id: "conv-voice-ok",
      clientId: null,
      aiBudgetDate: dushanbeDayKey(new Date()),
      aiTurnsToday: 1,
      aiVoiceToday: 3,
      aiPhotoToday: 0,
      aiVideoToday: 0,
      aiDocToday: 0,
      aiLimitNoticeAt: null,
    });
    expect(logged).toHaveLength(0);
  });
});

describe("3. Рилс, присланный клиентом, не возвращается ему ссылкой", () => {
  beforeEach(() => resetClientSharedPosts());

  it("ссылка объекта на ту же публикацию узнаётся по коду, без хвоста ?stkn", () => {
    rememberClientSharedPost("INSTAGRAM", "client-1", "DAbc123_x");
    const codes = clientSharedPostCodes("INSTAGRAM", "client-1");
    expect(isClientOwnSharedPost("https://www.instagram.com/reel/DAbc123_x/", codes)).toBe(true);
    expect(isClientOwnSharedPost("https://www.instagram.com/p/DAbc123_x?stkn=zz", codes)).toBe(true);
  });

  it("другая публикация и другой клиент — ссылка уходит как раньше", () => {
    rememberClientSharedPost("INSTAGRAM", "client-1", "DAbc123_x");
    expect(isClientOwnSharedPost("https://www.instagram.com/reel/Other999/", clientSharedPostCodes("INSTAGRAM", "client-1"))).toBe(false);
    expect(clientSharedPostCodes("INSTAGRAM", "client-2")).toEqual([]);
    expect(isClientOwnSharedPost(null, ["DAbc123_x"])).toBe(false);
  });

  it("через сутки присланное забывается", () => {
    const at = Date.now();
    rememberClientSharedPost("INSTAGRAM", "client-1", "Old1", at);
    expect(clientSharedPostCodes("INSTAGRAM", "client-1", at + CLIENT_SHARED_POST_TTL_MS + 1)).toEqual([]);
  });

  it("пустой код не запоминается", () => {
    rememberClientSharedPost("INSTAGRAM", "client-1", null);
    expect(clientSharedPostCodes("INSTAGRAM", "client-1")).toEqual([]);
  });
});
