import { createContext, useContext, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDown, type LucideIcon } from "lucide-react";

/**
 * Поиск по настройкам (макет владельца, экран «Помощник»: строка «Что ищем:
 * „пауза“, „промт“, „ключ“» и счётчик «Найдено N настроек»).
 *
 * Запрос живёт в контексте, а не в пропсах: складок на вкладке два десятка, и
 * каждая решает сама, совпадает ли её текст. Пустая строка — поиска нет, складки
 * ведут себя как обычно.
 */
const SettingsSearchContext = createContext("");

export function SettingsSearchProvider({ query, children }: { query: string; children: ReactNode }) {
  return <SettingsSearchContext.Provider value={query.trim().toLowerCase()}>{children}</SettingsSearchContext.Provider>;
}

/**
 * Карточка-раздел настроек, которая сворачивается — как разделы в Настройках
 * телефона, а не простыня из полностью раскрытых блоков подряд.
 *
 * Раньше каждый раздел рисовал собственную «шапку карточки» (иконка + заголовок +
 * бейдж) как статичный `<div>` — один и тот же разметочный блок копипастился в
 * восьми местах вкладки «Данные и система», и ни один не сворачивался: чтобы
 * дойти до нужного, приходилось листать мимо остальных семи целиком развёрнутыми
 * (просьба владельца 19.08.2026 — «чёрт ногу сломит»).
 *
 * Тема «Royal Home 2026»: разметка дословно из эталона
 * (docs/pult/theme-2026/screens/settings.html, блок «Данные и система») —
 * `.acc` с шапкой `.acc-h` (иконка `.i.lg`, заголовок, счётчик `.cnt`, шеврон
 * `.ch`) и телом `.acc-b`. Поворот шеврона и подсветку шапки рисует CSS
 * прототипа по `aria-expanded`, поэтому в разметке ни одного класса состояния.
 *
 * Тело скрывается условным рендером, а не атрибутом `hidden`: в теме `[hidden]`
 * объявлен с `!important`, но правило лежит рядом с утилитами приложения, и
 * закрытая секция обязана быть невидимой при любом порядке слоёв.
 *
 * При поиске складка раскрывается принудительно (иначе искать не в чем) и
 * прячется целиком, если её текст не содержит запроса. Совпадение считается по
 * отрисованному тексту после каждого рендера: данные внутри складки приходят
 * с сервера позже первого кадра, и список «найдено» обязан их дождаться.
 */
export function SettingsSection({
  icon: Icon,
  iconClassName,
  title,
  badge,
  defaultOpen = false,
  children,
}: {
  icon: LucideIcon;
  /** Необязательная подкраска иконки шапки; по умолчанию — приглушённая, как в эталоне. */
  iconClassName?: string;
  title: string;
  /** Счётчик справа от заголовка — тот же слот, что раньше был вклеен в шапку напрямую. */
  badge?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const bodyId = useId();
  const query = useContext(SettingsSearchContext);
  const rootRef = useRef<HTMLDivElement>(null);
  const [miss, setMiss] = useState(false);
  const searching = query.length > 0;
  const isOpen = searching || open;

  // Текст складки меняется с приходом данных уже после первого кадра, поэтому
  // совпадение пересчитывает наблюдатель за поддеревом, а не один эффект.
  useLayoutEffect(() => {
    if (!searching) {
      setMiss(false);
      return;
    }
    const root = rootRef.current;
    if (!root) return;
    const check = () => setMiss(!(root.textContent ?? "").toLowerCase().includes(query));
    check();
    const observer = new MutationObserver(check);
    observer.observe(root, { subtree: true, childList: true, characterData: true });
    return () => observer.disconnect();
  }, [searching, query]);

  return (
    <div ref={rootRef} className="acc" data-search-miss={miss ? "" : undefined} style={miss ? { display: "none" } : undefined}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={isOpen}
        aria-controls={bodyId}
        className="acc-h"
      >
        <Icon className={`i lg${iconClassName ? ` ${iconClassName}` : ""}`} aria-hidden="true" />
        <h3>{title}</h3>
        {badge ? <span className="cnt">{badge}</span> : null}
        <ChevronDown className="i ch" aria-hidden="true" />
      </button>
      {isOpen && (
        <div id={bodyId} className="acc-b">
          {children}
        </div>
      )}
    </div>
  );
}

/** Заголовок группы разделов — те же группы, что iOS/Android Настройки: серый,
 *  прописными, без своей карточки. Разделяет вкладку на смысловые зоны, не на
 *  восемь одинаковых карточек подряд. Эталон: `.grp-lab`. */
export function SettingsGroupLabel({ children }: { children: ReactNode }) {
  return <div className="grp-lab">{children}</div>;
}
