import { describe, expect, it } from "vitest";
import {
  computeSpeedBps,
  formatActiveUploadLine,
  formatEtaSeconds,
  formatProgressFraction,
  formatRetryCountdown,
  formatShortUserAgent,
  formatSpeedBps,
  formatUploadIssueMessage,
  formatUploadSize,
  unreadableFileMessage,
} from "../uploadFormat";

describe("uploadFormat: formatUploadSize — та же лестница единиц, что и раньше в UploadTaskRow", () => {
  it("КБ, МБ, ГБ по границам", () => {
    expect(formatUploadSize(500)).toBe("1 КБ");
    expect(formatUploadSize(2048)).toBe("2 КБ");
    expect(formatUploadSize(5 * 1024 * 1024)).toBe("5.0 МБ");
    expect(formatUploadSize(2 * 1024 * 1024 * 1024)).toBe("2.0 ГБ");
  });
});

describe("uploadFormat: formatSpeedBps", () => {
  it("та же лестница единиц с припиской «/с»", () => {
    expect(formatSpeedBps(250 * 1024)).toBe("250 КБ/с");
    expect(formatSpeedBps(4.2 * 1024 * 1024)).toBe("4.2 МБ/с");
  });
});

describe("uploadFormat: computeSpeedBps — скользящее среднее по ~5с", () => {
  const now = 1_000_000;

  it("null, пока данных меньше двух точек", () => {
    expect(computeSpeedBps([], now)).toBeNull();
    expect(computeSpeedBps([{ t: now, loaded: 100 }], now)).toBeNull();
  });

  it("null, если прошло слишком мало времени", () => {
    const samples = [
      { t: now - 100, loaded: 0 },
      { t: now, loaded: 1000 },
    ];
    expect(computeSpeedBps(samples, now)).toBeNull();
  });

  it("считает байт/сек по точкам внутри окна", () => {
    const samples = [
      { t: now - 4000, loaded: 0 },
      { t: now - 2000, loaded: 500_000 },
      { t: now, loaded: 1_000_000 },
    ];
    // от первой до последней точки в окне: 1_000_000 байт за 4с = 250_000 байт/с
    expect(computeSpeedBps(samples, now)).toBe(250_000);
  });

  it("отбрасывает точки старше окна (5с)", () => {
    const samples = [
      { t: now - 10_000, loaded: 0 }, // вне окна — не должна участвовать
      { t: now - 4000, loaded: 100_000 },
      { t: now, loaded: 500_000 },
    ];
    expect(computeSpeedBps(samples, now)).toBe(100_000);
  });

  it("null, если байты не двигаются (значит, точки от предыдущего задания)", () => {
    const samples = [
      { t: now - 3000, loaded: 500 },
      { t: now, loaded: 500 },
    ];
    expect(computeSpeedBps(samples, now)).toBeNull();
  });
});

describe("uploadFormat: formatEtaSeconds", () => {
  it("секунды, минуты, часы", () => {
    expect(formatEtaSeconds(45)).toBe("~45 с");
    expect(formatEtaSeconds(59)).toBe("~59 с");
    expect(formatEtaSeconds(60)).toBe("~1 мин");
    expect(formatEtaSeconds(12 * 60)).toBe("~12 мин");
    expect(formatEtaSeconds(65 * 60)).toBe("~1 ч 05 мин");
    expect(formatEtaSeconds(120 * 60)).toBe("~2 ч");
  });

  it("не отдаёт «0 с» — минимум 1", () => {
    expect(formatEtaSeconds(0)).toBe("~1 с");
    expect(formatEtaSeconds(-5)).toBe("~1 с");
  });
});

describe("uploadFormat: formatProgressFraction — «4,2 МБ из 183»", () => {
  it("обе части в единице ИТОГА", () => {
    const totalBytes = 183 * 1024 * 1024;
    const loadedBytes = 4.2 * 1024 * 1024;
    expect(formatProgressFraction(loadedBytes, totalBytes)).toBe("4,2 МБ из 183");
  });

  it("маленький файл — в КБ, без десятых", () => {
    expect(formatProgressFraction(300 * 1024, 500 * 1024)).toBe("300 КБ из 500");
  });
});

describe("uploadFormat: formatActiveUploadLine — честная строка активного задания", () => {
  it("«начинаем…», пока скорости ещё нет", () => {
    expect(formatActiveUploadLine(183 * 1024 * 1024, 0, null)).toBe("183.0 МБ · начинаем…");
  });

  it("полная строка со скоростью и ETA, когда данные есть", () => {
    const total = 183 * 1024 * 1024;
    const loaded = 4.2 * 1024 * 1024;
    const speed = 250 * 1024; // 250 КБ/с
    const line = formatActiveUploadLine(total, loaded, speed);
    expect(line).toContain("183.0 МБ");
    expect(line).toContain("4,2 МБ из 183");
    expect(line).toContain("250 КБ/с");
    expect(line).toContain("осталось ~");
  });
});

describe("uploadFormat: formatRetryCountdown", () => {
  it("живой обратный отсчёт, округлённый вверх", () => {
    const now = 1_000_000;
    expect(formatRetryCountdown("Связь прервалась", now + 39_500, now)).toBe("Связь прервалась · повтор через 40 с");
  });

  it("не даёт «0 с» за миг до повтора", () => {
    const now = 1_000_000;
    expect(formatRetryCountdown("x", now + 10, now)).toBe("x · повтор через 1 с");
  });
});

describe("uploadFormat: formatShortUserAgent", () => {
  it("iPhone Safari", () => {
    const ua =
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
    expect(formatShortUserAgent(ua)).toBe("iPhone Safari");
  });

  it("Android Chrome", () => {
    const ua = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36";
    expect(formatShortUserAgent(ua)).toBe("Android Chrome");
  });

  it("пусто — честная заглушка, не пустая строка", () => {
    expect(formatShortUserAgent("")).toBe("браузер неизвестен");
  });
});

describe("uploadFormat: formatUploadIssueMessage", () => {
  it("собирает одну строку телеметрии со всеми полями", () => {
    const message = formatUploadIssueMessage({
      kind: "video",
      name: "IMG_0065.mov",
      sizeBytes: 183 * 1024 * 1024,
      propertyLabel: "объект ОБ-000134",
      attempts: 3,
      maxAttempts: 10,
      status: 0,
      error: "Связь прервалась",
      online: true,
      partsDone: 0,
      partsTotal: 22,
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Safari/604.1",
    });
    expect(message).toContain("[загрузка] видео IMG_0065.mov");
    expect(message).toContain("объект ОБ-000134");
    expect(message).toContain("попытка 3/10");
    expect(message).toContain("статус 0");
    expect(message).toContain("«Связь прервалась»");
    expect(message).toContain("online=true");
    expect(message).toContain("части 0/22");
    expect(message).toContain("iPhone Safari");
    // Дедуп в errorReporter.ts режет по первым 200 символам — номер попытки
    // обязан попасть в этот срез, иначе разные попытки схлопнутся в одну.
    expect(message.slice(0, 200)).toContain("попытка 3/10");
  });

  it("без частей — секция «части» не появляется", () => {
    const message = formatUploadIssueMessage({
      kind: "photo",
      name: "a.jpg",
      sizeBytes: 1024,
      propertyLabel: "объект ОБ-000001",
      attempts: 1,
      maxAttempts: 10,
      status: 500,
      error: "Внутренняя ошибка сервера",
      online: true,
      userAgent: "",
    });
    expect(message).not.toContain("части");
  });
});

describe("uploadFormat: unreadableFileMessage", () => {
  it("базовый текст — файл, который не читается", () => {
    expect(unreadableFileMessage(false)).toBe(
      "Телефон не даёт прочитать файл (после перезапуска приложения так бывает) — уберите его и добавьте заново"
    );
  });

  it("с подтверждённой связью — пометка добавляется", () => {
    expect(unreadableFileMessage(true)).toContain("связь есть, файл не читается");
  });
});
