import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";
import { instagramShortcode, sharedMediaHint, sharedPostContext } from "../src/messengers/sharedMedia.js";
import {
  expandShareLink,
  facebookMediaIds,
  resetShareLinkCache,
  shareShortLinks,
  unwrapRedirectLinks,
} from "../src/messengers/sharedLinks.js";
import { deleteAgentsWithTraces } from "./helpers/cleanupAgents.js";
import { waitFor } from "./helpers/waitFor.js";

/**
 * P0-2 аудита docs/audit-bots-2026-10-10-object-routing.md — пересланный пост не
 * узнавался: ссылки instagram.com/share/…, форматы Facebook, обёртки переходов,
 * креатив рекламы и повтор ролика (их нет в ленте), номер публикации Instagram у
 * карточки. Неузнанная пересылка — строка руководителю и честный ответ клиенту
 * («передал коллеге»), а не только «видео не открылось».
 */
const runId = Date.now();
const tag36 = runId.toString(36);
const CODE_AD = `AdCr${tag36}`;
const CODE_REPOST = `RpSt${tag36}`;
const CODE_SHARE = `ShRe${tag36}`;
const CODE_HEAL = `HeAl${tag36}`;
const FB_ID = `9${String(runId).slice(-10)}`;
let districtId: string;
let ownerId: string;
let directorId: string;
const propertyIds: Record<string, string> = {};
let adId: string;

async function mkProperty(key: string, extra: Record<string, unknown> = {}) {
  const p = await prisma.property.create({
    data: {
      title: `Пересланный пост ${key} ${runId}`,
      type: "APARTMENT",
      areaSqm: 48,
      rooms: 1,
      price: 210_000,
      currency: "TJS",
      districtId,
      address: "Тестовая, 2",
      condition: "GOOD",
      status: "AVAILABLE",
      intakeAgentId: ownerId,
      ...extra,
    },
  });
  propertyIds[key] = p.id;
  return p;
}

beforeAll(async () => {
  districtId = (await prisma.district.create({ data: { name: `Район-пересылка-${runId}` } })).id;
  ownerId = (await prisma.agent.create({ data: { fullName: "Хозяин (пересылка)", role: "AGENT", phone: `+99291${String(runId).slice(-7)}`, passwordHash: "x" } })).id;
  directorId = (await prisma.agent.create({ data: { fullName: "Директор (пересылка)", role: "DIRECTOR", phone: `+99292${String(runId).slice(-7)}`, passwordHash: "x" } })).id;
  await mkProperty("ad");
  await mkProperty("repost");
  await mkProperty("share", { instagramUrl: `https://www.instagram.com/reel/${CODE_SHARE}/` });
  await mkProperty("heal", { instagramUrl: `https://www.instagram.com/reel/${CODE_HEAL}/` });
  await mkProperty("fb", { publishedPostIds: { FACEBOOK: FB_ID } });
  adId = (await prisma.ad.create({ data: { externalId: `ad-${runId}`, name: `Реклама ${runId}`, postShortcode: CODE_AD, propertyId: propertyIds.ad } })).id;
  await prisma.propertySocialRepost.create({
    data: {
      propertyId: propertyIds.repost!,
      round: 1,
      hook: "тест",
      channel: "INSTAGRAM",
      status: "PUBLISHED",
      permalink: `https://www.instagram.com/reel/${CODE_REPOST}/`,
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  const ids = Object.values(propertyIds);
  await prisma.notification.deleteMany({ where: { tag: { startsWith: `unknown-share-INSTAGRAM-osp-${runId}` } } });
  await prisma.propertySocialRepost.deleteMany({ where: { propertyId: { in: ids } } });
  await prisma.ad.deleteMany({ where: { id: adId } });
  await prisma.property.deleteMany({ where: { id: { in: ids } } });
  await deleteAgentsWithTraces([ownerId, directorId]);
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.$disconnect();
});

describe("разбор ссылок на публикации (sharedLinks.ts)", () => {
  it("instagram.com/share/reel/<токен> — не код поста", () => {
    expect(instagramShortcode("https://www.instagram.com/share/reel/BAxyzToken1/")).toBeNull();
    expect(instagramShortcode("https://www.instagram.com/royal.home.tj/reel/ABC123/")).toBe("ABC123");
  });

  it("обёртка перехода Facebook разворачивается в настоящий адрес", () => {
    const wrapped = `смотри https://l.facebook.com/l.php?u=${encodeURIComponent("https://www.instagram.com/reel/XyZ987/")}&h=AT0`;
    expect(instagramShortcode(unwrapRedirectLinks(wrapped))).toBe("XyZ987");
  });

  it("ссылки «поделиться» находятся, и без https тоже", () => {
    expect(shareShortLinks("вот instagram.com/share/reel/Tok1 и https://fb.watch/abcD12/ и https://www.facebook.com/share/r/1AbC/")).toEqual([
      "https://instagram.com/share/reel/Tok1",
      "https://fb.watch/abcD12/",
      "https://www.facebook.com/share/r/1AbC/",
    ]);
  });

  it("номера публикаций Facebook из всех форматов", () => {
    expect(facebookMediaIds("https://www.facebook.com/reel/1234567890")).toEqual(["1234567890"]);
    expect(facebookMediaIds("https://www.facebook.com/permalink.php?story_fbid=5555566666&id=100")).toEqual(["5555566666"]);
    expect(facebookMediaIds("https://www.facebook.com/watch/?v=7777788888")).toEqual(["7777788888"]);
    expect(facebookMediaIds("https://www.facebook.com/royalhome/videos/3333344444/")).toEqual(["3333344444"]);
  });

  it("переадресация «поделиться» проходится, код берётся и из next= страницы входа", async () => {
    resetShareLinkCache();
    const fake = vi.fn(async (url: string) =>
      url.includes("/share/")
        ? { status: 302, headers: { get: () => `https://www.instagram.com/accounts/login/?next=%2Freel%2FNxT55%2F` } }
        : { status: 200, headers: { get: () => null } }
    );
    const urls = await expandShareLink("https://www.instagram.com/share/reel/TokNext/", fake);
    expect(urls.some((u) => instagramShortcode(u) === "NxT55")).toBe(true);
  });
});

describe("пересланный пост узнаётся там, где раньше — нет", () => {
  it("креатив нашей рекламы (Ad.postShortcode) — объект объявления", async () => {
    const ctx = await sharedPostContext({ text: "", attachmentType: "ig_reel", attachmentUrl: `https://www.instagram.com/reel/${CODE_AD}/` });
    expect(ctx.propertyId).toBe(propertyIds.ad);
  });

  it("повтор ролика (PropertySocialRepost) — его объект", async () => {
    const ctx = await sharedPostContext({ text: "", attachmentType: "ig_reel", attachmentUrl: `https://www.instagram.com/reel/${CODE_REPOST}/` });
    expect(ctx.propertyId).toBe(propertyIds.repost);
  });

  it("ссылка Facebook permalink.php?story_fbid= — объект по номеру публикации", async () => {
    const ctx = await sharedPostContext({
      text: "",
      attachmentType: "share",
      attachmentUrl: `https://www.facebook.com/permalink.php?story_fbid=${FB_ID}&id=1`,
    });
    expect(ctx.propertyId).toBe(propertyIds.fb);
  });

  it("instagram.com/share/… — объект по адресу, куда ведёт ссылка", async () => {
    resetShareLinkCache();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        String(url).includes("/share/")
          ? { status: 301, headers: { get: () => `https://www.instagram.com/reel/${CODE_SHARE}/` } }
          : { status: 200, headers: { get: () => null } }
      )
    );
    const ctx = await sharedPostContext({ text: "", attachmentType: "share", attachmentUrl: `https://www.instagram.com/share/reel/Tk${tag36}/` });
    expect(ctx.propertyId).toBe(propertyIds.share);
  });

  it("номер публикации из НАШЕЙ ленты дописывается в карточку, если его не было, и не перезаписывается", async () => {
    await sharedPostContext({
      text: "",
      attachmentType: "ig_reel",
      attachmentUrl: `https://www.instagram.com/reel/${CODE_HEAL}/`,
      ownPermalink: `https://www.instagram.com/reel/${CODE_HEAL}/`,
      ownMediaId: "17900000000000001",
    });
    let p = await prisma.property.findUniqueOrThrow({ where: { id: propertyIds.heal! } });
    expect((p.publishedPostIds as Record<string, string>).INSTAGRAM).toBe("17900000000000001");
    await sharedPostContext({
      text: "",
      attachmentType: "ig_reel",
      attachmentUrl: `https://www.instagram.com/reel/${CODE_HEAL}/`,
      ownPermalink: `https://www.instagram.com/reel/${CODE_HEAL}/`,
      ownMediaId: "17900000000000002",
    });
    p = await prisma.property.findUniqueOrThrow({ where: { id: propertyIds.heal! } });
    expect((p.publishedPostIds as Record<string, string>).INSTAGRAM).toBe("17900000000000001");
  });
});

describe("неузнанная пересылка — дело руководителю и честный ответ", () => {
  it("руководитель получает «обращение по неизвестной публикации», бот говорит, что передал коллеге", async () => {
    const recipientId = `osp-${runId}-1`;
    const hint = await sharedMediaHint({
      text: "это свободна?",
      attachmentType: "ig_reel",
      attachmentUrl: `https://www.instagram.com/reel/NoSuch${tag36}/`,
      channel: "INSTAGRAM",
      recipientId,
    });
    expect(hint).toContain("передал коллеге");
    await waitFor(() =>
      prisma.notification.findFirst({ where: { agentId: directorId, tag: `unknown-share-INSTAGRAM-${recipientId}` } })
    );
  });

  it("без переписки строке некуда вести — бот коллегу не обещает", async () => {
    const hint = await sharedMediaHint({ text: "", attachmentType: "ig_reel", attachmentUrl: `https://www.instagram.com/reel/NoConv${tag36}/` });
    expect(hint).not.toContain("коллеге");
    expect(hint).toContain("Ни в коем случае не молчи");
  });
});
