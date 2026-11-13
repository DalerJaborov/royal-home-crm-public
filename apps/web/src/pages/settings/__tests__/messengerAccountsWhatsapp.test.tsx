import React from "react";
import { renderToString } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

/**
 * Второй номер WhatsApp на экране «Аккаунты» (12.11.2026, «Арван»). Экран умел
 * заводить только Instagram, и номер приходилось вписывать мимо интерфейса.
 */
vi.mock("../../../lib/api", () => ({ api: vi.fn(async () => ({ items: [] })) }));
// Привязка приложения у Instagram ходит в сеть за своими данными — к этому тесту не относится.
vi.mock("../InstagramAppBinding", () => ({ InstagramAppBinding: () => null }));

import { MessengerAccounts, PHONE_NUMBER_ID } from "../MessengerAccounts";

const WA_ID = "1129773893562843";
const base = { enabled: true, hasToken: true, systemPrompt: null };

function render(items: unknown[]): string {
  const client = new QueryClient();
  client.setQueryData(["messenger-accounts"], { items });
  return renderToString(
    <QueryClientProvider client={client}>
      <MessengerAccounts />
    </QueryClientProvider>,
  );
}

describe("экран аккаунтов: номер WhatsApp", () => {
  it("предлагает завести и Instagram, и номер WhatsApp", () => {
    const html = render([]);
    expect(html).toContain("Добавить Instagram");
    expect(html).toContain("Добавить номер WhatsApp");
  });

  it("номер WhatsApp в списке: подпись «номер», без звезды «основной» и без чипа «основной»", () => {
    const html = render([
      { ...base, id: "wa1", channel: "WHATSAPP", externalId: WA_ID, title: "Арван, WhatsApp", isDefault: true, brandName: "Арван" },
      { ...base, id: "ig1", channel: "INSTAGRAM", externalId: "17841400000001", title: "Арван Instagram", isDefault: true, brandName: "Арван" },
    ]);
    expect(html).toContain("Арван, WhatsApp");
    // React разделяет соседние текстовые узлы служебными комментариями — для сравнения убираем их.
    expect(html.replace(/<!-- -->/g, "")).toContain("WhatsApp · номер 1129773893562843");
    // «Сделать основным» и чип «основной» остались только у Instagram: основной номер WhatsApp живёт в Настройках.
    expect(html.match(/aria-label="Сделать основным"/g) ?? []).toHaveLength(0);
    expect(html.match(/<span class="chip">основной<\/span>/g) ?? []).toHaveLength(1);
  });

  it("у неосновного Instagram звезда «Сделать основным» на месте, у неосновного номера WhatsApp — нет", () => {
    const html = render([
      { ...base, id: "wa2", channel: "WHATSAPP", externalId: WA_ID, title: "Арван, WhatsApp", isDefault: false, brandName: null },
      { ...base, id: "ig2", channel: "INSTAGRAM", externalId: "17841400000002", title: "Royal Home Info", isDefault: false, brandName: null },
    ]);
    expect(html.match(/aria-label="Сделать основным"/g) ?? []).toHaveLength(1);
  });

  it("идентификатор номера — только цифры: телефон с плюсом и пробелами не проходит", () => {
    expect(PHONE_NUMBER_ID.test(WA_ID)).toBe(true);
    expect(PHONE_NUMBER_ID.test("+992 900 00 00 00")).toBe(false);
    expect(PHONE_NUMBER_ID.test("12ab")).toBe(false);
    expect(PHONE_NUMBER_ID.test("")).toBe(false);
  });
});
