import fs from "node:fs";
import path from "node:path";
import base from "./playwright.config";

/**
 * E2E В ВЕБ-СЕССИИ claude.ai/code (22.09.2026).
 *
 * До этой обёртки считалось, что в веб-сессии браузерных проверок не бывает, и
 * ночные смены обходились сборкой и серверными тестами. На деле Chromium в
 * образе есть — не сходятся только ревизии: `@playwright/test` из
 * package-lock.json ждёт свою (`chromium_headless_shell-1234`), а в образе
 * лежит та, что положил образ. `npx playwright install` в этом окружении
 * запускать нельзя (сеть закрыта политикой, и это прямо оговорено в
 * docs/web-session-stand.md), поэтому подсовываем настоящий бинарник.
 *
 * Чего это стоит знать: смоук на телефонном проекте ловил живую регрессию
 * профиля (ключ входа и 2FA пропали с телефона после переноса облика 2026),
 * которую не видели ни `tsc`, ни 1618 серверных тестов.
 *
 * Запуск:
 *   npm run e2e:web-session --workspace=apps/web -- --grep @smoke
 *
 * На машине владельца и в CI этот конфиг не нужен: там обычный
 * `npm run e2e --workspace=apps/web` с браузерами самого Playwright.
 */

/** Папка браузеров образа. Ревизию не зашиваем: образ её меняет. */
const browsersRoot = process.env.PLAYWRIGHT_BROWSERS_PATH || "/opt/pw-browsers";

function findChromium(): string | undefined {
  // Полноценный Chromium, а не headless shell: shell не умеет часть того, что
  // проверяют наши тесты (окно выбора файла, установка PWA).
  const candidates = fs.existsSync(browsersRoot)
    ? fs
        .readdirSync(browsersRoot)
        .filter((name) => /^chromium(-\d+)?$/.test(name))
        .map((name) => path.join(browsersRoot, name, "chrome-linux", "chrome"))
    : [];
  return candidates.find((p) => fs.existsSync(p));
}

const executablePath = findChromium();
if (!executablePath) {
  // Молчаливое падение здесь читается как поломка приложения, а не стенда —
  // ровно та путаница, из-за которой в конфиге репозитория есть E2E_API_URL.
  throw new Error(
    `Chromium не найден в ${browsersRoot}. Этот конфиг только для веб-сессии claude.ai/code; на своей машине запускай обычный npm run e2e --workspace=apps/web.`
  );
}

const here = path.dirname(new URL(import.meta.url).pathname);

export default {
  ...base,
  // Пути в конфиге репозитория заданы относительно apps/web; при запуске из
  // другой папки Playwright считал бы их от папки конфига.
  testDir: path.join(here, "tests", "e2e"),
  webServer: (base.webServer as { cwd?: string }[] | undefined)?.map((w) => ({ ...w, cwd: here })),
  projects: (base.projects ?? []).map((p) => ({
    ...p,
    use: {
      ...(p.use ?? {}),
      launchOptions: { ...((p.use as { launchOptions?: object } | undefined)?.launchOptions ?? {}), executablePath },
    },
  })),
};
