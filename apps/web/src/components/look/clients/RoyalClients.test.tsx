import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { CleanClientRow } from "../../clean/CleanClientRow";
import { CleanClientDetailTabs } from "../../clean/CleanClientDetailLayout";
import { readFileSync } from "node:fs";
import { ROYAL_ROW_PC_ONLY, RoyalClientFacts, RoyalClientListHead, RoyalClientRow, RoyalClientTabs, type RoyalClientRowProps } from "./RoyalClients";

/**
 * «Новый вид» раздела «Клиенты»: разметка другая, данные и действия те же.
 * Строка нового вида обязана показывать всё, что показывает строка Clean, —
 * иначе перенос на новый вид молча теряет сведения (правило брифа №2).
 */
const fixture: RoyalClientRowProps = {
  id: "client-1", name: "Мадина Каримова", href: "/clients/42", avatar: <span>МК</span>,
  identity: "КЛ-000042 · Покупатель", request: "3 комн · Сино · $55–70 тыс.", source: "Instagram",
  nextAction: <span>Позвонить сейчас</span>, nextActionDate: "2026-11-03T11:00:00.000Z", lastContact: "2 дня назад",
  staleContact: false, showAgent: true, agentName: "Фаррух", agentAssigned: true,
  actions: <button type="button">Позвонить через CRM</button>, deleted: false,
};
const inRouter = (node: ReactElement) => renderToStaticMarkup(<MemoryRouter>{node}</MemoryRouter>);
const royal = (props: Partial<RoyalClientRowProps> = {}) => inRouter(<RoyalClientRow {...fixture} {...props} />);
const clean = (props: Partial<RoyalClientRowProps> = {}) => inRouter(<CleanClientRow {...fixture} {...props} />);
/** Видимые слова строки без подписей колонок, которые в новом виде стоят в шапке таблицы. */
const words = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&nbsp;|·|:/g, " ")
  .split(/\s+/).filter(Boolean).filter((w) => !["Следующее", "действие", "Ответственный"].includes(w));

describe("строка клиента нового вида", () => {
  it("одна дата с глаголом: срок шага или когда связывались (пачка D1)", () => {
    const withDeadline = royal({ nextActionDate: "2099-01-01T08:00:00.000Z" });
    expect(withDeadline).toContain("срок ");
    expect(withDeadline).not.toContain("2 дня назад");
    expect(royal({ nextActionDate: "2020-01-01T08:00:00.000Z" })).toContain("просрочено");
    const noDeadline = royal({ nextAction: null });
    expect(noDeadline).toContain("связывались ");
    expect(noDeadline).toContain("2 дня назад");
    expect(royal({ nextAction: null, staleContact: true })).toContain("давно не связывались");
  });
  it("показывает всё, что показывает строка Clean (ничего не теряется)", () => {
    // Исключение одно и намеренное (пачка D1, 20.11.2026): при сроке шага строка нового вида
    // показывает ОДНУ дату — срок; «последний контакт» и подписи «Срок / Последний контакт /
    // Давно не связывались» остаются в карточке клиента и в строке без срока.
    const dropped = (props: Partial<RoyalClientRowProps>) => {
      const p = { ...fixture, ...props };
      const words = new Set(["Срок", "Последний", "контакт", "Давно", "не", "связывались"]);
      if (p.nextAction && p.nextActionDate) for (const w of p.lastContact.split(/\s+/)) words.add(w);
      return words;
    };
    for (const props of [{}, { staleContact: true }, { nextAction: null }, { agentName: null, agentAssigned: false }, { showAgent: false }]) {
      const mine = new Set(words(royal(props)));
      const allowed = dropped(props);
      for (const w of words(clean(props))) if (!allowed.has(w)) expect(mine, `потеряно «${w}» при ${JSON.stringify(props)}`).toContain(w);
    }
  });
  it("та же ссылка в карточку, тот же признак строки для смахивания и звонка", () => {
    const html = royal();
    expect(html).toContain('href="/clients/42"');
    expect(html).toContain('data-client-row="client-1"');
    expect(html).toContain('aria-label="Открыть карточку: Мадина Каримова"');
  });
  it("удалённую карточку не ведёт на недоступную страницу, действия передаёт как есть", () => {
    const html = royal({ href: undefined, deleted: true, actions: <button>Восстановить</button> });
    expect(html).not.toContain("href=");
    expect(html).toContain("Восстановить");
    expect(html).toContain("data-deleted");
  });
  it("не выдумывает ответственного, когда колонку скрыли", () => {
    expect(royal({ showAgent: false })).not.toContain("Фаррух");
    expect(inRouter(<RoyalClientListHead showAgent={false} />)).not.toContain("Ответственный");
    expect(inRouter(<RoyalClientListHead showAgent />)).toContain("Ответственный");
  });
});

describe("строка на телефоне: что скрыто — помечено и есть в карточке", () => {
  it("номер карточки и источник помечены «только ПК» — остальное видно и на телефоне", () => {
    const html = royal();
    const pcOnly = [...html.matchAll(new RegExp(`class="[^"]*${ROYAL_ROW_PC_ONLY}[^"]*">([^<]*)<`, "g"))].map((m) => m[1]);
    expect(pcOnly).toEqual([fixture.identity, fixture.source]);
  });
  it("слой нового вида прячет их только на телефоне и возвращает в таблице ПК", () => {
    const css = readFileSync(new URL("../../../theme-look-royal-clients.css", import.meta.url), "utf8");
    const container = css.indexOf("@container ry-clist");
    const hide = css.indexOf(`.${ROYAL_ROW_PC_ONLY} { display: none; }`);
    const show = css.indexOf(`.${ROYAL_ROW_PC_ONLY} { display: block; }`);
    expect(hide).toBeGreaterThan(-1);
    expect(hide).toBeLessThan(container);
    expect(show).toBeGreaterThan(container);
  });
  it("в шапке карточки факты: полные подписи для чтеца, короткий текст на виду", () => {
    const html = renderToStaticMarkup(<RoyalClientFacts facts={[
      { icon: "calendar-days", text: "16 ноября", label: "Пришёл 16 ноября" },
      { icon: "inbox", text: "Instagram", label: "Откуда пришёл: Instagram" },
    ]} />);
    expect(html).toContain("Instagram");
    expect(html).toContain("Откуда пришёл: Instagram");
    expect(html).toContain('class="sr-only">Пришёл 16 ноября');
  });
});

describe("вкладки карточки нового вида", () => {
  const ids = (html: string) => [...html.matchAll(/id="(clean-client-tab-[a-z]+)"/g)].map((m) => m[1]);
  const controls = (html: string) => [...html.matchAll(/aria-controls="([^"]+)"/g)].map((m) => m[1]);
  it("те же вкладки, id и связи с панелями, что у Clean (панели карточки не меняются)", () => {
    const a = renderToStaticMarkup(<RoyalClientTabs value="calls" onChange={() => {}} objectsLabel="Показы" />);
    const b = renderToStaticMarkup(<CleanClientDetailTabs value="calls" onChange={() => {}} objectsLabel="Показы" />);
    expect(ids(a)).toEqual(ids(b));
    expect(controls(a)).toEqual(controls(b));
    expect(a).toContain('role="tablist"');
    expect(a.match(/aria-selected="true"/g)).toHaveLength(1);
    expect(a).toMatch(/id="clean-client-tab-calls"[^>]*aria-selected="true"|aria-selected="true"[^>]*id="clean-client-tab-calls"/);
    for (const label of ["Обзор", "Показы", "Переписка", "Звонки", "История"]) expect(a).toContain(label);
  });
  it("без инлайновых цветов: оформление только из слоя нового вида", () => {
    expect(renderToStaticMarkup(<RoyalClientTabs value="short" onChange={() => {}} />)).not.toContain("style=");
  });
});
