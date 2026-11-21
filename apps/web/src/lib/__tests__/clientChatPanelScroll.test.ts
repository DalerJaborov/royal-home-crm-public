import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Боковая переписка на карточке клиента, ПК (21.11.2026, кадры владельца).
 * Сторож исходника; живая проверка прокрутки колесом, ширин и меток канала. e2e
 * tests/e2e/urgent-pc-chat-panel.spec.ts.
 */
const here = dirname(fileURLToPath(import.meta.url));
const panel = readFileSync(resolve(here, "../../components/ClientChatPanel.tsx"), "utf8");

describe("ClientChatPanel", () => {
  it("слой списка Virtuoso не владеет прокруткой: `.thread` темы с overscroll contain не глотает колесо", () => {
    const list = panel.slice(panel.indexOf("const VirtuosoList"), panel.indexOf("const VirtuosoItem"));
    expect(list).toContain('overflow: "visible"');
    expect(list).toContain('overscrollBehavior: "auto"');
  });

  it("метки канала в пузыре и счётчика каналов в шапке нет", () => {
    expect(panel).not.toContain("data-message-channel");
    expect(panel).not.toContain("канал(а)");
  });

  it("канал один: выбор не рисуется, ответ уходит в него сам; полей без min-width: 0 нет", () => {
    expect(panel).toContain("sendableConversations.length === 1");
    expect(panel).toContain("sendableConversations.length > 1 && <select");
    expect(panel).toContain('minWidth: 0');
  });
});
