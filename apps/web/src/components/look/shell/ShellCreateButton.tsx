import { Plus } from "lucide-react";
import { QuickCreateRing, useQuickCreate } from "../../quickCreate";

/**
 * Круглая «+» «Нового вида» (макет 27.11.2026, пачка shell2): та же шторка быстрых действий
 * по нажатию и тот же голос по удержанию, что у прежней «+» нижнего меню (components/quickCreate.tsx).
 * Стоит в шапке у колокола (RoyalTopbarRow) и в своей шапке «Чатов» на телефоне, где общей шапки нет.
 */
export function ShellCreateButton({ className = "" }: { className?: string }) {
  const quick = useQuickCreate({ ensureObjectNew: true });
  return (
    <>
      <button type="button" {...quick.buttonProps} data-fab data-topbar-create className={`ry-create-btn ${className}`.trim()}
        aria-label="Создать: быстрые действия, удержите для голосового ввода">
        <QuickCreateRing />
        <Plus className="w-[22px] h-[22px]" strokeWidth={1.9} aria-hidden="true" />
      </button>
      {quick.menu}
    </>
  );
}
