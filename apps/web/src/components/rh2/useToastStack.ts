import { useLayoutEffect, useRef } from "react";
import type { CSSProperties } from "react";
import { toastStackOffsets } from "./toastStackLayout";

type Stack = { nodes: { current: (HTMLElement | null)[] }; count: number; priority: number; order: number };
const stacks = new Map<symbol, Stack>();
let nextOrder = 0;

function measureStacks() {
  const groups = [...stacks.values()].sort((a, b) => a.priority - b.priority || a.order - b.order);
  const nodes = groups.map(group => group.nodes.current.slice(0, group.count));
  // Read every height before writing positions: wrapping/resize must not cause
  // a read-write layout flush for each message.
  const offsets = toastStackOffsets(nodes.map(group => group.map(node => node?.offsetHeight ?? 0)),
    document.documentElement.dataset.shell === "clean");
  nodes.forEach((group, g) => group.forEach((node, i) => {
    if (node) node.style.marginBottom = `${offsets[g][i]}px`;
  }));
}

/**
 * СТОПКА УВЕДОМЛЕНИЙ ПОВЕРХ ПРИМИТИВА `.toast`.
 *
 * Примитив эталона прижимается к низу экрана сам (`position:fixed; bottom:24px`,
 * на телефоне 92px над нижним меню) и ничего не знает о соседях: три таких
 * элемента лягут друг на друга. У фиксированного элемента `bottom` отмеряется до
 * края ПОЛЯ, поэтому `margin-bottom` поднимает копию вверх, оставляя значение
 * `bottom` тем, что задала тема, вместе с её медиазапросом.
 *
 * ПОЧЕМУ ВЫСОТА ИЗМЕРЯЕТСЯ, А НЕ ЗАДАЁТСЯ ЧИСЛОМ. Первая версия сдвигала каждый
 * следующий тост на постоянные 56 px. На 390 длинный текст переносится на четыре
 * строки, пилюля становится вдвое выше шага, и уведомления наехали друг на
 * друга — кадр 09.09.2026 это и показал. Высота зависит от текста и ширины
 * экрана, значит её надо мерить, а не угадывать.
 *
 * Хук общий для `Toasts` (короткие «Сохранено») и `ui/Toaster` (строка с
 * отменой за 10 секунд): два стора с разными жизненными циклами, но одна и та же
 * геометрия, и копия этой арифметики в двух файлах разъехалась бы.
 * В Clean все зарегистрированные порталы занимают одну стопку; legacy сохраняет
 * отдельное размещение каждого стора. ResizeObserver учитывает перенос текста.
 */
export function useToastStack(count: number, priority = 0) {
  const nodes = useRef<(HTMLElement | null)[]>([]);
  const owner = useRef<symbol>(Symbol("toast-stack"));
  const order = useRef<number | null>(null);
  useLayoutEffect(() => {
    order.current ??= nextOrder++;
    const key = owner.current;
    stacks.set(key, { nodes, count, priority, order: order.current });
    measureStacks();
    const observer = new ResizeObserver(measureStacks);
    nodes.current.slice(0, count).forEach(node => { if (node) observer.observe(node); });
    const shellObserver = new MutationObserver(measureStacks);
    shellObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-shell"] });
    window.addEventListener("resize", measureStacks);
    return () => {
      observer.disconnect();
      shellObserver.disconnect();
      window.removeEventListener("resize", measureStacks);
      stacks.delete(key);
      measureStacks();
    };
  });

  return {
    ref: (i: number) => (el: HTMLElement | null) => {
      nodes.current[i] = el;
    },
    // The layout pass owns this style for all registered portals. React must
    // not overwrite another lifecycle's measured offset during its render.
    style: (_i: number): CSSProperties => ({}),
  };
}
