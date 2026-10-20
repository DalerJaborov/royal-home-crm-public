import { useCan } from "../lib/permissions";
import { useMobileUx } from "../hooks/useMobileUx";
import { MobileFunnel } from "../components/mobile/MobileFunnel";
import { FunnelTab } from "./settings/FunnelTab";

/**
 * Раздел «Воронка» — комментарий под рекламой → чек-лист в директ.
 *
 * Отдельный пункт меню, а не вкладка Настроек (просьба владельца 16.08.2026):
 * во время рекламы сюда смотрят каждый час — счётчики, журнал выдач, репетиция, —
 * и путь через Настройки с подтверждением личности превращал взгляд на цифры в
 * ритуал. Содержимое живёт в settings/FunnelTab и не продублировано: у страницы
 * и вкладки один код, различается только рамка.
 *
 * Права те же, что на сервере (routes/leadMagnets.ts): смотреть — settings.view,
 * менять — settings.manage. Кампания решает, что CRM напишет постороннему от
 * имени компании, и это вес настройки, где бы кнопка ни висела.
 */
export function Funnel() {
  const can = useCan();
  // Телефон получает свой экран (MobileFunnel), десктоп — как был. Ветвление
  // ДО остального рендера, но ПОСЛЕ проверки права — у обеих версий одно и то
  // же правило доступа (см. паттерн Archive.tsx).
  const mobile = useMobileUx();

  if (!can("settings.view")) {
    return (
      <div className="rh2 screens">
        <div className="scr">
          <div className="pg-h">
            <div>
              <h1>Воронка</h1>
              <p className="sub">Раздел доступен директору и администратору.</p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (mobile) return <MobileFunnel />;

  // Заголовок экрана рисует сам FunnelTab (блок .pg-h эталона): своя вторая
  // шапка над ним читалась бы как сбой вёрстки.
  return <FunnelTab />;
}
