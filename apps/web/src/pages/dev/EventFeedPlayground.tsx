import { useState } from "react";
import { EventFeed, type EventFeedItem } from "../../components/pult/EventFeed";

/**
 * Дев-стенд задачи 7 (слой 2, «Живая лента») — визуальная проверка `EventFeed`
 * без API и без входа в CRM: своя фикстура, кнопка «добавить событие» имитирует
 * приход нового тика тикера. Только `import.meta.env.DEV` (маршрут регистрирует
 * `App.tsx`), в проде не собирается в бандл (Vite вырезает мёртвый код за
 * `if (import.meta.env.DEV)` на уровне маршрута — сам файл всё равно попадёт в
 * граф только по динамическому импорту дев-маршрута).
 */

let nextId = 100;

const FIXTURE: EventFeedItem[] = [
  { id: "1", kind: "awaitsYou", text: "Сделка №118 ждёт вашей подписи · Фируза", href: "/deals", createdAt: "2026-09-08T08:12:00.000Z" },
  { id: "2", kind: "question", text: "Вопрос ко мне: продлевать ли рекламу на Facebook?", href: null, createdAt: "2026-09-08T08:05:00.000Z" },
  { id: "3", kind: "audit", text: "Сделка №118 → Договор подписан · Фируза", href: "/deals", createdAt: "2026-09-08T07:58:00.000Z" },
  { id: "4", kind: "interaction", text: "Рустам пишет клиенту Ситора Назарова", href: "/clients/10", createdAt: "2026-09-08T07:50:00.000Z" },
  { id: "5", kind: "lead", text: "Новая заявка с сайта · Дом, Сино", href: "/clients/11", createdAt: "2026-09-08T07:40:00.000Z" },
];

const NEW_EVENT_TEMPLATES: Array<Pick<EventFeedItem, "kind" | "text" | "href">> = [
  { kind: "awaitsYou", text: "Материалы объекта ждут проверки · Сино 14", href: "/properties" },
  { kind: "question", text: "Вопрос ко мне: разморозить Умеда?", href: null },
  { kind: "audit", text: "Сделка №121 → Показ назначен · Далер", href: "/deals" },
  { kind: "interaction", text: "Манижа пишет клиенту Комрон Юсупов", href: "/clients/22" },
  { kind: "lead", text: "Комментарий в Instagram ждёт ответа", href: "/comments" },
];

export default function EventFeedPlayground() {
  const [events, setEvents] = useState<EventFeedItem[]>(FIXTURE);
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [empty, setEmpty] = useState(false);

  function addEvent() {
    const tpl = NEW_EVENT_TEMPLATES[nextId % NEW_EVENT_TEMPLATES.length];
    const item: EventFeedItem = { id: String(nextId++), ...tpl, createdAt: new Date().toISOString() };
    setEvents((prev) => [item, ...prev]);
  }

  return (
    // Обёртка `.rh2` обязательна: EventFeed собран из классов эталона, а они
    // заскоуплены под `.rh2` — без неё стенд показывал ленту без оформления.
    // Кнопки стенда — те же `.pill`, что и везде: свои классы тут заводить не за чем.
    <div className="rh2 screens">
      <div className="scr" style={{ maxWidth: 640 }}>
        <div className="pg-h">
          <div>
            <h1>EventFeed — дев-стенд (задача 7, слой 2)</h1>
            <p className="sub">
              Прокрутите ленту вниз, потом нажмите «Добавить событие» — новая строка не встанет под
              курсором, появится чип «↑ N новых» сверху. Кликните по чипу, чтобы влить. Звук
              (playSoftTick) играет только на события «ждёт вас»/«вопрос ко мне», не чаще раза в
              3 минуты и не более 8 в час — проверьте несколько раз подряд.
            </p>
          </div>
        </div>

        <div className="filters">
          <button type="button" className="pill sm" onClick={addEvent}>
            Добавить событие
          </button>
          <button type="button" className="pill ghost sm" onClick={() => setEvents([])}>
            Очистить
          </button>
          <button type="button" className="pill ghost sm" onClick={() => setEvents(FIXTURE)}>
            Сбросить к фикстуре
          </button>
          <label className="chip wrapok">
            <input type="checkbox" checked={soundEnabled} onChange={(e) => setSoundEnabled(e.target.checked)} />
            Звук (тумблер «sound»)
          </label>
          <label className="chip wrapok">
            <input type="checkbox" checked={empty} onChange={(e) => setEmpty(e.target.checked)} />
            Пустое состояние
          </label>
        </div>

        <EventFeed events={empty ? [] : events} soundEnabled={soundEnabled} />
      </div>
    </div>
  );
}
