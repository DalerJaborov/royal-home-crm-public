import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import {
  BUILTIN_COVER_TEMPLATE,
  CHATGPT_COVER_TEMPLATE,
  CHATGPT_COVER_TEMPLATE_ID,
  GREEN_COVER_TEMPLATE,
  applyTemplateValues,
  isCoverTemplateEnabled,
  listCoverTemplates,
  pickCoverTemplate,
  sanitizeTemplateSvg,
  type CoverTemplateRecord,
} from "../src/lib/video/coverRegistry.js";
import { BUILTIN_COVER_TEMPLATE_ID, DEFAULT_COVER_TEMPLATE_ID, COVER_SQUARE, COVER_STORY, coverFormatsFromSpec, coverTemplateSpecSchema } from "@royal-home/shared";
import { renderCoverPosterImage, buildCoverPosterValues, buildTemplateSvgLayer } from "../src/lib/video/coverPoster.js";
import { coverSafeZone } from "../src/lib/video/coverTemplate.js";

/**
 * Реестр шаблонов обложки (владелец, 23.09.2026): что шаблон считается
 * пригодным только после проверки spec.json, что SVG чистится до записи, и что
 * выбор «Один и тот же»/«Случайный» ведёт себя предсказуемо — включая случай,
 * когда отмеченных шаблонов не осталось (обложка нужнее выбора).
 */
const runId = Date.now().toString(36);
const createdIds: string[] = [];

const demoSpec = {
  version: "1.0",
  canvas: { width: 1080, height: 1920 },
  colors: { gold: "#F2B94B" },
};

beforeAll(async () => {
  const row = await prisma.coverTemplate.create({
    data: {
      name: `Тест-шаблон-${runId}`,
      svgUrl: `/uploads/cover-templates/test-${runId}.svg`,
      spec: demoSpec,
    },
  });
  createdIds.push(row.id);
});

afterAll(async () => {
  await prisma.coverTemplate.deleteMany({ where: { id: { in: createdIds } } });
});

describe("spec.json шаблона — граница", () => {
  it("принимает файл владельца целиком, лишние ключи не мешают", () => {
    const parsed = coverTemplateSpecSchema.safeParse({
      canvas: { square: [1080, 1080], reels: [1080, 1920] },
      colors: { gold: "#F2B94B", dark: "#07130F" },
      important_limitations: ["реконструкция, не исходник"],
      elements: { square: { logo: { x: 493, y: 45 } } },
    });
    expect(parsed.success).toBe(true);
  });

  it("не принимает цвет не цветом — иначе он уедет прямо в SVG", () => {
    const parsed = coverTemplateSpecSchema.safeParse({ colors: { gold: "url(https://чужой.сайт/x)" } });
    expect(parsed.success).toBe(false);
  });

  it("форматы считаются по холстам, без холста — оба", () => {
    expect(coverFormatsFromSpec({ canvas: { width: 1080, height: 1920 } })).toEqual(["story"]);
    expect(coverFormatsFromSpec({ canvas: { width: 1080, height: 1080 } })).toEqual(["square"]);
    expect(coverFormatsFromSpec({ canvas: { square: [1080, 1080], reels: [1080, 1920] } }).sort()).toEqual(["square", "story"]);
    expect(coverFormatsFromSpec({}).sort()).toEqual(["square", "story"]);
  });
});

describe("очистка загруженного SVG", () => {
  it("вырезает скрипты и обработчики событий", () => {
    const clean = sanitizeTemplateSvg(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>fetch("/x")</script><rect onclick="alert(1)" width="10" height="10"/></svg>'
    );
    expect(clean.ok).toBe(true);
    if (!clean.ok) return;
    expect(clean.svg).not.toMatch(/<script/i);
    expect(clean.svg).not.toMatch(/onclick/i);
  });

  it("отказывает шаблону с внешней ссылкой — рендер на сервере не должен ходить наружу", () => {
    const clean = sanitizeTemplateSvg('<svg xmlns="http://www.w3.org/2000/svg"><image href="https://чужой.сайт/a.png"/></svg>');
    expect(clean.ok).toBe(false);
  });

  it("не принимает файл, который вовсе не SVG", () => {
    expect(sanitizeTemplateSvg("{\"это\":\"json\"}").ok).toBe(false);
  });
});

describe("подстановка значений в свой шаблон", () => {
  it("подставляет значения объекта и экранирует их", () => {
    const svg = applyTemplateValues("<text>{{rooms}} {{roomsWord}} — {{price}} / {{district}}</text>", {
      rooms: "2",
      roomsWord: "ХОНАГА",
      price: "890 000 TJS",
      priceNumber: "890 000",
      currency: "TJS",
      area: "90 м²",
      areaNumber: "90",
      floor: "15 ошёна",
      city: "Душанбе",
      district: "Сино & Ко",
      landmark: "",
    });
    expect(svg).toContain("2 ХОНАГА — 890 000 TJS / Сино &amp; Ко");
  });

  it("пустое поле даёт пустую строку, а не «undefined» на обложке", () => {
    const svg = applyTemplateValues("<text>{{landmark}}{{неизвестное}}</text>", {
      rooms: "",
      roomsWord: "",
      price: "",
      priceNumber: "",
      currency: "TJS",
      area: "",
      areaNumber: "",
      floor: "",
      city: "",
      district: "",
      landmark: "",
    });
    expect(svg).toBe("<text></text>");
    expect(svg).not.toMatch(/undefined/);
  });
});

describe("реестр и выбор шаблона на публикацию", () => {
  const custom: CoverTemplateRecord = {
    id: "custom-1",
    name: "Свой",
    builtin: false,
    formats: ["story"],
    svgUrl: "/uploads/cover-templates/x.svg",
  };
  const templates = [BUILTIN_COVER_TEMPLATE, custom];

  it("встроенный шаблон всегда в списке и не удаляется по признаку builtin", async () => {
    const all = await listCoverTemplates();
    // Порядок (28.09.2026): «Royal Green» первым, «Royal Gold» вторым.
    expect(all[0].id).toBe(DEFAULT_COVER_TEMPLATE_ID);
    expect(all[0].builtin).toBe(true);
    expect(all[1].id).toBe(BUILTIN_COVER_TEMPLATE_ID);
    expect(all.some((t) => createdIds.includes(t.id))).toBe(true);
  });

  it("FIXED: берётся выбранный, а нет такого — встроенный", () => {
    expect(
      pickCoverTemplate(templates, { coverTemplateMode: "FIXED", coverTemplateId: "custom-1", coverTemplateEnabledIds: [] }).id
    ).toBe("custom-1");
    expect(
      pickCoverTemplate(templates, { coverTemplateMode: "FIXED", coverTemplateId: "его-удалили", coverTemplateEnabledIds: [] }).id
    ).toBe(BUILTIN_COVER_TEMPLATE_ID);
  });

  it("RANDOM: выбирает только из отмеченных", () => {
    const settings = { coverTemplateMode: "RANDOM", coverTemplateId: null, coverTemplateEnabledIds: ["custom-1"] };
    expect(pickCoverTemplate(templates, settings, () => 0).id).toBe("custom-1");
    expect(pickCoverTemplate(templates, settings, () => 0.99).id).toBe("custom-1");
  });

  it("RANDOM без отмеченных — встроенный, а не отказ от обложки", () => {
    const settings = { coverTemplateMode: "RANDOM", coverTemplateId: null, coverTemplateEnabledIds: ["его-удалили"] };
    expect(pickCoverTemplate(templates, settings, () => 0.5).id).toBe(BUILTIN_COVER_TEMPLATE_ID);
  });

  it("пустой список отметок означает «только шаблон по умолчанию», а не «все»", () => {
    const settings = { coverTemplateMode: "RANDOM", coverTemplateId: null, coverTemplateEnabledIds: [] };
    expect(isCoverTemplateEnabled(DEFAULT_COVER_TEMPLATE_ID, settings)).toBe(true);
    expect(isCoverTemplateEnabled(BUILTIN_COVER_TEMPLATE_ID, settings)).toBe(false);
    expect(isCoverTemplateEnabled("custom-1", settings)).toBe(false);
    expect(pickCoverTemplate(templates, settings, () => 0.5).id).toBe(BUILTIN_COVER_TEMPLATE_ID);
  });
});


describe("отрисовка форматов и откат на встроенный шаблон", () => {
  const values = buildCoverPosterValues(
    { rooms: 2, areaSqm: 90, floor: 15, price: 890000, currency: "TJS", districtName: "Сино", address: "Парк Победы" },
    { usdToTjs: 10.9 }
  );

  /** Ровная подложка вместо фото: проверяем размеры, а не картинку. */
  async function backdrop(width: number, height: number): Promise<Buffer> {
    const sharp = (await import("sharp")).default;
    return sharp({ create: { width, height, channels: 3, background: { r: 30, g: 40, b: 35 } } }).jpeg().toBuffer();
  }

  it("вертикаль — 1080x1920 (Reels, TikTok, Shorts, Telegram), квадрат — 1080x1080 (лента и сайт)", async () => {
    const sharp = (await import("sharp")).default;
    const story = await renderCoverPosterImage(await backdrop(1080, 1920), values, "story", null, true);
    const square = await renderCoverPosterImage(await backdrop(1080, 1080), values, "square", null, true);
    const storyMeta = await sharp(story).metadata();
    const squareMeta = await sharp(square).metadata();
    expect([storyMeta.width, storyMeta.height]).toEqual([COVER_STORY.width, COVER_STORY.height]);
    expect([squareMeta.width, squareMeta.height]).toEqual([COVER_SQUARE.width, COVER_SQUARE.height]);
  });

  it("свой шаблон без файла на диске не роняет публикацию — рисуем встроенным", async () => {
    const sharp = (await import("sharp")).default;
    const broken: CoverTemplateRecord = {
      id: "broken",
      name: "Потерянный файл",
      builtin: false,
      formats: ["story"],
      svgUrl: "/uploads/cover-templates/нет-такого-файла.svg",
    };
    const image = await renderCoverPosterImage(await backdrop(1080, 1920), values, "story", null, true, broken);
    const meta = await sharp(image).metadata();
    expect([meta.width, meta.height]).toEqual([COVER_STORY.width, COVER_STORY.height]);
  });
});

describe("очистка SVG — обходы (аудит 24.09)", () => {
  const svg = (inner: string): string => `<svg xmlns="http://www.w3.org/2000/svg">${inner}</svg>`;

  it("DOCTYPE/ENTITY не принимаются — XXE и «миллиард смешков»", () => {
    expect(sanitizeTemplateSvg(`<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]>${svg("<text>&x;</text>")}`).ok).toBe(false);
  });

  it("ссылка, закодированная сущностью, не проходит мимо проверки", () => {
    expect(sanitizeTemplateSvg(svg('<image href="&#104;ttps://evil.example/a.png"/>')).ok).toBe(false);
    expect(sanitizeTemplateSvg(svg('<image xlink:href="  HTTP://evil.example/a.png"/>')).ok).toBe(false);
    expect(sanitizeTemplateSvg(svg('<a href="javascript:alert(1)"><text>x</text></a>')).ok).toBe(false);
    expect(sanitizeTemplateSvg(svg('<image href="file:///etc/passwd"/>')).ok).toBe(false);
  });

  it("путь к локальному файлу вырезается — librsvg иначе читает его с диска сервера", () => {
    const clean = sanitizeTemplateSvg(svg('<image href="../../.env" width="10" height="10"/><image href="leaves.png"/>'));
    expect(clean.ok).toBe(true);
    if (clean.ok) expect(clean.svg).not.toMatch(/\.env|leaves\.png/);
  });

  it("внешний url() в стиле и обработчик без кавычек не проходят", () => {
    expect(sanitizeTemplateSvg(svg('<style>@import url(https://evil.example/x.css);</style>')).ok).toBe(false);
    expect(sanitizeTemplateSvg(svg('<rect style="fill:url(http://evil.example/p)"/>')).ok).toBe(false);
    const clean = sanitizeTemplateSvg(svg("<rect onload=alert(1) width=\"1\"/>"));
    expect(clean.ok && clean.svg).not.toMatch(/onload/i);
    expect(sanitizeTemplateSvg(svg("<script>alert(1)")).ok).toBe(false);
  });

  it("внутренние ссылки и градиенты остаются", () => {
    const clean = sanitizeTemplateSvg(svg('<defs><linearGradient id="g"/></defs><rect fill="url(#g)"/><use href="#g"/>'));
    expect(clean.ok).toBe(true);
  });
});

describe("подстановка: условные блоки, регистр, кавычки, подгонка кегля", () => {
  const base = {
    rooms: "2",
    roomsWord: "ХОНАГА",
    price: "890 000 TJS",
    priceNumber: "890 000",
    currency: "TJS",
    area: "90 м²",
    areaNumber: "90",
    floor: "",
    city: "Душанбе",
    district: "Сино",
    landmark: 'Парк "Победы"',
  };

  it("нет поля — блок data-if вырезается целиком, вместе с подписью", () => {
    const svg = applyTemplateValues('<g data-if="floor"><rect/><text>{{floor}}</text><text>ЭТАЖ</text></g><text data-if="district">{{district|upper}}</text>', base);
    expect(svg).not.toMatch(/ЭТАЖ|<rect/);
    expect(svg).toContain("<text>СИНО</text>");
  });

  it("кавычка в значении не ломает атрибут", () => {
    const svg = applyTemplateValues('<text aria-label="{{landmark}}">{{areaSqm}}</text>', base);
    expect(svg).toBe('<text aria-label="Парк &quot;Победы&quot;">90</text>');
  });

  it("data-fit уменьшает кегль длинной строки, короткую не трогает", () => {
    const short = applyTemplateValues('<text font-size="20" font-weight="800" data-fit="400">{{city}}</text>', base);
    expect(short).toContain('font-size="20"');
    const long = applyTemplateValues('<text font-size="20" font-weight="800" data-fit="100">{{city}} {{city}} {{city}}</text>', base);
    const size = Number(/font-size="([\d.]+)"/.exec(long)?.[1]);
    expect(size).toBeLessThan(20);
    expect(long).not.toMatch(/data-fit/);
  });
});

describe("встроенный «Royal Gold · ChatGPT» (пакет ChatGPT, 24.09)", () => {
  const cases: { name: string; p: Parameters<typeof buildCoverPosterValues>[0] }[] = [
    { name: "обычная квартира", p: { rooms: 2, areaSqm: 90, floor: 15, price: 890_000, currency: "TJS", districtName: "Сино", address: "Парк Победы" } },
    { name: "минимум: без этажа/района/ориентира", p: { rooms: 2, areaSqm: 90, floor: null, price: 890_000, currency: "TJS", districtName: null, address: null } },
    { name: "участок без комнат", p: { rooms: null, areaSqm: 12000, floor: null, price: 4_500_000, currency: "TJS", districtName: "Рудаки", address: null } },
    { name: "доллары", p: { rooms: 5, areaSqm: 320, floor: 2, price: 1_500_000, currency: "USD", districtName: "Сино", address: "Парк Победы" } },
    {
      name: "всё длинное разом",
      p: {
        rooms: 6,
        areaSqm: 12345.5,
        floor: 24,
        price: 128_500_000,
        currency: "TJS",
        districtName: "Исмоили Сомонӣ (бывший Фрунзенский)",
        address: "Напротив рынка Корвон, за новым мостом <&> через канал, дом 14",
      },
    },
  ];

  it("в списке третьим, встроенный, умеет оба формата", async () => {
    const all = await listCoverTemplates();
    expect(all[2].id).toBe(CHATGPT_COVER_TEMPLATE_ID);
    expect(all[2].builtin).toBe(true);
    expect(all[2].formats.sort()).toEqual(["square", "story"]);
  });

  it("при двух встроенных запасным остаётся «Royal Gold», а не первый встречный builtin", () => {
    const settings = { coverTemplateMode: "FIXED", coverTemplateId: "его-удалили", coverTemplateEnabledIds: [] };
    expect(pickCoverTemplate([CHATGPT_COVER_TEMPLATE, BUILTIN_COVER_TEMPLATE], settings).id).toBe(BUILTIN_COVER_TEMPLATE_ID);
  });

  it("весь нарисованный текст и плашки — внутри безопасной зоны (по пикселям), в обоих форматах и на краевых данных", async () => {
    const sharp = (await import("sharp")).default;
    for (const { name, p } of cases) {
      const values = buildCoverPosterValues(p, { usdToTjs: 10.9 });
      for (const format of ["square", "story"] as const) {
        const { width, height } = format === "square" ? COVER_SQUARE : COVER_STORY;
        const svg = await buildTemplateSvgLayer(CHATGPT_COVER_TEMPLATE, format, values, false);
        expect(svg).not.toMatch(/\{\{|undefined|null/);
        // Фон (затемнение на весь кадр) — не надпись; мягкую тень плашки отсекает порог альфы.
        const ink = svg.replace(/<g data-bg="1">[\s\S]*?<\/g>/, "");
        const { data, info } = await sharp(Buffer.from(ink)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        let x0 = width, y0 = height, x1 = 0, y1 = 0;
        for (let y = 0; y < info.height; y++) {
          for (let x = 0; x < info.width; x++) {
            if (data[(y * info.width + x) * 4 + 3] > 96) {
              if (x < x0) x0 = x;
              if (x > x1) x1 = x;
              if (y < y0) y0 = y;
              if (y > y1) y1 = y;
            }
          }
        }
        // Пустой слой «внутри» любой зоны — страж обязан видеть, что нарисовано хоть что-то.
        expect(x1 - x0).toBeGreaterThan(width / 3);
        const z = coverSafeZone(width, height);
        const inside = x0 >= z.x - 1 && y0 >= z.y - 1 && x1 <= z.x + z.width + 1 && y1 <= z.y + z.height + 1;
        expect(`${name} / ${format}: ${inside ? "внутри" : `${x0},${y0}–${x1},${y1} вне ${JSON.stringify(z)}`}`).toBe(`${name} / ${format}: внутри`);
        // Место настоящего логотипа из Настроек — тоже внутри зоны.
        const box = CHATGPT_COVER_TEMPLATE.logoBoxes?.[format];
        expect(box && box.left >= z.x && box.top >= z.y && box.left + box.size <= z.x + z.width && box.top + box.size <= z.y + z.height).toBe(true);
      }
    }
  });

  it("минимальные данные: нет строк «ЭТАЖ», «РАЙОН:», «ОРИЕНТИР:»", async () => {
    const values = buildCoverPosterValues(cases[1].p, { usdToTjs: 10.9 });
    for (const format of ["square", "story"] as const) {
      const svg = await buildTemplateSvgLayer(CHATGPT_COVER_TEMPLATE, format, values, false);
      expect(svg).not.toMatch(/ЭТАЖ|РАЙОН:|ОРИЕНТИР:/);
      expect(svg).toContain("890 000");
    }
  });

  it("есть логотип в Настройках — векторный знак шаблона не рисуется поверх него", async () => {
    const values = buildCoverPosterValues(cases[0].p, { usdToTjs: 10.9 });
    expect(await buildTemplateSvgLayer(CHATGPT_COVER_TEMPLATE, "square", values, false)).toContain("HOME TJ");
    expect(await buildTemplateSvgLayer(CHATGPT_COVER_TEMPLATE, "square", values, true)).not.toContain("HOME TJ");
  });

  it("рисует JPEG нужного размера в обоих форматах", async () => {
    const sharp = (await import("sharp")).default;
    const values = buildCoverPosterValues(cases[0].p, { usdToTjs: 10.9 });
    for (const format of ["square", "story"] as const) {
      const { width, height } = format === "square" ? COVER_SQUARE : COVER_STORY;
      const bg = await sharp({ create: { width, height, channels: 3, background: { r: 30, g: 40, b: 35 } } }).jpeg().toBuffer();
      const meta = await sharp(await renderCoverPosterImage(bg, values, format, null, true, CHATGPT_COVER_TEMPLATE)).metadata();
      expect([meta.width, meta.height]).toEqual([width, height]);
    }
  });
});

describe("свой шаблон: путь к файлу и формат (аудит 24.09)", () => {
  it("SVG своего шаблона читается из uploads/cover-templates — куда его пишет загрузка", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const { uploadsDir } = await import("../src/upload.js");
    const dir = path.join(uploadsDir, "cover-templates");
    await fs.mkdir(dir, { recursive: true });
    const file = `test-path-${runId}.svg`;
    await fs.writeFile(path.join(dir, file), '<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1080"><text>{{city}}</text></svg>');
    try {
      const values = buildCoverPosterValues(
        { rooms: 2, areaSqm: 90, floor: 15, price: 890000, currency: "TJS", districtName: "Сино", address: "Парк Победы" },
        { usdToTjs: 10.9 }
      );
      const svg = await buildTemplateSvgLayer(
        { id: "t", name: "t", builtin: false, formats: ["square"], svgUrl: `/uploads/cover-templates/${file}` },
        "square",
        values,
        false
      );
      expect(svg).toContain("Душанбе");
    } finally {
      await fs.rm(path.join(dir, file), { force: true });
    }
  });
});

describe("встроенный «Royal Green» (владелец, 29.09.2026 — копия его макетов, наш рендер)", () => {
  const cases: { name: string; p: Parameters<typeof buildCoverPosterValues>[0] }[] = [
    { name: "обычная квартира", p: { rooms: 3, areaSqm: 112, floor: 7, price: 145_000, currency: "USD", districtName: "Сино", address: null } },
    { name: "минимум", p: { rooms: null, areaSqm: 90, floor: null, price: 890_000, currency: "TJS", districtName: null, address: null } },
    { name: "всё длинное разом", p: { rooms: 6, areaSqm: 12345.5, floor: 24, price: 12_500_000, currency: "USD", districtName: "Исмоили Сомонӣ (бывший Фрунзенский)", address: null } },
  ];
  // Плашка цены в координатах квадрата (royal-green.build.mjs, v2 29.09): x 57…715.
  const PLATE = { left: 57, right: 715 };

  it("по умолчанию выбирается «Royal Green»", async () => {
    const all = await listCoverTemplates();
    const pick = pickCoverTemplate(all, { coverTemplateMode: "FIXED", coverTemplateId: null, coverTemplateEnabledIds: [] });
    expect(pick.id).toBe(GREEN_COVER_TEMPLATE.id);
    expect(GREEN_COVER_TEMPLATE.formats.sort()).toEqual(["square", "story"]);
    // Знак владельца вшит в шаблон: логотип из Настроек и листья не накладываются.
    expect(GREEN_COVER_TEMPLATE.logoBoxes).toBeUndefined();
    expect(GREEN_COVER_TEMPLATE.leavesFiles).toBeUndefined();
  });

  it("подстановки заполнены в обоих форматах, пустые строки не рисуются", async () => {
    for (const { p } of cases) {
      const values = buildCoverPosterValues(p, { usdToTjs: 10.9 });
      for (const format of ["square", "story"] as const) {
        // Вшитый логотип (base64) не смотрим: в нём буквы «NaN» встречаются случайно.
        const svg = (await buildTemplateSvgLayer(GREEN_COVER_TEMPLATE, format, values, false)).replace(/data:image\/png;base64,[^"]+/g, "");
        expect(svg).not.toMatch(/\{\{|undefined|null|NaN/);
      }
    }
  });

  it("цена любой длины помещается в кремовую плашку (по пикселям)", async () => {
    const sharp = (await import("sharp")).default;
    for (const { name, p } of cases) {
      const values = buildCoverPosterValues(p, { usdToTjs: 10.9 });
      const svg = await buildTemplateSvgLayer(GREEN_COVER_TEMPLATE, "square", values, false);
      const open = /<svg[^>]*>/.exec(svg)?.[0];
      const text = /<g id="price">[\s\S]*?(<text[\s\S]*?<\/text>)/.exec(svg)?.[1];
      expect(open && text).toBeTruthy();
      const { data, info } = await sharp(Buffer.from(`${open}${text}</svg>`)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      let x0 = info.width, x1 = 0;
      for (let y = 0; y < info.height; y++) {
        for (let x = 0; x < info.width; x++) {
          if (data[(y * info.width + x) * 4 + 3] > 96) {
            if (x < x0) x0 = x;
            if (x > x1) x1 = x;
          }
        }
      }
      expect(x1 - x0).toBeGreaterThan(150);
      const inside = x0 >= PLATE.left + 8 && x1 <= PLATE.right - 8;
      expect(`${name}: ${inside ? "внутри" : `${x0}–${x1} вне плашки`}`).toBe(`${name}: внутри`);
    }
  });

  it("рисует JPEG нужного размера в обоих форматах", async () => {
    const sharp = (await import("sharp")).default;
    const values = buildCoverPosterValues(cases[0].p, { usdToTjs: 10.9 });
    for (const format of ["square", "story"] as const) {
      const { width, height } = format === "square" ? COVER_SQUARE : COVER_STORY;
      const bg = await sharp({ create: { width, height, channels: 3, background: { r: 220, g: 210, b: 190 } } }).jpeg().toBuffer();
      const meta = await sharp(await renderCoverPosterImage(bg, values, format, null, true, GREEN_COVER_TEMPLATE)).metadata();
      expect([meta.width, meta.height]).toEqual([width, height]);
    }
  });

  /**
   * ВЕРТИКАЛЬ ДЛЯ СЕТКИ INSTAGRAM (владелец, 02.10.2026): профиль показывает у Reels центр
   * кадра 3:4 — строки 240…1679 из 1920. Всё важное (знак, цифра, «ХОНАГА», плашка цены,
   * нижний ряд) обязано лежать внутри с запасом, а фон — идти на ВСЮ высоту: кремовая
   * полоса от самого верха, панель до самого низа с мягким градиентом и тонкой золотой линией.
   */
  describe("вертикаль 1080×1920: безопасная зона сетки Instagram (строки 240…1679)", () => {
    const GRID_TOP = 240;
    const GRID_BOTTOM = 1679;
    const STRIP = 345;

    it("все надписи, цифры, плашки и знак — внутри строк 240…1679 с запасом (по пикселям), на любых данных", async () => {
      const sharp = (await import("sharp")).default;
      for (const { name, p } of cases) {
        const values = buildCoverPosterValues(p, { usdToTjs: 10.9 });
        const svg = await buildTemplateSvgLayer(GREEN_COVER_TEMPLATE, "story", values, false);
        // Фон (полоса, панель, низ) — не надпись; мягкую тень плашки отсекает порог альфы.
        const ink = svg.replace(/<g data-bg="1">[\s\S]*?<\/g>/, "");
        const { data, info } = await sharp(Buffer.from(ink)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        expect([info.width, info.height]).toEqual([1080, 1920]);
        let y0 = info.height;
        let y1 = 0;
        for (let y = 0; y < info.height; y++) {
          for (let x = 0; x < info.width; x++) {
            if (data[(y * info.width + x) * 4 + 3] > 96) {
              if (y < y0) y0 = y;
              if (y > y1) y1 = y;
            }
          }
        }
        expect(y1 - y0).toBeGreaterThan(900); // слой не пустой: страж обязан видеть рисунок
        expect(y0, `${name}: верх рисунка ${y0}`).toBeGreaterThanOrEqual(GRID_TOP + 30);
        expect(y1, `${name}: низ рисунка ${y1}`).toBeLessThanOrEqual(GRID_BOTTOM - 25);
      }
    });

    it("фон на всю высоту: полоса кремовая от верхней кромки до панели, панель до нижней кромки с градиентом и золотой линией, знак внутри полосы по центру", async () => {
      const sharp = (await import("sharp")).default;
      const values = buildCoverPosterValues(cases[0].p, { usdToTjs: 10.9 });
      // Светлая «фотография»: тёмное и золотое на ней — только то, что нарисовал шаблон.
      const bg = await sharp({ create: { width: 1080, height: 1920, channels: 3, background: { r: 236, g: 232, b: 218 } } }).jpeg().toBuffer();
      const img = await renderCoverPosterImage(bg, values, "story", null, true, GREEN_COVER_TEMPLATE);
      const { data, info } = await sharp(img).raw().toBuffer({ resolveWithObject: true });
      expect([info.width, info.height]).toEqual([1080, 1920]);
      const at = (x: number, y: number) => {
        const i = (y * info.width + x) * info.channels;
        return { r: data[i], g: data[i + 1], b: data[i + 2] };
      };
      const cream = ({ r, g, b }: { r: number; g: number; b: number }) => r > 200 && g > 190 && b > 175 && r - b < 60;

      // Полоса: кремовая в самом верху (строки 0…239) и дальше до панели, постоянной ширины.
      for (const y of [0, 1, 60, 120, 200, 239, 260, 520]) {
        for (const x of [3, 120, STRIP - 8]) expect(cream(at(x, y)), `полоса (${x},${y}) ${JSON.stringify(at(x, y))}`).toBe(true);
      }
      expect(cream(at(330, 700))).toBe(true); // у правого края полосы панель начинается ниже
      // Ни тёмных, ни золотых пикселей в полосе выше строки 240: знака и надписей там нет.
      for (let y = 0; y < GRID_TOP; y++) {
        for (let x = 0; x < STRIP - 4; x += 3) {
          const { r, g, b } = at(x, y);
          expect(r + g + b, `в полосе выше сетки есть рисунок (${x},${y})`).toBeGreaterThan(540);
        }
      }

      // Панель продолжается до самого низа по всей ширине, внизу она глубже, чем у блока.
      for (const x of [3, 540, 1076]) {
        const bottom = at(x, 1919);
        expect(bottom.r < 25 && bottom.g < 45 && bottom.b < 40, `низ панели (${x},1919) ${JSON.stringify(bottom)}`).toBe(true);
      }
      expect(at(540, 1700).g - at(540, 1915).g).toBeGreaterThanOrEqual(8);

      // Ниже сетки (строки 1680…1919) нет светлого и золотого, кроме одной тонкой линии.
      const lightRows: number[] = [];
      for (let y = GRID_BOTTOM + 1; y < 1920; y++) {
        let max = 0;
        for (let x = 0; x < 1080; x += 3) {
          const { r, g, b } = at(x, y);
          max = Math.max(max, (r + g + b) / 3);
        }
        if (max > 90) lightRows.push(y);
      }
      expect(lightRows.length, `светлые строки ниже сетки: ${lightRows.join(",")}`).toBeGreaterThanOrEqual(1); // линия есть
      expect(lightRows.length, `светлые строки ниже сетки: ${lightRows.join(",")}`).toBeLessThanOrEqual(5); // и она тонкая
      expect(at(540, lightRows[0]).r).toBeGreaterThan(120); // золотая

      // Знак владельца целиком внутри полосы и по её центру (тёмные пиксели знака в строках 240…530).
      let left = info.width;
      let right = 0;
      let top = info.height;
      for (let y = GRID_TOP; y < 530; y++) {
        for (let x = 0; x < STRIP; x++) {
          const { r, g, b } = at(x, y);
          if (r < 120 && g < 140 && b < 130) {
            if (x < left) left = x;
            if (x > right) right = x;
            if (y < top) top = y;
          }
        }
      }
      expect(right, "знак не найден").toBeGreaterThan(left);
      expect(left, `знак ${left}…${right} вылезает за левый край полосы`).toBeGreaterThanOrEqual(8);
      expect(right, `знак ${left}…${right} вылезает за правый край полосы`).toBeLessThanOrEqual(STRIP - 8);
      expect(Math.abs((left + right) / 2 - STRIP / 2), `знак ${left}…${right} не по центру полосы`).toBeLessThanOrEqual(12);
      expect(top).toBeGreaterThanOrEqual(GRID_TOP + 30);
    });

    it("квадрат не тронут: ни градиента низа, ни золотой линии", async () => {
      const fs = await import("node:fs/promises");
      const squareSvg = await fs.readFile(GREEN_COVER_TEMPLATE.svgFiles!.square!, "utf8");
      expect(squareSvg).not.toContain("goldLine");
      expect(squareSvg).not.toContain('id="deep"');
    });
  });
});
