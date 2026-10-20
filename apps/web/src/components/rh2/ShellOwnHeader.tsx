import { useShellClaim } from "../../store/shell";

/**
 * Пометка «этот экран рисует шапку сам» (`.rh2 .mh > .top` / `.chead`).
 *
 * Ставится первым ребёнком области `.mh` рядом с шапкой, которую рисует экран.
 * Ничего не отрисовывает: пока метка в дереве, шапка оболочки на телефоне
 * скрыта и вторая полоса сверху не появляется. Заменяет прежний
 * MutationObserver в `Topbar`, который искал `.top`/`.chead` в разметке
 * (store/shell.ts). Экран, который переезжает на `<Rh2Screen title=…>`, метку
 * удаляет вместе со своей шапкой.
 */
export function ShellOwnHeader() {
  useShellClaim({ ownHeader: true });
  return null;
}
