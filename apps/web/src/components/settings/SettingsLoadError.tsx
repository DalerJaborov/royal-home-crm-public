import { useSettings } from "../../hooks/useSettings";
import { Rh2ErrorState } from "../rh2/Rh2ErrorState";

/**
 * Настройки читает вся страница разом (один запрос на двадцать разделов), а часть разделов при `!settings` просто
 * ничего не рисует (`return null`). Если запрос упал, человек видел пустую страницу без слова (К14, аудит
 * 20.11.2026). Одна строка над вкладкой говорит об этом словами и даёт «Повторить»; разделы остаются как были.
 */
export function SettingsLoadError() {
  const { data, isError, refetch, isFetching } = useSettings();
  if (!isError || data) return null;
  return <Rh2ErrorState message="Не удалось загрузить настройки. Проверьте связь и нажмите «Повторить»." onRetry={() => void refetch()} retrying={isFetching} />;
}
