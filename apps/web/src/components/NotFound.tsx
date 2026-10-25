import { Compass } from "lucide-react";
import { LinkButton } from "./rh2/Button";
import { Rh2EmptyState } from "./rh2/Rh2EmptyState";
import { Rh2Screen } from "./rh2/Rh2Screen";

/**
 * Заглушка для несуществующих адресов. Без неё любой опечатанный или устаревший
 * URL (старая закладка, ссылка из push с изменившимся путём) рендерил layout с
 * пустым Outlet: сайдбар и шапка на месте, содержимого нет вообще. В PWA, куда
 * возвращаются по иконке с сохранённым адресом, это выглядит как поломка.
 *
 * Страница в теме «Royal Home 2026» (24.10.2026): раньше — голые Tailwind-классы
 * (`text-gray-500`, `bg-blue`) вне `.rh2`, перепись нашла её единственным экраном
 * целиком не из темы. Тексты и действие прежние.
 */
export function NotFound() {
  return (
    <Rh2Screen>
      <div className="card">
        <Rh2EmptyState
          icon={Compass}
          title="Страница не найдена"
          hint="Адрес неверный или раздел переехал. Возможно, вы перешли по устаревшей ссылке или закладке."
          action={<LinkButton to="/">На главную</LinkButton>}
        />
      </div>
    </Rh2Screen>
  );
}
