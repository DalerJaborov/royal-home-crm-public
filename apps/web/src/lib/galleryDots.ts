/**
 * Точки под фотолентой: окно из не более `max` точек вокруг текущего кадра.
 *
 * ПОЧЕМУ ОКНО, А НЕ «ПЕРВЫЕ N» (ревью владельца 21.09.2026: «листание упирается в
 * потолок на 8-м снимке»). Прежняя лента рисовала не больше восьми точек и
 * зажимала индекс тем же числом: с девятого кадра подсветка стояла на месте, и
 * исправная лента читалась как сломанная. Здесь активная точка ВСЕГДА стоит там,
 * где текущий кадр, а окно сдвигается за ним; число кадров ничем не ограничено.
 */
export function galleryDots(current: number, total: number, max = 7): { index: number; active: boolean }[] {
  if (total <= 0) return [];
  const cur = Math.min(Math.max(0, current), total - 1);
  const size = Math.min(max, total);
  const start = Math.min(Math.max(0, cur - Math.floor(size / 2)), total - size);
  return Array.from({ length: size }, (_, i) => ({ index: start + i, active: start + i === cur }));
}
