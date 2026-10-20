import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";
import {
  extractAllPhones,
  extractTypedPhone,
  extractVolunteeredPhone,
  looksDialable,
  unparsedPhoneAttempt,
  unreadablePhoneAttempt,
} from "../src/ai/leadQualifier.js";
import { processMessengerTurn } from "../src/messengers/conversation.js";
import { createCustomerMessengerFixture, type CustomerMessengerFixture } from "./helpers/customerMessengerFixture.js";

/** Модель подменена: переспрос обязан обойтись БЕЗ хода ИИ (ответ определён
 *  полностью, платить за него не за что) — этот мок ещё и доказывает, что так и есть. */
const { callAi } = vi.hoisted(() => ({ callAi: vi.fn() }));
vi.mock("../src/ai/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/client.js")>()),
  callAiText: callAi,
}));

/**
 * НОМЕР — ПРОВЕРЯЕМ ДЛИНОЙ, А НЕ ДОГАДКОЙ О КОДЕ ОПЕРАТОРА (владелец 03.09.2026).
 *
 * Живой случай, который отменил прежний подход целиком: «00 000 10 08» в
 * Instagram. Сначала это выглядело как «две лишних нуля, номера не хватает» —
 * значащая часть после отбрасывания нулей и кода страны давала семь цифр, на
 * два меньше нужного. Но владелец поправил: «у MegaFon есть код 01», то есть
 * ведущий ноль в номере ТАДЖИКИСТАНА — это не мусор и не опечатка, а часть
 * настоящего кода. Различить «000001008» (реальный номер с редким кодом) и
 * «000001008» (тот же самый набор цифр, но реально неполный) НЕЛЬЗЯ никаким
 * правилом о содержании — они идентичны посимвольно. Единственное, что не
 * меняется, пока операторы получают новые ёмкости, — это ДЛИНА: план нумерации
 * Таджикистана закрытый, значащая часть всегда девять цифр. Поэтому вся
 * проверка ниже — только про длину, никогда про то, какая цифра первая.
 *
 * Плата за этот выбор — в другую сторону: «00 000 10 08» больше не ловится как
 * ошибка, а принимается как валидный номер. Это осознанный компромисс на стороне
 * «лучше сохранить клиента, чем угадать код и потерять» (прямые слова владельца).
 */

describe("Разбор номера — только по длине, без догадок о коде", () => {
  it("«00 000 10 08» — раньше считался испорченным, теперь принимается", () => {
    // Девять значащих цифр («000001008») — этого достаточно, кто бы ни выдал код,
    // начинающийся с нуля. Диагноза больше нет: length===9 — законченный номер.
    expect(extractVolunteeredPhone("Занг занед 00 000 10 08")).toBe("+992000001008");
    expect(unreadablePhoneAttempt("Занг занед 00 000 10 08")).toBeNull();
  });

  it("код оператора, начинающийся с нуля (MegaFon «01»), принимается без белого списка", () => {
    // Ни разу не встречавшийся код не должен требовать правки этого файла — иначе
    // каждая новая ёмкость снова теряла бы клиентов, пока про неё не узнают.
    expect(extractVolunteeredPhone("011234567")).toBe("+992011234567");
    // Тот же код, продиктованный с трубочным нулём («0» + девятизначный номер).
    expect(extractVolunteeredPhone("0011234567")).toBe("+992011234567");
  });

  it("настоящий номер диагнозом не считается — заявка оформится обычным путём", () => {
    expect(unreadablePhoneAttempt("Рақамам 980001009")).toBeNull();
    expect(unreadablePhoneAttempt("мой номер +992 90 000 10 35")).toBeNull();
  });

  it("цена рядом со словом о деньгах не превращается в жалобу на номер", () => {
    // Семизначные цены короче девяти цифр и не доходят даже до порога проверки.
    expect(unreadablePhoneAttempt("Нарх 1050000 сомонӣ")).toBeNull();
    // Девятизначная сумма — редкость, но если рядом стоит слово о деньгах,
    // решает оно, а не первая цифра суммы.
    expect(unreadablePhoneAttempt("бюджет 150000000 сомонӣ")).toBeNull();
  });

  it("цена и настоящий номер в ОДНОМ сообщении не гасят друг друга", () => {
    // Мотивирующий пример уже в файле leadQualifier.ts (extractTypedPhone):
    // «3 сотих, 1050000 сомонӣ, занг занед 910001044». Слово «сомонӣ» должно
    // погасить только соседнюю сумму, а не весь текст сообщения — иначе настоящий
    // номер, упомянутый чуть дальше, терялся бы вместе с ценой.
    const text = "3 сотих, 1050000 сомонӣ, занг занед 910001044";
    expect(extractVolunteeredPhone(text)).toBe("+992910001044");
    expect(unreadablePhoneAttempt(text)).toBeNull();
  });

  it("явно короткий или явно длинный набор цифр всё ещё диагностируется", () => {
    // Код страны есть, но после него только восемь цифр — не хватает одной.
    const short = unreadablePhoneAttempt("Рақамам 99298544494");
    expect(short?.kind).toBe("short");
    expect(short?.missing).toBe(1);

    // Одиннадцать цифр, не подходящих ни под один формат (не Россия/Казахстан,
    // не Таджикистан ни в одной из длин) — явно лишнее.
    const long = unreadablePhoneAttempt("Рақамам 12345678901");
    expect(long?.kind).toBe("long");
  });
});

describe("Номер с «?» — модель честно не расслышала цифру (24.09.2026)", () => {
  // Инструкция расшифровки (ai/transcribe.ts) требует ставить «?» вместо каждой
  // нерасслышанной цифры. До этой правки «?» рвал класс символов PHONE_INNER на
  // куски короче девяти цифр («918 84» и «54» по отдельности), кандидатом в номер
  // не становился НИКАК, и номер тихо терялся: ни в карточку, ни в переспрос, ни
  // в тревогу руководству (lib/phoneLeadWatchdog.ts).
  it("«918 84 ?? 54» — номером не становится, но ловится как неразборчивая попытка", () => {
    const text = "Рақамам 918 84 ?? 54";
    expect(extractVolunteeredPhone(text)).toBeNull();
    expect(extractTypedPhone(text)).toBeNull();
    const attempt = unreadablePhoneAttempt(text);
    expect(attempt).not.toBeNull();
    expect(attempt?.raw).toContain("?");
    // Известных цифр семь, до девяти не хватает ровно двух — тех, что скрыты «?».
    expect(attempt?.kind).toBe("short");
    expect(attempt?.missing).toBe(2);
  });

  it("«910 00 10 03» (без «?») по-прежнему разбирается как обычный номер", () => {
    const text = "Рақамам 910 00 10 03";
    expect(extractVolunteeredPhone(text)).toBe("+992910001003");
    expect(unreadablePhoneAttempt(text)).toBeNull();
  });

  it("одна нерасслышанная цифра — «missing» тоже единица", () => {
    const attempt = unreadablePhoneAttempt("Рақамам 918 84 4? 54");
    expect(attempt?.kind).toBe("short");
    expect(attempt?.missing).toBe(1);
  });

  it("настоящий номер рядом гасит «?»-попытку — тревожить некого", () => {
    // Хоть один разобранный номер в сообщении — остальное не считается потерей
    // (то же правило, что и у обычных кандидатов, см. unparsedPhoneAttempt).
    const text = "Основной 980001009, запасной вроде 918 84 ?? 54";
    expect(unreadablePhoneAttempt(text)).toBeNull();
  });
});

describe("Дата/время/сумма с «?» — НЕ номер (правка ревью 24.09.2026)", () => {
  // Найдено при ревью коммита cba0eebce: «?» в PHONE_INNER_UNCLEAR ставит модель
  // не только на нерасслышанной цифре номера, но и на дате/времени/сумме, если
  // расшифровка их не разобрала («24.09.2026?», «1.200.000?»). Восемь цифр даты
  // плюс один «?» дают ровно девять цифровых мест — столько же, сколько в
  // настоящем местном номере — и до правки такая дата маскировалась в
  // расшифровке (scrubMentionedPhones) и вызывала ложный переспрос телефона
  // (unparsedPhoneAttempt/unreadablePhoneAttempt).
  it("«встреча 24.09.2026? в 11:00?» — не номер, не переспрашивается", () => {
    const text = "Договорились на встречу 24.09.2026? в 11:00?, подтвердите пожалуйста";
    expect(unparsedPhoneAttempt(text)).toBeNull();
    expect(unreadablePhoneAttempt(text)).toBeNull();
  });

  it("«1.200.000? сомони» — не номер (точки рвут кандидат ещё до проверки денег)", () => {
    const text = "Цена примерно 1.200.000? сомони, точно не расслышал";
    expect(unparsedPhoneAttempt(text)).toBeNull();
    expect(unreadablePhoneAttempt(text)).toBeNull();
  });

  it("«12000000? сомони» — девятизначная сумма без точек гасится словом о деньгах", () => {
    // Без разделителей число превращается в ОДИН длинный unclear-кандидат (восемь
    // цифр + «?» = девять мест, ровно порог местного номера) — тут решает уже не
    // класс символов, а looksLikeMoneyContext.
    const text = "Бюджет примерно 12000000? сомони, дальше уточню";
    expect(unparsedPhoneAttempt(text)).toBeNull();
    expect(unreadablePhoneAttempt(text)).toBeNull();
  });

  it("«15000? TJS» — расширенный список денежных слов (правка 24.09.2026)", () => {
    const text = "Оплата 150000000? TJS примерно, могу ошибаться";
    expect(unparsedPhoneAttempt(text)).toBeNull();
  });

  it("«918 84 ?? 54» по-прежнему разбирается как раньше — дата/время рядом не гасит настоящий неразборчивый номер", () => {
    const text = "Основной не разобрал, звоните на 918 84 ?? 54";
    const attempt = unreadablePhoneAttempt(text);
    expect(attempt).not.toBeNull();
    expect(attempt?.raw).toContain("?");
    expect(attempt?.kind).toBe("short");
    expect(attempt?.missing).toBe(2);
  });
});

describe("Мягкий разбор не выдумывает номер", () => {
  it("настоящие номера мягкий разбор по-прежнему берёт", () => {
    expect(extractTypedPhone("980001009")).toBe("+992980001009");
    expect(extractTypedPhone("0937001122")).toBe("+992937001122");
    expect(extractTypedPhone("372 65 43 21")).toBe("+992372654321");
  });

  it("«00» впереди — это плюс, а не часть номера", () => {
    // Международный префикс выхода (ITU E.123): так номер сохраняют в телефоне и
    // так его диктуют. Правил под него не было ни одного, и цена этого была
    // двойная: строгий разбор такой номер терял, мягкий заводил карточку с
    // «+00992980001009» — по нему не дозвонится никто.
    expect(extractVolunteeredPhone("00992980001009")).toBe("+992980001009");
    expect(extractVolunteeredPhone("Занг занед 00 992 98 000 10 09")).toBe("+992980001009");
    expect(extractTypedPhone("00992980001009")).toBe("+992980001009");
    // Префикс выхода перед местным номером — тот же случай.
    expect(extractVolunteeredPhone("00 980 001 009")).toBe("+992980001009");
    // И перед зарубежным: клиент из России сохранил номер через 00.
    expect(extractVolunteeredPhone("0079161234567")).toBe("+79161234567");
  });

  it("«00» проверяется ПОСЛЕДНИМ — не отбирает цифры у местного номера с кодом на нуле", () => {
    // «0011234567» — трубка «0» + девятизначный номер с кодом «01». Если бы «00»
    // отваливалось раньше проверки длины, от него оставалось бы восемь цифр —
    // на одну меньше нужного, и настоящий номер терялся бы.
    expect(extractVolunteeredPhone("0011234567")).toBe("+992011234567");
  });

  it("столбик номеров разбирается построчно, каждый сохраняется", () => {
    // Живой случай 18.08.2026 (см. комментарий у PHONE_INNER в leadQualifier.ts):
    // продавец прислал несколько номеров подряд, каждый с новой строки.
    expect(extractAllPhones("030001023\n000001018\n940001011")).toEqual([
      "+992030001023",
      "+992000001018",
      "+992940001011",
    ]);
  });

  it("иностранные номера правило не сужает — там свой план нумерации", () => {
    expect(looksDialable("+79161234567")).toBe(true);
    expect(looksDialable("+992980001009")).toBe(true);
    // Длина не сходится ни с одним форматом — восемь значащих цифр после кода.
    expect(looksDialable("+99200010080")).toBe(false);
  });
});

const runId = Date.now().toString(36);
const SUBSCRIBER = `unreadable-phone-${runId}`;
let messengerFixture: CustomerMessengerFixture;
let settingsBefore: { botReplyDelaySec: number; botReplyMaxWaitSec: number } | null = null;

beforeAll(async () => {
  messengerFixture = await createCustomerMessengerFixture("INSTAGRAM");
  const s = await prisma.settings.upsert({
    where: { id: "singleton" },
    update: {},
    create: { id: "singleton" },
    select: { botReplyDelaySec: true, botReplyMaxWaitSec: true },
  });
  settingsBefore = s;
  // Окно дебаунса минимальное: предмет теста — переспрос, а не ожидание пачки.
  await prisma.settings.update({
    where: { id: "singleton" },
    data: { botReplyDelaySec: 0, botReplyMaxWaitSec: 1 },
  });
});

afterAll(async () => {
  await messengerFixture?.dispose();
  if (settingsBefore) await prisma.settings.update({ where: { id: "singleton" }, data: settingsBefore });
});

describe("Бот переспрашивает номер сразу", () => {
  it("явно неполный номер — переспрашивает и говорит, сколько цифр не хватает, не зовёт модель", async () => {
    callAi.mockClear();
    // «99298544494» — код страны есть, а после него только восемь цифр: этот
    // пример диагностируется всегда, независимо от того, какие коды операторов
    // появятся в будущем (в отличие от «00 000 10 08», который теперь понимается
    // как возможный номер с редким кодом — см. набор тестов выше).
    const result = await processMessengerTurn({
      ...messengerFixture.turnInput(SUBSCRIBER),
      text: "Салом, занг занед 99298544494",
    });

    expect(result.reply).toMatch(/99298544494/);
    // Диагноз, а не «неверный номер»: человек должен понять, что именно поправить.
    expect(result.reply).toMatch(/намерасад|не хватает/i);
    expect(result.accepted).toBe(false);
    expect(callAi).not.toHaveBeenCalled();

    // Карточки нет — выдумывать номер не стали.
    const conv = await prisma.botConversation.findFirst({
      where: { channel: "INSTAGRAM", subscriberId: SUBSCRIBER },
      select: { clientId: true, leadDraft: true },
    });
    expect(conv?.clientId).toBeNull();
    // Счётчик переспросов вырос — на третий раз бот замолчит и отдаст дело сторожу.
    expect((conv?.leadDraft as { phoneRetryCount?: number } | null)?.phoneRetryCount).toBe(1);
  });
});
