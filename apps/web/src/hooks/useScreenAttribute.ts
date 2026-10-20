import { useEffect } from "react";
import { useLocation } from "react-router-dom";

/**
 * `html[data-screen]` — режим «показан экран» из артефакта «Единый пульт
 * директора» (перенесён дословно в theme-2026-proto.css, 10.09.2026).
 *
 * В артефакте пульт и 43 экрана живут на одной странице. Экраны лежат в
 * контейнере `.screens`, который по умолчанию спрятан (`.screens{display:none}`);
 * когда скрипт макета ставит на <html> атрибут `data-screen="<экран>"`, контейнер
 * показывается (`html[data-screen] .screens{display:block}`), а содержимое пульта
 * прячется (`html[data-screen] main.wrap>*…{display:none}`). Один атрибут
 * переключает обе половины.
 *
 * У нас пульт и экраны — разные маршруты (а на «Главной» ещё и разные ветки по
 * роли: директору пульт, агенту ролевой экран), поэтому атрибут ставится по
 * простому правилу: пока смонтирован хоть один пульт — атрибута нет, иначе он
 * стоит, и значением служит первый сегмент адреса. Поймано кадрами 10.09:
 * атрибут «всегда» прятал пульт директора целиком, оставляя одну подложку.
 *
 * Порядок эффектов React — от детей к родителю: пульт успевает отметиться до
 * того, как App пересчитает атрибут на смену адреса, поэтому счётчик, а не
 * флаг, и одна функция `sync` на оба хука.
 */
let pultMounted = 0;
let segment = "home";

function sync(): void {
  const root = document.documentElement;
  if (pultMounted > 0) root.removeAttribute("data-screen");
  else root.setAttribute("data-screen", segment);
}

/** Ставится в App, а не в AppLayout: экран входа и дев-стенды рендерятся мимо рамки. */
export function useScreenAttribute(): void {
  const { pathname } = useLocation();
  useEffect(() => {
    segment = pathname.split("/").filter(Boolean)[0] ?? "home";
    sync();
  }, [pathname]);
}

/** Вызывается в каждом компоненте, который рисует `<div class="pult">`. */
export function usePultMode(): void {
  useEffect(() => {
    pultMounted += 1;
    sync();
    return () => {
      pultMounted -= 1;
      sync();
    };
  }, []);
}
