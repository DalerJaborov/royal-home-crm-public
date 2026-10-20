// Development-only browser fixture: real shared components, synthetic data,
// no API clients, authentication or persistence. Not a production Vite entry.
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import "../../src/index.css";
import { Rh2Sheet } from "../../src/components/rh2/Rh2Sheet";
import { Rh2Inline } from "../../src/components/rh2/Rh2Scope";
import { CleanPropertySummary, CleanPropertySlot } from "../../src/components/clean/CleanPropertyDetailLayout";
import { CCard } from "../../src/components/clean/ui";
import { CountingNumber } from "../../src/components/ui/CountingNumber";
import { Rh2Money } from "../../src/components/rh2/Rh2Money";
import { SocialVideoMetadata } from "../../src/components/socialVideos/SocialVideoMetadata";
import { ChannelProcess } from "../../src/components/socialVideos/ChannelProcess";
import { initMobileUxFlag } from "../../src/hooks/useMobileUx";
import type { Property } from "../../src/types";

const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = `royal-home-2026-${params.get("theme") ?? "light"}`;
if (params.get("shell") !== "legacy") document.documentElement.dataset.shell = "clean";
document.documentElement.classList.add("mo");
initMobileUxFlag();
const property = {
  id: 1, title: "Тестовый объект с длинным названием для проверки расположения действий",
  price: 100000, currency: "TJS", areaSqm: 80, rooms: 3, floor: 4, totalFloors: 9, condition: "GOOD",
  type: "APARTMENT", status: "AVAILABLE", district: { name: "Тестовый район" },
} as Property;

function Fixture() {
  const [sheet, setSheet] = useState(false);
  const [child, setChild] = useState(false);
  const [action, setAction] = useState("");
  return <div className="app-shell clean-shell"><main style={{ padding: 16 }}>
    <h1>Проверка поверхностей</h1>
    <button onClick={() => setSheet(true)}>Открыть окно</button>
    <output aria-label="Последнее действие">{action}</output>
    <span data-testid="counter"><CountingNumber value={12345} /></span>
    <span data-testid="money"><Rh2Money value={23456} /></span>
    <Rh2Inline>
      <div className="pg-h"><div><h2>Тестовый ролик</h2><SocialVideoMetadata statusClassName="chip mute" item={{ status: "SCHEDULED", scheduledAt: "2026-10-21T04:00:00Z", startedAt: null, finishedAt: null, createdBy: { id: "test-agent", name: "Тестовый сотрудник" } }} /></div></div>
      <section className="card"><h2>Как идёт публикация</h2><ChannelProcess
        destinations={["INSTAGRAM", "FACEBOOK", "YOUTUBE", "TIKTOK", "TELEGRAM"].map(channel => ({ channel, accountId: null })) as Parameters<typeof ChannelProcess>[0]["destinations"]}
        infos={[]} results={{}} /></section>
      <CleanPropertySummary property={property} onSchedule={() => setAction("Показ")}
        onEdit={() => setAction("Изменить")} onMore={() => setSheet(true)} />
      <div className="clean-property-detail">
        <CleanPropertySlot enabled area="description"><div className="rh-pcard-desc">
          <section className="card"><h2>Описание</h2><p>Содержимое одной карточки.</p></section>
        </div></CleanPropertySlot>
        <CleanPropertySlot enabled area="people"><section className="card"><h2>Ответственный</h2><p>Тестовая запись.</p></section></CleanPropertySlot>
      </div>
      <div className="secwrap"><section className="card" data-testid="entrance">Сразу видимая карточка</section></div>
    </Rh2Inline>
    <CCard>Самостоятельная карточка</CCard>
    <div className="clean-more-panel" style={{ position: "relative", inset: "auto" }}>Меню с непрозрачной поверхностью</div>
    {sheet && <Rh2Sheet title="Тестовое окно" onClose={() => setSheet(false)}
      footer={<button onClick={() => setSheet(false)}>Отмена</button>}>
      <label>Поле окна<input /></label><button onClick={() => setChild(true)}>Открыть вложенное окно</button>
      {child && <Rh2Sheet title="Вложенное окно" onClose={() => setChild(false)}><p>Проверка верхнего слоя</p></Rh2Sheet>}
    </Rh2Sheet>}
  </main></div>;
}
createRoot(document.getElementById("root")!).render(<BrowserRouter><Fixture /></BrowserRouter>);
