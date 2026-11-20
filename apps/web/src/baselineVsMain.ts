import { execSync } from "node:child_process";

/**
 * Сверка списка исключений сторожа с `origin/main` (общая для сторожей текстов, ревью #341).
 * Список исключений только убывает: даже если в файл вписали большее число, сравнение с главной веткой это ловит.
 *
 * Нет `origin/main` (не сделан `git fetch origin main`, нет git) — это КРАСНОЕ, а не пропуск: молчаливый пропуск превращает
 * сторожа в декорацию именно там, где его запускают (чистая копия на раннере). Обход для особого случая: `GUARD_NO_ORIGIN=1`.
 * Файла ещё нет на главной ветке (первое появление сторожа) — сверять не с чем, это не ошибка.
 */
export function baselineOnMain<T>(repoRelativePath: string, cwd: string): { ok: true; main: T | null } | { ok: false; why: string } {
  const run = (cmd: string) => execSync(cmd, { cwd, stdio: ["ignore", "pipe", "ignore"], timeout: 15_000 }).toString();
  try {
    run("git rev-parse --verify --quiet origin/main");
  } catch {
    if (process.env.GUARD_NO_ORIGIN === "1") return { ok: true, main: null };
    return { ok: false, why: "нет ветки origin/main: выполните `git fetch origin main` (сверка списка исключений с главной веткой обязательна)" };
  }
  try {
    run(`git cat-file -e origin/main:${repoRelativePath}`);
  } catch {
    return { ok: true, main: null };
  }
  try {
    return { ok: true, main: JSON.parse(run(`git show origin/main:${repoRelativePath}`)) as T };
  } catch (err) {
    return { ok: false, why: `не удалось прочитать ${repoRelativePath} с origin/main: ${err instanceof Error ? err.message : String(err)}` };
  }
}
