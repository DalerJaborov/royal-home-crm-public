import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { MetaLoginAssets } from "@royal-home/shared";
import {
  defaultMetaLoginSelection,
  readMetaLoginParam,
  selectionToInput,
  toggleInSelection,
  whatsappNumberHint,
  withoutMetaLoginParams,
} from "../../../lib/metaLoginSelection";

/** «Войти через Facebook» в Настройках → Каналы (13.11.2026): правила выбора и возврата. */
const assets: MetaLoginAssets = {
  pages: [
    { id: "1001", name: "Arvan", canMessage: true, ig: { id: "17841", username: "arvan" }, connected: null },
    { id: "1002", name: "Royal Home", canMessage: true, ig: null, connected: "settings" },
    { id: "1003", name: "Чужая", canMessage: false, ig: null, connected: null },
    { id: "1004", name: "Уже есть", canMessage: true, ig: null, connected: "account" },
  ],
  instagram: [
    { id: "17841", username: "arvan", pageId: "1001", pageName: "Arvan", connected: null },
    { id: "17842", username: "info", pageId: "1004", pageName: "Уже есть", connected: "page" },
  ],
  adAccounts: [
    { id: "act_1", name: "Свой", status: 1, connected: false },
    { id: "act_2", name: "Закрытый", status: 2, connected: false },
    { id: "act_3", name: "Уже в отчёте", status: 1, connected: true },
  ],
  whatsapp: [
    { id: "50001", phone: "+992 90 000 0001", name: "Arvan", wabaId: "60001", wabaName: "Arvan WA", registered: true, verified: true, connected: null },
    { id: "50002", phone: "+992 90 000 0002", name: "Arvan 2", wabaId: "60001", wabaName: null, registered: false, verified: false, connected: null },
    { id: "50009", phone: "+992 90 000 0009", name: "Royal Home", wabaId: "60002", wabaName: null, registered: true, verified: true, connected: "settings" },
    { id: "50003", phone: null, name: null, wabaId: "60001", wabaName: null, registered: true, verified: true, connected: "account" },
  ],
  keyKind: "personal",
  warnings: [],
};

describe("выбор после входа", () => {
  it("сразу отмечено только новое и доступное", () => {
    expect(defaultMetaLoginSelection(assets)).toEqual({
      pages: ["1001"],
      instagram: ["17841"],
      adAccounts: ["act_1"],
      // Основной номер из Настроек и уже подключённый — не отмечены; незарегистрированный — отмечен (подключить можно).
      whatsapp: ["50001", "50002"],
    });
  });

  it("галочка ставится и снимается без дублей", () => {
    const base = defaultMetaLoginSelection(assets);
    const on = toggleInSelection(toggleInSelection(base, "adAccounts", "act_3", true), "adAccounts", "act_3", true);
    expect(on.adAccounts).toEqual(["act_1", "act_3"]);
    expect(toggleInSelection(on, "pages", "1001", false).pages).toEqual([]);
  });

  it("в запрос уходят виды по своим полям", () => {
    expect(selectionToInput({ pages: ["1"], instagram: ["2"], adAccounts: ["act_3"], whatsapp: ["4"] })).toEqual({
      pageIds: ["1"],
      instagramIds: ["2"],
      adAccountIds: ["act_3"],
      whatsappIds: ["4"],
    });
  });

  it("подпись номера WhatsApp говорит, что мешает, бытовыми словами", () => {
    expect(whatsappNumberHint(assets.whatsapp[0])).toContain("Arvan WA");
    expect(whatsappNumberHint(assets.whatsapp[1])).toContain("зарегистрировать");
    expect(whatsappNumberHint(assets.whatsapp[2])).toContain("Основной номер");
  });
});

describe("возврат из Facebook", () => {
  it("id сессии, ошибка и мусор различаются", () => {
    expect(readMetaLoginParam(new URLSearchParams(`tab=channels&metaLogin=${"a".repeat(36)}`))).toEqual({ kind: "session", id: "a".repeat(36) });
    expect(readMetaLoginParam(new URLSearchParams("metaLogin=error&message=Вход%20отменён"))).toEqual({ kind: "error", message: "Вход отменён" });
    expect(readMetaLoginParam(new URLSearchParams("metaLogin=<script>"))?.kind).toBe("error");
    expect(readMetaLoginParam(new URLSearchParams("tab=channels"))).toBeNull();
  });

  it("после подключения адрес очищается, вкладка остаётся", () => {
    expect(withoutMetaLoginParams(new URLSearchParams("tab=channels&metaLogin=x&message=y")).toString()).toBe("tab=channels");
  });
});

describe("экран MetaEternalKeys", () => {
  const src = readFileSync(fileURLToPath(new URL("../MetaEternalKeys.tsx", import.meta.url)), "utf8");

  it("кнопка входа уводит в окно Facebook адресом от сервера", () => {
    expect(src).toContain("Войти через Facebook");
    expect(src).toContain('api("/settings/meta-eternal/login"');
    expect(src).toContain("window.location.assign(url)");
  });

  it("секция WhatsApp: номера галочками, предупреждение о личном ключе, честная строка про одобрение Meta", () => {
    const block = src.slice(src.indexOf("function FacebookLogin()"));
    expect(block).toContain('title="WhatsApp"');
    expect(block).toContain('pick("whatsapp", n.id)');
    expect(block).toContain('data.keyKind !== "business"');
    expect(block).toContain("Meta должна одобрить");
    expect(block).toContain("пока публикуются только на основную Страницу");
  });

  it("без слов «токен» и «OAuth» на экране входа", () => {
    const block = src.slice(src.indexOf("function FacebookLogin()"));
    expect(block).not.toMatch(/токен|OAuth/i);
  });
});
