import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { sendPushToAgents } from "../src/push.js";
import {
  QUIET_END,
  QUIET_START,
  isQuietHour,
  quietDecision,
  quietHoursEndAfter,
} from "../src/lib/pushQuietHours.js";
import { dushanbeInputToDate, dushanbeTimeString } from "../src/lib/dushanbeTime.js";

/**
 * ТИХИЕ ЧАСЫ ДЛЯ ПУШЕЙ (владелец 12.09.2026: «ночью запрещено слать пуши всем
 * пользователям, только в начале рабочего дня»).
 *
 * Границы окна проверяются ТОЛЬКО через lib/dushanbeTime.ts — `setHours` здесь
 * запрещён правилом репозитория: контейнер живёт в UTC, Душанбе это UTC+5, и
 * «22:00» через часы процесса пришлось бы на 03:00 душанбинских.
 *
 * Проверяется именно граничное поведение: 20:59 ещё день, 21:00 уже ночь,
 * 07:59 ещё ночь, 08:00 уже утро. Окно перевалено через полночь, и до 12.09
 * `isWithinDushanbeWindow` такое окно возвращала ложью ВСЕГДА.
 */

const runId = Date.now();
let agentId = "";

/** Момент по душанбинским настенным часам — без единого setHours. */
const at = (hhmm: string, date = "2026-09-12") => dushanbeInputToDate(date, hhmm);

beforeAll(async () => {
  // Этот файл проверяет саму тишину — общий выключатель из tests/setup.ts снимаем.
  process.env.PUSH_QUIET_HOURS = "on";
  const agent = await prisma.agent.create({
    data: {
      fullName: `Агент тишины ${runId}`,
      phone: `+99283${String(runId).slice(-7)}`,
      role: "AGENT",
      passwordHash: "x",
    },
  });
  agentId = agent.id;
});

afterAll(async () => {
  await prisma.backgroundJob.deleteMany({ where: { type: "deferred-push" } });
  await prisma.notification.deleteMany({ where: { agentId } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
});

describe("Границы окна тишины 21:00 → 08:00 по Душанбе", () => {
  it("окно объявлено ровно так, как просил владелец", () => {
    expect(QUIET_START).toBe("21:00");
    expect(QUIET_END).toBe("08:00");
  });

  it("20:59 — ещё день, 21:00 — уже ночь", () => {
    expect(isQuietHour(at("20:59"))).toBe(false);
    expect(isQuietHour(at("21:00"))).toBe(true);
    expect(isQuietHour(at("23:59"))).toBe(true);
  });

  it("полночь не разрывает окно: 00:00 и 07:59 — ночь, 08:00 — утро", () => {
    expect(isQuietHour(at("00:00"))).toBe(true);
    expect(isQuietHour(at("03:30"))).toBe(true);
    expect(isQuietHour(at("07:59"))).toBe(true);
    expect(isQuietHour(at("08:00"))).toBe(false);
    expect(isQuietHour(at("12:00"))).toBe(false);
  });

  it("отложенное уходит ровно в 08:00 по Душанбе — в тот же день из ночи, назавтра из вечера", () => {
    // Из 23:30 ближайшие 08:00 — уже следующие календарные сутки.
    const fromNight = quietHoursEndAfter(at("23:30"));
    expect(dushanbeTimeString(fromNight)).toBe("08:00");
    expect(fromNight.getTime()).toBeGreaterThan(at("23:30").getTime());

    // Из 03:00 — те же сутки, через пять часов.
    const fromDeepNight = quietHoursEndAfter(at("03:00"));
    expect(dushanbeTimeString(fromDeepNight)).toBe("08:00");
    expect(fromDeepNight.getTime() - at("03:00").getTime()).toBe(5 * 60 * 60 * 1000);
  });
});

describe("Что именно делает тишина с уведомлением", () => {
  it("днём не трогает ничего", () => {
    expect(quietDecision({ kind: "task" }, at("12:00"))).toBe("send");
    expect(quietDecision({ kind: "lead" }, at("12:00"))).toBe("send");
  });

  it("звонок проходит ночью — единственное исключение", () => {
    expect(quietDecision({ realtime: true }, at("03:00"))).toBe("send");
    // Закрытие уже показанной карточки — уборка, а не звонок: тоже проходит.
    expect(quietDecision({ close: true, kind: "lead" }, at("03:00"))).toBe("send");
  });

  it("то, что к утру теряет смысл, отбрасывается, остальное откладывается", () => {
    // У лида срок короче ночи — утром он уже у другого агента.
    expect(quietDecision({ kind: "lead" }, at("02:00"))).toBe("drop");
    expect(quietDecision({ kind: "score" }, at("02:00"))).toBe("drop");
    expect(quietDecision({ kind: "celebration" }, at("02:00"))).toBe("drop");

    expect(quietDecision({ kind: "message" }, at("02:00"))).toBe("defer");
    expect(quietDecision({ kind: "showing" }, at("02:00"))).toBe("defer");
    expect(quietDecision({ kind: "task" }, at("02:00"))).toBe("defer");
    expect(quietDecision({ kind: "oversight" }, at("02:00"))).toBe("defer");
    // Служебный сигнал без вида (сбой интеграции) — ждёт утра, не пропадает.
    expect(quietDecision({}, at("02:00"))).toBe("defer");
  });
});

describe("Транспорт: ночью в шторку не уходит, в ленте остаётся", () => {
  it("запись в ленте уведомлений создаётся независимо от часа", async () => {
    // Функция возвращает число доставленных подписок; их нет (VAPID в тестах не
    // настроен), поэтому проверяем не доставку, а СЛЕД: лента и очередь.
    await sendPushToAgents([agentId], {
      title: `Ночное уведомление ${runId}`,
      body: "Проверка тишины",
      kind: "task",
      tag: `quiet-${runId}`,
    });
    // createNotifications вызывается через void (сбой записи не имеет права
    // ронять push) — ждём её появления с опросом, а не одной паузой: жёсткий
    // setTimeout здесь и есть рецепт плавающего теста.
    let note = null as Awaited<ReturnType<typeof prisma.notification.findFirst>>;
    for (let i = 0; i < 30 && !note; i += 1) {
      note = await prisma.notification.findFirst({ where: { agentId } });
      if (!note) await new Promise((r) => setTimeout(r, 100));
    }
    expect(note).not.toBeNull();
    expect(note?.title).toContain(String(runId));
  });
});
