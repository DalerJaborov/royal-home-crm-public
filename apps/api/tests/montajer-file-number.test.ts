import { describe, expect, it } from "vitest";
import { declaredObjectNumber } from "../src/telegram/montajerFileNumber.js";

/**
 * Номер объекта в имени файла или подписи монтажёра (24.09.2026) — по нему бот
 * решает, чей это готовый ролик, и не кладёт поздний файл на чужой объект.
 */
describe("declaredObjectNumber", () => {
  it.each([
    ["108.mp4", 108],
    ["108_1из3.mov", 108],
    ["№132 финал.mp4", 132],
    ["  45-готово.MP4", 45],
    ["Объект 77.mp4", 77],
  ])("имя «%s» — номер %s", (name, n) => {
    expect(declaredObjectNumber(name, null)).toBe(n);
  });

  it.each(["IMG_1234.MOV", "20260924_видео.mp4", "video.mp4", "обложка.mp4", "финал 108.mp4"])(
    "имя «%s» — номера нет (цифры не в начале или это дата)",
    (name) => {
      expect(declaredObjectNumber(name, null)).toBeNull();
    }
  );

  it("номера в имени нет — берётся из начала подписи", () => {
    expect(declaredObjectNumber("IMG_1234.MOV", "объект 108")).toBe(108);
    expect(declaredObjectNumber("IMG_1234.MOV", "№108 исправленный")).toBe(108);
  });

  it("имя важнее подписи: его выдал сам бот", () => {
    expect(declaredObjectNumber("108.mp4", "2 варианта")).toBe(108);
  });

  it("подпись без номера в начале — номера нет", () => {
    expect(declaredObjectNumber("IMG_1234.MOV", "готово, звук поправил")).toBeNull();
  });
});

/**
 * ИМЯ, ПОДПИСЬ, КОНТРОЛЬНОЕ СООБЩЕНИЕ, КВИТАНЦИЯ, СВОДКА МОДЕРАЦИИ (25.09.2026,
 * «чтобы вообще никогда ни описания, ни ролики не путались»). Чистые функции —
 * без обращений к базе и к Telegram.
 */
const { montajerFileName, montajerFileCaptionHead, montajerDeliveryControlText } = await import("../src/lib/videoHandoff.js");
const { handoffReceiptText } = await import("../src/telegram/montajerReceive.js");
const { moderationVideoSummaryText, humanFileSize } = await import("../src/lib/telegramModeration.js");

describe("montajerFileName — номер объекта в имени при любом числе файлов", () => {
  it("один файл — «133.MOV»", () => {
    expect(montajerFileName(133, 0, 1, "IMG_0001.MOV")).toBe("133.MOV");
  });
  it("два файла — «133_1из2», «133_2из2»", () => {
    expect([0, 1].map((i) => montajerFileName(133, i, 2, "a.mp4"))).toEqual(["133_1из2.mp4", "133_2из2.mp4"]);
  });
  it("пятнадцать файлов — все разные, по порядку, каждый с номером объекта", () => {
    const names = Array.from({ length: 15 }, (_, i) => montajerFileName(133, i, 15, `IMG_${i}.mov`));
    expect(new Set(names).size).toBe(15);
    names.forEach((name, i) => expect(name).toBe(`133_${i + 1}из15.mov`));
    // Имя, выданное ботом, бот и распознаёт обратно — круг замкнут.
    names.forEach((name) => expect(declaredObjectNumber(name, null)).toBe(133));
  });
  it("файл без расширения — только номер", () => {
    expect(montajerFileName(7, 0, 1, "video")).toBe("7");
  });
});

describe("declaredObjectNumber — случаи из задания", () => {
  it.each([
    ["133.mp4", null, 133],
    ["133_2из15.mov", null, 133],
    ["lv_0_2026.mp4", "объект 133", 133],
    ["lv_0_2026.mp4", null, null],
  ])("имя «%s», подпись «%s» — %s", (name, caption, expected) => {
    expect(declaredObjectNumber(name, caption)).toBe(expected);
  });
});

describe("подпись файла монтажёру начинается с номера объекта", () => {
  it("«Объект №133 · файл 2 из 15 · факты»", () => {
    expect(montajerFileCaptionHead(133, 1, 15, "0:45 · 1080×1920")).toBe("Объект №133 · файл 2 из 15 · 0:45 · 1080×1920");
  });
  it("один файл — всё равно «файл 1 из 1», без фактов — без хвоста", () => {
    expect(montajerFileCaptionHead(133, 0, 1, "")).toBe("Объект №133 · файл 1 из 1");
  });
});

describe("контрольное сообщение после отправки", () => {
  it("всё дошло — «Отправлено 15 из 15 файлов объекта №133»", () => {
    expect(montajerDeliveryControlText(133, 15, 15)).toBe("Отправлено 15 из 15 файлов объекта №133.");
  });
  it("один файл — «из 1 файла», двадцать один — «из 21 файла»", () => {
    expect(montajerDeliveryControlText(5, 1, 1)).toBe("Отправлено 1 из 1 файла объекта №5.");
    expect(montajerDeliveryControlText(5, 21, 21)).toBe("Отправлено 21 из 21 файла объекта №5.");
  });
  it("дошло не всё — честно и с обещанием досылки", () => {
    expect(montajerDeliveryControlText(133, 14, 15)).toBe("Объект №133: дошло 14 из 15 файлов, остальное дошлю автоматически.");
  });
});

describe("квитанция монтажёру честная (А7)", () => {
  const now = new Date("2026-09-25T06:00:00Z"); // 11:00 по Душанбе
  it("слот сегодня — «публикую по каналам в 14:30»", () => {
    const text = handoffReceiptText({ ok: true, summary: null, scheduledPublishAt: new Date("2026-09-25T09:30:00Z") }, 133, now);
    expect(text).toBe("Ролик по объекту №133 принят, публикую по каналам в 14:30.");
  });
  it("слот завтра — с датой", () => {
    const text = handoffReceiptText({ ok: true, summary: null, scheduledPublishAt: new Date("2026-09-26T04:00:00Z") }, 133, now);
    expect(text).toBe("Ролик по объекту №133 принят, публикую по каналам 26.09 в 09:00.");
  });
  it("публиковаться не будет — причина, а не «публикую»", () => {
    const text = handoffReceiptText({ ok: true, summary: null, notPublishingReason: "Автопубликация выключена в Настройках." }, 133, now);
    expect(text).toContain("принят, но публиковаться не будет: Автопубликация выключена");
    expect(text).not.toContain("публикую");
  });
  it("отказ — номер объекта и причина", () => {
    expect(handoffReceiptText({ ok: false, error: "Ролик короче 3 секунд." }, 133, now)).toBe(
      "Объект №133: не получилось принять ролик: Ролик короче 3 секунд."
    );
  });
});

describe("модерация: сводка по всем видео, а не «Видео 1 из 16» (А6)", () => {
  it("16 файлов — число, общий вес и список имён с длительностью", () => {
    const videos = Array.from({ length: 16 }, (_, i) => ({ filename: `IMG_${i + 1}.MOV`, sizeBytes: 80 * 1024 * 1024, durationSec: 30 + i }));
    const text = moderationVideoSummaryText(videos);
    expect(text.split("\n")[0]).toBe("🎬 Видео: 16 файлов (1,3 ГБ), первый — ниже:");
    expect(text).toContain("1. IMG_1.MOV — 0:30");
    expect(text).toContain("16. IMG_16.MOV — 0:45");
    expect(text).not.toContain("из 16");
  });
  it("длительность неизвестна — только имя", () => {
    const text = moderationVideoSummaryText([
      { filename: "a.mov", sizeBytes: 1, durationSec: null },
      { filename: "b.mov", sizeBytes: 1, durationSec: null },
    ]);
    expect(text).toContain("2. b.mov");
    expect(text.split("\n")[0]).toContain("2 файла");
  });
  it("размер по-русски", () => {
    expect(humanFileSize(1.25 * 1024 ** 3)).toBe("1,3 ГБ");
    expect(humanFileSize(640 * 1024 ** 2)).toBe("640 МБ");
  });
});
