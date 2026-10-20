/**
 * ИИ свободных роликов: подписи и обложка (lib/socialVideoAi.ts). Без сети и без базы:
 * модель и OpenAI подменены. Проверяется то, за что отвечает код, а не модель, — сборка
 * подписи, защита от выдуманных фактов, предел длины сети, отказы с русским текстом.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SocialVideoAiCaptionRequest } from "@royal-home/shared";

// База не нужна: без `settings` в подделке общий сброс настроек из tests/setup.ts пропускает файл,
// а `$disconnect` нужен его afterAll.
vi.mock("../src/db.js", () => ({ prisma: { $disconnect: async () => undefined } }));
vi.mock("../src/ai/geminiClient.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/geminiClient.js")>()),
  callGemini: vi.fn(),
}));
vi.mock("../src/ai/openaiClient.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/openaiClient.js")>()),
  openAiPost: vi.fn(),
  resolveOpenAiKey: vi.fn(),
  logOpenAiCall: vi.fn(async () => undefined),
}));
vi.mock("../src/lib/video/coverOpenAi.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/video/coverOpenAi.js")>()),
  loadCoverRuntimeSettings: vi.fn(),
}));
vi.mock("../src/lib/systemError.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/systemError.js")>()),
  logSystemError: vi.fn(async () => undefined),
}));

import { callGemini } from "../src/ai/geminiClient.js";
import { OpenAiError, openAiPost, resolveOpenAiKey } from "../src/ai/openaiClient.js";
import { loadCoverRuntimeSettings } from "../src/lib/video/coverOpenAi.js";
import { CONTACT_NUMBERS } from "../src/lib/reelsCaptionTemplate.js";
import {
  SocialVideoAiError,
  buildSocialVideoCoverPrompt,
  effectiveCaptionLimit,
  fitCaptionToLimit,
  generateSocialVideoCaptions,
  generateSocialVideoCoverImage,
} from "../src/lib/socialVideoAi.js";

const gemini = vi.mocked(callGemini);

function request(patch: Partial<SocialVideoAiCaptionRequest> = {}): SocialVideoAiCaptionRequest {
  return {
    brief: "Рассказываем, как проходит покупка квартиры в Душанбе с Royal Home, шаг за шагом",
    tone: "SELLING",
    language: "RU",
    channels: [],
    avoid: [],
    ...patch,
  };
}

function variant(hook: string, extra: Record<string, unknown> = {}) {
  return {
    hook,
    body: ["Покажем весь путь от выбора до ключей", "Проверяем документы и владельца"],
    cta: "📲 Пишите в директ, подберём вариант",
    hashtags: ["#недвижимость", "#квартира", "#Душанбе", "#покупка", "#новостройка", "#RoyalHome"],
    ...extra,
  };
}

function threeVariants() {
  return {
    variants: [
      variant("🏠 Покупка квартиры без страха"),
      variant("🔑 Ключи в руках за один месяц"),
      variant("✨ Как мы проверяем каждый объект"),
    ],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("generateSocialVideoCaptions", () => {
  it("возвращает три разных готовых варианта с контактами и хештегами", async () => {
    gemini.mockResolvedValue(threeVariants());
    const out = await generateSocialVideoCaptions(request());
    expect(out).toHaveLength(3);
    expect(new Set(out).size).toBe(3);
    for (const caption of out) {
      expect(caption).toContain(CONTACT_NUMBERS);
      expect(caption).toMatch(/#RoyalHome/);
      expect(caption).toMatch(/#Душанбе/);
      expect((caption.match(/#/g) ?? []).length).toBeLessThanOrEqual(8);
      expect(caption).not.toMatch(/[—–]/);
    }
  });

  it("пустой ответ модели, null и мусор дают SocialVideoAiError по-русски", async () => {
    for (const answer of [null, { variants: [] }, { variants: ["мусор", 5, { hook: "" }] }, "строка"]) {
      gemini.mockResolvedValueOnce(answer);
      const error = await generateSocialVideoCaptions(request()).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(SocialVideoAiError);
      expect((error as Error).message).toMatch(/[А-Яа-я]/);
    }
  });

  it("сбой самого вызова модели не вылетает наружу сырым", async () => {
    gemini.mockRejectedValue(new Error("socket hang up"));
    const error = await generateSocialVideoCaptions(request()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SocialVideoAiError);
    expect((error as Error).message).not.toContain("socket");
  });

  it("запрос к модели содержит brief, тон, язык, сети и прежние подписи", async () => {
    gemini.mockResolvedValue(threeVariants());
    await generateSocialVideoCaptions(
      request({
        brief: "Новый офис агентства на Сомони, день открытых дверей",
        title: "День открытых дверей",
        tone: "PREMIUM",
        language: "TG",
        channels: ["THREADS", "TELEGRAM"],
        avoid: ["Старая подпись про ипотеку и скидки"],
      })
    );
    const params = gemini.mock.calls[0]![0];
    expect(params.user).toContain("Новый офис агентства на Сомони");
    expect(params.user).toContain("День открытых дверей");
    expect(params.user).toContain("Премиум");
    expect(params.user).toContain("таджикский");
    expect(params.user).toContain("THREADS");
    expect(params.user).toContain("500");
    expect(params.user).toContain("Старая подпись про ипотеку и скидки");
    expect(params.system).toMatch(/не придумывай/i);
  });

  it("не пропускает выдуманные телефоны, ссылки и цены, а данные из brief оставляет", async () => {
    gemini.mockResolvedValue({
      variants: [
        variant("🏠 Квартира от 650 000 сомони", {
          body: [
            "Звоните +992 900 11 22 33",
            "Смотрите на www.fake-agency.tj",
            "Цена всего 1 200 000 сомони",
            "Проверяем документы и владельца",
          ],
          cta: "Пишите @fake_agent_tj",
        }),
        variant("Звоните 987654321 прямо сейчас"),
      ],
    });
    const out = await generateSocialVideoCaptions(
      request({ brief: "Акция: квартира от 650 000 сомони, показываем в эти выходные" })
    );
    expect(out).toHaveLength(1);
    const text = out[0]!;
    expect(text).toContain("650 000");
    expect(text).toContain("Проверяем документы и владельца");
    for (const forbidden of ["900 11 22 33", "fake-agency", "1 200 000", "fake_agent", "987654321"]) {
      expect(text).not.toContain(forbidden);
    }
    // Единственный номер в подписи — номер агентства из общей константы.
    expect(text).toContain(CONTACT_NUMBERS);
  });

  it("с выбранным Threads каждый вариант не длиннее 500 символов и сохраняет первую строку", async () => {
    const long = "Очень длинная строка про покупку квартиры в Душанбе без лишних слов и воды, ".repeat(3).trim();
    gemini.mockResolvedValue({
      variants: [1, 2, 3].map((n) =>
        variant(`🏠 Заход номер ${n} про покупку`, { body: [long, long, long, long], cta: long })
      ),
    });
    const out = await generateSocialVideoCaptions(request({ channels: ["INSTAGRAM", "THREADS"] }));
    expect(out).toHaveLength(3);
    out.forEach((caption, i) => {
      expect(caption.length).toBeLessThanOrEqual(500);
      expect(caption.split("\n")[0]).toBe(`🏠 Заход номер ${i + 1} про покупку`);
    });
  });

  it("первая строка не длиннее 100 символов (заголовок YouTube)", async () => {
    gemini.mockResolvedValue({
      variants: [variant("🏠 " + "Очень длинный заголовок про покупку квартиры в Душанбе ".repeat(5))],
    });
    const [caption] = await generateSocialVideoCaptions(request({ channels: ["YOUTUBE"] }));
    expect(caption!.split("\n")[0]!.length).toBeLessThanOrEqual(100);
  });

  it("не повторяет заход, который уже показывали, и дубли внутри ответа", async () => {
    gemini.mockResolvedValue({
      variants: [
        variant("🏠 Покупка квартиры без страха"),
        variant("Покупка квартиры без страха!"),
        variant("🔑 Совсем другой заход"),
      ],
    });
    const out = await generateSocialVideoCaptions(
      request({ avoid: ["🏠 Покупка квартиры без страха\n\nстарый текст"] })
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.split("\n")[0]).toBe("🔑 Совсем другой заход");
  });

  it("если все варианты забракованы, говорит об этом понятно", async () => {
    gemini.mockResolvedValue({ variants: [variant("Звоните 987654321")] });
    await expect(generateSocialVideoCaptions(request())).rejects.toThrow(/не прошли проверку/);
  });

  it("русский + тоҷикӣ: два блока, а вариант без таджикской половины отбрасывается", async () => {
    gemini.mockResolvedValue({
      variants: [
        variant("🏠 Покупка квартиры", {
          hookTg: "🏠 Харидани хона",
          bodyTg: ["Тамоми роҳро нишон медиҳем"],
          ctaTg: "Дар директ нависед",
        }),
        variant("🔑 Только русский"),
      ],
    });
    const out = await generateSocialVideoCaptions(request({ language: "RU_TG" }));
    expect(out).toHaveLength(1);
    const text = out[0]!;
    expect(text.indexOf("Покупка квартиры")).toBeLessThan(text.indexOf("Харидани хона"));
    expect(text).toContain("Дар директ нависед");
    expect(gemini.mock.calls[0]![0].schema).toMatchObject({
      properties: { variants: { items: { required: expect.arrayContaining(["hookTg"]) } } },
    });
  });
});

describe("effectiveCaptionLimit / fitCaptionToLimit", () => {
  it("берёт самый короткий предел выбранных сетей, иначе 1000", () => {
    expect(effectiveCaptionLimit([])).toBe(1000);
    expect(effectiveCaptionLimit(["YOUTUBE", "TIKTOK"])).toBe(1000);
    expect(effectiveCaptionLimit(["INSTAGRAM", "TELEGRAM"])).toBe(1000);
    expect(effectiveCaptionLimit(["TELEGRAM", "THREADS"])).toBe(500);
  });

  it("укорачивает целыми строками с конца и не трогает первую", () => {
    const caption = ["Первая строка", "", "вторая строка текста", "третья строка текста", "#хвост"].join("\n");
    expect(fitCaptionToLimit(caption, 40)).toBe("Первая строка\n\nвторая строка текста");
    expect(fitCaptionToLimit(caption, 1000)).toBe(caption);
  });

  it("первую строку режет по слову, только если не помещается даже она", () => {
    const out = fitCaptionToLimit("Длинный крючок который не помещается целиком\nвторая", 20);
    expect(out.length).toBeLessThanOrEqual(20);
    expect(out).not.toContain("\n");
  });
});

// Путь OpenAI: рисовальщик по умолчанию теперь Gemini (см. social-video-ai-covers.test.ts), поэтому здесь он выбран явно.
describe("generateSocialVideoCoverImage (OpenAI)", () => {
  const settings = { openaiImageModel: "gpt-image-2.5-sunburst", openaiImageQuality: "medium" } as Awaited<
    ReturnType<typeof loadCoverRuntimeSettings>
  >;
  const post = vi.mocked(openAiPost);

  beforeEach(() => {
    vi.mocked(resolveOpenAiKey).mockResolvedValue({ key: "sk-test", source: "env" });
    vi.mocked(loadCoverRuntimeSettings).mockResolvedValue(settings);
  });

  it("возвращает картинку и просит вертикаль без текста на ней", async () => {
    post.mockResolvedValue({ data: [{ b64_json: Buffer.from("PNGDATA").toString("base64") }] });
    const result = await generateSocialVideoCoverImage({ title: "Новый офис", brief: "День открытых дверей", prompt: "светлый холл", provider: "OPENAI" });
    expect(result.mimeType).toBe("image/png");
    expect(result.buffer.toString()).toBe("PNGDATA");
    const [endpoint, options] = post.mock.calls[0]!;
    expect(endpoint).toBe("/images/generations");
    const body = options.body as Record<string, unknown>;
    expect(body.size).toBe("1152x2048");
    expect(String(body.prompt)).toContain("Новый офис");
    expect(String(body.prompt)).toContain("светлый холл");
    expect(String(body.prompt)).toMatch(/БЕЗ ТЕКСТА/);
  });

  it("нет денег на счёте OpenAI: понятный отказ", async () => {
    post.mockRejectedValue(new OpenAiError("На счёте OpenAI закончились деньги", 429, "insufficient_quota"));
    await expect(generateSocialVideoCoverImage({ title: "Ролик", brief: null, provider: "OPENAI" })).rejects.toThrow(
      "На счёте OpenAI закончились деньги — пополните баланс или загрузите обложку сами"
    );
  });

  it("другие отказы и пустой ответ тоже SocialVideoAiError", async () => {
    post.mockRejectedValueOnce(new OpenAiError("OpenAI не ответил за 120 с", null, "timeout"));
    await expect(generateSocialVideoCoverImage({ title: "Ролик", brief: null, provider: "OPENAI" })).rejects.toBeInstanceOf(SocialVideoAiError);
    post.mockResolvedValueOnce({ data: [] });
    await expect(generateSocialVideoCoverImage({ title: "Ролик", brief: null, provider: "OPENAI" })).rejects.toBeInstanceOf(SocialVideoAiError);
  });

  it("без ключа OpenAI не ходит в сеть", async () => {
    vi.mocked(resolveOpenAiKey).mockResolvedValue(null);
    await expect(generateSocialVideoCoverImage({ title: "Ролик", brief: null, provider: "OPENAI" })).rejects.toThrow(/Ключ OpenAI/);
    expect(post).not.toHaveBeenCalled();
  });

  it("промт без темы не ломается", () => {
    expect(buildSocialVideoCoverPrompt({ title: "", brief: null })).toMatch(/Душанбе/);
  });
});
