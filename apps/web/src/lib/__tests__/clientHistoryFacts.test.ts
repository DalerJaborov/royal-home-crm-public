import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { clientHistoryFacts } from "../clientHistoryFacts";
import type { Interaction } from "../../types";

/** Аудит 04.10.2026, WEB-PAGES21: факты истории выводились из усечённых 200 записей карточки. */
const sys = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `s${i}`, type: "SYSTEM" }) as unknown as Interaction);
const showing = (extra: Partial<Interaction> = {}) => ({ id: "sh", type: "SHOWING", ...extra }) as unknown as Interaction;
const call = (sec: number) => ({ id: `c${sec}`, type: "CALL", recordingDurationSec: sec }) as unknown as Interaction;

describe("факты истории клиента", () => {
  it("старый показ вне усечённых 200 записей: серверный факт открывает «Завершить сделку»", () => {
    const facts = clientHistoryFacts({ interactions: sys(200), hadConductedShowing: true, hadRealCall: true, callsCount: 2 }, 30);
    expect(facts.hadShowing).toBe(true);
    expect(facts.hadRealContact).toBe(true);
    expect(facts.callsCount).toBe(2);
  });

  it("без серверных полей (старый ответ) считаем по тому, что пришло", () => {
    const facts = clientHistoryFacts({ interactions: [showing({ completedAt: "2026-09-01T10:00:00Z" } as never), call(45)] }, 30);
    expect(facts.hadShowing).toBe(true);
    expect(facts.hadRealCall).toBe(true);
    expect(facts.callsCount).toBe(1);
  });

  it("назначенный на будущее и отменённый показ не считаются проведёнными", () => {
    const future = showing({ nextActionDate: "2999-01-01T10:00:00Z" } as never);
    const declined = showing({ declinedAt: "2026-09-01T10:00:00Z" } as never);
    expect(clientHistoryFacts({ interactions: [future, declined] }, 30).hadShowing).toBe(false);
  });

  it("короткий недозвон не настоящий разговор, но ответ клиента в переписке даёт контакт", () => {
    expect(clientHistoryFacts({ interactions: [call(3)] }, 30).hadRealContact).toBe(false);
    expect(clientHistoryFacts({ interactions: [call(3)], lastClientMessageAt: "2026-10-01T10:00:00Z" }, 30).hadRealContact).toBe(true);
  });

  it("счёт звонков берёт больший из серверного и локального", () => {
    expect(clientHistoryFacts({ interactions: [call(3), call(50)], callsCount: 7 }, 30).callsCount).toBe(7);
    expect(clientHistoryFacts({ interactions: [call(3), call(50)], callsCount: 0 }, 30).callsCount).toBe(2);
  });

  it("клиента ещё нет: всё ложно", () => {
    expect(clientHistoryFacts(undefined, 30)).toEqual({ hadShowing: false, hadRealCall: false, hadRealContact: false, callsCount: 0 });
  });
});

describe("ClientDetail", () => {
  it("берёт факты из clientHistoryFacts, а не выводит из усечённых interactions", () => {
    const src = readFileSync(fileURLToPath(new URL("../../pages/ClientDetail.tsx", import.meta.url)), "utf8");
    expect(src).toContain("clientHistoryFacts(");
    expect(src).not.toContain('const callsCount = interactions.filter((i) => i.type === "CALL").length;');
  });
});
