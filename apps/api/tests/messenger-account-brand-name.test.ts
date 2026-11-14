import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";

/**
 * Имя компании у аккаунта (08.11.2026): второй бренд на тех же фактах, бот
 * называет компанию «Арван» и никогда «Royal Home» в диалогах этого аккаунта.
 *
 * Что держит тест:
 *  (а) собранный промт хода аккаунта с именем содержит имя и не содержит
 *      «Royal Home»; у аккаунта без имени он побайтово тот же, что без аккаунта;
 *  (б) страховка на выходе заменяет утёкшее имя и пишет ошибку в журнал;
 *  (в) поле сохраняется, читается и не теряется при правке других полей;
 *  чистая подмена не трогает сайт royalhome.tj и ники.
 *
 * Новый сторож проверен внесением поломки: если убрать подмену в
 * ai/leadQualifier.ts (brandize(systemStable…)) или шаг в finalizeBotReply,
 * соответствующие тесты краснеют (см. запись журнала).
 */

const { callAi, logError } = vi.hoisted(() => ({ callAi: vi.fn(), logError: vi.fn() }));
vi.mock("../src/ai/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/client.js")>()),
  callAiText: callAi,
}));
vi.mock("../src/lib/systemError.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/systemError.js")>()),
  logSystemError: logError,
}));

const { runQualifyTurn } = await import("../src/ai/leadQualifier.js");
const { brandize, guardBrandLeak, mentionsDefaultBrand } = await import("../src/ai/brandName.js");
const { finalizeBotReply } = await import("../src/messengers/replyChain.js");
const { listAccounts, saveAccount, accountBrandName, resetAccountsCache } = await import("../src/messengers/accounts.js");

const run = randomUUID().slice(0, 8);
const EXT_BRANDED = `brand-test-${run}-a`;
const EXT_PLAIN = `brand-test-${run}-b`;
let brandedId = "";
let plainId = "";

// vacancies: false — живой каталог вакансий читается из базы и меняется между прогонами.
const caps = {
  showings: true, askOwner: true, vacancies: false, promptEconomy: true,
  canSendPhotos: true, canSendGuide: true, topicLock: false, callback: false, links: true, cautious: false,
};
const answer = { reply: ["Здравствуйте!"], ready: false, confident: false };

/** Весь системный промт хода (стабильная + изменяемая часть), как он уходит модели. */
async function promptFor(accountId: string | null): Promise<string> {
  callAi.mockReset();
  callAi.mockResolvedValue(answer);
  await runQualifyTurn([{ role: "user", content: "Здравствуйте, ищу квартиру" }], {}, { abilities: caps, accountId });
  expect(callAi).toHaveBeenCalledTimes(1);
  const arg = callAi.mock.calls[0]![0] as { systemStable: string; system: string };
  return arg.systemStable + "\n=====\n" + arg.system;
}

beforeAll(async () => {
  brandedId = await saveAccount({
    channel: "INSTAGRAM", externalId: EXT_BRANDED, title: `Arvan test ${run}`, token: "t-branded", brandName: "Арван",
  });
  plainId = await saveAccount({
    channel: "INSTAGRAM", externalId: EXT_PLAIN, title: `Plain test ${run}`, token: "t-plain",
  });
});

beforeEach(() => {
  logError.mockClear();
});

afterAll(async () => {
  await prisma.messengerAccount.deleteMany({ where: { id: { in: [brandedId, plainId].filter(Boolean) } } });
  resetAccountsCache();
});

describe("(в) поле brandName: сохранение и чтение", () => {
  it("сохраняется, читается и отдаётся в списке; у аккаунта без имени пусто", async () => {
    expect(await accountBrandName(brandedId)).toBe("Арван");
    expect(await accountBrandName(plainId)).toBeNull();
    expect(await accountBrandName(null)).toBeNull();
    const view = (await listAccounts()).find((a) => a.id === brandedId);
    expect(view?.brandName).toBe("Арван");
    expect((await listAccounts()).find((a) => a.id === plainId)?.brandName).toBeNull();
  });

  it("правка другого поля имя не трогает; пустая строка возвращает «Royal Home»", async () => {
    await saveAccount({ id: brandedId, channel: "INSTAGRAM", externalId: EXT_BRANDED, title: `Arvan test ${run}`, enabled: true });
    expect(await accountBrandName(brandedId)).toBe("Арван");

    await saveAccount({ id: brandedId, channel: "INSTAGRAM", externalId: EXT_BRANDED, title: `Arvan test ${run}`, brandName: "  Арван  " });
    expect(await accountBrandName(brandedId)).toBe("Арван");

    await saveAccount({ id: brandedId, channel: "INSTAGRAM", externalId: EXT_BRANDED, title: `Arvan test ${run}`, brandName: "" });
    expect(await accountBrandName(brandedId)).toBeNull();

    await saveAccount({ id: brandedId, channel: "INSTAGRAM", externalId: EXT_BRANDED, title: `Arvan test ${run}`, brandName: "Арван" });
    expect(await accountBrandName(brandedId)).toBe("Арван");
  });
});

describe("чистая подмена имени", () => {
  it("заменяет «Royal Home», «Royal Home Info» и регистр; «$» в имени не ломает результат", () => {
    expect(brandize("Я консультант Royal Home. Пишите в Royal Home Info или ROYAL HOME.", "Арван")).toBe(
      "Я консультант Арван. Пишите в Арван или Арван."
    );
    expect(brandize("Royal Home", "A$&B")).toBe("A$&B");
  });

  it("не трогает сайт, ники и ссылки", () => {
    const keep = "Сайт royalhome.tj, ник @royal.home.tj, github.com/royal-home-crm, https://royalhome.tj/x, royalhome.info";
    expect(brandize(keep, "Арван")).toBe(keep);
    expect(mentionsDefaultBrand(keep)).toBe(false);
  });

  it("без имени — текст побайтово тот же", () => {
    const t = "Консультант Royal Home в Душанбе, royalhome.tj";
    expect(brandize(t, null)).toBe(t);
    expect(brandize(t, undefined)).toBe(t);
    expect(brandize(t, "   ")).toBe(t);
  });
});

describe("(а) собранный промт хода", () => {
  it("аккаунт с именем: в промте «Арван», «Royal Home» нет, сайт остаётся", async () => {
    const prompt = await promptFor(brandedId);
    expect(prompt).toContain("Арван");
    expect(prompt).not.toMatch(/Royal[  ]+Home/i);
    expect(prompt).toContain("royalhome.tj");
  });

  it("аккаунт без имени и ход без аккаунта: промт побайтово один и тот же, «Royal Home» на месте", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-08T07:00:00Z") });
    try {
      const withoutAccount = await promptFor(null);
      const plainAccount = await promptFor(plainId);
      expect(plainAccount).toBe(withoutAccount);
      expect(withoutAccount).toMatch(/Royal Home/);
      expect(withoutAccount).not.toContain("Арван");
    } finally {
      vi.useRealTimers();
    }
  });

  it("аккаунт с именем отличается от обычного только именем", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-08T07:00:00Z") });
    try {
      const plain = await promptFor(plainId);
      const branded = await promptFor(brandedId);
      expect(branded).toBe(brandize(plain, "Арван"));
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("(б) страховка на выходе", () => {
  it("guardBrandLeak заменяет утёкшее имя и пишет ошибку с dedupKey", () => {
    const out = guardBrandLeak(["Здравствуйте! Это Royal Home.", "Чем помочь?"], "Арван", {
      where: "тест", conversationId: "conv-1",
    });
    expect(out).toEqual(["Здравствуйте! Это Арван.", "Чем помочь?"]);
    expect(logError).toHaveBeenCalledTimes(1);
    expect(logError.mock.calls[0]![2]).toMatchObject({ dedupKey: "brand-name-leak", dedupScope: "conv-1" });
  });

  it("чистый ответ и аккаунт без имени: ничего не меняется и в журнал не пишется", () => {
    expect(guardBrandLeak(["Привет, это Арван."], "Арван", { where: "тест" })).toEqual(["Привет, это Арван."]);
    expect(guardBrandLeak(["Это Royal Home."], null, { where: "тест" })).toEqual(["Это Royal Home."]);
    expect(logError).not.toHaveBeenCalled();
  });

  const base = {
    conversationId: "conv-brand",
    channelLabel: "INSTAGRAM",
    openUrl: "/messages?open=conv-brand",
    botSpokeBefore: false,
    botSaidBefore: [] as string[],
    clientSaidTrusted: "Здравствуйте, ищу квартиру",
    clientTurnText: "Здравствуйте, ищу квартиру",
    previousBotText: "",
    language: "ru" as const,
    draft: { intent: "buy" as const, stage: "chatting" as const },
    jobConversation: false,
    phoneAsksSent: 0,
    phoneKnown: false,
    fallbackLanguageWords: ["Здравствуйте, ищу квартиру"],
  };

  it("общий ряд ответа бота: у аккаунта с именем «Royal Home» заменяется до отправки", async () => {
    const out = await finalizeBotReply({
      ...base,
      reply: ["Мы в Royal Home подберём вариант. В каком районе ищете?"],
      accountId: brandedId,
    });
    expect(out.bubbles.join(" ")).toContain("Арван");
    expect(out.bubbles.join(" ")).not.toMatch(/Royal Home/);
    expect(logError.mock.calls.some((c) => (c[2] as { dedupKey?: string } | undefined)?.dedupKey === "brand-name-leak")).toBe(true);
  });

  it("аккаунт без имени и ход без аккаунта: ответ остаётся как есть", async () => {
    for (const accountId of [plainId, undefined]) {
      logError.mockClear();
      const out = await finalizeBotReply({
        ...base,
        reply: ["Мы в Royal Home подберём вариант. В каком районе ищете?"],
        accountId,
      });
      expect(out.bubbles.join(" ")).toContain("Royal Home");
      expect(logError.mock.calls.some((c) => (c[2] as { dedupKey?: string } | undefined)?.dedupKey === "brand-name-leak")).toBe(false);
    }
  });
});
