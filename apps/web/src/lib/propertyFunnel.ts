/**
 * Ступень пути покупателя, на которой теряется больше всего людей: худшая доля
 * перехода с предыдущей ступени. Ступени без числа («площадка не отдаёт») и
 * переходы с нуля пропускаются; рост (людей стало больше, чем на прошлой
 * ступени — так бывает, клиенты приходят не только с сайта) потерей не считается.
 * null — теряться негде.
 */
export function leakIndex(steps: { count: number | null }[]): number | null {
  let worst: { i: number; share: number } | null = null;
  for (let i = 1; i < steps.length; i++) {
    const prev = steps[i - 1].count;
    const cur = steps[i].count;
    if (prev == null || cur == null || prev <= 0) continue;
    const share = Math.min(1, cur / prev);
    if (share < 1 && (!worst || share < worst.share)) worst = { i, share };
  }
  return worst?.i ?? null;
}
