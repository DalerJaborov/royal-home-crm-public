/**
 * Запуск e2e против БОЕВОЙ сборки (`vite preview`), см. playwright.config.ts.
 *
 * Отдельный скрипт, а не `E2E_PROD=1 playwright test` в package.json: такая
 * запись не работает в cmd.exe, а разработка идёт и на Windows. Заводить ради
 * одной переменной зависимость (cross-env) избыточно.
 */
import { spawnSync } from "node:child_process";

const result = spawnSync("npx", ["playwright", "test", ...process.argv.slice(2)], {
  stdio: "inherit",
  shell: true,
  env: { ...process.env, E2E_PROD: "1" },
});

process.exit(result.status ?? 1);
