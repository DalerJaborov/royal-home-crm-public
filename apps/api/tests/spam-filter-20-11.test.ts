import { describe, expect, it } from "vitest";
import { customerSpamMuteGate, customerSpamMuteRecord, customerSpamTurn } from "../src/ai/customerSpamMute.js";

/**
 * СПАМ — БЕЗ ОТВЕТА И БЕЗ МОДЕЛИ (владелец 20.11.2026: «таким спамерам как то не отвечать… сэкономить токены»).
 * Одна дверь ai/customerSpamMute.ts::customerSpamTurn. Примеры «лайк/подписка» и «реклама своих услуг» — живые реплики прода
 * (20.11.2026, только чтение, без номеров); просьбы денег — живые случаи из шапки ai/moneyRequestGuard.ts (за 45 дней прод
 * новых не дал). Предохранитель важнее фильтра: номер или слова о жилье, цене, вакансии — никогда не спам.
 */
const spam = (text: string) => customerSpamTurn({ inputText: text });

describe("спам отсеивается кодом", () => {
  it("лайки, комментарии, подписки (живые)", () => {
    for (const text of ["Лай камент акара под мекнем", "Лайк 🤍 камень жду", "Лайк камень сохранит паделитсия кн радной", "Лайк камент паделится",
      "лайк за лайк", "Подпишитесь на мой канал", "взаимка?", "Mind giving us a follow first? Right after you follow me, I will send you the link"]) {
      expect(spam(text), text).toBe(true);
    }
  });
  it("реклама своих услуг", () => {
    for (const text of ["вот мои работы: https://example.com/a", "Акачон ма монтажёрм, агар махкул шава хамкори мекнем", "Мое портфолио по ссылке",
      "Заработок без вложений, пиши мне в директ", "Ставки на спорт, переходи и выигрывай"]) {
      expect(spam(text), text).toBe(true);
    }
  });
});

describe("настоящие клиенты, похожие на спам, — НЕ спам", () => {
  it("номер, жильё, цена, вакансия, наш объект", () => {
    for (const text of ["Лайк поставил, сколько стоит квартира?", "Хонаи мора фурушен 90 000 00 01", "Подпишитесь… шутка, есть 2-комнатная в Сино?",
      "Шумо навиштаед ки барои фуруши амвол кумак мекунед, пас кумак кунед ман хонаамро фурушам!", "Вакансия SMM ещё актуальна?",
      "Ссылку на объект скиньте, адрес какой?", "Привет! Можно узнать об этом подробнее?", "Цена", "Ассаламу алейкум адрес кучоба",
      // Ревью #333: просьба о помощи с жильём — не просьба денег.
      "Кумак кунед, фарзандам калон шуд, ҷой лозим", "Yordam bering, hovli kerak", "Помогите найти манзил в Сино"]) {
      expect(spam(text), text).toBe(false);
    }
  });
});

describe("«Вернуть боту» не отменяется молча (ревью #333, четвёртый круг)", () => {
  it("вернули → спам-похожее → ещё спам-похожее: отметка не пишется, разговор не глушится, признак сохраняется", () => {
    const now = new Date("2026-11-20T10:00:00.000Z");
    let state = { turns: [], exempt: true } as Parameters<typeof customerSpamMuteRecord>[0];
    for (const [i, text] of ["Лайк камент паделится", "лайк за лайк"].entries()) {
      expect(spam(text)).toBe(true);
      state = customerSpamMuteRecord(state, { key: `k${i}`, now: new Date(now.getTime() + i * 60_000) });
      expect(state).toEqual({ turns: [], exempt: true });
      expect(customerSpamMuteGate(state, { inputText: text, now })).toBe("open");
    }
  });
});
