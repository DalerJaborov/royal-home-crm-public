import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { PhoneOff } from "lucide-react";
import type { RobotCallStopState } from "@royal-home/shared";
import { ClientMoreMenu } from "./ClientMoreMenu";
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

  it("обычные строки меню переключателями не становятся", () => {
    const html = renderToStaticMarkup(
      <ClientMoreMenu groups={[{ key: "main", items: [{ key: "x", label: "Тип карточки", icon: PhoneOff, onSelect: vi.fn() }] }]} />
    );
    expect(html).not.toContain('role="switch"');
  });
});

describe("тумблер переключается сразу", () => {
  const base: RobotCallStopState = { stopped: false, source: null, since: null, optedOutInChat: false, canClear: false };
  it("включение — своя отметка, её можно снять", () => {
    const next = robotStopOptimistic(base, true, new Date("2026-11-11T07:00:00Z"));
    expect(next).toMatchObject({ stopped: true, source: "STAFF", canClear: true, since: "2026-11-11T07:00:00.000Z" });
  });
  it("выключение гасит источник; чужая просьба при включении не подменяется", () => {
    const voice: RobotCallStopState = { ...base, stopped: true, source: "VOICE", since: "x", canClear: false };
    expect(robotStopOptimistic(voice, true)).toBe(voice);
    expect(robotStopOptimistic(voice, false)).toMatchObject({ stopped: false, source: null });
  });
});
