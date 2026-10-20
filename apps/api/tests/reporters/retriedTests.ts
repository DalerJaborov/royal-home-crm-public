/**
 * СПИСОК ТЕСТОВ, ПРОШЕДШИХ СО ВТОРОЙ ПОПЫТКИ.
 *
 * В CI прогон делает одну повторную попытку (`retry: 1` в vitest.config.ts) —
 * иначе одна плавающая проверка красит всю ветку и выкат встаёт. Но повтор,
 * который никто не видит, за месяц превращает набор в лотерею: тест «зелёный»,
 * хотя на самом деле падает каждый второй раз.
 *
 * Поэтому повтор обязан быть ГРОМКИМ. Этот репортёр печатает в конце прогона
 * поимённый список того, что не прошло с первого раза, — с ним видно, что чинить,
 * и видно, если список растёт. Пустой список — прогон честно зелёный.
 *
 * ПЕРЕПИСАН ПОД vitest 4 (13.09.2026). Раньше здесь был метод `onFinished(files)`
 * и ручной обход дерева `task.tasks` с чтением `task.result.retryCount`. В vitest 4
 * старый task-API репортёров удалён целиком: `onFinished` больше не вызывается
 * НИКОГДА и не считается ошибкой — репортёр молча перестал бы печатать список,
 * а прогон остался бы зелёным. Ровно тот случай, когда обновление ничего не
 * ломает на вид и тихо выключает страховку.
 *
 * Новый API: `onTestRunEnd(testModules)`, обход через `module.children.allTests()`,
 * число попыток — в `test.diagnostic()?.retryCount`, состояние — в `test.result().state`
 * (в vitest 4 это "passed", а не прежнее "pass").
 */
import type { Reporter, TestModule } from "vitest/node";

export class RetriedTestsReporter implements Reporter {
  onTestRunEnd(testModules: ReadonlyArray<TestModule>): void {
    const retried: string[] = [];

    for (const testModule of testModules) {
      for (const test of testModule.children.allTests()) {
        const retries = test.diagnostic()?.retryCount ?? 0;
        if (retries > 0 && test.result().state === "passed") {
          retried.push(`${testModule.moduleId} > ${test.fullName} — попыток: ${retries + 1}`);
        }
      }
    }

    if (retried.length === 0) return;

    // process.stdout, а не console.log: репортёры пишут мимо перехвата вывода
    // тестов, иначе список утонет между строками stderr отдельных файлов.
    process.stdout.write(
      `\n⚠ Прошли только со второй попытки (${retried.length}) — это НЕ норма, чинить:\n` +
        retried.map((line) => `  · ${line}\n`).join("") +
        "\n"
    );
  }
}

export default RetriedTestsReporter;
