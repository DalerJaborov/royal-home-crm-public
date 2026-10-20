import { describe, expect, it } from "vitest";
import {
  SOCIAL_VIDEO_LIMITS,
  destinationKeyOf,
  type SocialVideoAccountOption,
  type SocialVideoChannel,
  type SocialVideoChannelInfo,
  type SocialVideoChannelResult,
  type SocialVideoDestination,
} from "@royal-home/shared";
import {
  accountLabelOf,
  channelsOfDestinations,
  coverMetaText,
  destinationBlockReasons,
  destinationLabel,
  destinationsFromChannels,
  destinationsInState,
  destinationsOfItem,
  effectiveProvider,
  isAccountSelected,
  isAddressTaken,
  isInterruptedResult,
  orderDestinations,
  resultOfDestination,
  sameDestinations,
  selectableAccounts,
  toggleAccount,
  toggleChannel,
} from "../../lib/socialVideoDestinations";

/**
 * Адреса «канал + аккаунт» (12.10.2026, владелец: «у нас два Instagram»): сборка адресов из выбора,
 * подписи, ключи результатов и повтор.
 */

const acc = (id: string | null, label: string, over: Partial<SocialVideoAccountOption> = {}): SocialVideoAccountOption => ({
  id,
  label,
  username: null,
  isDefault: false,
  ready: true,
  problem: null,
  ...over,
});

function info(channel: SocialVideoChannel, accounts: SocialVideoAccountOption[], over: Partial<SocialVideoChannelInfo> = {}): SocialVideoChannelInfo {
  return { channel, label: channel, connected: true, ready: true, problem: null, limits: SOCIAL_VIDEO_LIMITS[channel], accounts, ...over };
}

const INFOS: SocialVideoChannelInfo[] = [
  info("INSTAGRAM", [acc("ig-main", "Royal Home Info", { isDefault: true, username: "royalhome.info" }), acc("ig-second", "Royal Home Dubai")]),
  info("TELEGRAM", [acc("tg-1", "Канал Royal Home", { isDefault: true }), acc("tg-2", "Чат агентов", { ready: false, problem: "Бот не админ" })]),
  info("YOUTUBE", [acc(null, "Royal Home TV", { isDefault: true })]),
];

const IG_MAIN: SocialVideoDestination = { channel: "INSTAGRAM", accountId: "ig-main" };
const IG_SECOND: SocialVideoDestination = { channel: "INSTAGRAM", accountId: "ig-second" };
const IG_DEFAULT: SocialVideoDestination = { channel: "INSTAGRAM", accountId: null };

describe("ключи и порядок адресов", () => {
  it("адрес без аккаунта даёт ключ канала, с аккаунтом — ключ с суффиксом", () => {
    expect(destinationKeyOf(IG_DEFAULT)).toBe("INSTAGRAM");
    expect(destinationKeyOf(IG_SECOND)).toBe("INSTAGRAM:ig-second");
  });

  it("каналы выводятся из адресов без повторов и в порядке приложения", () => {
    expect(channelsOfDestinations([{ channel: "TELEGRAM", accountId: "tg-1" }, IG_MAIN, IG_SECOND])).toEqual(["INSTAGRAM", "TELEGRAM"]);
  });

  it("старый ролик: каналы без адресов превращаются в адреса по умолчанию", () => {
    expect(destinationsFromChannels(["INSTAGRAM", "YOUTUBE"])).toEqual([
      { channel: "INSTAGRAM", accountId: null },
      { channel: "YOUTUBE", accountId: null },
    ]);
    expect(destinationsOfItem({ channels: ["INSTAGRAM"], destinations: [] })).toEqual([IG_DEFAULT]);
    expect(destinationsOfItem({ channels: ["INSTAGRAM"], destinations: [IG_SECOND] })).toEqual([IG_SECOND]);
  });

  it("порядок: сначала каналы, внутри канала — как аккаунты в справочнике", () => {
    const ordered = orderDestinations([{ channel: "TELEGRAM", accountId: "tg-1" }, IG_SECOND, IG_MAIN], INFOS);
    expect(ordered.map(destinationKeyOf)).toEqual(["INSTAGRAM:ig-main", "INSTAGRAM:ig-second", "TELEGRAM:tg-1"]);
  });

  it("сравнение наборов не зависит от порядка", () => {
    expect(sameDestinations([IG_MAIN, IG_SECOND], [IG_SECOND, IG_MAIN])).toBe(true);
    expect(sameDestinations([IG_MAIN], [IG_DEFAULT])).toBe(false);
    expect(sameDestinations([IG_MAIN], [IG_MAIN, IG_SECOND])).toBe(false);
  });
});

describe("выбор канала и аккаунтов", () => {
  it("выбор аккаунта только с несколькими аккаунтами: у одного аккаунта списка нет", () => {
    expect(selectableAccounts(INFOS[0]).length).toBe(2);
    expect(selectableAccounts(INFOS[2])).toEqual([]);
    expect(selectableAccounts(undefined)).toEqual([]);
  });

  it("галочка на канале берёт аккаунт по умолчанию (accountId: null), повторная снимает все адреса канала", () => {
    const on = toggleChannel([], "INSTAGRAM", INFOS);
    expect(on).toEqual([IG_DEFAULT]);
    expect(toggleChannel([IG_MAIN, IG_SECOND, { channel: "TELEGRAM", accountId: "tg-1" }], "INSTAGRAM", INFOS)).toEqual([
      { channel: "TELEGRAM", accountId: "tg-1" },
    ]);
  });

  it("адрес по умолчанию отмечает аккаунт, помеченный isDefault", () => {
    const [main, second] = INFOS[0].accounts;
    expect(isAccountSelected([IG_DEFAULT], "INSTAGRAM", main)).toBe(true);
    expect(isAccountSelected([IG_DEFAULT], "INSTAGRAM", second)).toBe(false);
    expect(isAccountSelected([IG_SECOND], "INSTAGRAM", second)).toBe(true);
  });

  it("второй Instagram добавляется рядом, а адрес по умолчанию заменяется явным без дубля", () => {
    const [main, second] = INFOS[0].accounts;
    const withBoth = toggleAccount([IG_DEFAULT], "INSTAGRAM", second, INFOS);
    expect(withBoth.map(destinationKeyOf)).toEqual(["INSTAGRAM", "INSTAGRAM:ig-second"]);
    // галочка на основном при адресе «по умолчанию» снимает именно его
    expect(toggleAccount(withBoth, "INSTAGRAM", main, INFOS).map(destinationKeyOf)).toEqual(["INSTAGRAM:ig-second"]);
    // явный основной не дублирует адрес по умолчанию
    const explicit = toggleAccount([], "INSTAGRAM", main, INFOS);
    expect(explicit.map(destinationKeyOf)).toEqual(["INSTAGRAM:ig-main"]);
    expect(toggleAccount(explicit, "INSTAGRAM", main, INFOS)).toEqual([]);
  });
});

describe("подписи адресов", () => {
  it("«Канал · аккаунт» по справочнику", () => {
    expect(destinationLabel(IG_MAIN, INFOS)).toBe("Instagram · Royal Home Info");
    expect(destinationLabel({ channel: "TELEGRAM", accountId: "tg-1" }, INFOS)).toBe("Telegram · Канал Royal Home");
  });

  it("адрес по умолчанию подписан аккаунтом по умолчанию; канал без справочника — просто названием", () => {
    expect(destinationLabel(IG_DEFAULT, INFOS)).toBe("Instagram · Royal Home Info");
    expect(destinationLabel({ channel: "FACEBOOK", accountId: null }, INFOS)).toBe("Facebook");
  });

  it("аккаунт, которого уже нет, показывается коротким id", () => {
    expect(accountLabelOf({ channel: "INSTAGRAM", accountId: "abcdef123456" }, INFOS)).toBe("аккаунт abcdef…");
  });
});

describe("результаты по адресам", () => {
  const result = (state: SocialVideoChannelResult["state"], error: string | null = null): SocialVideoChannelResult => ({
    state,
    error,
    note: null,
    postId: null,
    url: null,
    retriable: false,
    attempts: 1,
    startedAt: null,
    finishedAt: null,
  });

  it("результат ищется по ключу адреса; у старых роликов ключ без суффикса", () => {
    const results = { INSTAGRAM: result("PUBLISHED"), "INSTAGRAM:ig-second": result("FAILED", "нет прав") };
    expect(resultOfDestination(results, IG_DEFAULT)?.state).toBe("PUBLISHED");
    expect(resultOfDestination(results, IG_SECOND)?.state).toBe("FAILED");
    expect(resultOfDestination(results, IG_MAIN)).toBeUndefined();
  });

  it("повторять можно упавшие и пропущенные, вышедшие нет", () => {
    const item = {
      channels: ["INSTAGRAM", "TELEGRAM", "YOUTUBE"] as SocialVideoChannel[],
      destinations: [IG_DEFAULT, { channel: "TELEGRAM", accountId: "tg-1" }, { channel: "YOUTUBE", accountId: null }] as SocialVideoDestination[],
      results: { INSTAGRAM: result("PUBLISHED"), "TELEGRAM:tg-1": result("SKIPPED"), YOUTUBE: result("FAILED", "x") },
    };
    expect(destinationsInState(item, ["FAILED", "SKIPPED"]).map(destinationKeyOf)).toEqual(["TELEGRAM:tg-1", "YOUTUBE"]);
  });

  it("прерванная перезапуском публикация требует подтверждения", () => {
    expect(isInterruptedResult(result("FAILED", "Публикация оборвалась: сервер перезапустился"))).toBe(true);
    expect(isInterruptedResult(result("FAILED", "Токен истёк"))).toBe(false);
    expect(isInterruptedResult(undefined)).toBe(false);
  });
});

describe("добавление адресов к вышедшему ролику", () => {
  it("занятые адреса и аккаунт по умолчанию, уже стоящий в ролике, не выбираются снова", () => {
    const [main, second] = INFOS[0].accounts;
    const taken = new Set(["INSTAGRAM", "TELEGRAM:tg-1"]);
    expect(isAddressTaken(taken, "INSTAGRAM", main)).toBe(true); // main = по умолчанию = адрес «INSTAGRAM»
    expect(isAddressTaken(taken, "INSTAGRAM", second)).toBe(false);
    expect(isAddressTaken(taken, "TELEGRAM", INFOS[1].accounts[0])).toBe(true);
    expect(isAddressTaken(taken, "TELEGRAM", INFOS[1].accounts[1])).toBe(false);
  });
});

describe("что мешает отправить", () => {
  it("недоступный аккаунт и блокеры канала называются адресом словами", () => {
    const reasons = destinationBlockReasons(
      [{ channel: "TELEGRAM", accountId: "tg-2" }, IG_MAIN],
      INFOS,
      [{ channel: "INSTAGRAM", level: "BLOCK", format: "Reels", blockers: ["Длиннее 15 минут"], warnings: [] } as never]
    );
    expect(reasons).toEqual(["Telegram · Чат агентов: Бот не админ", "Instagram · Royal Home Info: Длиннее 15 минут"]);
  });

  it("канал без подключения объясняется причиной", () => {
    const infos = [info("TIKTOK", [], { ready: false, problem: "Нет токена" })];
    expect(destinationBlockReasons([{ channel: "TIKTOK", accountId: null }], infos, [])).toEqual(["TikTok: Нет токена"]);
  });
});

describe("обложка ИИ", () => {
  const providers = (gemini: boolean, openai: boolean) => ({
    defaultProvider: "GEMINI" as const,
    providers: [
      { provider: "GEMINI" as const, label: "Gemini (Google)", available: gemini, problem: gemini ? null : "Нет ключа" },
      { provider: "OPENAI" as const, label: "ChatGPT (OpenAI)", available: openai, problem: openai ? null : "Нет ключа" },
    ],
  });

  it("по умолчанию Gemini; недоступный выбор заменяется доступным", () => {
    expect(effectiveProvider(providers(true, true), null)).toBe("GEMINI");
    expect(effectiveProvider(providers(true, true), "OPENAI")).toBe("OPENAI");
    expect(effectiveProvider(providers(false, true), null)).toBe("OPENAI");
    expect(effectiveProvider(providers(true, false), "OPENAI")).toBe("GEMINI");
    expect(effectiveProvider(undefined, null)).toBe("GEMINI");
  });

  it("подпись под обложкой перечисляет только то, что было применено", () => {
    expect(coverMetaText({ provider: "GEMINI", usedFrame: true, usedTrends: true })).toBe("Нарисовано: Gemini · по кадру ролика · с трендами");
    expect(coverMetaText({ provider: "OPENAI", usedFrame: false, usedTrends: false })).toBe("Нарисовано: ChatGPT");
  });
});
