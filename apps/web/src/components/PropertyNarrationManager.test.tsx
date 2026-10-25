import { describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import type { PropertyNarrationView } from "@royal-home/shared";
vi.mock("../lib/api", () => ({ api: vi.fn() }));
import { PropertyNarrationManager } from "./PropertyNarrationManager";
function render(overrides: Partial<PropertyNarrationView> = {}) {
  const client = new QueryClient();
  client.setQueryData(["property-narration", "p"], { versions: [], suggestedScript: "Квартира площадью девяносто метров.", config: { modelId: "", voices: [] }, configured: false, canApprove: false, sendsEnabled: false, ...overrides });
  return renderToStaticMarkup(<QueryClientProvider client={client}><PropertyNarrationManager propertyId="p" /></QueryClientProvider>);
}
describe("narration visible boundaries", () => {
  it("shows unconfigured state and editable draft without invented voices", () => {
    const html = render(); expect(html).toContain("Генерация пока недоступна"); expect(html).toContain("Сохранить новую версию");
    expect(html).not.toContain("Сгенерировать в ElevenLabs"); expect(html).not.toContain("Настройки голосов");
  });
  it("shows both editor handoff modes only to marketing for ready audio", () => {
    const versions = [{ id: "v", revision: 1, script: "Квартира", voiceId: "configured", status: "READY", approvedAt: "2026-10-25", stale: false, hasAudio: true, errorCode: null, createdAt: "2026-10-25" }];
    const html = render({ versions, canApprove: true });
    expect(html).toContain("Только новую озвучку"); expect(html).toContain("Исходники и озвучку"); expect(html).toContain("Отправка монтажёру, изменение публикаций и SMS пока отключены");
    expect(render({ versions })).not.toContain("Подготовить передачу монтажёру");
  });
  it("does not offer handoff of obsolete facts", () => {
    expect(render({ canApprove: true, versions: [{ id: "v", revision: 1, script: "Квартира", voiceId: null, status: "READY", approvedAt: "2026-10-25", stale: true, hasAudio: true, errorCode: null, createdAt: "2026-10-25" }] })).not.toContain("Подготовить передачу монтажёру");
  });
  it("marketing can approve but only leadership can configure global voices", () => {
    expect(render({ canApprove: true, canConfigure: false })).not.toContain("Настройки голосов");
    expect(render({ canApprove: true, canConfigure: true })).toContain("Настройки голосов");
  });
});
