import { matchPath, NavLink, useLocation, useNavigate } from "react-router-dom";
import type { PermissionId } from "@royal-home/shared";
import { useCan } from "../lib/permissions";
import { useCleanShell } from "../hooks/useCleanShell";
import { useNarrowScreen } from "../hooks/useNarrowScreen";

/**
 * ОДИН вид вкладок на все свёрнутые разделы CRM.
 *
 * ЗАЧЕМ. Меню было подрезано с 34 пунктов до 19 (решение владельца 15.09.2026,
 * вариант «плоские восемь»): всё, что было не отдельным местом работы, а срезом
 * того же списка — «Отложенные», «Потерянные», «Воронка лидов», «Карта
 * объектов», «Источники лидов», «Конвейер», «Тренировка», «Интеграции»,
 * «Резервные копии», «Активность», «Вакансии» — переехало внутрь своего экрана
 * вкладкой. Семь экранов получают вкладки одновременно, и если каждый нарисует
 * их по-своему, сокращение меню обернётся семью разными полосками — ровно тем
 * разнобоем, из-за которого меню и начали чинить.
 *
 * Поэтому вид здесь один и берётся из эталона темы: `.seg-ai` артефакта
 * ff1d9d17 (пилюля 36 px, активная — на карточке, счётчик пастельным чипом
 * `.n`). Свои Tailwind-классы под вкладки больше не пишутся нигде: до этого
 * `ClientsTabs` рисовал собственные `rounded-lg px-3 py-1.5`, и вкладки
 * «Клиентов» уже не совпадали ни с одним другим элементом темы.
 *
 * ДУБЛИ. Состав приходит массивом, а компонент ОТСЕИВАЕТ повторы по `to`
 * (см. `dedupe` ниже) — при переносе пунктов из меню один и тот же маршрут
 * легко приезжает в набор дважды: из старого списка экрана и из нового
 * реестра. Молча продублированная вкладка выглядит как опечатка дизайна и
 * ломает подсветку активной (две ссылки на один путь подсвечиваются обе).
 *
 * ПРАВА. Вкладка с `permission` рисуется по тому же праву, что и раздел в
 * `lib/navigation.ts`: вкладка, ведущая туда, куда сервер не пустит, — обещание,
 * которого приложение не сдержит.
 */
export interface ScreenTab {
  /** Маршрут вкладки. Он же ключ уникальности: повторы отсеиваются. */
  to: string;
  label: string;
  /** Число рядом с подписью: размер среза, не «требует действия». */
  count?: number | null;
  /** Право, без которого вкладки не существует (как в реестре меню). */
  permission?: PermissionId;
  /** Дополнительное условие видимости для случаев, когда одного права мало.
   *  В реестре меню часть разделов открыта по «или»: «Реклама» — это
   *  `finance.view` ИЛИ роль маркетолога, «Маркетинг» — `properties.moderate`
   *  ИЛИ `properties.aiListing`, «Тренировка» — ещё и рубильник в настройках.
   *  Вкладка обязана повторять то же условие, иначе она либо прячется от того,
   *  кому раздел открыт, либо ведёт в отказ. `undefined` — условия нет. */
  when?: boolean;
  /** Точное совпадение пути — для корневой вкладки раздела («/clients»). */
  end?: boolean;
}

/** Убирает повторяющиеся маршруты, сохраняя порядок первого появления. */
function dedupe(tabs: ScreenTab[]): ScreenTab[] {
  const seen = new Set<string>();
  return tabs.filter((t) => (seen.has(t.to) ? false : (seen.add(t.to), true)));
}

export function ScreenTabs({ tabs, right }: { tabs: ScreenTab[]; right?: React.ReactNode }) {
  const can = useCan();
  const clean = useCleanShell();
  const narrow = useNarrowScreen();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const visible = dedupe(tabs)
    .filter((t) => t.when !== false)
    .filter((t) => !t.permission || can(t.permission));

  // Одна вкладка — это не выбор, а подпись: полоса из единственной пилюли
  // только занимает строку и предлагает нажать на то, что уже открыто.
  if (visible.length < 2 && !right) return null;

  // One permission-filtered registry serves every section. Long phone rows
  // become a native picker instead of hiding destinations beyond the edge.
  // Short rows, desktop navigation and the AGENT legacy branch stay as before.
  if (clean && narrow && visible.length > 3) {
    const bySpecificity = [...visible].sort((a, b) => b.to.length - a.to.length);
    const active = bySpecificity.find((tab) => matchPath({ path: tab.to.split(/[?#]/)[0], end: tab.end ?? false }, pathname))
      ?? bySpecificity.find((tab) => matchPath({ path: tab.to.split(/[?#]/)[0], end: false }, pathname));
    return (
      <nav className="clean-section-switcher" aria-label="Разделы экрана">
        <select aria-label="Перейти в раздел" value={active?.to ?? ""} onChange={(event) => navigate(event.target.value)}>
          {!active && <option value="" disabled>Выберите раздел</option>}
          {visible.map((tab) => <option key={tab.to} value={tab.to}>{tab.label}{typeof tab.count === "number" ? ` · ${tab.count > 99 ? "99+" : tab.count}` : ""}</option>)}
        </select>
        {right && <div className="clean-section-switcher-actions">{right}</div>}
      </nav>
    );
  }

  return (
    <nav className="seg-ai" aria-label="Разделы экрана">
      {visible.map((t) => (
        // `data-f` — крючок, на котором держится `.seg-ai` эталона; вкладка при
        // этом остаётся ссылкой (средний клик, «открыть в новой вкладке», адрес
        // в строке браузера). Активную помечает сам NavLink — он ставит
        // `aria-current="page"`, поэтому сравнивать pathname руками не нужно, а
        // на это же состояние и опирается подсветка. Правило для ССЫЛКИ
        // дописано в theme-royal-home-2026.css: эталон знает только
        // `button[data-f]`, а его файл перегенерируется скриптом и не правится.
        <NavLink key={t.to} to={t.to} end={t.end} data-f="">
          {t.label}
          {typeof t.count === "number" && <span className="n">{t.count > 99 ? "99+" : t.count}</span>}
        </NavLink>
      ))}
      {right && (
        <>
          <span className="sp" />
          {right}
        </>
      )}
    </nav>
  );
}
