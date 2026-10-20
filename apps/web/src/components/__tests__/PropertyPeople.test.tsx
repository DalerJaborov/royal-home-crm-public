import { describe, it, expect } from "vitest";
import React from "react";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PropertyPeople } from "../PropertyPeople";

/**
 * «Кто ведёт объект» (владелец 24.09.2026): собственник — именем со ссылкой на
 * карточку продавца, один и тот же агент — одной строкой, без служебных
 * заголовков. jsdom в проекте нет — проверяем разметку первого рендера.
 */
const render = (node: React.ReactElement) =>
  renderToString(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>{node}</MemoryRouter>
    </QueryClientProvider>,
  );

const intake = { id: "a1", fullName: "Умед Каримов" };
const other = { id: "a2", fullName: "Нозанин Саидова" };

describe("PropertyPeople", () => {
  it("руководителю — имя собственника ссылкой на карточку продавца и его телефон", () => {
    const html = render(
      <PropertyPeople
        property={{
          assignedAgent: null,
          intakeAgent: intake,
          ownerContact: "+992910001012",
          ownerContactHidden: false,
          sellerClient: { id: "c1", shortId: 86, fullName: "Фарход Рахимов", canOpen: true },
        }}
      />
    );
    expect(html).toContain('href="/clients/86"');
    expect(html).toContain("Фарход Рахимов");
    expect(html).toContain("+992910001012");
    expect(html).not.toContain("видно при полном доступе");
  });

  it("карточка продавца не откроется — имя без ссылки", () => {
    const html = render(
      <PropertyPeople
        property={{
          assignedAgent: null,
          intakeAgent: intake,
          ownerContact: "+992910001012",
          ownerContactHidden: false,
          sellerClient: { id: "c1", shortId: 86, fullName: "Фарход Рахимов", canOpen: false },
        }}
      />
    );
    expect(html).toContain("Фарход Рахимов");
    expect(html).not.toContain("/clients/86");
  });

  it("собственник не привязан к карточке — честно «Имя не записано», номер остаётся", () => {
    const html = render(
      <PropertyPeople
        property={{ assignedAgent: null, intakeAgent: intake, ownerContact: "+992910001012", ownerContactHidden: false, sellerClient: null }}
      />
    );
    expect(html).toContain("Имя не записано");
    expect(html).toContain("+992910001012");
  });

  it("номер скрыт правом — блока собственника нет вовсе, остаётся «кто ведёт»", () => {
    const html = render(
      <PropertyPeople property={{ assignedAgent: null, intakeAgent: intake, ownerContact: null, ownerContactHidden: true }} />
    );
    expect(html).not.toContain("Собственник");
    expect(html).not.toContain("property-owner");
    expect(html).not.toContain("Имя не записано");
    expect(html).toContain("Умед Каримов");
  });

  it("принял и ведёт сделку один человек — одна строка, а не две", () => {
    const html = render(
      <PropertyPeople property={{ assignedAgent: intake, intakeAgent: intake, ownerContact: null, ownerContactHidden: false }} />
    );
    expect(html.split("Умед Каримов").length - 1).toBe(1);
    expect(html).toContain("Ответственный за объект");
    expect(html).toContain("Приёмка объекта у собственника");
  });

  it("разные люди — две строки; монтажёру собственник не показывается", () => {
    const html = render(
      <PropertyPeople
        property={{ assignedAgent: other, intakeAgent: intake, ownerContact: "+992910001012", ownerContactHidden: true }}
        showOwner={false}
      />
    );
    expect(html).toContain("Нозанин Саидова");
    expect(html).toContain("Умед Каримов");
    expect(html).not.toContain("Собственник<");
    expect(html).not.toContain("видят руководитель");
  });
  it("телефон собственника — кнопка звонка через CRM, когда карточка продавца открыта", () => {
    const html = render(
      <PropertyPeople
        property={{
          assignedAgent: null,
          intakeAgent: intake,
          ownerContact: "+992910001012",
          ownerContactHidden: false,
          sellerClient: { id: "c1", shortId: 86, fullName: "Фарход Рахимов", canOpen: true },
        }}
      />
    );
    expect(html).toContain("data-call-button");
    expect(html).toContain("Позвонить");
    expect(html).not.toContain("tel:");
    // Ни кнопки внутри ссылки: имя и «Карточка» — ссылки, звонок — отдельная кнопка.
    expect(html).not.toMatch(/<a[^>]*>(?:(?!<\/a>).)*data-call-button/s);
  });

  it("карточка продавца не откроется — звонка в обход станции нет, кнопка неактивна", () => {
    const html = render(
      <PropertyPeople
        property={{
          assignedAgent: null,
          intakeAgent: intake,
          ownerContact: "+992910001012",
          ownerContactHidden: false,
          sellerClient: { id: "c1", shortId: 86, fullName: "Фарход Рахимов", canOpen: false },
        }}
      />
    );
    expect(html).not.toContain("tel:");
    expect(html).not.toContain("data-call-button");
    expect(html).toContain("cursor-not-allowed");
  });

  it("телефона нет — кнопки звонка нет", () => {
    const html = render(
      <PropertyPeople property={{ assignedAgent: null, intakeAgent: intake, ownerContact: null, ownerContactHidden: false, sellerClient: null }} />
    );
    expect(html).toContain("Телефон не записан");
    expect(html).not.toContain("Позвонить");
  });
  it("в правке номер стоит полем ниже — строкой второй раз не печатается, имя остаётся", () => {
    const html = render(
      <PropertyPeople
        ownerPhoneInField
        property={{
          assignedAgent: null,
          intakeAgent: intake,
          ownerContact: "+992910001012",
          ownerContactHidden: false,
          sellerClient: { id: "c1", shortId: 86, fullName: "Фарход Рахимов", canOpen: true },
        }}
      />
    );
    expect(html).toContain("Фарход Рахимов");
    expect(html).not.toContain("<span>+992910001012</span>");
  });
});
