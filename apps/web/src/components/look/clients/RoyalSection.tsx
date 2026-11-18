import { createContext, useContext, type ReactNode } from "react";

/**
 * МЕТКА РАЗДЕЛА «НОВОГО ВИДА» — `data-ry-section="<пачка>"` (18.11.2026).
 *
 * Слой пачки (`theme-look-royal-<пачка>.css`) обязан действовать только на свой
 * раздел — не на чужой экран с похожими классами (Vacancies носит те же
 * `clean-client-*`) и не на общий портал `body > .rh2`, где живут уведомления,
 * окно входящего лида и шторки оболочки. Поэтому каждое правило слоя привязано к
 * метке (сторож theme-look-royal.test.ts), а метку ставит только сам раздел:
 * `<RoyalSection name={royal ? "clients" : undefined}>` над своим деревом. Её
 * переносят на свой корень `Rh2Screen` (экран) и `Rh2Portal` (общий корпус шторок,
 * меню и панелей); экран со своей обёрткой ставит `data-ry-section` сам. Порталы
 * React наследуют контекст: шторка, открытая из раздела, помечена, чужая — нет.
 * Без признака вида значение пустое: атрибута нет, ни один пиксель не меняется.
 *
 * Механизм общий для всех пачек; лежит в папке пачки clients по правилу брифа —
 * сводящему перенести в общие детали `components/look/`.
 */
const RoyalSectionContext = createContext<string | undefined>(undefined);

export function RoyalSection({ name, children }: { name: string | undefined; children: ReactNode }) {
  return <RoyalSectionContext.Provider value={name}>{children}</RoyalSectionContext.Provider>;
}

/** Метка раздела, внутри которого рисуется элемент (для корня портала). */
export function useRoyalSectionName(): string | undefined {
  return useContext(RoyalSectionContext);
}
