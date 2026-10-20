import type { UseMutationResult } from "@tanstack/react-query";

/**
 * Единая плашка ошибки для мутаций.
 *
 * В CRM много действий с оптимистичным обновлением (принять лид, сменить статус,
 * подвинуть сделку, восстановить из Корзины): при отказе сервера кэш откатывался
 * молча — карточка на миг менялась и возвращалась обратно. Пользователь при этом
 * уверен, что кнопка сломана, и жмёт ещё раз. Сервер же отвечает по делу: «лид уже
 * переназначен», «объект уже продан», «нужно подтвердить личность». Показываем это.
 *
 * Принимает мутацию целиком, чтобы на месте вызова была одна строка и нельзя было
 * забыть про reset() — без него ошибка залипает на экране после успешной повторной
 * попытки.
 */
export function MutationError({
  mutation,
  fallback = "Не удалось выполнить действие",
  className = "",
  variant = "legacy",
}: {
  mutation: Pick<UseMutationResult<unknown, Error, never>, "isError" | "error" | "reset">;
  fallback?: string;
  className?: string;
  /**
   * `rh2` — оформление темы «Royal Home 2026» (тихая строка `.quiet.crit`), для
   * экранов, уже перенесённых на макет. `legacy` — прежняя красная плашка, пока
   * экран не перенесён. Разные экраны переезжают волнами, поэтому плашка обязана
   * уметь оба облика: один компонент, а не копия текста «Понятно» в каждом файле.
   */
  variant?: "legacy" | "rh2";
}) {
  if (!mutation.isError) return null;
  const message = mutation.error instanceof Error ? mutation.error.message : fallback;
  if (variant === "rh2") {
    return (
      <div role="alert" className={`quiet crit ${className}`}>
        <span className="dot crit" />
        <span className="txt">{message}</span>
        <button className="lnk" type="button" onClick={() => mutation.reset()}>
          Понятно
        </button>
      </div>
    );
  }
  return (
    <div
      role="alert"
      className={`flex items-start gap-2 p-2.5 text-[15px] text-red bg-red-bg rounded-lg ${className}`}
    >
      <span className="flex-1">{message}</span>
      <button type="button" onClick={() => mutation.reset()} className="font-semibold shrink-0 hover:underline">
        Понятно
      </button>
    </div>
  );
}
