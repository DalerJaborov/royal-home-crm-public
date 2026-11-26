import { describe, expect, it } from "vitest";
import { buildOverlayCardArgs, STORY_OVERLAY_SEC } from "../src/lib/ffmpeg.js";
import { isStoryAspect } from "../src/lib/instagramStories.js";
import { storyJobDecision } from "../src/jobs/propertyStatusStory.js";

/**
 * История-ролик «цена снижена» / «продано» (25.11.2026): карточка поверх готового ролика первые секунды.
 * База и ffmpeg не нужны — проверяем аргументы ffmpeg, решение «подходит ли ролик» и решение задания «ждать озвучку».
 */
describe("buildOverlayCardArgs — карточка поверх ролика", () => {
  const args = buildOverlayCardArgs("in.mp4", "card.png", "out.mp4");
  const joined = args.join(" ");

  it("карточка гаснет до конца показа и не держится дольше STORY_OVERLAY_SEC", () => {
    expect(joined).toContain(`-t ${STORY_OVERLAY_SEC.toFixed(2)} -i card.png`);
    expect(joined).toContain("fade=t=in:st=0.2");
    expect(joined).toContain(`fade=t=out:st=${(STORY_OVERLAY_SEC - 0.5).toFixed(2)}`);
    expect(joined).toContain("eof_action=pass");
  });

  it("ролик режется до 60 секунд (предел Instagram) и звук ролика сохраняется", () => {
    expect(args.slice(0, 5)).toEqual(["-y", "-t", "60.00", "-i", "in.mp4"]);
    expect(joined).toContain("-map 0:a?");
    expect(joined).toContain("-c:a aac");
  });

  it("результат — yuv420p h264 с faststart: Instagram такое принимает", () => {
    expect(joined).toContain("-c:v libx264");
    expect(joined).toContain("-pix_fmt yuv420p");
    expect(joined).toContain("-movflags +faststart");
    expect(args[args.length - 1]).toBe("out.mp4");
  });

  it("свои секунды показа и предел длины передаются в аргументы", () => {
    const custom = buildOverlayCardArgs("a.mp4", "b.png", "c.mp4", { showSec: 3, maxDurationSec: 30 }).join(" ");
    expect(custom).toContain("-t 30.00 -i a.mp4");
    expect(custom).toContain("-t 3.00 -i b.png");
    expect(custom).toContain("fade=t=out:st=2.50");
  });
});

describe("isStoryAspect — на какой ролик можно класть карточку", () => {
  it("вертикальный 9:16 подходит, горизонтальный и квадрат — нет", () => {
    expect(isStoryAspect(1080, 1920)).toBe(true);
    expect(isStoryAspect(720, 1280)).toBe(true);
    expect(isStoryAspect(1920, 1080)).toBe(false);
    expect(isStoryAspect(1080, 1080)).toBe(false);
    expect(isStoryAspect(1080, 0)).toBe(false);
  });
});

describe("storyJobDecision — ждать озвучку или публиковать", () => {
  const base = { kind: "PRICE_DROP" as const, maxAttempts: 6 };
  it("цена снижена: пока озвучка накладывается — ждём", () => {
    expect(storyJobDecision({ ...base, remixPending: true, attempt: 1 })).toBe("WAIT");
    expect(storyJobDecision({ ...base, remixPending: true, attempt: 5 })).toBe("WAIT");
  });
  it("идёт публикация нового ролика — тоже ждём, чтобы история вышла после него", () => {
    expect(storyJobDecision({ ...base, remixPending: false, publishRunning: true, attempt: 2 })).toBe("WAIT");
    expect(storyJobDecision({ ...base, remixPending: false, publishRunning: true, attempt: 6 })).toBe("PUBLISH");
  });
  it("озвучка накладывалась слишком долго — на последней попытке публикуем всё равно", () => {
    expect(storyJobDecision({ ...base, remixPending: true, attempt: 6 })).toBe("PUBLISH");
  });
  it("озвучки нет — публикуем сразу", () => {
    expect(storyJobDecision({ ...base, remixPending: false, attempt: 1 })).toBe("PUBLISH");
  });
  it("продано озвучку не ждёт никогда", () => {
    expect(storyJobDecision({ kind: "SOLD", remixPending: true, attempt: 1, maxAttempts: 3 })).toBe("PUBLISH");
  });
});

describe("clipHasPriceInFrame — цена набрана в кадр старого ролика (ревью #445)", () => {
  it("строка «Цена:» в фактах прошлой передачи — да; задание после 25.11 без цены — нет", async () => {
    const { clipHasPriceInFrame, priceLineInFrame } = await import("../src/lib/clipPriceInFrame.js");
    expect(clipHasPriceInFrame({ videoHandoffLastFactsText: "Объект №1\nЭтаж: 3\nЦена: 890 000 с." })).toBe(true);
    expect(clipHasPriceInFrame({ videoHandoffLastFactsText: "Объект №1\nЭтаж: 3\nПлощадь: 50 м²" })).toBe(false);
    // Фактов нет — передача до 20.09.2026, цена в кадре тогда была.
    expect(clipHasPriceInFrame({ videoHandoffLastFactsText: null })).toBe(true);
    // «Цена» не в начале строки (адрес, агент) — не признак.
    expect(clipHasPriceInFrame({ videoHandoffLastFactsText: "Объект №1\nАдрес: Цена: шутка" })).toBe(false);
    expect(priceLineInFrame("Объект №1\nЦена: 890 000 с.\nЭтаж: 3")).toBe("Цена: 890 000 с.");
    expect(priceLineInFrame("Объект №1\nЭтаж: 3")).toBeNull();
  });
});

describe("visibleChangeLines — цена в кадре делает её правку «правкой кадра»", () => {
  it("новый ролик: цена не поле кадра; старый с ценой в кадре — поле кадра и видна монтажу", async () => {
    const { visibleChangeLines } = await import("../src/lib/propertyEditNotify.js");
    const changes = [{ field: "price", label: "Цена", was: "890000", becomes: "870000" }] as never;
    const fresh = visibleChangeLines(changes, { before: "TJS", after: "TJS" }, { withPrice: false });
    expect(fresh).toEqual({ lines: [], frameChanged: false });
    const old = visibleChangeLines(changes, { before: "TJS", after: "TJS" }, { withPrice: false, priceInFrame: true });
    expect(old.frameChanged).toBe(true);
    expect(old.lines).toEqual(["Цена: 890000 TJS → 870000 TJS"]);
  });
});

describe("storyJobDecision — озвучка новее звучащей в ролике", () => {
  it("ждём, пока она не ляжет в ролик; на последней попытке публикуем (выйдет фото)", () => {
    expect(storyJobDecision({ kind: "PRICE_DROP", remixPending: false, narrationNewerPending: true, attempt: 1, maxAttempts: 6 })).toBe("WAIT");
    expect(storyJobDecision({ kind: "PRICE_DROP", remixPending: false, narrationNewerPending: true, attempt: 6, maxAttempts: 6 })).toBe("PUBLISH");
    expect(storyJobDecision({ kind: "SOLD", remixPending: false, narrationNewerPending: true, attempt: 1, maxAttempts: 6 })).toBe("PUBLISH");
  });
});
