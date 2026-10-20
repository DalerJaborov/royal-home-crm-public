import { describe, expect, it, vi } from "vitest";

/**
 * НОМЕР, КОТОРЫЙ ЧЕЛОВЕК УЖЕ ДАЛ, ВТОРОЙ РАЗ НЕ ПРОСИМ (владелец 22.09.2026).
 *
 * ЖИВОЙ СЛУЧАЙ. Продавец дачи (WhatsApp) прислал «550001025 номьм Шахбоз
 * Бобозода» в 07:02, заявка оформилась. В 08:44 он ответил на ту же рекламную
 * подводку («Привет! Можно узнать об этом подробнее?») — и снова услышал
 * «Рақаматонро нависед, агенти мо занг зада, ҳамаашро мувофиқа мекунад?».
 *
 * ПОЧЕМУ ЭТО СЛУЧИЛОСЬ. Стадия `awaiting_phone` вычисляется заново каждый ход, а
 * телефона в состоянии диалога, которое читает модель, нет вовсе: в LeadDraft
 * такого поля не существует. То есть сказать модели «не переспрашивай» было
 * НЕЧЕМ — она физически не знала, что номер уже наш. Запрет внутри блока показов
 * при этом был написан (`showingPromptBlock`, аргумент leadAccepted), но вызывался
 * блок БЕЗ аргумента — мёртвый код, который не мог сработать ни при каких
 * настройках.
 *
 * Здесь проверяется и то, и другое: строка запрета в промте по phoneKnown и живой
 * аргумент у блока показов.
 */

const { callAi } = vi.hoisted(() => ({
  callAi: vi.fn(async () => ({ reply: "Хуб", ready: false, confident: true, intent: "sell" })),
}));
vi.mock("../src/ai/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/client.js")>()),
  callAiText: callAi,
}));

const { runQualifyTurn, showingPromptBlock } = await import("../src/ai/leadQualifier.js");

const ABILITIES = {
  photos: false,
  photosPerOffer: 3,
  showings: false,
  showingConfirmations: false,
  followUps: true,
  comments: true,
  callback: false,
  askOwner: false,
  vacancies: true,
  links: true,
  cautious: false,
  promptEconomy: false,
  voiceReplies: false,
};

/** Системный промт последнего хода — по нему и видно, что бот прочитал. */
async function systemPromptFor(phoneKnown: boolean): Promise<string> {
  callAi.mockClear();
  await runQualifyTurn(
    [
      { role: "user", content: "дачаи фуруши дорм" },
      { role: "assistant", content: "Маълумотро диҳед" },
      { role: "user", content: "Привет! Можно узнать об этом подробнее?" },
    ],
    { stage: "awaiting_phone", intent: "sell" },
    { abilities: ABILITIES, phoneKnown }
  );
  const call = callAi.mock.calls[0]?.[0] as unknown as { system?: string } | undefined;
  return call?.system ?? "";
}

describe("телефон уже наш — просить его снова запрещено", () => {
  it("с phoneKnown в промте стоит прямой запрет", async () => {
    const system = await systemPromptFor(true);
    expect(system).toMatch(/У НАС УЖЕ ЕСТЬ/);
    expect(system).toMatch(/просить номер снова/i);
  });

  it("без phoneKnown промт прежний — ни одной новой строки", async () => {
    const system = await systemPromptFor(false);
    expect(system).not.toMatch(/У НАС УЖЕ ЕСТЬ/);
  });

  it("блок показов больше не требует номер у того, чей телефон уже наш", () => {
    const accepted = showingPromptBlock(new Date(), true);
    expect(accepted).toMatch(/ТЕЛЕФОН У НАС УЖЕ ЕСТЬ/);
    expect(accepted).not.toMatch(/тут же попроси номер/);
    // А обычный разговор ведёт к номеру как прежде.
    expect(showingPromptBlock(new Date(), false)).toMatch(/тут же попроси номер/);
  });
});
