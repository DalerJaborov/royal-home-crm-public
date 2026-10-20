import { describe, expect, it } from "vitest";
import { emojiThanksReply, reactionHeart, stripShowingInvite } from "../src/messengers/comments.js";
import { isReactionOnly, stripMachineTypography } from "../src/ai/replyGuards.js";

/**
 * Два решения владельца от 02.08.2026 про комментарии под публикациями.
 *
 * Оба сделаны КОДОМ, а не промтом, и по одной причине: правило «ответь смайликом на
 * смайлик» стояло в промте с 31.07 и не сработало ни разу — за сутки 37 комментариев
 * подряд модель закрыла решением «отвечать не на что».
 */

describe("Смайлик в ответ на смайлик", () => {
  it("комментарий из одних смайликов узнаётся", () => {
    expect(isReactionOnly("😍😍😍🔥🔥🔥")).toBe(true);
    expect(isReactionOnly("👏👏👏👏👏")).toBe(true);
  });

  it("похвала словами — не смайлик, на неё отвечает модель", () => {
    expect(isReactionOnly("Беҳтарин хона 👏👏👏")).toBe(false);
    expect(isReactionOnly("класс")).toBe(false);
  });

  it("ответ — ровно два знака: благодарность и одно сердечко", () => {
    const reply = emojiThanksReply("17851234567890");
    expect(reply.startsWith("🙏")).toBe(true);
    // Гирлянда под собственным постом читается как накрутка: сердечко ровно одно.
    expect([...reply].filter((ch) => ch === "🙏").length).toBe(1);
    expect(reply.length).toBeLessThanOrEqual(4);
  });

  it("цвет сердечка разный у разных комментариев, но постоянный у одного", () => {
    const a = emojiThanksReply("comment-a");
    const b = emojiThanksReply("comment-b");
    // Постоянство важнее разнообразия: повторная обработка той же записи после
    // сбоя обязана дать тот же ответ, иначе под постом появится второй, другой.
    expect(emojiThanksReply("comment-a")).toBe(a);
    const colours = new Set(
      ["c1", "c2", "c3", "c4", "c5", "c6", "c7", "c8", "c9", "c10"].map((id) => emojiThanksReply(id))
    );
    expect(colours.size).toBeGreaterThan(1);
    expect(typeof b).toBe("string");
  });
});

describe("reactionHeart — один смайлик для настоящей реакции WhatsApp/Telegram", () => {
  it("ровно один символ сердечка, не гирлянда", () => {
    const heart = reactionHeart("wamid.xyz123");
    expect([...heart].length).toBeLessThanOrEqual(2); // некоторые сердечки — составной emoji (❤️ = 2 code point)
    expect(heart.startsWith("🙏")).toBe(false);
  });

  it("постоянен для одного id, разный для разных", () => {
    expect(reactionHeart("wamid-a")).toBe(reactionHeart("wamid-a"));
    const colours = new Set(["m1", "m2", "m3", "m4", "m5", "m6", "m7", "m8"].map((id) => reactionHeart(id)));
    expect(colours.size).toBeGreaterThan(1);
  });
});

describe("Публичный ответ не зовёт смотреть квартиру", () => {
  it("приглашение вырезается целым предложением, ответ по существу остаётся", () => {
    const out = stripShowingInvite("Хонаи 3-ҳуҷрагӣ дар Сино, 123 000$. Кай бароятон қулай аст, омада бинед?");
    expect(out).toBe("Хонаи 3-ҳуҷрагӣ дар Сино, 123 000$.");
  });

  it("русские формулировки тоже", () => {
    expect(stripShowingInvite("Цена 320 000 сомони. Приходите посмотреть!")).toBe("Цена 320 000 сомони.");
    expect(stripShowingInvite("Есть такой вариант. Приезжайте посмотреть в любое время.")).toBe(
      "Есть такой вариант."
    );
  });

  it("ответ без приглашения не трогается", () => {
    const clean = "Нархаш 320 000 сомонӣ, дар ноҳияи Сино.";
    expect(stripShowingInvite(clean)).toBe(clean);
  });

  it("если приглашение было единственной фразой — остаётся пустая строка", () => {
    // Вызывающий обязан такой ответ не публиковать: пустой комментарий хуже молчания.
    expect(stripShowingInvite("Приходите посмотреть!")).toBe("");
  });
});

describe("Приметы машинного текста", () => {
  it("длинное тире между словами становится запятой", () => {
    expect(stripMachineTypography("Сино — 320 000 сомонӣ")).toBe("Сино, 320 000 сомонӣ");
  });

  it("точка в конце единственной фразы убирается", () => {
    expect(stripMachineTypography("Ҳа, ҳаст.")).toBe("Ҳа, ҳаст");
  });

  it("точки внутри текста остаются — без них фразы слипаются", () => {
    expect(stripMachineTypography("Нархаш 320 000. Дар Сино.")).toBe("Нархаш 320 000. Дар Сино");
  });

  it("многоточие не трогаем: это интонация, а не пунктуация", () => {
    expect(stripMachineTypography("Ҳозир мебинам...")).toBe("Ҳозир мебинам...");
  });

  it("вопрос и восклицание не теряются", () => {
    expect(stripMachineTypography("Чанд хона даркор?")).toBe("Чанд хона даркор?");
  });
});

describe("Приглашение вырезается и без точки между фразами", () => {
  it("фразы разделены переносом строки — остаётся ответ по существу", () => {
    // Раньше весь текст считался одним предложением и выбрасывался целиком:
    // комментарий оставался без ответа, ровно наоборот к задуманному.
    expect(stripShowingInvite("Нархаш 320 000 сомонӣ\nОмада бинед")).toBe("Нархаш 320 000 сомонӣ");
  });

  it("приглашение внутри одной фразы забирает её целиком, но не весь ответ", () => {
    expect(stripShowingInvite("Салом!\nНархаш 320 000, дар Сино")).toBe("Салом! Нархаш 320 000, дар Сино");
  });
});
