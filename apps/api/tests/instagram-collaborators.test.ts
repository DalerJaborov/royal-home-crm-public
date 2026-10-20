import { describe, expect, it } from "vitest";
import { instagramCollaboratorsFor } from "../src/lib/instagramCollaborators.js";

/**
 * СОАВТОРЫ INSTAGRAM REELS (26.09.2026) — разбор строки из Настроек +
 * ник агента-хозяина объекта в итоговый список для Graph API. Чистая функция,
 * без базы и сети — см. lib/instagramCollaborators.ts.
 */
describe("instagramCollaboratorsFor", () => {
  it("разбирает @, пробелы, дубли (без учёта регистра) и обрезает до 3", () => {
    const result = instagramCollaboratorsFor({ settingsRaw: "@Ali, ali , bob.k, x, y", agentUsername: null });
    expect(result).toEqual(["ali", "bob.k", "x"]);
  });

  it("ник агента-хозяина ставится первым", () => {
    const result = instagramCollaboratorsFor({ settingsRaw: "bob.k, carla", agentUsername: "Noza" });
    expect(result[0]).toBe("noza");
    expect(result).toEqual(["noza", "bob.k", "carla"]);
  });

  it("агент, уже упомянутый в настройках, не дублируется", () => {
    const result = instagramCollaboratorsFor({ settingsRaw: "noza, bob.k", agentUsername: "noza" });
    expect(result).toEqual(["noza", "bob.k"]);
  });

  it("пустые настройки и пустой агент → пустой список", () => {
    expect(instagramCollaboratorsFor({ settingsRaw: null, agentUsername: null })).toEqual([]);
    expect(instagramCollaboratorsFor({ settingsRaw: "", agentUsername: undefined })).toEqual([]);
    expect(instagramCollaboratorsFor({ settingsRaw: "   ", agentUsername: null })).toEqual([]);
  });

  it("ник с недопустимыми символами тихо выбрасывается, а не ломает публикацию", () => {
    const result = instagramCollaboratorsFor({ settingsRaw: "ok_user, b@d!user, тоже-плохой", agentUsername: null });
    expect(result).toEqual(["ok_user"]);
  });

  it("ник агента с недопустимыми символами не попадает в список", () => {
    const result = instagramCollaboratorsFor({ settingsRaw: "bob.k", agentUsername: "плохой ник" });
    expect(result).toEqual(["bob.k"]);
  });

  it("разделители — запятая, пробел и перевод строки вперемешку", () => {
    const result = instagramCollaboratorsFor({ settingsRaw: "one\ntwo, three  four", agentUsername: null });
    expect(result).toEqual(["one", "two", "three"]); // лимит 3 — four не влезает
  });

  it("больше 3 валидных ников в настройках + агент — агент первым, итог не длиннее 3", () => {
    const result = instagramCollaboratorsFor({ settingsRaw: "a, b, c, d", agentUsername: "z" });
    expect(result).toEqual(["z", "a", "b"]);
    expect(result.length).toBeLessThanOrEqual(3);
  });
});
