import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { PhoneOff } from "lucide-react";
import type { RobotCallStopState } from "@royal-home/shared";
import { ClientMoreMenu, closesSheetOnSelect } from "./ClientMoreMenu";
import { robotStopOptimistic } from "../hooks/useClients";

/** «Не звонить роботом» (П3, 11.11.2026): строка-тумблер меню «Ещё» — одна на ПК и телефон. */
function renderToggle(checked: boolean, extra: { disabled?: boolean; hint?: string } = {}) {
  return renderToStaticMarkup(
    <ClientMoreMenu
      groups={[{ key: "extra", items: [{ key: "robot-stop", label: "Не звонить роботом", icon: PhoneOff, checked, onSelect: vi.fn(), ...extra }] }]}
    />
  );
}

describe("строка-тумблер «Не звонить роботом»", () => {
  it("объявлена переключателем, подпись — текущее положение", () => {
    const on = renderToggle(true);
    expect(on).toContain('role="switch"');
    expect(on).toContain('aria-checked="true"');
    expect(on).toContain("Включено");
    expect(on).not.toContain("cd-mi-c");
    const off = renderToggle(false);
    expect(off).toContain('aria-checked="false"');
    expect(off).toContain("Выключено");
  });

  it("просьба клиента — строка погашена и объяснена", () => {
    const html = renderToggle(true, { disabled: true, hint: "Клиент сам просил не звонить — снять может руководитель" });
    expect(html).toMatch(/<button[^>]*disabled/);
    expect(html).toContain("снять может руководитель");
  });

  it("тумблер шторку на телефоне не закрывает, обычная строка — закрывает", () => {
    expect(closesSheetOnSelect({ checked: true })).toBe(false);
    expect(closesSheetOnSelect({ checked: false })).toBe(false);
    expect(closesSheetOnSelect({})).toBe(true);
  });

  it("обычные строки меню переключателями не становятся", () => {
    const html = renderToStaticMarkup(
      <ClientMoreMenu groups={[{ key: "main", items: [{ key: "x", label: "Тип карточки", icon: PhoneOff, onSelect: vi.fn() }] }]} />
    );
    expect(html).not.toContain('role="switch"');
  });
});

describe("тумблер переключается сразу", () => {
  const base: RobotCallStopState = { stopped: false, staffStop: false, clientReasons: [], since: null, optedOutInChat: false,
    allowedBySupervisor: false, canClear: false, canOverride: false };
  it("включение — своя отметка, её можно снять", () => {
    const next = robotStopOptimistic(base, { stopped: true }, new Date("2026-11-11T07:00:00Z"));
    expect(next).toMatchObject({ stopped: true, staffStop: true, canClear: true, since: "2026-11-11T07:00:00.000Z" });
  });
  it("снятие своей отметки при просьбе клиента — запрет остаётся, разрешения нет", () => {
    const both: RobotCallStopState = { ...base, stopped: true, staffStop: true, clientReasons: ["CONVERSATION"], optedOutInChat: true, canClear: true, canOverride: true };
    expect(robotStopOptimistic(both, { stopped: false })).toMatchObject({ stopped: true, staffStop: false, allowedBySupervisor: false });
  });
  it("явное разрешение руководителя снимает всё и отмечается; включение его отзывает", () => {
    const chat: RobotCallStopState = { ...base, stopped: true, clientReasons: ["CONVERSATION"], optedOutInChat: true, canOverride: true };
    const off = robotStopOptimistic(chat, { stopped: false, overrideClientRequest: true });
    expect(off).toMatchObject({ stopped: false, clientReasons: [], allowedBySupervisor: true });
    expect(robotStopOptimistic(off, { stopped: true })).toMatchObject({ stopped: true, allowedBySupervisor: false });
  });
});
