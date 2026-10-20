/**
 * РАССТОЯНИЕ ДАМЕРАУ—ЛЕВЕНШТЕЙНА — единая реализация (12.09.2026, вынесена из
 * `lib/requestedAgent.ts` при работе над дедупликацией ориентиров,
 * docs/geo-match-plan-12-09.md, блок G/H): распознавание сотрудника по имени
 * (`requestedAgent.ts`) и схлопывание дублей ориентиров при импорте
 * (`prisma/scripts/import-geo.ts`) нуждались в одном и том же алгоритме —
 * второй копии по правилу репозитория быть не должно («копия логики вместо
 * самой логики», CLAUDE.md).
 *
 * С ранним выходом по допуску `max`: как только на очередной строке минимум
 * превышает `max`, дальше можно не считать — сравнение всё равно уже не
 * пройдёт порог. Это и делает функцию пригодной для проверки тысяч пар имён
 * при импорте (иначе на 857 ориентирах O(n²) полных вычислений было бы дорого).
 */

/**
 * Расстояние Дамерау—Левенштейна между `a` и `b`, не более `max` (иначе
 * возвращает `max + 1` — вызывающему важно только «больше допуска или нет»,
 * не точное число за пределами допуска).
 */
export function levenshteinDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev: number[] = Array.from({ length: b.length + 1 }, (_, j) => j);
  let prevPrev: number[] = [];
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(row[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
      // Перестановка соседних букв — одна ошибка, а не две.
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        v = Math.min(v, prevPrev[j - 2] + 1);
      }
      row.push(v);
      if (v < best) best = v;
    }
    if (best > max) return max + 1;
    prevPrev = prev;
    prev = row;
  }
  return prev[b.length];
}
