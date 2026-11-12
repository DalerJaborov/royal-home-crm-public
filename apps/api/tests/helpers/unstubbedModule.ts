/**
 * Модуль без заглушки для тестов, которые грузят настоящий assistantBot.ts в песочнице
 * (runInNewContext) и подменяют его импорты картой (12.11.2026).
 *
 * Раньше такой модуль подменялся пустым объектом `{}`, и новый импорт в боте ронял тест
 * только в облаке безликим «X is not a function» (ship #147 обрывался так четыре раза).
 * Теперь вызов любой функции такого модуля называет модуль и имя: добавь заглушку в карту.
 * Константы (имена с заглавной) читаются как undefined, как и прежде.
 */
export function unstubbedModule(testName: string, name: string): Record<string, unknown> {
  return new Proxy({}, {
    get(_target, prop) {
      if (typeof prop !== "string" || prop === "__esModule" || prop === "then") return undefined;
      if (!/^[a-z]/.test(prop)) return undefined;
      return () => { throw new Error(`${testName}: нет заглушки для ${name} (вызов ${prop}) — добавь её в карту зависимостей`); };
    },
  });
}
