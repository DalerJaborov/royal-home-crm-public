import { describe, expect, it } from "vitest";
import { canSendPauseAlert, hadCallContactAfter, pauseWatchStageFor } from "../src/lib/botPauseWatch.js";

/**
 * «Бот на паузе и забыли» (Пачка 17, 12.09.2026) — чистые правила порогов и
 * дедупа пуша, без базы (см. doc-comment в src/lib/botPauseWatch.ts за
 * причиной, почему новые колонки читаются через $queryRaw — та же причина,
 * по которой сквозной прогон с БД сюда не включён: миграция руками, клиент
 * Prisma не регенерирован в этом worktree).
 */
describe("pauseWatchStageFor", () => {
  const cfg = { alertHours: 24, escalateHours: 72 };

  it("до порога предупреждения — ничего", () => {
    expect(pauseWatchStageFor(0, cfg)).toBe("none");
    expect(pauseWatchStageFor(23.9, cfg)).toBe("none");
  });

  it("на пороге и выше предупреждения — «alert»", () => {
    expect(pauseWatchStageFor(24, cfg)).toBe("alert");
    expect(pauseWatchStageFor(71.9, cfg)).toBe("alert");
  });

  it("на пороге и выше автоснятия — «escalate»", () => {
    expect(pauseWatchStageFor(72, cfg)).toBe("escalate");
    expect(pauseWatchStageFor(1000, cfg)).toBe("escalate");
  });

  it("уважает изменённые в настройках пороги", () => {
    const custom = { alertHours: 6, escalateHours: 12 };
    expect(pauseWatchStageFor(5, custom)).toBe("none");
    expect(pauseWatchStageFor(6, custom)).toBe("alert");
    expect(pauseWatchStageFor(12, custom)).toBe("escalate");
  });
});

describe("canSendPauseAlert", () => {
  const now = new Date("2026-09-12T12:00:00Z");

  it("никогда не слали — можно", () => {
    expect(canSendPauseAlert(null, now)).toBe(true);
  });

  it("слали меньше суток назад — нельзя (дедуп раза в сутки)", () => {
    const sentAt = new Date(now.getTime() - 23 * 3_600_000);
    expect(canSendPauseAlert(sentAt, now)).toBe(false);
  });

  it("слали ровно сутки назад или раньше — можно снова", () => {
    const sentAt = new Date(now.getTime() - 24 * 3_600_000);
    expect(canSendPauseAlert(sentAt, now)).toBe(true);
    const longAgo = new Date(now.getTime() - 48 * 3_600_000);
    expect(canSendPauseAlert(longAgo, now)).toBe(true);
  });
});

/**
 * Карточка ПР-000381 (22.09.2026, 17:20): «агент не ответил клиенту 73 ч» была
 * ложью — агент созванивался с клиентом каждый день, просто не в чате бота.
 * Звонок виден боту только через Interaction (чат этого не знает), поэтому
 * тик сверяет его отдельно — см. doc-comment botPauseWatch.ts.
 */
describe("hadCallContactAfter", () => {
  const lastMessageAt = new Date("2026-09-19T10:00:00Z");
  // now/escalateHoursWindow — правка ревью 24.09.2026, см. doc-comment у функции:
  // lastCallAt — максимум по ВСЕЙ истории звонков, а не только недавних, так что
  // «был после реплики» одного само по себе уже недостаточно.
  const escalateHoursWindow = 72;

  it("звонка не было вовсе — контакта нет", () => {
    const now = new Date(lastMessageAt.getTime() + 3_600_000);
    expect(hadCallContactAfter(lastMessageAt, null, now, escalateHoursWindow)).toBe(false);
  });

  it("звонок был ДО последней реплики клиента в чате — контакта после неё нет", () => {
    const before = new Date("2026-09-18T10:00:00Z");
    const now = new Date(lastMessageAt.getTime() + 3_600_000);
    expect(hadCallContactAfter(lastMessageAt, before, now, escalateHoursWindow)).toBe(false);
  });

  it("звонок был ПОСЛЕ последней реплики клиента И внутри окна эскалации — контакт есть, как у ПР-000381", () => {
    const after = new Date("2026-09-22T17:00:00Z");
    // «Сейчас» — два часа спустя звонка, окно 72 ч ещё далеко не вышло.
    const now = new Date(after.getTime() + 2 * 3_600_000);
    expect(hadCallContactAfter(lastMessageAt, after, now, escalateHoursWindow)).toBe(true);
  });

  it("звонок ровно в момент последней реплики — не считается контактом ПОСЛЕ (строгое >)", () => {
    const now = new Date(lastMessageAt.getTime() + 3_600_000);
    expect(hadCallContactAfter(lastMessageAt, lastMessageAt, now, escalateHoursWindow)).toBe(false);
  });

  it("звонок был 2 часа назад — контакт свежий, эскалацию блокирует (не эскалируем)", () => {
    const callAt = new Date("2026-09-24T08:00:00Z");
    const now = new Date(callAt.getTime() + 2 * 3_600_000);
    expect(hadCallContactAfter(lastMessageAt, callAt, now, escalateHoursWindow)).toBe(true);
  });

  it("звонок был 5 дней назад при окне 72 ч — контакт устарел, эскалируем (правка ревью 24.09.2026)", () => {
    // Живой сценарий бага: единственный звонок случился сразу после реплики
    // клиента, но это было пять дней назад — с тех пор агент молчит. Раньше
    // hadCallContactAfter смотрела только «звонок ПОСЛЕ реплики» и блокировала
    // эскалацию НАВСЕГДА; теперь звонок старше escalateHours (72 ч) эскалацию
    // больше не блокирует.
    const callAt = new Date("2026-09-19T11:00:00Z"); // через час после lastMessageAt
    const now = new Date(callAt.getTime() + 5 * 24 * 3_600_000);
    expect(hadCallContactAfter(lastMessageAt, callAt, now, escalateHoursWindow)).toBe(false);
  });
});
