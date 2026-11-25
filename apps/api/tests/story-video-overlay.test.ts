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
