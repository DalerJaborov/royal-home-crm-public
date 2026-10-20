import { describe, expect, it } from "vitest";
import { humanizeAttachmentTags } from "../botMessages";

/**
 * «[вложение: template]» у реплики клиента — нейтральная «карточка» (25.09.2026).
 *
 * Клиент в Instagram прислал свою карточку с номером, а лента подписала её «наша
 * карточка с кнопкой» — агент решил, что клиент ничего не присылал. «Наша» —
 * только у исходящей реплики.
 */
describe("humanizeAttachmentTags: карточка", () => {
  it("у реплики клиента — нейтральная подпись", () => {
    expect(humanizeAttachmentTags("[вложение: template]")).toBe("📋 карточка");
  });

  it("у нашей исходящей реплики — «наша карточка с кнопкой»", () => {
    expect(humanizeAttachmentTags("[вложение: template]", { outgoing: true })).toBe("📋 наша карточка с кнопкой");
  });

  it("остальные типы от направления не зависят", () => {
    expect(humanizeAttachmentTags("[вложение: image]", { outgoing: true })).toBe("🖼 фото");
  });
});
