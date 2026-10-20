import { useEffect, useId, type ReactNode } from "react";
import { create } from "zustand";

/**
 * ЗАГОЛОВОК ЭКРАНА, КОТОРЫЙ ПОКАЗЫВАЕТ ШАПКА ОБОЛОЧКИ НА ТЕЛЕФОНЕ (06.10.2026,
 * контракт оболочки, задание B).
 *
 * Раньше `Topbar` угадывал, нужен ли ему заголовок, нюхая DOM: MutationObserver
 * на `.rh2 .mh > .top, .chead` и IntersectionObserver на `h1` с таймером в
 * 1200 мс. Угадывание давало двойные шапки (экран уже нарисовал свою, а оболочка
 * не успела заметить) и пустые полоски (заголовок появился позже таймера). Теперь
 * экран говорит сам, одним из двух способов, и оболочка только исполняет:
 *
 *   · `title` (+ `back`, `actions`) — экран отдаёт заголовок шапке оболочки
 *     (`<Rh2Screen title="Клиенты">`); шапка рисует его, кнопку «Назад» и до
 *     двух круглых кнопок справа;
 *   · `ownHeader` — экран рисует шапку сам (`.rh2 .mh > .top` / `.chead`), и
 *     шапка оболочки на телефоне не рисуется вовсе (`<ShellOwnHeader />`).
 *
 * Не заявил ничего (старая страница без обёртки) — шапка берёт имя раздела из
 * реестра `lib/navigation.ts`, как и раньше: у такой страницы нет другого
 * заголовка, кроме h1 внутри, и терять шапку с поиском и колокольчиком нельзя.
 *
 * ЧИСТКА. Каждая заявка помечена владельцем (`useId`), `release` гасит её только
 * если она ещё текущая. Дело в порядке эффектов React: при смене маршрута
 * очистка старого экрана идёт ДО эффекта нового, поэтому сброс «по смене пути» в
 * родителе стёр бы заявку нового экрана, а чистка владельцем — нет. Размонтирован
 * экран — заявка ушла; следующий экран заявит свою.
 */

export interface ShellClaim {
  /** Заголовок для шапки телефона; `null` — не задан. */
  title?: string | null;
  /** Путь раздела, куда ведёт «Назад» (не `history.back()`), либо `null`. */
  back?: string | null;
  /** Optional existing history controller; the path still defines back context. */
  onBack?: (() => void) | null;
  /** До двух круглых кнопок справа; лишние шапка не рисует. */
  actions?: ReactNode;
  /** Экран рисует шапку сам: оболочка на телефоне свою убирает. */
  ownHeader?: boolean;
}

interface ShellState {
  owner: string | null;
  title: string | null;
  back: string | null;
  onBack: (() => void) | null;
  actions: ReactNode;
  ownHeader: boolean;
  /** Записать заявку владельца (заменяет прежнюю целиком). */
  setShell: (owner: string, claim: ShellClaim) => void;
  /** Снять заявку, если она всё ещё принадлежит этому владельцу. */
  release: (owner: string) => void;
}

const EMPTY = { owner: null, title: null, back: null, onBack: null, actions: null, ownHeader: false } as const;

export const useShellStore = create<ShellState>((set, get) => ({
  ...EMPTY,
  setShell: (owner, claim) =>
    set({
      owner,
      title: claim.title ?? null,
      back: claim.back ?? null,
      onBack: claim.onBack ?? null,
      actions: claim.actions ?? null,
      ownHeader: claim.ownHeader ?? false,
    }),
  release: (owner) => {
    if (get().owner === owner) set({ ...EMPTY });
  },
}));

/**
 * Заявить заголовок/шапку из компонента экрана. Пишет в стор при монтировании и
 * при смене значений, чистит при размонтировании.
 *
 * `actions` — узел React: новый на каждый рендер экрана, поэтому в зависимости
 * эффекта он входит и перезаписывается каждый раз; это дёшево (стор читает
 * только шапка) и единственный способ держать кнопки актуальными.
 */
export function useShellClaim({ title, back, onBack, actions, ownHeader }: ShellClaim): void {
  const owner = useId();
  const setShell = useShellStore((s) => s.setShell);
  const release = useShellStore((s) => s.release);
  useEffect(() => {
    setShell(owner, { title, back, onBack, actions, ownHeader });
  }, [owner, setShell, title, back, onBack, actions, ownHeader]);
  useEffect(() => () => release(owner), [owner, release]);
}
