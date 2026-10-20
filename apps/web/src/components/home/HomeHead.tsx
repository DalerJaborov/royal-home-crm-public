import { useMobileUx } from "../../hooks/useMobileUx";
import { MobileHomeHeader } from "../mobile/MobileHomeHeader";

/**
 * Шапка ролевой Главной — одна разметка на обе ширины (правило порта 09.09.2026).
 *
 * На телефоне выше области `.rh2` стоит шапка приложения (поиск, звонки,
 * уведомления, тема) — это рамка приложения, договор §4, ею занимается
 * мобильный чат. На ПК всё это уже есть в боковой панели и верхней строке,
 * поэтому там рисуется `.pg-h` макета: «Главная» и строка
 * «{Имя}, роль. {день}. {что ждёт}».
 */
export function HomeAppHeader({ firstName }: { firstName: string }) {
  const mobile = useMobileUx();
  return mobile ? <MobileHomeHeader firstName={firstName} /> : null;
}

export function HomePageHead({ title, sub }: { title: string; sub: string }) {
  const mobile = useMobileUx();
  if (mobile) return null;
  return (
    <div className="pg-h">
      <div>
        <h1>{title}</h1>
        <p className="sub">{sub}</p>
      </div>
    </div>
  );
}
