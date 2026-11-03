import { describe, expect, it } from "vitest";
import {
  classifyErrorLog,
  errorGroupKey,
  groupErrorLogEntries,
  isDuplicateLeadSignal,
} from "../src/lib/errorLogClassify.js";

/**
 * Разбор аудита 03.09.2026 (docs/audit-02-09-2026/20-deep-audit-03-09-night.md,
 * раздел 4-5): «377 неразобранных, 17 типов за неделю» — минимум 6 из 17 типов
 * были эксплуатационным шумом ИИ-конвейера, не решением, которое ждёт от
 * директора действия. Здесь закреплены конкретные тексты, которые пишет код
 * (ai/client.ts, ai/geminiClient.ts) — если формулировка сообщения когда-нибудь
 * изменится, тест упадёт раньше, чем директора снова начнут будить попусту.
 */
describe("classifyErrorLog: операционный шум ИИ-конвейера не будит директора", () => {
  it("Gemini ответил на резервной модели (чат) — operational", () => {
    expect(
      classifyErrorLog("ai", "Gemini ответил на РЕЗЕРВНОЙ модели gemini-2.5-flash — основная gemini-3.6-pro недоступна.")
    ).toBe("operational");
  });

  it("ассистент ответил на резервной модели — operational", () => {
    expect(
      classifyErrorLog("ai", "Ассистент ответил на РЕЗЕРВНОЙ модели gemini-2.5-flash — основная gemini-3.6-pro недоступна.")
    ).toBe("operational");
  });

  it("повтор помог с первого раза — operational", () => {
    expect(classifyErrorLog("ai", "Gemini не ответил с первого раза (chat) — помог повтор")).toBe("operational");
  });

  it("повтор тоже не помог — operational (уже в фоновой очереди повторов)", () => {
    expect(classifyErrorLog("ai", "Gemini не ответил (chat), повтор тоже не помог")).toBe("operational");
  });

  it("ТРЕВОГА остаётся actionable, даже если текст похож на операционный шум", () => {
    expect(
      classifyErrorLog(
        "ai",
        "ТРЕВОГА: основная модель Gemini «gemini-3.6-pro» отказала 12 раз за час — резерв ответил, повтор помог"
      )
    ).toBe("actionable");
  });

  it("настоящая новая поломка (без резерва/повтора в тексте) — actionable", () => {
    expect(classifyErrorLog("telegram", "Бот не получает сообщения от Telegram дольше трёх минут")).toBe("actionable");
  });

  it("сигнал «номер в переписке без карточки» остаётся actionable", () => {
    const msg = "[alarm] Номер +992900000000 есть в переписке, карточки в базе нет (диалог c1, INSTAGRAM, Иван).";
    expect(classifyErrorLog("ai", msg)).toBe("actionable");
    expect(isDuplicateLeadSignal(msg)).toBe(true);
  });
});

describe("groupErrorLogEntries: уникальные типы с count, не растущий список строк", () => {
  it("схлопывает повторы одной и той же поломки и считает count", () => {
    const now = new Date("2026-09-03T10:00:00Z");
    const earlier = new Date("2026-09-01T08:00:00Z");
    const rows = [
      { source: "telegram", message: "Бот не получает сообщения дольше трёх минут", createdAt: earlier, url: null },
      { source: "telegram", message: "Бот не получает сообщения дольше трёх минут", createdAt: now, url: null },
      { source: "site-sync", message: "Сайт недоступен: таймаут", createdAt: now, url: null },
    ];
    const groups = groupErrorLogEntries(rows);
    expect(groups).toHaveLength(2);
    const telegramGroup = groups.find((g) => g.source === "telegram")!;
    expect(telegramGroup.count).toBe(2);
    expect(telegramGroup.lastAt).toEqual(now);
  });

  it("группа с сигналом «номер без карточки» уходит в конец списка (понижен приоритет)", () => {
    const now = new Date("2026-09-03T10:00:00Z");
    const rows = [
      { source: "ai", message: "[alarm] Номер есть в переписке, карточки в базе нет (диалог c1)", createdAt: now, url: null },
      { source: "telephony", message: "ARI-подписка на события звонков оборвалась", createdAt: new Date("2026-09-02T09:00:00Z"), url: null },
    ];
    const groups = groupErrorLogEntries(rows);
    expect(groups[0].source).toBe("telephony");
    expect(groups[1].lowPriority).toBe(true);
  });

  it("errorGroupKey — source и первые 160 символов текста (то же число, что у logSystemError)", () => {
    // Уникальная деталь (id диалога) — в ХВОСТЕ длинного сообщения, за 160-м
    // символом: ровно та ситуация, ради которой DEDUP_TEXT_LEN и заведён
    // (systemError.ts, 28.08.2026) — иначе каждое такое сообщение считалось бы
    // новым уникальным типом.
    const prefix = "Разбор договорённости о показе (ручной ответ) не удался: ".padEnd(170, "x");
    const keyA = errorGroupKey("ai", `${prefix} диалог c1`);
    const keyB = errorGroupKey("ai", `${prefix} диалог c2`);
    expect(keyA).toBe(keyB);

    // Уникальная деталь В НАЧАЛЕ (номер файла/канала) — с 01.11.2026 цифры в ключе
    // заменяются на «#», поэтому это тоже один тип (аудит: 30 «типов» ARI были одной ошибкой).
    const keyC = errorGroupKey("ai", "Голосовое (file-1.ogg) не расшифровано: таймаут сети");
    const keyD = errorGroupKey("ai", "Голосовое (file-2.ogg) не расшифровано: таймаут сети");
    expect(keyC).toBe(keyD);
  });

  it("errorGroupKey — две ошибки ARI, различающиеся только числами/id, дают один ключ", () => {
    const a = errorGroupKey("telephony", "ARI: канал 1730412345.678 (ext 1042, +992901234567) не ответил за 5000 мс");
    const b = errorGroupKey("telephony", "ARI: канал 1730412399.912 (ext 1077, +992907654321) не ответил за 5000 мс");
    expect(a).toBe(b);
    const withUuid = errorGroupKey("telephony", "ARI: call 3f2b8c1e-1a2b-4c3d-8e9f-0123456789ab hangup failed");
    const withUuid2 = errorGroupKey("telephony", "ARI: call 9a8b7c6d-5e4f-4a3b-9c2d-ffeeddccbbaa hangup failed");
    expect(withUuid).toBe(withUuid2);
    // Разный текст остаётся разными типами.
    expect(errorGroupKey("telephony", "ARI: канал 1 не ответил")).not.toBe(errorGroupKey("telephony", "ARI: канал 1 занят"));
    expect(errorGroupKey("ai", "x 1")).not.toBe(errorGroupKey("telephony", "x 1"));
  });
});
