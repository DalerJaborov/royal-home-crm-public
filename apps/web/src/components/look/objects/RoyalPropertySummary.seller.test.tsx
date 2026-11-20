// @vitest-environment jsdom
/**
 * Продавец в главном блоке карточки объекта «Нового вида» — по ролям (ревью #331).
 * Номер и признаки доступа считает сервер (lib/ownerContact.ts): директору полный номер,
 * тому, кто ведёт объект, — маской, остальным ничего. Экран лишь не должен показать
 * больше, чем отдали, и не должен показать мёртвую кнопку «Позвонить».
 */
import type { ReactElement } from "react";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Property } from "../../../types";
import { RoyalPropertySummary } from "./RoyalPropertySummary";
import { stageLabelFor } from "../../../lib/theme2026";

afterEach(cleanup);

const base = {
  id: "p1", shortId: 17, title: "2-комн · Сино", type: "APARTMENT", status: "AVAILABLE", condition: "GOOD",
  price: "440000", currency: "TJS", areaSqm: "52", rooms: 2, floor: 3, totalFloors: 5, address: "Дехлави, 7",
  district: { name: "Сино" }, photos: [], publishedOnSite: false,
} as unknown as Property;

const ui = (node: ReactElement) => render(<QueryClientProvider client={new QueryClient()}><MemoryRouter>{node}</MemoryRouter></QueryClientProvider>);
const summary = (extra: Partial<Property>, onAddSeller?: () => void) =>
  ui(<RoyalPropertySummary property={{ ...base, ...extra } as Property} onSchedule={() => {}} onEdit={null} onMore={() => {}} onAddSeller={onAddSeller} />);
const seller = { id: "c9", shortId: 9, fullName: "Джахонгир", canOpen: true };

describe("продавец в главном блоке карточки объекта", () => {
  it("директор: полный номер и живая кнопка «Позвонить»", () => {
    summary({ ownerContact: "+992900001122", sellerClient: seller });
    const block = screen.getByTestId("property-seller");
    expect(block.textContent).toContain("+992900001122");
    expect(block.querySelector("button[data-call-button]")).not.toBeNull();
  });
  it("ведущий объект: номер маской и звонок через карточку продавца", () => {
    summary({ ownerContact: null, ownerContactHidden: true, ownerContactMasked: "+9929000••122", sellerClient: seller });
    const block = screen.getByTestId("property-seller");
    expect(block.textContent).toContain("+9929000••122");
    expect(block.textContent).not.toContain("+992900001122");
    expect(block.querySelector("button[data-call-button]")).not.toBeNull();
  });
  it("маска без доступа к карточке продавца — номер виден, мёртвой кнопки нет", () => {
    summary({ ownerContact: null, ownerContactHidden: true, ownerContactMasked: "+9929000••122", sellerClient: { ...seller, canOpen: false } });
    const block = screen.getByTestId("property-seller");
    expect(block.textContent).toContain("+9929000••122");
    expect(block.textContent).not.toContain("Позвонить");
  });
  it("остальные роли: собственник закрыт — блока нет вовсе", () => {
    summary({ ownerContact: null, ownerContactHidden: true, ownerContactMasked: null, sellerClient: null });
    expect(screen.queryByTestId("property-seller")).toBeNull();
  });
  it("продавец не записан: тихое «Продавец не указан» и «Добавить продавца», без «Имя не записано»", () => {
    const add = vi.fn();
    summary({ ownerContact: null, ownerContactHidden: false, ownerContactMasked: null, sellerClient: null }, add);
    const block = screen.getByTestId("property-seller");
    expect(block.textContent).toContain("Продавец не указан");
    expect(block.textContent).not.toContain("Имя не записано");
    expect(block.textContent).not.toContain("Телефон не записан");
    fireEvent.click(screen.getByRole("button", { name: "Добавить продавца" }));
    expect(add).toHaveBeenCalledOnce();
  });
});

describe("этап объекта бытовыми словами", () => {
  it("агенту «На монтаже» → «Готовим видео», остальным прежнее слово", () => {
    const stage = { inPipeline: true, daysInStage: 3 } as never;
    expect(stageLabelFor("EDITING", stage, "AGENT")).toBe("Готовим видео, 3 дн.");
    expect(stageLabelFor("EDITING", stage, "EDITOR")).toBe("На монтаже, 3 дн.");
    expect(stageLabelFor("AVAILABLE", null, "AGENT")).toBe(stageLabelFor("AVAILABLE", null, "DIRECTOR"));
  });
});
