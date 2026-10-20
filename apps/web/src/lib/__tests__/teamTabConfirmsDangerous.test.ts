import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * ОТКЛЮЧЕНИЕ СОТРУДНИКА И СБРОС 2FA — ТОЛЬКО ЧЕРЕЗ ПОДТВЕРЖДЕНИЕ (глубокая
 * проверка 02.10.2026, F6).
 *
 * Иконка «Деактивировать» в списке сотрудников слала PATCH одним нажатием.
 * Сервер на отключение гасит сеансы, удаляет подписки на пуши, возвращает
 * непринятые лиды в очередь и НЕОБРАТИМО снимает человека с дежурств в
 * настройках — промах по соседней иконке стоил всего этого. Сброс 2FA рядом
 * — тоже одно нажатие. Теперь оба идут через ConfirmDialog; рендер без DOM
 * здесь не нажать, поэтому сторож смотрит в исходник: прямого вызова из
 * onClick строки быть не должно.
 */
const FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../pages/settings/TeamTab.tsx");

describe("TeamTab: опасные действия строки сотрудника", () => {
  const text = fs.readFileSync(FILE, "utf8").replace(/\r\n/g, "\n");

  it("отключение не вызывается прямо из onClick иконки", () => {
    expect(text).not.toMatch(/onClick=\{\(\) => updateAgent\.mutate\(\{ id: a\.id, body: \{ isActive: !a\.isActive \} \}\)\}/);
  });

  it("сброс 2FA не вызывается прямо из onClick иконки", () => {
    expect(text).not.toMatch(/onClick=\{async \(\) => \{\s*try \{\s*await reset2fa\.mutateAsync\(a\.id\)/);
  });

  it("подтверждение называет последствия отключения", () => {
    expect(text).toMatch(/выйдет из всех сеансов/);
    expect(text).toMatch(/дежурств/);
  });
});
