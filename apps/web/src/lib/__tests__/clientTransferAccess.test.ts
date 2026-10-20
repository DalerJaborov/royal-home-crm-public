import { describe, expect, it } from "vitest";
import { canCallOnTransferredCard, transferBannerOf } from "../clientTransferAccess";
import type { Client } from "../../types";

/**
 * Пачка 16 (11.09.2026): GET /clients/:id отдаёт `access.readOnly` вместо 403
 * агенту, у которого клиента забрали (см. apps/api/src/routes/clients/card.ts,
 * loadTransferAccess). Здесь — чистая логика фронта, вынесенная из
 * ClientDetail.tsx ровно затем, чтобы её можно было проверить без рендера
 * (в apps/web нет testing-library/jsdom).
 */

function client(access?: Client["access"]): Pick<Client, "access"> {
  return { access };
}

describe("transferBannerOf", () => {
  it("обычная карточка (access не пришёл) — баннера нет", () => {
    expect(transferBannerOf(client(undefined))).toBeNull();
  });

  it("называет нового агента и причину", () => {
    const banner = transferBannerOf(
      client({
        readOnly: true,
        transferredTo: { id: "a2", fullName: "Фарход Каримов" },
        transferredAt: "2026-09-11T10:00:00.000Z",
        reason: "[declineLead] лид отклонён, передан по очереди",
      })
    );
    expect(banner).toEqual({
      headline: "Клиент передан Фарход Каримов",
      reason: "[declineLead] лид отклонён, передан по очереди",
    });
  });

  it("клиент ушёл в очередь руководителя (toAgentId=null) — без имени, без выдумывания агента", () => {
    const banner = transferBannerOf(
      client({ readOnly: true, transferredTo: null, transferredAt: "2026-09-11T10:00:00.000Z", reason: null })
    );
    expect(banner?.headline).toBe("Клиент передан в очередь руководителя");
    expect(banner?.reason).toBeNull();
  });
});

describe("canCallOnTransferredCard", () => {
  it("без access — не о чем разрешать (эта функция не про обычные карточки)", () => {
    expect(canCallOnTransferredCard(client(undefined), true)).toBe(false);
  });

  it("read-only, но без права clients.assign — «Позвонить» скрыт", () => {
    const c = client({ readOnly: true, transferredTo: null, transferredAt: "x", reason: null });
    expect(canCallOnTransferredCard(c, false)).toBe(false);
  });

  it("read-only и есть clients.assign — «Позвонить» остаётся", () => {
    const c = client({ readOnly: true, transferredTo: null, transferredAt: "x", reason: null });
    expect(canCallOnTransferredCard(c, true)).toBe(true);
  });
});
