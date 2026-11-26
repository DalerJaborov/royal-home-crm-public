import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildStoryCardOverlaySvg,
  computeStoryCardTextLayout,
  measureStoryText,
  pickStoryLanguage,
  storyPriceLines,
  SAFE_BOTTOM_PX,
  SAFE_TOP_PX,
  STORY_CARD_HEIGHT,
  STORY_CARD_WIDTH,
} from "../src/lib/video/storyCard.js";
import type { ReelsCaptionValues } from "../src/lib/reelsCaptionTemplate.js";

/**
 * Облик карточки-истории «Royal Clean» (25.11.2026): белая карточка, Onest, синий акцент.
 * База не нужна — проверяем чистые функции и собранный SVG-слой (растровое сравнение картинок
 * в проекте не гоняется, поэтому смотрим на слой и на вычисленные координаты).
 */
const values = {
  type: "Квартира", district: "Исмоили Сомони", rooms: "2", areaSqm: "66", floor: "11", totalFloors: "16",
  condition: "", price: "870 000 с.", phone: null, agentName: null, address: null, documents: null,
  windowCount: null, bathroom: null, landAreaSotka: null, marketType: null, amenities: null,
} as unknown as ReelsCaptionValues;

describe("storyPriceLines — цена карточки", () => {
  it("снижение: число в сомони, старая цена зачёркнутой, разница плашкой", () => {
    const p = storyPriceLines({ priceText: "870 000 с.", priceNowTjs: 870000, priceWasTjs: 890000 });
    expect(p).toEqual({ now: "870 000", currency: "TJS", was: "890 000 TJS", saved: "−20 000" });
  });

  it("«снижения» нет (старая цена не выше новой) — старую цену не рисуем: «цена снижена» без снижения было бы враньём", () => {
    expect(storyPriceLines({ priceText: "x", priceNowTjs: 870000, priceWasTjs: 870000 }).was).toBeNull();
    expect(storyPriceLines({ priceText: "x", priceNowTjs: 870000, priceWasTjs: 800000 }).saved).toBeNull();
  });

  it("обычная карточка: только новая цена, без старой и плашки", () => {
    expect(storyPriceLines({ priceText: "870 000 с.", priceNowTjs: 870000 })).toEqual({ now: "870 000", currency: "TJS", was: null, saved: null });
  });

  it("числа в сомони нет (доллары без курса) — откат на прежний текст цены", () => {
    const p = storyPriceLines({ priceText: "62 000 $", priceNowTjs: null, priceWasText: "70 000 $" });
    expect(p).toEqual({ now: "62 000 $", currency: null, was: "70 000 $", saved: null });
  });

  it("старая цена только текстом (прежний вызов) — рисуется, плашки разницы нет", () => {
    expect(storyPriceLines({ priceText: "x", priceNowTjs: 870000, priceWasText: "890 000 с." }).saved).toBeNull();
    expect(storyPriceLines({ priceText: "x", priceNowTjs: 870000, priceWasText: "890 000 с." }).was).toBe("890 000 с.");
  });
});

describe("слой карточки-истории", () => {
  it("«Цена снижена»: синяя пилюля, плашка разницы и Onest, а не DejaVu", () => {
    const svg = buildStoryCardOverlaySvg(values, "ОБ-000214", { priceNowTjs: 870000, priceWasTjs: 890000 });
    expect(svg).toContain("Цена снижена");
    expect(svg).toContain("−20 000");
    expect(svg).toContain("#1D5FE0");
    expect(svg).toContain('font-family="Onest"');
    expect(svg).not.toContain("DejaVu");
    expect(svg).toContain("ROYAL HOME TJ");
  });

  it("обычная карточка и «продано» не пишут «Цена снижена»", () => {
    expect(buildStoryCardOverlaySvg(values, "ОБ-000214", { priceNowTjs: 870000 })).not.toContain("Цена снижена");
    const sold = buildStoryCardOverlaySvg(values, "ОБ-000214", { priceNowTjs: 870000, priceWasTjs: 890000, soldStamp: true });
    expect(sold).not.toContain("Цена снижена");
    expect(sold).toContain("ПРОДАНО");
  });

  it("плитки только для заполненных полей: участок без комнат и этажа не печатает пустоту", () => {
    const land = { ...values, rooms: null, floor: null, totalFloors: null } as unknown as ReelsCaptionValues;
    const svg = buildStoryCardOverlaySvg(land, "ОБ-000214", { priceNowTjs: 870000 });
    expect(svg).toContain(">м²<");
    expect(svg).not.toContain(">комн.<");
    expect(svg).not.toContain(">этаж<");
  });

  it("дробная площадь с запятой, как пишут в Таджикистане", () => {
    const frac = { ...values, areaSqm: "112.5" } as unknown as ReelsCaptionValues;
    expect(buildStoryCardOverlaySvg(frac, "ОБ-000214", { priceNowTjs: 870000 })).toContain(">112,5<");
  });

  it("очень большая цена сжимает кегль, но остаётся внутри карточки", () => {
    const svg = buildStoryCardOverlaySvg(values, "ОБ-000214", { priceNowTjs: 1_345_000_000, priceWasTjs: 1_400_000_000 });
    const m = svg.match(/font-size="([\d.]+)" font-weight="600" fill="#0E1726"/);
    expect(m).not.toBeNull();
    const size = Number(m![1]);
    expect(size).toBeLessThan(124);
    const innerW = STORY_CARD_WIDTH - 48 * 2 - 48 * 2;
    expect(measureStoryText("1 345 000 000", size, "SemiBold", -size * 0.02)).toBeLessThanOrEqual(innerW);
  });

  it("длинный район режется «…», а не вылезает за карточку", () => {
    const long = { ...values, district: "Микрорайон Испечак-1 (за новым мостом через канал возле рынка Корвон)" } as unknown as ReelsCaptionValues;
    const svg = buildStoryCardOverlaySvg(long, "ОБ-000214", { priceNowTjs: 870000 });
    expect(svg).toContain("…");
  });

  it("текст из карточки экранируется (район с «&» и «<» не ломает SVG)", () => {
    const evil = { ...values, district: "Сино & <Центр>" } as unknown as ReelsCaptionValues;
    const svg = buildStoryCardOverlaySvg(evil, "ОБ-000214", { priceNowTjs: 870000 });
    expect(svg).toContain("Сино &amp; &lt;Центр&gt;");
  });
});

describe("безопасные поля новой карточки", () => {
  it("логотип ниже верхнего поля, карточка выше нижнего — со снижением, без него, с самым худшим районом", () => {
    const worst = { ...values, district: "Микрорайон Испечак-1 (за новым мостом через канал возле рынка Корвон)" } as unknown as ReelsCaptionValues;
    for (const [v, was] of [[values, 890000], [values, undefined], [worst, 14000000]] as const) {
      const layout = computeStoryCardTextLayout(v, "ОБ-000214", null, { priceNowTjs: 870000, priceWasTjs: was });
      expect(layout.topY).toBeGreaterThanOrEqual(SAFE_TOP_PX);
      expect(layout.bottomY).toBeLessThanOrEqual(STORY_CARD_HEIGHT - SAFE_BOTTOM_PX);
    }
  });

  it("карточка не вылезает за боковые края холста", () => {
    const svg = buildStoryCardOverlaySvg(values, "ОБ-000214", { priceNowTjs: 870000 });
    const card = svg.match(/<rect x="48" y="[\d.]+" width="(\d+)" height="[\d.]+" rx="48"/);
    expect(card).not.toBeNull();
    expect(48 + Number(card![1])).toBeLessThanOrEqual(STORY_CARD_WIDTH - 48);
  });
});

describe("measureStoryText", () => {
  it("цифры SemiBold шире, чем «пустая строка», и растёт с кеглем", () => {
    expect(measureStoryText("", 40)).toBe(0);
    expect(measureStoryText("870 000", 124)).toBeGreaterThan(measureStoryText("870 000", 62));
  });
  it("все таджикские буквы есть в таблице (иначе ширина считалась бы по запасному знаку)", () => {
    for (const ch of "ҒғӢӣҚқӮӯҲҳҶҷЁё№²") expect(measureStoryText(ch, 100, "Medium")).toBeGreaterThan(0);
  });
});

describe("шрифт карточки", () => {
  it("каждое начертание, которое просит карточка, лежит файлом в assets/fonts/cover", () => {
    // Как у обложек (cover-poster.test.ts): font-family на сервере резолвит СИСТЕМНЫЙ fontconfig по файлам,
    // которые Dockerfile кладёт в /usr/share/fonts. Начертание без файла — чужой шрифт на готовой картинке без ошибки.
    const FILES: Record<string, string> = { "Onest/500": "Onest-Medium.ttf", "Onest/600": "Onest-SemiBold.ttf" };
    const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../assets/fonts/cover");
    const svg = buildStoryCardOverlaySvg(values, "ОБ-000214", { priceNowTjs: 870000, priceWasTjs: 890000, soldStamp: false });
    const sold = buildStoryCardOverlaySvg(values, "ОБ-000214", { priceNowTjs: 870000, soldStamp: true });
    const asked = new Set<string>();
    for (const doc of [svg, sold]) for (const m of doc.matchAll(/font-family="([^"]+)"[^>]*? font-weight="([0-9]+)"/g)) asked.add(`${m[1]}/${m[2]}`);
    expect(asked.size).toBeGreaterThan(0);
    for (const key of asked) {
      expect(FILES[key], `карточка просит начертание «${key}», которого нет в списке файлов`).toBeDefined();
      expect(fs.existsSync(path.join(dir, FILES[key]!)), `нет файла ${FILES[key]}`).toBe(true);
    }
  });
});

describe("язык надписей: русский и таджикский по очереди (25.11.2026)", () => {
  it("чётная по счёту история — русская, нечётная — таджикская", () => {
    expect([0, 1, 2, 3, 4].map(pickStoryLanguage)).toEqual(["ru", "tg", "ru", "tg", "ru"]);
  });

  it("таджикская карточка: «Нарх паст шуд», «хонагӣ», «ошёна»; район и номер объекта не переводятся", () => {
    const svg = buildStoryCardOverlaySvg(values, "ОБ-000214", { priceNowTjs: 870000, priceWasTjs: 890000, lang: "tg" });
    expect(svg).toContain("Нарх паст шуд");
    expect(svg).toContain(">хонагӣ<");
    expect(svg).toContain(">ошёна<");
    expect(svg).not.toContain("Цена снижена");
    expect(svg).toContain("Исмоили Сомони");
    expect(svg).toContain("ОБ-000214");
  });

  it("русская карточка не получает таджикских слов, язык по умолчанию — русский", () => {
    const svg = buildStoryCardOverlaySvg(values, "ОБ-000214", { priceNowTjs: 870000, priceWasTjs: 890000 });
    expect(svg).toContain("Цена снижена");
    expect(svg).toContain(">комн.<");
    expect(svg).not.toContain("Нарх");
  });

  it("печать «продано» на таджикском: «ФУРӮХТА ШУД», и она помещается между боковыми полями", () => {
    const svg = buildStoryCardOverlaySvg(values, "ОБ-000214", { priceNowTjs: 870000, soldStamp: true, lang: "tg" });
    expect(svg).toContain("ФУРӮХТА ШУД");
    const rect = svg.match(/<rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)" rx="16"/);
    expect(rect).not.toBeNull();
    const [x, , w] = rect!.slice(1).map(Number);
    expect(x).toBeGreaterThanOrEqual(65);
    expect(x + w).toBeLessThanOrEqual(STORY_CARD_WIDTH - 65);
  });

  it("слой поверх ролика без затемнений фото: остаются карточка и логотип, градиентов нет", () => {
    const photo = buildStoryCardOverlaySvg(values, "ОБ-000214", { priceNowTjs: 870000 });
    const video = buildStoryCardOverlaySvg(values, "ОБ-000214", { priceNowTjs: 870000, forVideo: true });
    expect(photo).toContain('fill="url(#shadeTop)"');
    expect(video).not.toContain('fill="url(#shadeTop)"');
    expect(video).not.toContain('fill="url(#shadeBottom)"');
    expect(video).toContain("ROYAL HOME TJ");
    expect(video).toContain("870 000");
  });
});

describe("карточка без цены (подборка роликом, 26.11.2026)", () => {
  it("hidePrice: ни цены, ни «TJS», ни старой цены — плитки и район остаются", () => {
    const svg = buildStoryCardOverlaySvg(values, "№214", { priceNowTjs: 870000, priceWasTjs: 890000, priceWasText: "890 000 с.", hidePrice: true, forVideo: true });
    expect(svg).not.toContain("870");
    expect(svg).not.toContain("890");
    expect(svg).not.toContain("TJS");
    expect(svg).not.toContain("Цена снижена");
    expect(svg).toContain("Исмоили Сомони");
    expect(svg).toContain("№214");
  });

  it("без hidePrice цена на месте (обычная карточка не изменилась)", () => {
    const svg = buildStoryCardOverlaySvg(values, "№214", { priceNowTjs: 870000 });
    expect(svg).toContain("870");
    expect(svg).toContain("TJS");
  });
});
