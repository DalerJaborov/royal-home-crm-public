import { ABSENCE_KIND_LABELS, type AbsenceKind } from "@royal-home/shared";

/**
 * Как называется отсутствие сотрудника в списке команды (владелец 09.09.2026).
 *
 * ОДНА ФУНКЦИЯ НА ОБЕ ШИРИНЫ. До 22.09.2026 раздел «Команда» рисовался двумя
 * разными компонентами — pages/Team.tsx и components/mobile/MobileTeam.tsx, — и
 * слово «заморожен» было написано в каждом из них своей строкой. Такие пары
 * расходятся молча: правку видит тот экран, который открыли, а второй месяцами
 * показывает старое (см. CLAUDE.md, случай с Oversight). Мобильный компонент
 * удалён, но функция осталась общей: её вызывают и широкая таблица, и узкий
 * список внутри одного pages/Team.tsx.
 *
 * Пусто, если человек на работе. «Заморожен» без вида — это прежняя экстренная
 * заморозка для разбирательства, и называть её отпуском нельзя.
 */
export function absenceLabel(member: {
  frozen: boolean;
  absenceKind?: AbsenceKind | null;
  absenceUntil?: string | null;
}): string {
  if (!member.frozen) return "";
  const name = member.absenceKind ? ABSENCE_KIND_LABELS[member.absenceKind].toLowerCase() : "заморожен";
  if (!member.absenceUntil) return name;
  const date = new Date(member.absenceUntil);
  if (Number.isNaN(date.getTime())) return name;
  // Часовой пояс задан явно: контейнер живёт в UTC, и без него дата выхода
  // 20 сентября показывалась бы 19-м (см. CLAUDE.md, ловушки репозитория).
  const day = date.toLocaleDateString("ru-RU", { day: "numeric", month: "long", timeZone: "Asia/Dushanbe" });
  return `${name} до ${day}`;
}
