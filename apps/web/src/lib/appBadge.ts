/**
 * Число на иконке установленного приложения (Badging API).
 *
 * ГДЕ ЭТО ВИДНО. На iPhone — начиная с iOS 16.4 и только у приложения,
 * добавленного на домашний экран, при выданном разрешении на уведомления. На
 * компьютере (Chrome, Edge) — на значке в панели задач. В Chrome на Android
 * этого API НЕТ ВОВСЕ: там система сама рисует точку на иконке, пока в шторке
 * висит уведомление, и вмешиваться не нужно.
 *
 * То есть половина сотрудников значка не увидит — и это нормально. Ошибкой
 * было бы строить на нём что-то важное: он напоминание, а не способ доставки.
 * Всё, что обязано дойти, приходит уведомлением.
 *
 * Отказы глотаем молча. Их два вида, и оба ожидаемы: браузер без поддержки и
 * iPhone, где приложение открыто во вкладке Safari, а не с домашнего экрана.
 * Ни то ни другое не поломка и не повод писать в журнал ошибок.
 */

export function badgeSupported(): boolean {
  return typeof navigator.setAppBadge === "function";
}

export function setAppBadge(count: number): void {
  if (!badgeSupported()) return;
  // Ноль показывать нечего: по спецификации setAppBadge(0) значок снимает, но
  // явный вызов clearAppBadge читается однозначнее и ведёт себя так же везде.
  if (count <= 0) {
    clearAppBadge();
    return;
  }
  void navigator.setAppBadge(count).catch(() => {});
}

export function clearAppBadge(): void {
  if (typeof navigator.clearAppBadge !== "function") return;
  void navigator.clearAppBadge().catch(() => {});
}
