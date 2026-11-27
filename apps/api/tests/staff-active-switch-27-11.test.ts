import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

/**
 * ОТВЕТ СОТРУДНИКА НЕ ГЛУШИТ БОТА НИ В ОДНОМ КАНАЛЕ (владелец 27.11.2026: «Да, убрать и его»).
 * Молчание оператора приёма (staffActive, staffQuietMinutes 180 мин) в WhatsApp, Instagram и Facebook теперь за тем же
 * рубильником, что автопауза: botPauseOnStaffReplyEnabled. Выкл (по умолчанию) — staffActive всегда false, бот отвечает;
 * вкл — прежнее поведение. Сообщения сотрудника остаются в истории бота (staffThread не зависит от рубильника).
 * Рубильник подменён в модуле: тесты идут в несколько процессов на одной базе.
 */
const { switchState } = vi.hoisted(() => ({ switchState: { on: false } }));
vi.mock("../src/lib/automationSwitches.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/lib/automationSwitches.js")>();
  return {
    ...original,
    automationSwitchOn: async (key: Parameters<typeof original.automationSwitchOn>[0], db?: Parameters<typeof original.automationSwitchOn>[1]) =>
      key === "botPauseOnStaffReplyEnabled" ? switchState.on : original.automationSwitchOn(key, db),
  };
});

const { prisma } = await import("../src/db.js");
const { loadOperatorTurnSetup } = await import("../src/lib/operatorTurn.js");
const { LEAD_ONLY_DEFAULTS } = await import("../src/ai/leadOnlyMode.js");

const runId = Date.now().toString(36);
const ids: string[] = [];
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

async function conversation(channel: string, staffMinutesAgo: number | null) {
  const messages: unknown[] = [{ role: "user", content: "Здравствуйте", at: ago(60) }];
  if (staffMinutesAgo !== null) messages.push({ role: "assistant", content: "Это сотрудник", at: ago(staffMinutesAgo), by: { kind: "agent", agentId: "a1" } });
  messages.push({ role: "user", content: "Ещё вопрос", at: ago(1) });
  const c = await prisma.botConversation.create({
    data: { channel: channel as never, subscriberId: `staff-active-${runId}-${ids.length}`, messages: messages as never },
  });
  ids.push(c.id);
  return c.id;
}

const setup = async (channel: string, conversationId: string) =>
  (await loadOperatorTurnSetup({ channel, conversationId, config: { ...LEAD_ONLY_DEFAULTS, enabled: true }, focusPropertyId: null, phoneKnownByChannel: true })).ctx;

afterEach(() => { switchState.on = false; });
afterAll(async () => { if (ids.length) await prisma.botConversation.deleteMany({ where: { id: { in: ids } } }); });

describe("рубильник ВЫКЛ (по умолчанию): staffActive не включается", () => {
  for (const channel of ["WHATSAPP", "INSTAGRAM", "FACEBOOK"]) {
    it(`${channel}: сотрудник писал 10 минут назад — бот не молчит, но знает, что сотрудник писал`, async () => {
      const ctx = await setup(channel, await conversation(channel, 10));
      expect(ctx.staffActive).toBe(false);
      expect(ctx.staffThread).toBe(true); // сообщения сотрудника в истории: бот не здоровается заново и не противоречит
    });
  }
});

describe("рубильник ВКЛ: прежнее поведение", () => {
  for (const channel of ["WHATSAPP", "INSTAGRAM", "FACEBOOK"]) {
    it(`${channel}: свежий ответ сотрудника — staffActive, давний — нет`, async () => {
      switchState.on = true;
      expect((await setup(channel, await conversation(channel, 10))).staffActive).toBe(true);
      expect((await setup(channel, await conversation(channel, 600))).staffActive).toBe(false);
      expect((await setup(channel, await conversation(channel, null))).staffActive).toBe(false);
    });
  }
});
