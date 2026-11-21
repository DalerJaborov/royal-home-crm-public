import { useSettings } from "../../hooks/useSettings";
import { Rh2ErrorState, Rh2OfflineState, loadView } from "../rh2/Rh2ErrorState";

/**
 * Настройки читает вся страница разом (один запрос на двадцать разделов), а часть разделов при `!settings` просто
 * ничего не рисует (`return null`). Если запрос упал или связи нет, человек видел пустую страницу без слова (К14,
 * аудит 20.11.2026). Одна строка над вкладкой говорит об этом словами и даёт «Повторить»; разделы остаются как были.
 * Решает общая `loadView` (components/rh2/Rh2ErrorState): есть данные — ничего не показываем.
 */
export function SettingsLoadError() {
  const query = useSettings();
  const view = loadView(query);
  if (view === "offline") return <Rh2OfflineState onRetry={() => void query.refetch()} />;
  if (view !== "error") return null;
  return <Rh2ErrorState message="Не удалось загрузить настройки. Проверьте связь и нажмите «Повторить»." onRetry={() => void query.refetch()} retrying={query.isFetching} />;
}
