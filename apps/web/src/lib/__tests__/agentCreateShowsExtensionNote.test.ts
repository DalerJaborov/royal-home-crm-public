import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Заведение сотрудника не теряет предупреждение сервера (аудит 23.09.2026, №62).
 *
 * «Номер выдан, но в очередь входящих не попал» сервер пишет в ответе на
 * заведение, а форма этот ответ выбрасывала.
 */
const src = readFileSync(fileURLToPath(new URL("../../pages/settings/TeamTab.tsx", import.meta.url)), "utf8");

describe("форма нового сотрудника", () => {
  it("показывает extensionNote из ответа на заведение", () => {
    const body = src.slice(src.indexOf("async function handleCreate"), src.indexOf("async function handleDelete"));
    expect(body).toMatch(/const (\w+) = await createAgent\.mutateAsync/);
    const name = body.match(/const (\w+) = await createAgent\.mutateAsync/)![1];
    expect(body).toContain(`setExtensionNote(${name}?.extensionNote`);
  });
});
