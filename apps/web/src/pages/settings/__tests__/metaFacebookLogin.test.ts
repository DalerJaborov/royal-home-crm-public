import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { MetaLoginAssets } from "@royal-home/shared";
import {
  defaultMetaLoginSelection,
  readMetaLoginParam,
  selectionToInput,
  toggleInSelection,
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
  warnings: [],
};

describe("выбор после входа", () => {
  it("сразу отмечено только новое и доступное", () => {
    expect(defaultMetaLoginSelection(assets)).toEqual({ pages: ["1001"], instagram: ["17841"], adAccounts: ["act_1"] });
  });

  it("галочка ставится и снимается без дублей", () => {
    const base = defaultMetaLoginSelection(assets);
    const on = toggleInSelection(toggleInSelection(base, "adAccounts", "act_3", true), "adAccounts", "act_3", true);
    expect(on.adAccounts).toEqual(["act_1", "act_3"]);
    expect(toggleInSelection(on, "pages", "1001", false).pages).toEqual([]);
  });

  it("в запрос уходят виды по своим полям", () => {
    expect(selectionToInput({ pages: ["1"], instagram: ["2"], adAccounts: ["act_3"] })).toEqual({ pageIds: ["1"], instagramIds: ["2"], adAccountIds: ["act_3"] });
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

  it("без слов «токен» и «OAuth» на экране входа", () => {
    const block = src.slice(src.indexOf("function FacebookLogin()"));
    expect(block).not.toMatch(/токен|OAuth/i);
  });
});
