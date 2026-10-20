import type { PultArea } from "@royal-home/shared";
import { AskPanel } from "../../components/pult/AskPanel";

/**
 * Дев-стенд задачи L2-T5 (слой 2, «Спросить») — визуальная и живая проверка
 * `AskPanel` с реальным `POST /dashboard/mission-control/ask` (через `useAskData`,
 * без фикстуры ответа — только список плиток для чипов-ссылок фиктивный, хрефы
 * реальные из `pultAreas`). Только `import.meta.env.DEV`, маршрут регистрирует
 * `App.tsx`, в прод-бандл не попадает (см. EventFeedPlayground.tsx — тот же приём).
 *
 * Нужен вход в CRM в этой же вкладке (токен берётся из уже существующей сессии) —
 * стенд не логинит сам, только показывает панель.
 */
const AREAS: PultArea[] = [
  { id: "clients", label: "Клиенты", href: "/clients", big: "10 новых", line: "Вчера ответили всем", tone: "ok" },
  { id: "money", label: "Деньги", href: "/finance", big: "0 % плана", line: "0 с из 0 с", tone: "crit" },
  { id: "calls", label: "Звонки", href: "/telephony", big: "0 входящих", line: "Пропущенных нет", tone: "ok" },
  { id: "team", label: "Команда", href: "/team", big: "3 агента", line: "Все клиенты в работе", tone: "ok" },
];

export default function AskPanelPlayground() {
  return (
    // Обёртка `.rh2` обязательна: AskPanel собран из классов эталона
    // (`.inp`, `.pill`, `.aib-*`, `.quiet`), а они заскоуплены под `.rh2` — без
    // неё стенд показывал панель вообще без оформления и врал о её виде.
    <div className="rh2 screens">
      <div className="scr" style={{ maxWidth: 640 }}>
        <div className="pg-h">
          <div>
            <h1>AskPanel — дев-стенд (задача 5, слой 2)</h1>
            <p className="sub">
              Реальный вызов <code>POST /mission-control/ask</code> (нужен вход директором/админом в
              этой вкладке). Если ключа ИИ нет локально — ответ придёт ошибкой 502, панель покажет
              тихую строку, без alert/тоста. Чипы-ссылки появляются, если в ответе упомянуты
              «Клиенты», «Деньги», «Звонки» или «Команда».
            </p>
          </div>
        </div>
        <AskPanel areas={AREAS} />
      </div>
    </div>
  );
}
