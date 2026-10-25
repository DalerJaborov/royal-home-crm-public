import { useMemo } from "react";
import { canViewInvestigations, resolvePermissions, type PermissionId } from "@royal-home/shared";
import { useAuthStore } from "../store/auth";
import { useMyProfile } from "../hooks/useMe";

/**
 * Итоговые права текущего сотрудника.
 *
 * Источник истины — ответ GET /me, где права уже посчитаны сервером с учётом
 * персональных надстроек. Пока профиль грузится, показываем пресет роли из
 * сохранённой сессии: это убирает мигание меню при открытии вкладки и почти
 * всегда совпадает с итогом (надстройки — исключение, а не правило).
 *
 * Всё это ТОЛЬКО про внешний вид. Каждый роут API проверяет право сам
 * (requirePermission), поэтому подмена ответа в браузере ничего не открывает —
 * пользователь увидит кнопку и получит на неё 403.
 */
export function usePermissions(): Set<PermissionId> {
  const role = useAuthStore((s) => s.agent?.role);
  const { data } = useMyProfile();
  const granted = data?.permissions;
  return useMemo(() => {
    if (granted) {
      const effective = new Set(granted);
      if (!canViewInvestigations(data?.role ?? role)) effective.delete("clients.securityReview");
      return effective;
    }
    return role ? resolvePermissions(role, null) : new Set<PermissionId>();
  }, [granted, role, data?.role]);
}

export function useCanViewInvestigations(): boolean {
  const role = useAuthStore((s) => s.agent?.role);
  const { data } = useMyProfile();
  return canViewInvestigations(data?.role ?? role);
}

/** `const can = useCan(); ... can("finance.view")` — короткая проверка в разметке. */
export function useCan(): (permission: PermissionId) => boolean {
  const permissions = usePermissions();
  return useMemo(() => (permission: PermissionId) => permissions.has(permission), [permissions]);
}

/**
 * Заводит ли эта роль объекты (решение владельца 02.10.2026, глубокая проверка
 * A12): служба безопасности проверяет работу, а не ведёт её — кнопок «Новый
 * объект» у неё нет, а сервер на POST /properties отвечает отказом
 * (routes/properties/shared.ts::propertyCreateDeniedReason). Смотреть и
 * проверять объекты СБ по-прежнему может.
 */
export function roleCreatesProperties(role: string | undefined | null): boolean {
  return role !== "SECURITY" && role !== "SHAREHOLDER";
}

/** The saved role keeps mutation controls closed while /me is loading. */
export function useIsReadOnly(): boolean {
  const role = useAuthStore((s) => s.agent?.role);
  const { data } = useMyProfile();
  return role === "SHAREHOLDER" || data?.readOnly === true;
}

/** `const canCreate = useCanCreateProperty()` — та же проверка для разметки. */
export function useCanCreateProperty(): boolean {
  const role = useAuthStore((s) => s.agent?.role);
  const readOnly = useIsReadOnly();
  return roleCreatesProperties(role) && !readOnly;
}
