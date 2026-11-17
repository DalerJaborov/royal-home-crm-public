import { describe, expect, it } from "vitest";
import { journalInstead, staffSignalAllowed, type StaffSignalKind } from "../src/lib/botAnswersItself.js";
import { clientWaitingSignalKind } from "../src/lib/clientWaitingAlert.js";
import { channelStaffSignalKind } from "../src/lib/channelStaffAlert.js";
import { ATTACHMENT_UNREADABLE, COMMENT_PHONE_DM, COMMENT_PHONE_PUBLIC, COMMENT_SELF_REPLY, commentPhonePublicReply, SELF_ASK_PHONE,
  SELF_OFFICE, selfAnswerLine, selfAnswerLines, selfLanguageOf } from "../src/ai/botSelfAnswerText.js";
import { commentPhoneReplyOf } from "../src/lib/commentPhoneHold.js";
import { COMMENT_HISTORY_PREFIX, commentPhoneDmInHistory } from "../src/messengers/commentPhoneLead.js";
import { isDefinitiveSendRejection } from "../src/messengers/meta.js";

/**
 * «Бот отвечает сам» (владелец 18.11.2026): таблица сигналов «остаётся / убирается» — одна дверь
 * (lib/botAnswersItself.ts), каждая строка таблицы — проверка. Без базы.
 */
describe("staffSignalAllowed — таблица сигналов", () => {
  const kinds: StaffSignalKind[] = ["answered_handover", "bot_choice", "unanswered", "technical"];

  it("ВЫКЛ (по умолчанию): все сигналы как раньше", () => {
    for (const kind of kinds) expect(staffSignalAllowed({ on: false, kind })).toBe(true);
  });

  it("ВКЛ: чат без карточки и без своего агента — «передал/уточнит», выбор бота и «без ответа» руководству не идут", () => {
    expect(staffSignalAllowed({ on: true, kind: "answered_handover" })).toBe(false);
    expect(staffSignalAllowed({ on: true, kind: "bot_choice" })).toBe(false);
    expect(staffSignalAllowed({ on: true, kind: "unanswered" })).toBe(false);
  });

  it("ВКЛ: техсбой — всегда; агенту о ЕГО клиенте — всегда; карточка (заявка) без агента — всегда", () => {
    expect(staffSignalAllowed({ on: true, kind: "technical" })).toBe(true);
    for (const kind of kinds) {
      expect(staffSignalAllowed({ on: true, kind, ownAgent: true })).toBe(true);
      expect(staffSignalAllowed({ on: true, kind, hasCard: true })).toBe(true);
    }
  });

  it("ВКЛ: клиент без ответа — строка журнала вместо пуша; бот ответил сам — ни пуша, ни журнала", () => {
    expect(journalInstead({ on: true, kind: "unanswered" })).toBe(true);
    expect(journalInstead({ on: true, kind: "answered_handover" })).toBe(false);
    expect(journalInstead({ on: true, kind: "bot_choice" })).toBe(false);
    expect(journalInstead({ on: true, kind: "unanswered", ownAgent: true })).toBe(false);
    expect(journalInstead({ on: false, kind: "unanswered" })).toBe(false);
  });
});

describe("виды сигналов в дверях", () => {
  it("«клиент ждёт» (clientWaitingAlert): follow_up/handover — ответ дан; escalate/silence — без ответа; failed и рубильник — техсбой", () => {
    expect(clientWaitingSignalKind("follow_up")).toBe("answered_handover");
    expect(clientWaitingSignalKind("handover")).toBe("answered_handover");
    expect(clientWaitingSignalKind("escalate")).toBe("unanswered");
    expect(clientWaitingSignalKind("silence")).toBe("unanswered");
    expect(clientWaitingSignalKind("failed")).toBe("technical");
    expect(clientWaitingSignalKind("handover", true)).toBe("technical");
  });

  it("Telegram (channelStaffAlert): ядро недоступно и бот выключен — техсбой, остальное — «передал сотруднику»", () => {
    expect(channelStaffSignalKind("core_unavailable")).toBe("technical");
    expect(channelStaffSignalKind("bot_retired")).toBe("technical");
    for (const why of ["escalate", "action_needs_staff", "unreadable_input", "core_refused"] as const) {
      expect(channelStaffSignalKind(why)).toBe("answered_handover");
    }
  });
});

describe("фразы «бот отвечает сам» и номера из комментария", () => {
  const all = [...selfAnswerLines(), ATTACHMENT_UNREADABLE.ru, ATTACHMENT_UNREADABLE.tg, COMMENT_PHONE_DM.ru, COMMENT_PHONE_DM.tg,
    COMMENT_SELF_REPLY.ru, COMMENT_SELF_REPLY.tg, ...COMMENT_PHONE_PUBLIC.flatMap((p) => [p.ru, p.tg])];

  it("без «передаю сотруднику», без запретных слов, без длинного тире, без «ты/ту»", () => {
    for (const line of all) {
      expect(line).not.toMatch(/переда|сотрудник|корманд|руковод/iu);
      expect(line).not.toMatch(/лутфан|безаҳмат|мутахассис|муфассал/iu);
      expect(line).not.toMatch(/—/u);
      expect(line).not.toMatch(/(^|\s)(ты|ту|тебе|туро)(\s|[,.!?]|$)/iu);
    }
  });

  it("публичный ответ на номер не повторяет номер и не зовёт «в директ»; по очереди из четырёх", () => {
    for (const p of COMMENT_PHONE_PUBLIC) for (const line of [p.ru, p.tg]) {
      expect(line).not.toMatch(/\d{3}/u);
      expect(line).not.toMatch(/директ|direct|личн/iu);
    }
    const seen = new Set([0, 1, 2, 3, 4].map((turn) => commentPhonePublicReply("tg", turn)));
    expect(seen.size).toBe(4);
    expect(commentPhonePublicReply("ru", 4)).toBe(commentPhonePublicReply("ru", 0));
  });

  it("личный ответ на номер: приветствие, «увидели номер», ОДИН вопрос о цели, номер не переспрашивает, аренду не предлагает", () => {
    for (const line of [COMMENT_PHONE_DM.ru, COMMENT_PHONE_DM.tg]) {
      expect(line.match(/\?/gu)).toHaveLength(1);
      expect(line).not.toMatch(/нависед|напишите.*номер|оставьте.*номер|аренд|иҷора/iu);
    }
    expect(COMMENT_PHONE_DM.ru).toMatch(/^Здравствуйте!.*увидели ваш номер.*купить, продать.*работа/su);
    expect(COMMENT_PHONE_DM.tg).toMatch(/^Ассалому алейкум!.*рақами шуморо дидем.*харид, фурӯши хона ё кор\?$/su);
  });

  it("безопасная фраза ведёт к номеру; номер уже просили или он известен — телефон офиса, второй просьбы нет", () => {
    expect(selfAnswerLine("tg", false)).toBe(SELF_ASK_PHONE.tg);
    expect(selfAnswerLine("ru", true)).toBe(SELF_OFFICE.ru);
    expect(selfAnswerLine("ru", false, true)).toBe(SELF_OFFICE.ru);
    expect(SELF_OFFICE.ru).toContain("+992 44 650 14 14");
  });

  it("язык готовой фразы: русский — только явно русский текст; номер без слов и таджикский — по-таджикски", () => {
    expect(selfLanguageOf("Сколько стоит эта квартира? Позвоните мне")).toBe("ru");
    expect(selfLanguageOf("Нархаш чанд? Занг занед")).toBe("tg");
    expect(selfLanguageOf("900000001")).toBe("tg");
  });
});

describe("номер из комментария: ответ клиента в личных", () => {
  const dm = { role: "assistant", content: COMMENT_PHONE_DM.tg };
  it("ответ после личного — это ответ; свои реплики кода и сам комментарий — нет", () => {
    expect(commentPhoneReplyOf([{ role: "user", content: `${COMMENT_HISTORY_PREFIX}900000001`, silentCapture: true }, dm])).toBeNull();
    expect(commentPhoneReplyOf([{ role: "user", content: `${COMMENT_HISTORY_PREFIX}900000001` }, dm, { role: "user", content: "Хона мехарам" }]))
      .toBe("Хона мехарам");
    expect(commentPhoneReplyOf([{ role: "user", content: "салом" }])).toBeNull();
    expect(commentPhoneReplyOf("not an array")).toBeNull();
  });
  it("личное уже уходило — второго не будет", () => {
    expect(commentPhoneDmInHistory([dm], [COMMENT_PHONE_DM.ru, COMMENT_PHONE_DM.tg])).toBe(true);
    expect(commentPhoneDmInHistory([{ role: "assistant", content: "Ташаккур!" }], [COMMENT_PHONE_DM.tg])).toBe(false);
  });
});

describe("щит исходящих: счёт возвращает только ЯВНЫЙ отказ провайдера", () => {
  it("HTTP-ответ Graph с ошибкой (368) — точно не ушло; таймаут/обрыв — могло уйти", () => {
    expect(isDefinitiveSendRejection(new Error('Graph API HTTP 400: {"error":{"code":368}}'))).toBe(true);
    expect(isDefinitiveSendRejection(new Error("Graph API HTTP 500: managed delivery rejected"))).toBe(true);
    expect(isDefinitiveSendRejection(new Error("The operation was aborted due to timeout"))).toBe(false);
    expect(isDefinitiveSendRejection(new Error("Graph API returned a contradictory message response"))).toBe(false);
  });
});
