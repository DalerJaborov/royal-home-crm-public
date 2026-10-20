import { beforeEach, describe, expect, it } from "vitest";
import { CLIENT_AVATAR_TONES, PERSON_ICON_PATHS, clientAvatarTone, guessGenderFromName } from "@royal-home/shared";
import {
  buildFallbackAvatarUrl,
  buildFallbackAvatarSvg,
  resetFallbackAvatarCache,
} from "../src/lib/clientAvatarFallback.js";

/**
 * Нарисованный аватар клиента (19.08.2026): у большинства клиентов настоящего фото нет
 * и не будет (WhatsApp его не отдаёт, заведённых руками никто не фотографировал), а до
 * этой правки все они выглядели в шторке одной иконкой приложения.
 *
 * Значок «покупатель/продавец» (домик/ключ по Client.kind), который здесь раньше
 * проверялся отдельным блоком, убран 21.09.2026 (решение владельца) — см.
 * packages/shared/src/clientAvatar.ts. Функции больше не принимают kind вовсе.
 *
 * Проверяется здесь ЧИСТАЯ часть — как имя клиента превращается в картинку. То,
 * что картинка доезжает до payload пуша и не затирает настоящее фото, — в
 * tests/client-message-alert.test.ts. Базы этот файл не касается вовсе.
 */

beforeEach(() => resetFallbackAvatarCache());

describe("Тон аватара по имени", () => {
  it("устойчив: одно имя — всегда один цвет", () => {
    // Ради этого хэш и заведён вместо случайного цвета: клиент обязан выглядеть
    // одинаково в списке, в карточке и в шторке телефона, в том числе после
    // перезапуска сервера и на другой машине.
    const first = clientAvatarTone("Далер Джаббаров");
    for (let i = 0; i < 20; i++) expect(clientAvatarTone("Далер Джаббаров")).toEqual(first);
  });

  it("разные имена разбирают всю палитру, а не липнут к одному тону", () => {
    const names = ["Далер", "Зарина", "Умед", "Мадина", "Иван", "Ольга", "Фирдавс", "Нигина", "Сергей", "Лола"];
    const used = new Set(names.map((n) => clientAvatarTone(n).bg));
    expect(used.size).toBeGreaterThan(2);
    // И ни один тон не выдуман на ходу — все из палитры shared.
    for (const bg of used) expect(CLIENT_AVATAR_TONES.some((t) => t.bg === bg)).toBe(true);
  });

  it("клиент без имени тоже получает тон, а не падает", () => {
    expect(CLIENT_AVATAR_TONES).toContainEqual(clientAvatarTone(null));
    expect(CLIENT_AVATAR_TONES).toContainEqual(clientAvatarTone("   "));
  });
});

describe("Фигурка человека", () => {
  /**
   * ОДНА фигурка на всех, и это главное отличие второй редакции от первой. Своих
   * силуэтов — мужского с широкими плечами, женского с каре — больше нет: владелец
   * забраковал их, увидев на экране, как чужеродные рядом с остальными значками CRM.
   * Пол теперь несёт только цвет кольца.
   */
  it("взята из lucide и одинакова независимо от имени и пола", () => {
    const male = buildFallbackAvatarSvg("Далер Джаббаров");
    const female = buildFallbackAvatarSvg("Зарина Ниязова");
    const unknown = buildFallbackAvatarSvg("Umed Karimov");
    for (const path of PERSON_ICON_PATHS) {
      expect(male).toContain(path);
      expect(female).toContain(path);
      expect(unknown).toContain(path);
    }
  });

  it("рисуется контуром, а не заливкой — как остальные значки lucide в CRM", () => {
    const svg = buildFallbackAvatarSvg("Далер");
    expect(svg).toContain('stroke-linecap="round"');
    expect(svg).toContain('fill="none"');
  });
});

describe("Пол по имени — догадка, которая обязана уметь молчать", () => {
  it("узнаёт частые таджикские имена", () => {
    expect(guessGenderFromName("Далер Джаббаров")).toBe("male");
    expect(guessGenderFromName("Фирдавс")).toBe("male");
    expect(guessGenderFromName("Зарина Ниязова")).toBe("female");
    expect(guessGenderFromName("Нигина")).toBe("female");
  });

  it("узнаёт частые русские имена", () => {
    expect(guessGenderFromName("Сергей Иванов")).toBe("male");
    expect(guessGenderFromName("Наталья Петрова")).toBe("female");
  });

  it("не зависит от регистра, пробелов и «ё»", () => {
    expect(guessGenderFromName("  далер  ")).toBe("male");
    expect(guessGenderFromName("БАХТИЁР")).toBe("male");
    expect(guessGenderFromName("Бахтиер")).toBe("male");
  });

  /**
   * ГЛАВНАЯ ПРОВЕРКА ЭТОГО БЛОКА. «Не нашли» обязано означать «ничего не показываем», а
   * НЕ «значит, мужчина». Ошибиться в поле человека неприятнее, чем не показать
   * украшение, поэтому неизвестное имя — это null, и кольца в аватаре просто нет.
   */
  it("незнакомое имя, латиница, фамилия вперёд и пустое имя — никакой догадки", () => {
    expect(guessGenderFromName("Умархон")).toBeNull();
    expect(guessGenderFromName("Umed Karimov")).toBeNull();
    expect(guessGenderFromName("Ниязова Зарина")).toBeNull(); // смотрим только ПЕРВОЕ слово
    expect(guessGenderFromName("Клиент из Instagram")).toBeNull();
    expect(guessGenderFromName(null)).toBeNull();
    expect(guessGenderFromName("")).toBeNull();
  });

  it("никаких эвристик по окончанию: «-ов/-ова» гадать не разрешено", () => {
    // «Наврузов» окончанием кричит «мужчина», но в словаре его нет — и это правильный
    // ответ: те же окончания врут на «Лола», «Зебо» и на любой латинице.
    expect(guessGenderFromName("Наврузов")).toBeNull();
  });
});

describe("Разметка нарисованного аватара", () => {
  it("несёт фигурку и цвета своего тона, но НИКАКОГО текста", () => {
    const svg = buildFallbackAvatarSvg("Далер Джаббаров");
    const tone = clientAvatarTone("Далер Джаббаров");
    expect(svg).toContain(tone.bg);
    expect(svg).toContain(tone.fg);
    expect(svg).toContain(PERSON_ICON_PATHS[0]!);
    // Инициалы владелец отклонил 19.08.2026 — текста в разметке быть не должно вовсе.
    expect(svg).not.toContain("<text");
  });

  it("пол виден ТОЛЬКО цветом: у мужчины и женщины одинаковая разметка", () => {
    // Если этот тест начнёт падать, значит кто-то вернул в фигурку зависимость от
    // пола — ровно те гендерные силуэты, которые владелец уже отклонил.
    // Цвета (и тон по имени, и кольцо) обезличиваем, остаётся чистая геометрия.
    const shape = (name: string) => buildFallbackAvatarSvg(name).replace(/#[0-9a-f]{6}/gi, "#");
    expect(shape("Далер")).toBe(shape("Зарина"));
  });

  it("кольцо пола появляется только на узнанном имени", () => {
    expect(buildFallbackAvatarSvg("Далер")).toContain("#5b8def");
    expect(buildFallbackAvatarSvg("Зарина")).toContain("#e0719c");
    const unknown = buildFallbackAvatarSvg("Umed Karimov");
    expect(unknown).not.toContain("#5b8def");
    expect(unknown).not.toContain("#e0719c");
  });

  it("спецсимволы в имени не ломают разметку", () => {
    // Имя приходит из мессенджера, там бывает что угодно. С отказом от инициалов имя
    // в разметку больше не попадает вовсе — проверяем, что это правда так и осталось,
    // иначе неэкранированный «&» сделал бы SVG невалидным и sharp его не прочёл бы.
    const svg = buildFallbackAvatarSvg("<Petrov & Co>");
    expect(svg).not.toContain("Petrov");
    expect(svg).not.toContain("&");
  });
});

describe("Картинка для шторки уведомлений", () => {
  it("это короткий путь /uploads/avatars-fallback/..., а не встроенный base64", async () => {
    // До 25.08.2026 это была data:image/png;base64,... прямо в теле push-payload —
    // раздувала его сверх лимита Apple/FCM (~4096 байт) и роняла доставку кодами
    // 413/400 (утренний отчёт об ошибках 25.08.2026). Путь короткий: браузер скачивает
    // картинку сам, в теле push-сообщения её байтов больше нет.
    const url = await buildFallbackAvatarUrl("Далер Джаббаров");
    expect(url).toMatch(/^\/uploads\/avatars-fallback\/[0-9a-f]{24}\.png$/);

    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const { uploadsDir } = await import("../src/upload.js");
    const png = await fs.readFile(path.join(uploadsDir, url!.replace("/uploads/", "")));
    // Сигнатура PNG — доказательство, что sharp правда отрисовал картинку на диск.
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect(png.length).toBeGreaterThan(200);
  });

  it("одно и то же имя даёт ровно ту же картинку, разные имена — разные", async () => {
    const a = await buildFallbackAvatarUrl("Зарина Ниязова");
    const b = await buildFallbackAvatarUrl("Зарина Ниязова");
    const c = await buildFallbackAvatarUrl("Умед Каримов");
    expect(a).toBe(b);
    expect(c).not.toBe(a);
  });

  it("клиент без имени картинку всё равно получает", async () => {
    expect(await buildFallbackAvatarUrl(null)).toMatch(/^\/uploads\/avatars-fallback\//);
  });
});
