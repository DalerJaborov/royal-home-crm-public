import { describe, expect, it, vi } from "vitest";
import { unaddressedHelpQuestion } from "../src/telegram/assistantGroupParticipation.js";
import { assistantGroupFixture as fixture } from "./helpers/assistantGroupFixture.js";

vi.mock("../src/db.js", () => ({ prisma: { $disconnect: async () => {} } }));

/**
 * ШАБНАМ В РАБОЧИХ ГРУППАХ БЕЗ ОБРАЩЕНИЯ (24.11.2026). Жалобы владельца: «молчит, пока не напишешь
 * "Шабнам"», «новички пишут, она не отвечает». Ясный рабочий вопрос получает ответ сам; болтовня,
 * разговор людей и обращение к человеку — нет; рубильник и «помолчи» выключают; новичку без привязки —
 * предложение привязки (сам модуль предложения проверен на базе в shabnam-group-newcomer-24-11.test.ts).
 */
describe("ясный рабочий вопрос без обращения", () => {
  it.each([
    "Есть варианты двушки в Сино до 50 тысяч?",
    "Коллеги, есть 3х комнатная в 82 мкр?",
    "Как добавить объект в CRM?",
    "Как в црм поменять цену объекта?",
    "Где в CRM посмотреть мои заявки?",
    "Найдите 2-комнатную квартиру в Шохмансуре",
    "Нужна трёшка в новостройке до 600 тысяч?",
    "Хонаи 2 ҳуҷрагӣ дар Сино ҳаст?",
    "Чӣ тавр дар CRM объект илова кунам?",
    // Ревью 25.11.2026: приветствие перед вопросом не мешает.
    "Салом, есть варианты 2к?",
    "Доброе утро, есть варианты в Сино?",
    "Можно ли в CRM удалить заявку?",
    // Повторное ревью 25.11.2026: число комнат слитно с цифрой.
    "Есть 2к?",
    "Есть варианты 2к до 50к?",
  ])("отвечает: %s", text => {
    expect(unaddressedHelpQuestion(text)).toBe(true);
  });

  it.each([
    "Как дела?",
    "Кто сегодня едет на показ?",
    "Ул. Джалола Икроми, ориентир Альфемо спуск новая дорога",
    "Я завтра в офис не приду",
    "Хорошо, договорились",
    "Нужно завтра отнести карточку в офис",
    "Фируза, есть варианты в Сино?",
    "@umed есть варианты в Сино?",
    "Есть варианты в Сино? не отвечай",
    "Как добавить объект в CRM?\nи ещё вопрос",
    "Есть варианты https://somon.tj/x?",
    "ха-ха",
    // Ревью 25.11.2026: слабые начала с «заявкой/карточкой» и без вопроса — разговор людей между собой.
    "Можно ли завтра показать клиенту из заявки?",
    "Нужна трёшка в новостройке до 600 тысяч",
    "Ищу 2к для клиента",
    "Нужна карточка клиента?",
    "Заявка от Умеда есть?",
    "Оё заявкаи навро дидед?",
    // Повторное ревью 25.11.2026: деньги и «2х» не комнаты; просьбы к людям — не к помощнице.
    "Есть 50 к?",
    "У тебя 100 к есть?",
    "Нужны документы в 2х экземплярах?",
    "Есть 2 500к?",
    "Нужна трёшка, кто может завтра показать?",
    "Найдите мне клиента на двушку",
  ])("молчит: %s", text => {
    expect(unaddressedHelpQuestion(text)).toBe(false);
  });
});

describe("поведение в группе", () => {
  it("отвечает на ясный вопрос сотрудника без обращения, только для чтения", async () => {
    const f = fixture();
    expect(await f.send("Есть варианты двушки в Сино до 50 тысяч?")).toBe(true);
    expect(f.run).toHaveBeenCalledTimes(1);
    expect(f.run.mock.calls[0]?.[2]).toMatchObject({ readOnly: true });
  });

  it("болтовня и адрес-реплика без вопроса: ни ответа, ни модели", async () => {
    const f = fixture();
    expect(await f.send("Как дела у всех?")).toBe(false);
    expect(await f.send("Ул. Джалола Икроми, ориентир Альфемо спуск новая дорога", { message_id: 11 })).toBe(false);
    expect(f.run).not.toHaveBeenCalled();
    expect(f.plain).not.toHaveBeenCalled();
  });

  it("вопрос ответом на сообщение другого человека — разговор людей, молчит", async () => {
    const f = fixture();
    const human = { chat: { id: -100, type: "supergroup" }, from: { id: 7, is_bot: false }, message_id: 5, text: "Я ищу клиенту квартиру" };
    expect(await f.send("Есть варианты двушки в Сино?", { reply_to_message: human } as never)).toBe(false);
    expect(f.run).not.toHaveBeenCalled();
  });

  it("не чаще раза в 12 секунд на группу", async () => {
    const f = fixture();
    await f.send("Есть варианты двушки в Сино?");
    await f.send("Есть варианты трёшки в Сино?", { message_id: 11 });
    expect(f.run).toHaveBeenCalledTimes(1);
  });

  it("рубильник выключен: без обращения молчит, по имени отвечает", async () => {
    const f = fixture();
    f.setUnaddressed(false);
    expect(await f.send("Есть варианты двушки в Сино?")).toBe(false);
    expect(await f.send("Какая цена ОБ-123?", { message_id: 11 })).toBe(false);
    expect(f.run).not.toHaveBeenCalled();
    expect(f.plain).not.toHaveBeenCalled();
    await f.send("Шабнам, есть варианты двушки в Сино?", { message_id: 12 });
    expect(f.run).toHaveBeenCalledTimes(1);
  });

  it("«помолчи» (полчаса) глушит и новые вопросы", async () => {
    const f = fixture();
    await f.send("/assistant_quiet");
    f.plain.mockClear();
    f.advance(20_000);
    expect(await f.send("Есть варианты двушки в Сино?", { message_id: 11 })).toBe(false);
    expect(f.run).not.toHaveBeenCalled();
  });

  it("незнакомый CRM: вопрос не уходит модели, идёт предложение привязки (ambient)", async () => {
    const f = fixture();
    f.setLinked(false);
    await f.send("Есть варианты двушки в Сино?");
    expect(f.run).not.toHaveBeenCalled();
    expect(f.offer).toHaveBeenCalledWith(expect.objectContaining({ text: "Есть варианты двушки в Сино?" }), "ambient");
  });

  it("незнакомый CRM позвал по имени — кнопка привязки вместо «я вас не знаю»", async () => {
    const f = fixture();
    f.setLinked(false);
    f.offer.mockResolvedValueOnce(true);
    expect(await f.send("Шабнам, привет")).toBe(true);
    expect(f.offer).toHaveBeenCalledWith(expect.anything(), "addressed");
    expect(f.plain).not.toHaveBeenCalled();
  });

  it("незнакомый CRM нажал /start в подключённой группе — предложение (start)", async () => {
    const f = fixture();
    f.setLinked(false);
    await f.send("/start");
    expect(f.offer).toHaveBeenCalledWith(expect.anything(), "start");
  });

  it("сотрудника с привязкой новичком не считает", async () => {
    const f = fixture();
    await f.send("Всем доброе утро");
    expect(f.offer).toHaveBeenCalledWith(expect.anything(), "ambient");
    // Решает сам модуль предложения (найдёт привязку и промолчит); здесь — что модель не звали.
    expect(f.run).not.toHaveBeenCalled();
  });
});

describe("/assistant_memory", () => {
  it("директор выключает: память выключена, сохранённое стёрто, автопамять не вернёт", async () => {
    const f = fixture();
    f.setContext(true);
    await f.send("/assistant_memory off");
    expect(f.memory().contextEnabledAt).toBeNull();
    expect(f.memory().contextOptOutAt).not.toBeNull();
    expect(f.contextPurge).toHaveBeenCalledWith({ where: { groupChatId: "-100" } });
    expect(f.plain.mock.calls.at(-1)?.[1]).toContain("Память группы выключена");
  });

  it("директор включает обратно: метка «выключено» снята", async () => {
    const f = fixture();
    await f.send("/assistant_memory off");
    await f.send("/assistant_memory on", { message_id: 11 });
    expect(f.memory().contextEnabledAt).not.toBeNull();
    expect(f.memory().contextOptOutAt).toBeNull();
    expect(f.plain.mock.calls.at(-1)?.[1]).toContain("Память группы включена");
  });

  it("агент не может переключить память", async () => {
    const f = fixture();
    f.setRole("AGENT");
    f.setContext(true);
    await f.send("/assistant_memory off");
    expect(f.memory().contextEnabledAt).not.toBeNull();
    expect(f.plain.mock.calls.at(-1)?.[1]).toContain("только директор или администратор");
  });

  it("без аргумента — состояние", async () => {
    const f = fixture();
    await f.send("/assistant_memory");
    expect(f.plain.mock.calls.at(-1)?.[1]).toContain("Память группы выключена. Включить: /assistant_memory on.");
  });
});
