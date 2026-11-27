import { describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { withSessionSettings } from "../src/lib/prismaAdapter.js";

/**
 * JIT Postgres выключен на соединениях приложения (27.11.2026): на проде JIT-компиляция добавляла
 * 3,6–4,1 с к каждому из двух запросов списка «Чатов» при исполнении 0,25–0,46 с.
 * Разбор — в шапке withSessionSettings (lib/prismaAdapter.ts).
 */
describe("соединение с базой: JIT выключен", () => {
  it("живое соединение пула отвечает jit = off", async () => {
    const rows = await prisma.$queryRaw<{ jit: string }[]>`SELECT current_setting('jit') AS jit`;
    expect(rows[0]?.jit).toBe("off");
  });

  it("боевой адрес: statement_timeout сохраняется, jit=off дописывается", () => {
    const prod = "postgresql://u:p%40ss@postgres:5432/royal_home_crm?schema=public&connection_limit=15&pool_timeout=20&options=-c%20statement_timeout%3D60000";
    const out = new URL(withSessionSettings(prod, {}));
    expect(out.searchParams.get("options")).toBe("-c statement_timeout=60000 -c jit=off");
    expect(out.searchParams.get("connection_limit")).toBe("15");
    expect(out.searchParams.get("pool_timeout")).toBe("20");
    expect(out.password).toBe("p%40ss");
  });

  it("адрес без options получает только jit=off", () => {
    const out = new URL(withSessionSettings("postgresql://u:p@localhost:5432/db", {}));
    expect(out.searchParams.get("options")).toBe("-c jit=off");
  });

  it("свой -c jit=… в адресе не перебивается", () => {
    const url = "postgresql://u:p@localhost:5432/db?options=-c%20jit%3Don";
    expect(withSessionSettings(url, {})).toBe(url);
  });

  it("рубильник PG_JIT=on оставляет адрес как есть; пустой и битый адрес не трогаются", () => {
    const url = "postgresql://u:p@localhost:5432/db";
    expect(withSessionSettings(url, { PG_JIT: "on" })).toBe(url);
    expect(withSessionSettings("", {})).toBe("");
    expect(withSessionSettings("not a url", {})).toBe("not a url");
  });
});
