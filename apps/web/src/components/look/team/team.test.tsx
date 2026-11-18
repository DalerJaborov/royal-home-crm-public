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
 * 2. В Настройках ничего не прячется: пояснение строки (hint) видно всегда; под «i» —
 *    только необязательная справка explain, которую в Настройках не ставит никто.
 */
afterEach(() => { cleanup(); });
/** Без jest-dom: «скрыто» = внутри элемента с атрибутом hidden. */
const shown = (el: HTMLElement) => el.closest("[hidden]") === null;
const team = (node: ReactNode) => <RoyalSection name="team">{node}</RoyalSection>;

/**
 * Сторож скрытия слоя пачки (ревью PR 279): ни одно правило не прячет и не режет
 * текст. Разрешены только перечисленные ЦЕЛИКОМ селекторы — заголовок-дубль на
 * телефоне, полосы прокрутки, маркер раскрытия, шапка таблицы и подписи цифр на
 * своих местах, имя в меню профиля.
 */
const HIDING = /display:\s*none|visibility:\s*hidden|font-size:\s*0(?![.\d])|max-height:\s*0(?![.\d])|opacity:\s*0(?![.\d])|line-clamp|clip-path|text-overflow:\s*ellipsis|clip:\s*rect\(0/;
const R = ':root[data-ui-look="royal"]';
const HIDING_ALLOWED = new Set([
  `${R}[data-mobile-ux] [data-ry-section="team"] .ry-title[data-dup]`,
  `${R} [data-ry-section="team"]:is(.ry-set, .ry-teamp, .ry-member, .ry-activity) .seg-ai::-webkit-scrollbar`,
  `${R} [data-ry-section="team"] .ry-search input::-webkit-search-cancel-button`,
  `${R}[data-mobile-ux] [data-ry-section="team"] .ry-set-tasks::-webkit-scrollbar`,
  `${R} [data-ry-section="team"] .ry-mhead`,
  `${R} [data-ry-section="team"] .ry-mhead > :last-child`,
  `${R} [data-ry-section="team"] .ry-mrow .ry-stat small`,
  `${R} .ry-teamp[data-ry-section="team"] details.clean-team-recognition > summary::-webkit-details-marker`,
  `${R} .ry-activity[data-ry-section="team"] .scr .seg::-webkit-scrollbar`,
  `${R} [data-ry-section="team"] .ry-pmenu-head b`,
]);
function hiddenTextSelectors(css: string): string[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  return [...text.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(([, , body]) => HIDING.test(body))
    .flatMap(([, head]) => head.split(/,(?![^(]*\))/).map((selector) => selector.trim()))
    .filter((selector) => !selector.startsWith("@") && !HIDING_ALLOWED.has(selector));
}

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

  it("в разделе team — плитка, слово состояния рядом, пояснение (последствие) видно всегда, без «i»", () => {
    const onToggle = vi.fn();
    const { container } = render(team(<SwitchRow title="Бот отвечает" hint="Отвечает круглосуточно" on={false} onToggle={onToggle}
      warning="Нужны ключи" />));
    expect(container.querySelector(".mod")).toBeNull();
    expect(container.querySelector(".ry-swt .ry-circle")).not.toBeNull();
    expect(container.querySelector(".ry-swt-ctl")?.textContent).toContain("Выключено");
    const hint = screen.getByText("Отвечает круглосуточно");
    expect(shown(hint)).toBe(true);
    expect(hint.closest("[data-ry-hint]")).toBeNull();
    expect(screen.queryByRole("button", { name: /Пояснение/ })).toBeNull();
    expect(container.querySelector("[hidden]")).toBeNull();
    expect(shown(screen.getByText("Нужны ключи"))).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: "Бот отвечает" }));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("признак «недоступен» не меняет разметку пояснения (экран не прыгает при сохранении)", () => {
    const { container, rerender } = render(team(<SwitchRow title="Голос" hint="Недоступно, пока выключен живой голос" on={false} onToggle={() => {}} />));
    const before = container.querySelector(".ry-swt")?.innerHTML.replace(/\s?disabled=""/g, "");
    rerender(team(<SwitchRow title="Голос" hint="Недоступно, пока выключен живой голос" on={false} disabled onToggle={() => {}} />));
    expect(container.querySelector(".ry-swt")?.innerHTML.replace(/\s?disabled=""/g, "")).toBe(before);
    expect(shown(screen.getByText("Недоступно, пока выключен живой голос"))).toBe(true);
  });

  it("под «i» уходит только необязательная справка explain", () => {
    render(team(<SwitchRow title="Бот" hint="Отвечает" explain="Справка про бота" on onToggle={() => {}} />));
    expect(shown(screen.getByText("Отвечает"))).toBe(true);
    expect(shown(screen.getByText("Справка про бота"))).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Пояснение: Бот" }));
    expect(shown(screen.getByText("Справка про бота"))).toBe(true);
  });
});

/** Последствия о деньгах, очереди и данных из ревью PR 279: каждое — проп hint общей строки. */
const CONSEQUENCES: [file: string, phrase: string, row: "switch" | "number"][] = [
  ["pages/settings/ReelsAutoBoostSection.tsx", "Боевой режим: объявления создаются и останавливаются в рекламном кабинете, деньги тратятся.", "switch"],
  ["pages/settings/BotTab.tsx", "Каждый вопрос стоит токенов.", "switch"],
  ["pages/settings/LeadsTab.tsx", "Ниже 60 очередь по KPI фактически перестанет работать.", "number"],
  ["pages/settings/MetaEternalKeys.tsx", "Работают только личные ключи сотрудников — их сломает смена пароля.", "switch"],
  ["pages/settings/ChannelsTab.tsx", "Бот ведёт такой диалог до заявки сам.", "switch"],
  ["pages/settings/LeadsTab.tsx", "Работает вместе с «Просить подтверждение встречи» во вкладке «Бот» — нужны оба.", "switch"],
  ["pages/settings/ChannelsTab.tsx", "Работают: ", "switch"],
  ["pages/settings/ChannelsTab.tsx", "Последняя сверка: ", "switch"],
];

describe("последствия видны без нажатия (ревью PR 279)", () => {
  it.each(CONSEQUENCES)("%s: «%s»", (file, phrase, row) => {
    expect(readFileSync(join(process.cwd(), "src", file), "utf8")).toContain(phrase);
    const text = `${phrase} (пример)`;
    const html = renderToStaticMarkup(team(row === "number"
      ? <NumberRow label="Строка" hint={text} value="1" onChange={() => {}} min={0} max={9} />
      : <SwitchRow title="Строка" hint={text} on onToggle={() => {}} />));
    expect(html).toContain(text);
    expect(html).not.toMatch(/\shidden(=|\s|>)/);
    expect(html).not.toContain("data-ry-hint");
    expect(html).not.toContain("Пояснение");
  });
});

describe("NumberRow", () => {
  it("в разделе team — строка со значком, пояснение видно, то же поле и тот же обработчик", () => {
    const onChange = vi.fn();
    const { container } = render(team(<NumberRow label="Пауза перед ответом" hint="Бот ждёт тишины" value="30" onChange={onChange} min={0} max={120} unit="сек" />));
    expect(container.querySelector(".ry-setrow .ry-circle")).not.toBeNull();
    fireEvent.change(screen.getByRole("spinbutton", { name: "Пауза перед ответом" }), { target: { value: "45" } });
    expect(onChange).toHaveBeenCalledWith("45");
    expect(shown(screen.getByText("Бот ждёт тишины"))).toBe(true);
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

  it("слой пачки ничего не прячет и не режет, кроме белого списка точных селекторов", () => {
    const css = readFileSync(join(process.cwd(), "src/theme-look-royal-team.css"), "utf8");
    expect(hiddenTextSelectors(css)).toEqual([]);
  });

  it.each([
    "display: none", "visibility: hidden", "font-size: 0", "max-height: 0", "opacity: 0",
    "-webkit-line-clamp: 2", "clip-path: inset(50%)", "text-overflow: ellipsis",
  ])("сторож скрытия ловит «%s» на тексте настроек (проверен поломкой)", (declaration) => {
    const css = readFileSync(join(process.cwd(), "src/theme-look-royal-team.css"), "utf8");
    const leak = ':root[data-ui-look="royal"] .ry-set[data-ry-section="team"] .acc-b .mod .t > span';
    expect(hiddenTextSelectors(`${css}
${leak} { ${declaration}; }`)).toEqual([leak]);
  });
});
