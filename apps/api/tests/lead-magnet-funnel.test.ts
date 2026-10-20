import { describe, expect, it } from "vitest";
import { matchesKeyword, QUICK_REPLY_TITLE_MAX } from "@royal-home/shared";
import { buildFileRequest, buildQuickReplyRequest, parseIncoming } from "../src/messengers/meta.js";
import { pickPublicReply } from "../src/lib/leadMagnet.js";

/**
 * Воронка «комментарий под рекламой → чек-лист в директ».
 *
 * Проверяется то, что нельзя проверить на живой рекламе, не потратив деньги:
 * отбор комментариев ключевым словом, разбор нажатия кнопки и форма запросов к
 * Meta. Ошибка в любом из трёх мест выглядит одинаково — «людям ничего не
 * приходит», — и разбираться пришлось бы на оплаченном трафике.
 */

describe("Ключевое слово ловит живой комментарий", () => {
  it("совпадает по вхождению и без учёта регистра", () => {
    // Под рекламой пишут не «ЧЕКЛИСТ», а фразой вокруг него. Точное совпадение
    // отсекло бы почти всех, а это и есть оплаченные лиды.
    expect(matchesKeyword("хочу чеклист пожалуйста", ["ЧЕКЛИСТ"])).toBe(true);
    expect(matchesKeyword("ЧЕКЛИСТ", ["чеклист"])).toBe(true);
  });

  it("дефис, пробел и точка внутри слова не мешают", () => {
    // Для человека «чек-лист», «чек лист» и «чеклист» — одно слово, и владелец не
    // обязан перечислять все написания.
    expect(matchesKeyword("Чек-лист!", ["чеклист"])).toBe(true);
    expect(matchesKeyword("чек лист хочу", ["чеклист"])).toBe(true);
    expect(matchesKeyword("хочу ЧЕКЛИСТ", ["чек-лист"])).toBe(true);
  });

  it("посторонний комментарий не ловится", () => {
    expect(matchesKeyword("красивая квартира", ["чеклист"])).toBe(false);
    expect(matchesKeyword("сколько стоит?", ["чеклист", "гайд"])).toBe(false);
  });

  it("пустое ключевое слово не совпадает ни с чем", () => {
    // Иначе кампания с пустой строкой в списке тихо превратилась бы в кампанию
    // «пишем в директ каждому, кто вообще что-то написал».
    expect(matchesKeyword("что угодно", [""])).toBe(false);
    expect(matchesKeyword("что угодно", ["   "])).toBe(false);
  });
});

describe("Публичный ответ выбирается постоянно, а не случайно", () => {
  const campaign = { publicReplies: ["Отправил в директ 📩", "Ушло вам в личные", "Смотрите директ"] };

  it("один и тот же комментарий всегда получает один и тот же вариант", () => {
    // Повторная обработка после сбоя не должна дать под постом ВТОРОЙ, другой ответ.
    const first = pickPublicReply(campaign, "17851234567890");
    expect(pickPublicReply(campaign, "17851234567890")).toBe(first);
  });

  it("разные комментарии получают разные варианты", () => {
    const seen = new Set(
      ["c1", "c2", "c3", "c4", "c5", "c6", "c7", "c8"].map((id) => pickPublicReply(campaign, id))
    );
    expect(seen.size).toBeGreaterThan(1);
  });

  it("пустой список означает «публично не отвечаем»", () => {
    expect(pickPublicReply({ publicReplies: [] }, "c1")).toBeNull();
    expect(pickPublicReply({ publicReplies: ["  "] }, "c1")).toBeNull();
  });
});

describe("Нажатие кнопки доходит до CRM", () => {
  it("быстрый ответ приносит метку кампании, а не только текст кнопки", () => {
    // Текст кнопки человек может напечатать и руками — по нему нажатие
    // неотличимо от слов. Ступень воронки определяется меткой.
    const [msg] = parseIncoming({
      object: "instagram",
      entry: [
        {
          messaging: [
            {
              sender: { id: "igsid-1" },
              message: { mid: "m1", text: "Хочу чек-лист", quick_reply: { payload: "lm:camp-1:want" } },
            },
          ],
        },
      ],
    });
    expect(msg.channel).toBe("INSTAGRAM");
    expect(msg.senderId).toBe("igsid-1");
    expect(msg.payload).toBe("lm:camp-1:want");
  });

  it("кнопка шаблона приходит БЕЗ message и раньше терялась целиком", () => {
    // Событие postback не содержит поля message вовсе. Прежняя проверка «нет
    // message — пропустить» выбрасывала его, и человек, нажавший нашу же кнопку,
    // оставался без ответа.
    const [msg] = parseIncoming({
      object: "instagram",
      entry: [
        {
          id: "entry-1",
          messaging: [
            {
              sender: { id: "igsid-2" },
              recipient: { id: "recipient-2" },
              postback: { mid: "p1", title: "Я подписался", payload: "lm:camp-1:followed" },
            },
          ],
        },
      ],
    });
    expect(msg?.payload).toBe("lm:camp-1:followed");
    expect(msg?.senderId).toBe("igsid-2");
    // 17.08.2026: постбэк уходил БЕЗ accountExternalId — кнопку всегда получал
    // аккаунт по умолчанию, даже когда человек переписывался со вторым, и Meta
    // отвечала «The requested user cannot be found» на каждую попытку.
    expect(msg?.accountExternalId).toBe("recipient-2");
  });

  it("эхо собственного сообщения по-прежнему отбрасывается", () => {
    const out = parseIncoming({
      object: "instagram",
      entry: [{ messaging: [{ sender: { id: "me" }, message: { mid: "m2", text: "наш ответ", is_echo: true } }] }],
    });
    expect(out).toHaveLength(0);
  });
});

describe("Форма запросов к Meta", () => {
  const credentials = { igToken: "ig-token", pageId: "page-1", pageToken: "page-token" } as never;

  it("кнопки уходят как quick_replies с нашей меткой", () => {
    const { body } = buildQuickReplyRequest(credentials, "INSTAGRAM", "igsid-1", "Текст", [
      { title: "Хочу чек-лист", payload: "lm:camp-1:want" },
    ]);
    expect(body).toMatchObject({
      recipient: { id: "igsid-1" },
      message: {
        text: "Текст",
        quick_replies: [{ content_type: "text", title: "Хочу чек-лист", payload: "lm:camp-1:want" }],
      },
    });
  });

  it("слишком длинная подпись кнопки обрезается, а не роняет всё сообщение", () => {
    // Двадцать знаков — предел Meta: одна лишняя буква, и запрос отвергается
    // целиком, вместе с текстом. Старая кампания могла быть заведена до появления
    // ограничения в форме.
    const { body } = buildQuickReplyRequest(credentials, "INSTAGRAM", "igsid-1", "Текст", [
      { title: "Очень длинная надпись, которая не влезет", payload: "lm:c:want" },
    ]);
    const title = (body as { message: { quick_replies: { title: string }[] } }).message.quick_replies[0].title;
    expect(title.length).toBe(QUICK_REPLY_TITLE_MAX);
  });

  it("файл в Instagram не отправляется вовсе — мгновенный типизированный отказ", () => {
    // 26.08.2026: Instagram Send API не принимает attachment type "file" (PDF) —
    // раньше запрос уходил в Graph и стабильно бился о 400 subcode 2018007 на
    // каждой выдаче. Воронка ловит этот отказ и отдаёт ссылку (см. send()).
    expect(() => buildFileRequest(credentials, "INSTAGRAM", "igsid-1", "https://crm.example/uploads/a.pdf")).toThrow();
  });

  it("WhatsApp этим путём не обслуживается — отказ на границе, а не молчание", () => {
    // Кнопки и файлы в WhatsApp устроены совсем иначе. Поддельная поддержка
    // означала бы сообщение БЕЗ кнопки, из-за которого человек застревает в
    // воронке навсегда.
    expect(() => buildQuickReplyRequest(credentials, "WHATSAPP", "992900000000", "Текст", [])).toThrow();
    expect(() => buildFileRequest(credentials, "WHATSAPP", "992900000000", "https://x/a.pdf")).toThrow();
  });
});
