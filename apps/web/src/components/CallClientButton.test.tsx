import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { FOREIGN_PHONE_CALL_ERROR } from "@royal-home/shared";
import { CallClientButton } from "./CallClientButton";

/**
 * Иностранный номер (19.11.2026): станция агентства звонит только по Таджикистану.
 * Кнопка «Позвонить» не должна выглядеть живой: причина видна сразу, а не после
 * ложного «не ответил». Таджикский номер — обычная кнопка без пояснения.
 */
vi.mock("../hooks/useClients", () => ({ useCallClient: () => ({ isPending: false, mutateAsync: vi.fn() }) }));
vi.mock("../hooks/useVacancies", () => ({ useCallCandidate: () => ({ isPending: false, mutateAsync: vi.fn() }) }));
vi.mock("../hooks/useActiveCall", () => ({ useActiveCallValue: () => ({ data: null }) }));
vi.mock("@tanstack/react-query", () => ({ useQueryClient: () => ({ invalidateQueries: vi.fn() }) }));
vi.mock("../store/auth", () => ({
  useAuthStore: (selector: (s: { agent: { readOnly: boolean; role: string } }) => unknown) =>
    selector({ agent: { readOnly: false, role: "AGENT" } }),
}));

const render = (props: Partial<React.ComponentProps<typeof CallClientButton>>) =>
  renderToStaticMarkup(<CallClientButton clientId="c1" phone="+992930001001" variant="full" {...props} />);

describe("CallClientButton: иностранный номер", () => {
  it("российский номер: причина на экране сразу, кнопка приглушена, шрифт не мельче 13px", () => {
    const html = render({ phone: "+79922992084" });
    expect(html).toContain("data-foreign-phone-note");
    expect(html).toContain(FOREIGN_PHONE_CALL_ERROR);
    expect(html).toContain('aria-disabled="true"');
    expect(html).toContain("text-[13px]");
    expect(html).not.toMatch(/text-\[(8|9|10|11|12)px\]/);
  });

  it("компактная кнопка (список, телефон): приглушена и с причиной в подсказке", () => {
    const html = render({ phone: "+12020000001", variant: "icon" });
    expect(html).toContain('aria-disabled="true"');
    expect(html).toContain(FOREIGN_PHONE_CALL_ERROR);
  });

  it("закрытый номер (маска) с чужим кодом страны тоже иностранный", () => {
    expect(render({ phone: "+799•••••84" })).toContain("data-foreign-phone-note");
  });

  it("таджикский номер: живая кнопка без пояснения", () => {
    const html = render({});
    expect(html).not.toContain("data-foreign-phone-note");
    expect(html).not.toContain("aria-disabled");
  });

  it("кандидат вакансии не трогаем: номер проверяет свой маршрут", () => {
    const html = render({ clientId: null, candidateId: "k1", phone: "+79922992084" });
    expect(html).not.toContain("data-foreign-phone-note");
  });

  it("звонок на дополнительный иностранный номер (WhatsApp) при таджикском основном", () => {
    expect(render({ callPhone: "+79922992084" })).toContain("data-foreign-phone-note");
  });
});
