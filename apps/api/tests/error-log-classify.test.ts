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

  it("голосовое расшифровано дешёвой/резервной моделью — operational (текст получен, журнал 28.11.2026)", () => {
    expect(classifyErrorLog("ai", "Голосовое (out-005217979-1005-20261128.mp3) расшифровано ДЕШЁВОЙ моделью gemini-3.6-flash — все дорогие не ответили/отказали: gemini-3.1-pro-preview (не ответила за 102 с)")).toBe("operational");
    expect(classifyErrorLog("ai", "Голосовое (a.ogg) расшифровано резервной дорогой моделью X — основная Y недоступна.")).toBe("operational");
    expect(classifyErrorLog("ai", "Голосовое клиента в переписке не расшифровано: модель вернула пустую расшифровку")).toBe("actionable");
  });

  it.each([
    "Бот не ответил клиенту (причина «original_context_changed»): переписка изменилась, пока бот готовил ответ, и ответ не ушёл. Текст в чате CRM, ответственный получил уведомление; ответить нужно вручную.",
    "Бот не ответил клиенту (причина «operation_closed»): бот не смог подготовить ответ. Текст в чате CRM, ответственный получил уведомление; ответить нужно вручную.",
    "Бот не смог ответить по существу (unsupported_decision_evidence) — клиенту ушла короткая фраза «это скажет агент», ответственному — сигнал",
    "Повтор ответа бота остановлен (615b44c3-2940-43e3-8b5d-c14944d55e19): 3 пустых повтора (через 6 часов одна новая попытка) — ИИ по этому сообщению сейчас не зовётся.",
    "Голосовое клиента в переписке не расшифровано: модель вернула пустую расшифровку (speech=unintelligible, язык=unknown), канал FACEBOOK",
    "Профиль Messenger не получен: Meta не отдаёт имя по части собеседников (HTTP 400 Unsupported get request) — имя остаётся пустым, это не поломка.",
    "Вкладки на старой сборке дольше 30 минут: 2. Текущая сборка 1795826417971; старые: 1795804045239 (2)",
    "Meta вернула разные идентификаторы подписок Instagram («Royal Home» — 1; «Royal Home Info» — 2). Это само по себе не доказывает разные приложения",
    "Звонок восстановлен постфактум по поиску на станции: клиент Шахноза (#1017)",
    "Бот под комментарием (YOUTUBE) назвал цену, которой нет в карточке (6500) — фраза вырезана. [8eaec2a8]",
    "Настройки групп объявлений act_2882470011985212: таргетинг и promoted_object не прочитаны, берём базовые поля группы: Marketing API: Invalid parameter",
    "Заявка из переписки (INSTAGRAM) заведена как «прочее обращение»: коммерческий объект — мы коммерцией не занимаемся.",
  ])("журнал 28.11.2026: след без действия — operational: %s", (text) => {
    expect(classifyErrorLog("ai", text)).toBe("operational");
  });

  it("журнал 28.11.2026: то, что требует человека, остаётся actionable", () => {
    for (const text of [
      "[alarm] Бот пообещал, что агент свяжется, но номера у бота нет и карточки нет. Напишите клиенту и попросите номер",
      "[alarm] Режим «только заявки»: бот обещал звонок, а заявка ушла в «Прочие обращения» без агента. Позвоните клиенту или напишите ему.",
      "Бот не ответил клиенту (причина «x», собеседник неизвестен): текст не попал в чат CRM, а кто писал, прочитать не удалось — уведомить некого.",
      "Instagram «Royal Home Info»: диалоги в CRM не обновлялись с 2026-11-10, хотя у другого аккаунта есть обновления.",
      "Реклама [AD_REJECTED] «Публикация»: Meta отклонила объявление",
    ]) expect(classifyErrorLog("meta", text)).toBe("actionable");
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

  it("40 типов разного возраста: первыми идут самые частые, а не самые свежие (журнал 17.11.2026)", () => {
    // Старый частый тип (лиды без агента 13–15.11) и 39 свежих одиночек за последние сутки.
    const week = new Date("2026-11-13T07:00:00Z");
    const rows = [
      ...Array.from({ length: 10 }, (_, i) => ({
        source: "ai", message: "Заявка из переписки заведена как «прочее обращение»: намерение не определено",
        createdAt: new Date(week.getTime() + i * 3_600_000), url: null,
      })),
      ...Array.from({ length: 39 }, (_, i) => ({
        source: `src${i}`, message: `Свежая разовая поломка вида ${String.fromCharCode(0x430 + (i % 30))}${"я".repeat(i)}`,
        createdAt: new Date(Date.UTC(2026, 10, 16, 23, 0) - i * 60_000), url: null,
      })),
    ];
    const groups = groupErrorLogEntries(rows);
    expect(groups).toHaveLength(40);
    expect(groups[0]!.count).toBe(10);
    expect(groups.slice(0, 30).some((g) => g.message.includes("намерение не определено"))).toBe(true);
    expect(groups[0]!.firstAt).toEqual(week);
  });

  it("требующие действия идут раньше эксплуатационного шума при любом числе", () => {
    const at = new Date("2026-11-16T10:00:00Z");
    const rows = [
      ...Array.from({ length: 5 }, () => ({ source: "ai", message: "Gemini не ответил с первого раза (chat) — помог повтор", createdAt: at, url: null })),
      { source: "telegram", message: "Бот не получает сообщения от Telegram дольше трёх минут", createdAt: at, url: null },
    ];
    const groups = groupErrorLogEntries(rows);
    expect(groups[0]!.source).toBe("telegram");
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
