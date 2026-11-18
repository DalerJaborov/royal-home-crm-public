// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RoyalCallFlag, RoyalCallListen, RoyalCallRow } from "./RoyalCallRow";
import { CALL_ICONS } from "./callIconData";
import { TranscriptView } from "../../TranscriptView";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

// Текст слоя с диска: в окружении jsdom адрес модуля не file://, а ?raw для .css отдаёт пустую строку.
const CSS_FILE = ["src/theme-look-royal-calls.css", "apps/web/src/theme-look-royal-calls.css"].map((p) => resolve(process.cwd(), p)).find((p) => existsSync(p))!;
const callsCss = readFileSync(CSS_FILE, "utf8");

/**
 * «Новый вид», пачка calls (18.11.2026).
 *
 * Окно звонка критичное: на стенде SIP нет, поэтому здесь проверяется, что в новом
 * виде те же кнопки на месте и их обработчики не тронуты (то же «Отменить» зовёт ту
 * же отмену), что окно несёт метку раздела только при признаке, и что в слое кнопка
 * сброса крупная (≥ 56 px) и красная, а трубка наборщика — зелёная.
 */
const h = vi.hoisted(() => ({
  royal: true,
  cancel: vi.fn(),
  call: {
    channelId: "ch-1", clientId: "client-1", clientShortId: 211, clientName: "Зарина Рахимова", dialingTo: "+992900000002",
    state: "ringing_client", startedAt: "2026-11-18T07:00:00.000Z", answeredAt: null, talkSeconds: 0, outcome: null, cancelled: false, clientRang: false,
  } as Record<string, unknown>,
}));

vi.mock("../../../hooks/useActiveCall", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../hooks/useActiveCall")>()),
  useActiveCall: () => ({ data: h.call }),
  useCancelActiveCall: () => ({ mutate: h.cancel, isPending: false, isError: false, error: null }),
}));
vi.mock("../../../hooks/useRoyalLook", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../hooks/useRoyalLook")>()),
  useRoyalLook: () => h.royal,
}));
vi.mock("../../../hooks/useCleanShell", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../hooks/useCleanShell")>()),
  useCleanShell: () => true,
}));

const { CallWindow } = await import("../../CallWindow");

afterEach(cleanup);
beforeEach(() => {
  // jsdom без matchMedia (TranscriptView спрашивает ширину экрана).
  window.matchMedia = ((query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  h.cancel.mockReset(); h.royal = true; h.call = { ...h.call, state: "ringing_client", talkSeconds: 0 }; });

function renderWindow() {
  return render(<MemoryRouter><CallWindow /></MemoryRouter>);
}

describe("окно звонка в новом виде", () => {
  it("несёт метку раздела calls, кнопка «Отменить» на месте и зовёт ту же отмену", () => {
    const { container } = renderWindow();
    expect(container.querySelector('.ry-cw[data-ry-section="calls"] .cw2')).not.toBeNull();
    const end = screen.getByRole("button", { name: /Отменить/ });
    expect(end.className).toContain("cw2-btn");
    expect(end.className).toContain("end");
    expect((end as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(end);
    expect(h.cancel).toHaveBeenCalledTimes(1);
    // Свернуть и закрыть — прежние кнопки шапки.
    expect(screen.getByRole("button", { name: /Свернуть, звонок продолжится/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Закрыть окно, звонок продолжится/ })).toBeTruthy();
    // Кнопки «Ответить» нет и не появилось: входящую трубку CRM не держит (решение 18.08.2026).
    expect(screen.queryByRole("button", { name: /Ответить/ })).toBeNull();
  });

  it("во время разговора кнопка выключена (из браузера разговор не завершить) — как было", () => {
    h.call = { ...h.call, state: "talking", answeredAt: "2026-11-18T07:00:10.000Z", talkSeconds: 42 };
    renderWindow();
    const end = screen.getByRole("button", { name: /Идёт разговор/ });
    expect((end as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(end);
    expect(h.cancel).not.toHaveBeenCalled();
  });

  it("без признака вида — прежнее дерево без метки раздела, та же кнопка", () => {
    h.royal = false;
    const { container } = renderWindow();
    expect(container.querySelector("[data-ry-section]")).toBeNull();
    expect(container.querySelector(".ry-cw")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Отменить/ }));
    expect(h.cancel).toHaveBeenCalledTimes(1);
  });
});

describe("слой calls: кнопки звонка крупные и со своим смыслом", () => {
  const css = callsCss;
  const ruleBody = (selectorPart: string) => {
    const m = new RegExp(`${selectorPart.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`).exec(css);
    return m?.[1] ?? "";
  };
  const px = (body: string, prop: string) => Number(new RegExp(`(?:^|;|\\s)${prop}:\\s*(\\d+)px`).exec(body)?.[1] ?? 0);

  it("«Отменить вызов» — красная, высотой не меньше 56 px, на телефоне тоже", () => {
    const body = ruleBody('.ry-cw[data-ry-section="calls"] .cw2-btn.end');
    expect(body).toMatch(/background:\s*var\(--rh-ui-crit\)/);
    expect(px(body, "height")).toBeGreaterThanOrEqual(56);
    const phone = /@media \(max-width: 640px\)[\s\S]*?\.cw2-btn\.end\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(px(phone, "height")).toBeGreaterThanOrEqual(56);
  });

  it("трубка наборщика и «Перезвонить» — зелёные, общий синий их не красит", () => {
    expect(ruleBody('[data-ry-section="calls"] .dp-call')).toMatch(/background:\s*var\(--ry-call-green\)/);
    expect(ruleBody('[data-ry-section="calls"] .ry-call-act')).toMatch(/background:\s*var\(--ry-call-green\)/);
    expect(css.replace(/\/\*[\s\S]*?\*\//g, "")).not.toMatch(/\.(dp-call|ry-call-act)[^{]*\{[^}]*background:\s*var\(--rh-ui-primary/);
  });

  it("сторож ловит поломку: кнопка ниже 56 px не проходит", () => {
    const broken = css.replace(/(\.ry-cw\[data-ry-section="calls"\] \.cw2-btn\.end \{[^}]*?)height: 64px/, "$1height: 40px");
    const body = new RegExp('\\.ry-cw\\[data-ry-section="calls"\\] \\.cw2-btn\\.end\\s*\\{([^}]*)\\}').exec(broken)?.[1] ?? "";
    expect(px(body, "height")).toBeLessThan(56);
  });
});

describe("строка звонка", () => {
  const html = (node: React.ReactNode) => renderToStaticMarkup(<MemoryRouter>{node}</MemoryRouter>);

  it("пропущенный отличается не только цветом: свой значок и подпись словом", () => {
    const missed = html(<RoyalCallRow dir="missed" dirLabel="Пропущенный входящий" title="Клиент" meta={["Пропущенный", "10:30"]} />);
    const out = html(<RoyalCallRow dir="out" dirLabel="Исходящий" title="Клиент" meta={["Исходящий", "10:30"]} />);
    expect(missed).toContain('data-dir="missed"');
    expect(missed).toContain('aria-label="Пропущенный входящий"');
    expect(missed).toContain('data-tone="crit"');
    expect(CALL_ICONS["phone-outgoing"].line).not.toEqual("");
    // Значки разные: у исходящего — своя стрелка наружу, у пропущенного — трубка с крестиком.
    expect(out).toContain('stroke-linecap="round"');
    expect(missed).not.toContain('stroke-linecap="round"');
  });

  it("ничего не прячет: суть, все пометки и одна кнопка на месте", () => {
    const markup = html(
      <RoyalCallRow dir="out" dirLabel="Исходящий" title="Клиент" meta={["Исходящий", "5 мин назад", "4:05", "Ноза"]}
        note="Договорились о показе" flags={<><RoyalCallFlag tone="ok">Балл 82</RoyalCallFlag><RoyalCallFlag tone="crit">Без договорённости</RoyalCallFlag></>}
        action={<RoyalCallListen open={false} onToggle={() => {}} controls="d1" duration="4:05" />} />,
    );
    for (const text of ["Договорились о показе", "Балл 82", "Без договорённости", "4:05", "Ноза"]) expect(markup).toContain(text);
    expect(markup.match(/<button/g)).toHaveLength(1);
    expect(markup).toContain('aria-expanded="false"');
  });

  it("телефон: «слушать» кругом без подписи, длительность — в имени кнопки", () => {
    const markup = html(<RoyalCallListen compact open={false} onToggle={() => {}} controls="d1" duration="6:12" />);
    expect(markup).toContain("data-compact");
    expect(markup).toContain('aria-label="Слушать и открыть разбор, разговор 6:12"');
    expect(markup).not.toContain('class="ry-num"');
  });

  it("«Слушать» переключает раскрытие тем же состоянием", () => {
    const onToggle = vi.fn();
    render(<RoyalCallListen open={false} onToggle={onToggle} controls="d1" duration="1:20" />);
    fireEvent.click(screen.getByRole("button", { name: /Слушать/ }));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});

describe("расшифровка пузырями", () => {
  const text = "Агент: Здравствуйте, слушаю вас.\nКлиент: Можно посмотреть завтра?";
  it("в новом виде — пузыри с классами слоя, стороны помечены", () => {
    const { container } = render(<TranscriptView text={text} agentName="Ноза" royal />);
    const lines = container.querySelectorAll(".ry-tr-line");
    expect(lines).toHaveLength(2);
    expect(lines[0].getAttribute("data-side")).toBe("agent");
    expect(lines[1].getAttribute("data-side")).toBe("client");
    expect(container.textContent).toContain("Можно посмотреть завтра?");
  });
  it("без признака — прежняя разметка без классов нового вида", () => {
    const { container } = render(<TranscriptView text={text} agentName="Ноза" />);
    expect(container.querySelector(".ry-tr-line")).toBeNull();
    expect(container.textContent).toContain("Можно посмотреть завтра?");
  });
});
