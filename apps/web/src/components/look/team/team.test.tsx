// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { customerAgentOwnerStateSchema } from "@royal-home/shared";
import { SwitchRow } from "../../Switch";
import { NumberRow } from "../../settings/SettingsRows";
import { CustomerAgentRolloutSection } from "../../settings/CustomerAgentRolloutSection";
import { WhatsAppTemplatesSection } from "../../../pages/settings/WhatsAppTemplatesSection";
import { RoyalSection } from "../clients/RoyalSection";
import { settingsIconFor } from "./parts";

vi.mock("../../../lib/api", () => ({ api: vi.fn(), ApiError: class extends Error {} }));

/**
 * «Новый вид», пачка team.
 * 1. Вид плиток включается только внутри метки раздела team; без неё — прежняя строка.
 * 2. Под «i» уходит только пояснение общей строки (проп hint, метка data-ry-hint);
 *    подписи галочек, причины, статусы и данные видны всегда (ревью PR 279).
 */
afterEach(() => { cleanup(); });
/** Без jest-dom: «скрыто» = внутри элемента с атрибутом hidden. */
const shown = (el: HTMLElement) => el.closest("[hidden]") === null;
const team = (node: ReactNode) => <RoyalSection name="team">{node}</RoyalSection>;

describe("значок строки настроек по названию", () => {
  it("узкие слова раньше общих, русские границы слов без \\b", () => {
    expect(settingsIconFor("Записывать звонки")).toBe("mic");
    expect(settingsIconFor("Ночной поиск двойных досье")).toBe("moon");
    expect(settingsIconFor("ИИ-помощник")).toBe("bot");
    expect(settingsIconFor("Дом")).toBe("building-2");
    expect(settingsIconFor("Домашний телефон")).toBe("phone-call");
    expect(settingsIconFor("Комиссия по умолчанию")).toBe("percent");
    expect(settingsIconFor("Что-то совсем другое", "key")).toBe("key");
  });
});

describe("SwitchRow", () => {
  it("вне раздела team (в том числе при признаке вида на чужом экране) — прежняя строка .mod", () => {
    document.documentElement.dataset.uiLook = "royal";
    const { container } = render(<SwitchRow title="Бот отвечает" hint="Отвечает круглосуточно" on onToggle={() => {}} />);
    delete document.documentElement.dataset.uiLook;
    expect(container.querySelector(".mod")).not.toBeNull();
    expect(container.querySelector(".ry-swt")).toBeNull();
    expect(shown(screen.getByText("Отвечает круглосуточно"))).toBe(true);
  });

  it("в разделе team — плитка, слово состояния рядом с переключателем, пояснение под «i»", () => {
    const onToggle = vi.fn();
    const { container } = render(team(<SwitchRow title="Бот отвечает" hint="Отвечает круглосуточно" on={false} onToggle={onToggle}
      warning="Нужны ключи" />));
    expect(container.querySelector(".mod")).toBeNull();
    expect(container.querySelector(".ry-swt .ry-circle")).not.toBeNull();
    expect(container.querySelector(".ry-swt-ctl")?.textContent).toContain("Выключено");
    const hint = screen.getByText("Отвечает круглосуточно");
    expect(hint.closest("[data-ry-hint]")).not.toBeNull();
    expect(shown(hint)).toBe(false);
    // Предупреждение — не пояснение: видно всегда.
    expect(shown(screen.getByText("Нужны ключи"))).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Пояснение: Бот отвечает" }));
    expect(shown(hint)).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: "Бот отвечает" }));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("недоступный переключатель: причина видна сразу, без «i»", () => {
    render(team(<SwitchRow title="Голос" hint="Недоступно, пока выключен живой голос" on={false} disabled onToggle={() => {}} />));
    expect(shown(screen.getByText("Недоступно, пока выключен живой голос"))).toBe(true);
    expect(screen.queryByRole("button", { name: /Пояснение/ })).toBeNull();
  });
});

describe("NumberRow", () => {
  it("в разделе team — строка со значком, то же поле и тот же обработчик", () => {
    const onChange = vi.fn();
    const { container } = render(team(<NumberRow label="Пауза перед ответом" hint="Бот ждёт тишины" value="30" onChange={onChange} min={0} max={120} unit="сек" />));
    expect(container.querySelector(".ry-setrow .ry-circle")).not.toBeNull();
    fireEvent.change(screen.getByRole("spinbutton", { name: "Пауза перед ответом" }), { target: { value: "45" } });
    expect(onChange).toHaveBeenCalledWith("45");
    expect(shown(screen.getByText("Бот ждёт тишины"))).toBe(false);
  });
});

describe("в разделе team ничего не прячется по форме разметки (ревью PR 279)", () => {
  const client = (key: unknown[], value: unknown) => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(key, value);
    return qc;
  };

  it("«Внедрение нового помощника»: тексты обеих галочек-согласий в разметке и не под «i»", () => {
    const state = customerAgentOwnerStateSchema.parse({
      policyRevision: "3", contractVersion: "scoped", rolloutMode: "ACTIVE", activeAgentRevisionId: "a".repeat(64), rollout: null,
      capabilities: {}, scopes: [{ endpointScopeId: "10000000-0000-4000-8000-000000000001", channel: "INSTAGRAM", surface: "dm",
        displayLabel: "Royal Home Info", writeAssurance: "per_event_required" }],
      moreScopes: false, counts: [{ lane: "CORE", count: "2" }], disabled: ["SHADOW", "PHONE"], stickyScope: "new_unassigned_only",
      existingPromotion: "not_implemented", dailyCap: "not_configured", configId: "royal-customer-g36-tools-20261015-v2",
    });
    const html = renderToStaticMarkup(team(<QueryClientProvider client={client(["settings", "customer-agent"], state)}><CustomerAgentRolloutSection /></QueryClientProvider>));
    expect(html).toContain("Подтверждаю отсутствие настроенного дневного лимита.");
    expect(html).toContain("Подтверждаю, что включение может создавать оплачиваемые обращения к модели.");
    expect(html).toContain("личные сообщения");
    expect(html).not.toContain("data-ry-hint");
    expect(html).not.toMatch(/\shidden(=|\s|>)/);
  });

  it("шаблоны WhatsApp: причина отказа Meta и текст шаблона в разметке и не под «i»", () => {
    const overview = { connected: true, accountKnown: true, error: null, templates: [
      { key: "general", name: "rh_first", body: "Здравствуйте, это {{1}}", state: "rejected", reason: "Нарушение правил рассылки", category: null },
    ] };
    const html = renderToStaticMarkup(team(<QueryClientProvider client={client(["whatsapp-templates"], overview)}><WhatsAppTemplatesSection /></QueryClientProvider>));
    expect(html).toContain("Причина отказа от Meta: Нарушение правил рассылки");
    expect(html).toContain("Здравствуйте, это [имя сотрудника]");
    expect(html).not.toContain("data-ry-hint");
  });

  it("слой пачки скрывает только своё (заголовок-дубль, маркер раскрытия, полосы прокрутки, шапку таблицы на телефоне)", () => {
    const css = readFileSync(join(process.cwd(), "src/theme-look-royal-team.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const hiding = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .filter(([, , body]) => /display:\s*none|visibility:\s*hidden|clip:\s*rect\(0/.test(body))
      .flatMap(([, head]) => head.split(/,(?![^(]*\))/).map((s) => s.trim()));
    const allowed = /(::-webkit-(details-marker|scrollbar|search-cancel-button)|\.ry-title\[data-dup\]|\.ry-mhead(\s*>\s*:last-child)?|\.ry-stat small)$/;
    expect(hiding.filter((selector) => !allowed.test(selector))).toEqual([]);
    // Сторож проверен поломкой: прежнее правило ревью 279 ловится.
    const broken = `${css}\n:root[data-ui-look="royal"] .ry-set[data-ry-section="team"] .acc-b :is(.mod > .t > span, p.sub) { display: none; }`;
    const again = [...broken.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(([, , b]) => /display:\s*none/.test(b)).map(([, h]) => h.trim());
    expect(again.some((h) => !allowed.test(h))).toBe(true);
  });
});
