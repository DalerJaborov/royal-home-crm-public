import { Link } from "react-router-dom";
import { Compass } from "lucide-react";

/**
 * Заглушка для несуществующих адресов. Без неё любой опечатанный или устаревший
 * URL (старая закладка, ссылка из push с изменившимся путём) рендерил layout с
 * пустым Outlet: сайдбар и шапка на месте, содержимого нет вообще. В PWA, куда
 * возвращаются по иконке с сохранённым адресом, это выглядит как поломка.
 */
export function NotFound() {
  return (
    <div className="flex flex-col items-center justify-center text-center py-20 px-4">
      <Compass className="w-10 h-10 text-gray-300 mb-3" strokeWidth={1.5} />
      <h1 className="text-[18px] font-bold tracking-tight mb-1">Страница не найдена</h1>
      <p className="text-[15px] text-gray-500 mb-5 max-w-[420px]">
        Адрес неверный или раздел переехал. Возможно, вы перешли по устаревшей ссылке или закладке.
      </p>
      <Link
        to="/"
        className="bg-blue text-on-accent text-[15px] font-semibold rounded-lg px-4 py-2 shadow-sm hover:bg-blue-hover"
      >
        На главную
      </Link>
    </div>
  );
}
