import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { createBlobUrlRegistry } from "../blobUrlRegistry";

/** Аудит 04.10.2026, WEB-PAGES04: просмотрщик фото переписки не освобождал blob-ссылки. */
describe("реестр blob-ссылок", () => {
  it("при закрытии освобождает все выданные ссылки", () => {
    const revoke = vi.fn();
    const reg = createBlobUrlRegistry(revoke);
    reg.track("blob:1");
    reg.track("blob:2");
    reg.track(null);
    reg.dispose();
    expect(revoke.mock.calls.map((c) => c[0]).sort()).toEqual(["blob:1", "blob:2"]);
  });

  it("ссылка, пришедшая после закрытия, освобождается сразу", () => {
    const revoke = vi.fn();
    const reg = createBlobUrlRegistry(revoke);
    reg.dispose();
    expect(reg.track("blob:late")).toBeNull();
    expect(revoke).toHaveBeenCalledWith("blob:late");
  });

  it("повторное закрытие не освобождает дважды", () => {
    const revoke = vi.fn();
    const reg = createBlobUrlRegistry(revoke);
    reg.track("blob:1");
    reg.dispose();
    reg.dispose();
    expect(revoke).toHaveBeenCalledTimes(1);
  });
});

describe("ChatPhotoViewer", () => {
  it("кладёт полученные ссылки в реестр, а cleanup не читает замкнутую карту", () => {
    const src = readFileSync(fileURLToPath(new URL("../../components/chat/ChatPhotoViewer.tsx", import.meta.url)), "utf8");
    expect(src).toContain("createBlobUrlRegistry");
    expect(src).not.toMatch(/for \(const url of resolved\.values\(\)\)/);
  });
});
