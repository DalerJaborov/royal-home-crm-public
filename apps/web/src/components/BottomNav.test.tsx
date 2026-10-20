import { createHash } from "node:crypto";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { Home, MessageCircle } from "lucide-react";
import { describe, expect, it, vi } from "vitest";
import { BottomNav } from "./BottomNav";

const state = vi.hoisted(() => ({ legacy: false, glass: true }));
vi.mock("../hooks/useLegacyAgentMobile", () => ({ useLegacyAgentMobile: () => state.legacy }));
vi.mock("../hooks/useSettings", () => ({ useSettings: () => ({ data: { aiAssistantEnabled: true } }) }));
vi.mock("../store/uiPrefs", () => ({ useUiPrefs: (selector: (s: { glass: boolean }) => boolean) => selector(state) }));
vi.mock("../lib/navigation", () => ({
  useNavigation: () => ({ bottom: {
    left: [{ to: "/", end: true, icon: Home, label: "Главная", badge: 0 }],
    right: [{ to: "/chat", icon: MessageCircle, label: "Чаты", badge: 12 }],
  } }),
}));
vi.mock("./AssistantPanelLazy", () => ({ AssistantPanelLazy: () => null }));

// Captured from both original implementations before consolidation.
const originalMarkup = {
  "false:false:/": "f3a6b32c672e3aaf347c6084e1ab62d0414d7faa3516384fa3b9dd05efeb2cc5",
  "false:false:/chat": "2e9f47ed0a61f71349b654e8daec75de47ecdbb689b60d8d62af195a106e3fd9",
  "false:true:/": "f3a6b32c672e3aaf347c6084e1ab62d0414d7faa3516384fa3b9dd05efeb2cc5",
  "false:true:/chat": "2e9f47ed0a61f71349b654e8daec75de47ecdbb689b60d8d62af195a106e3fd9",
  "true:false:/": "016adda693e2521a4294738e895556d5670beedeb4c85af2fdf05e50f16b3fd0",
  "true:false:/chat": "3a8b1f171a2c94ba93303c55eacb9847ad95bf1e41629cbd0d60676b4132db66",
  "true:true:/": "5d3669d37cb1dd56bdbbaa743a1062701d477de06636d95a8c698b944fb62c93",
  "true:true:/chat": "e4fc5db0418350e4a049c3af42d49afced541bf34fcb24c54647708e1aa85e71",
};

describe("canonical bottom navigation preserves both visual contracts", () => {
  for (const legacy of [false, true]) {
    for (const glass of [false, true]) {
      for (const route of ["/", "/chat"]) {
        it(`keeps pre-refactor markup: legacy=${legacy}, glass=${glass}, route=${route}`, () => {
          state.legacy = legacy;
          state.glass = glass;
          const html = renderToStaticMarkup(<MemoryRouter initialEntries={[route]}><BottomNav /></MemoryRouter>);
          const hash = createHash("sha256").update(html).digest("hex");
          expect(hash).toBe(originalMarkup[`${legacy}:${glass}:${route}` as keyof typeof originalMarkup]);
          expect(html).toContain('aria-current="page"');
          expect(html).toContain("9+");
          expect(html).not.toContain('href="/properties"');
        });
      }
    }
  }
});
