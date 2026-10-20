import type { PultArea } from "@royal-home/shared";
import { PultTiles } from "../../components/pult/PultTiles";
import { ActionRowList } from "../../components/pult/ActionRow";

/**
 * Стенд задачи 2 (слой 2, тема Royal Home 2026): только `import.meta.env.DEV`
 * (см. регистрация маршрута в App.tsx) — фикстура, без API, чтобы визуально
 * проверить сетку плиток-светофор на 1440/1280/1024/390 и строки-действия без
 * поднятого сервера. Никогда не попадает в прод-бандл: см. проверку `DEV` ниже
 * и в App.tsx (маршрут регистрируется только в dev-режиме).
 */
const FIXTURE_AREAS: PultArea[] = [
  { id: "clients", label: "новых", href: "/clients", big: "9", line: "Рустам без агента 41 мин", tone: "crit" },
  { id: "team", label: "на связи", href: "/team", big: "6/8", line: "Умед заморожен 3 дня", tone: "warn" },
  { id: "money", label: "плана", href: "/finance", big: "39 %", line: "прогноз к пятнице", tone: "ok" },
  { id: "properties", label: "в продаже", href: "/properties", big: "212", line: "2 ждут проверки", tone: "warn" },
  { id: "calls", label: "входящих", href: "/calls", big: "27", line: "пропущенный 0:44 с 1005", tone: "crit" },
  { id: "ads", label: "в день", href: "/ads", big: "6", line: "1 комментарий ждёт", tone: "warn" },
  { id: "bot", label: "диалогов", href: "/messages", big: "312", line: "2 замечания по диалогам", tone: "warn" },
  { id: "deals", label: "новых", href: "/deals", big: "9", line: "2 ждут подписи · 41 000 с", tone: "warn" },
  { id: "system", label: "без сбоев", href: "/health", big: "0", line: "всё штатно", tone: "ok" },
];

async function fakeRun(): Promise<boolean> {
  await new Promise((r) => setTimeout(r, 150));
  return true;
}

export function PultTilesPlayground() {
  if (!import.meta.env.DEV) return null;

  return (
    // Обёртка `.rh2` обязательна: PultTiles и ActionRow собраны из классов
    // эталона (`.tiles`, `.tile`, `.row`…), заскоупленных под `.rh2`, — без неё
    // стенд рисовал их голыми и «проверка на 390» ничего не проверяла.
    <div className="rh2 screens" data-testid="pult-tiles-playground">
      <div className="scr">
        <div className="pg-h">
          <div>
            <h1>Стенд: плитки-светофор + строки-действия</h1>
          </div>
        </div>

        <PultTiles areas={FIXTURE_AREAS} />

        <ActionRowList
          rows={[
            {
              id: "deal-118",
              tone: "warn",
              avatar: { label: "ФК", tone: "lime" },
              title: "Сделка №118 ждёт подписи",
              description: "комиссия 41 000 сомони, 2 сделки в очереди",
              actions: [
                { label: "Одобрить", endpoint: "PATCH /api/v1/deals/118", onRun: fakeRun, doneMessage: "Одобрено · 41 000 с · отменить 10 с", onUndo: async () => {} },
                { label: "Вернуть", endpoint: "PATCH /api/v1/deals/118", onRun: fakeRun, doneMessage: "Возвращено агенту", secondary: true },
              ],
            },
            {
              id: "call-1005",
              tone: "crit",
              avatar: { label: "10", tone: "pink" },
              title: "Пропущенный 0:44 с 1005",
              description: "не перезвонили",
              actions: [{ label: "Перезвонить", endpoint: "POST /api/v1/calls/callback", onRun: fakeRun, doneMessage: "Звонок открыт" }],
            },
            {
              id: "team-daler",
              tone: "warn",
              avatar: { label: "ДА", tone: "aqua" },
              title: "Далер А. 2 дня без показов",
              actions: [{ label: "Открыть агента", endpoint: "GET /api/v1/agents/daler", onRun: fakeRun, doneMessage: "Открыто" }],
            },
            {
              id: "property-review",
              tone: "warn",
              avatar: { label: "ОБ", tone: "lav" },
              title: "2 объекта ждут вашей проверки",
              actions: [{ label: "Открыть", endpoint: "GET /api/v1/properties?review=1", onRun: fakeRun, doneMessage: "Открыто" }],
            },
            {
              id: "extra-1",
              tone: "warn",
              avatar: { label: "РК", tone: "sky" },
              title: "1 комментарий ждёт",
              description: "реклама",
              actions: [{ label: "Открыть", endpoint: "GET /api/v1/instagram-comments", onRun: fakeRun, doneMessage: "Открыто" }],
            },
          ]}
        />
      </div>
    </div>
  );
}
