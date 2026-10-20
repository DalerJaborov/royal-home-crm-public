import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { SECRET_SETTINGS_FIELDS } from "../src/lib/settingsSnapshots.js";

/**
 * СТРАЖ: каждый секрет Настроек — в списке SECRET_SETTINGS_FIELDS (23.09.2026).
 *
 * Список вёлся руками и отстал на восемь полей (маркеры TikTok, YouTube,
 * рекламы, бюджетный токен Google, токен станции, маркер удаления Instagram):
 * точка возврата показывала их значение в «чем отличается». Новое поле с
 * «Token», «Secret», «Password» или «ApiKey» в имени без записи в список —
 * красный тест, а не тихая утечка.
 */
/**
 * Комментарии выбрасываются ПЕРЕД разбором схемы (25.09.2026). Проверка, читающая
 * исходник, иначе сторожит текст, а не поведение: поле, закомментированное блоком
 * `/* … *\/`, читалось бы как живое, и страж требовал бы записать в список секретов
 * то, чего в базе нет. Тот же приём и по той же причине, что в
 * `telephony-hooks-registered.test.ts`, где закомментированная строка читалась как
 * живая регистрация — там это поймала подмена кода.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
}

/**
 * Поля с «Key» на конце, которые НЕ секрет (G12, 02.10.2026: страж ловил только
 * «ApiKey», и ключ фида каталога metaCatalogFeedKey показывался в точках
 * возврата целиком). Каждое исключение — с причиной.
 */
const NOT_SECRET_KEY_FIELDS: Record<string, string> = {
  videoTemplateKey: "имя выбранного шаблона ролика, не доступ",
  tiktokClientKey: "открытый идентификатор приложения TikTok, его и так отдаёт GET /settings",
};

describe("SECRET_SETTINGS_FIELDS", () => {
  it("содержит все поля Settings, похожие на секрет", () => {
    const schema = stripComments(
      readFileSync(new URL("../prisma/schema.prisma", import.meta.url), "utf8")
    );
    const body = schema.slice(schema.indexOf("model Settings {"));
    const model = body.slice(0, body.indexOf("\n}"));
    const fields = [...model.matchAll(/^\s{2}(\w+)\s+String/gm)].map((m) => m[1]);
    const secretLike = fields.filter(
      (f) => /(Token|Secret|Password|Key\d*)$/.test(f) && !(f in NOT_SECRET_KEY_FIELDS)
    );
    const missing = secretLike.filter((f) => !(SECRET_SETTINGS_FIELDS as readonly string[]).includes(f));
    expect(missing).toEqual([]);
  });
});
