import { describe, expect, it } from "vitest";
import { backState, callAttemptText, canPauseLeads, chatChip, deviceKindLabel, leadsPaused, weekScoreTone } from "../agentCardText";
import type { TeamMember } from "../../hooks/useTeam";

/** Тексты карточки сотрудника вынесены из страницы (22.11.2026): старый и новый вид говорят одинаково. */
const member = (patch: Partial<TeamMember>) => ({ role: "AGENT", isActive: true, frozen: false, leadsPausedUntil: null, ...patch }) as TeamMember;

describe("тексты карточки сотрудника", () => {
  it("устройство различает телефон и компьютер по ОС", () => {
    expect(deviceKindLabel("Safari · iOS")).toBe("с телефона");
    expect(deviceKindLabel("Chrome · Android")).toBe("с телефона");
    expect(deviceKindLabel("Chrome · Windows")).toBe("с компьютера");
    expect(deviceKindLabel(null)).toBeNull();
  });

  it("чип переписки: ждёт ответа — тревога, бот — спокойно, агент — без чипа", () => {
    expect(chatChip("client")).toEqual({ text: "ждёт ответа", crit: true });
    expect(chatChip("bot")?.crit).toBe(false);
    expect(chatChip("agent")).toBeNull();
  });

  it("оценка недели: 70+ хорошо, 40+ внимание, ниже — плохо", () => {
    expect(weekScoreTone(70)).toBe("ok");
    expect(weekScoreTone(69)).toBe("warn");
    expect(weekScoreTone(40)).toBe("warn");
    expect(weekScoreTone(39)).toBe("crit");
  });

  it("пауза заявок: действует только до своего срока; кнопка — рабочему агенту", () => {
    expect(leadsPaused(member({ leadsPausedUntil: new Date(Date.now() + 3600_000).toISOString() }))).toBe(true);
    expect(leadsPaused(member({ leadsPausedUntil: new Date(Date.now() - 3600_000).toISOString() }))).toBe(false);
    expect(canPauseLeads(member({}))).toBe(true);
    expect(canPauseLeads(member({ frozen: true }))).toBe(false);
    expect(canPauseLeads(member({ role: "MANAGER" }))).toBe(false);
  });

  it("попытка звонка и возврат на карточку", () => {
    expect(callAttemptText({ callAttempt: "NO_ANSWER", durationSec: null })).toBe("клиент не ответил");
    expect(callAttemptText({ callAttempt: "OTHER", durationSec: null })).toBe("");
    expect(backState("a1", "Имя")).toEqual({ from: "/team/a1", fromLabel: "Имя" });
  });
});
