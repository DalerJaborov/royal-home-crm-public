import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { PropertyNarrationItem, PropertyNarrationView } from "@royal-home/shared";
import { PropertyNarrationManager } from "../../components/PropertyNarrationManager";

/**
 * Дев-стенд блока озвучки карточки (18.11.2026, макет «поменял, послушал, утвердил»; 20.11.2026 — все состояния
 * блока в карточке, кадры до и после разбора владельца) — только `import.meta.env.DEV`, вне входа: кадры ПК/телефона
 * и обе темы без засеянной базы. Каждое состояние — свой QueryClient с готовыми данными; сеть не нужна, пока не нажата кнопка.
 * Имена голосов — как в настройках прода (латиница, длинные), чтобы видеть перенос, а не обрезку.
 */
const config = {
  modelId: "eleven_v4", autoGenerate: true, defaultVoiceId: "a",
  voices: [{ id: "a", name: "Анна", gender: "female" as const }, { id: "n", name: "Nataly Vershinina", gender: "female" as const },
    { id: "w", name: "Viktoriya Voloshina", gender: "female" as const }, { id: "j", name: "Jessica", gender: "female" as const }, { id: "s", name: "Sergey", gender: "male" as const }],
  templates: [{ id: "ru-a", name: "Основной", lang: "ru" as const, text: "{вид} в Душанбе, район {район}. {площадь} квадратных метров, {этаж} этаж из {этажность}. Цена {цена}. Звоните в Роял Хоум." },
    { id: "tg-a", name: "Асосӣ", lang: "tg" as const, text: "{вид} дар Душанбе, ноҳияи {район}. Масоҳаташ {площадь} метри мураббаъ." }],
};
const facts = { type: "APARTMENT", rooms: 2, areaSqm: "52", floor: 4, totalFloors: 9, district: "Сино", price: "85000", currency: "USD" };
const script = "Двухкомнатная квартира в Душанбе, район Сино. Пятьдесят два квадратных метра, четвёртый этаж из девяти. Цена восемьдесят пять тысяч долларов. Звоните в Роял Хоум.";
const v = (over: Partial<PropertyNarrationItem> = {}): PropertyNarrationItem => ({ id: "v2", revision: 2, script, voiceId: "a", status: "READY", approvedAt: null, stale: false, hasAudio: true,
  errorCode: null, createdAt: new Date().toISOString(), source: "AUTO", templateId: "ru-a", language: "ru", audioSec: 27, ...over });
const samples = config.voices.flatMap((x) => [{ voiceId: x.id, lang: "ru" as const }, { voiceId: x.id, lang: "tg" as const }]);
const base: PropertyNarrationView = { versions: [v()], suggestedScript: script, facts, config, configured: true, autoGenerate: true, canApprove: false, canApproveAudio: true,
  canDraft: true, sendsEnabled: true, published: true, clipSec: 35, changed: ["цена", "этаж"], samples };
const soon = new Date(Date.now() + 15 * 60_000).toISOString();
const agoMin = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
const approved = (over: Partial<PropertyNarrationItem> = {}) => [v({ approvedAt: agoMin(3), ...over })];
const STATES: Array<[string, Partial<PropertyNarrationView>]> = [
  ["0. Озвучки нет, ролика ещё нет", { versions: [], published: false, changed: [] }],
  ["0б. Озвучки нет, ролик давно вышел (старый объект)", { versions: [], published: true, changed: [] }],
  ["1. Готовится", { versions: [v({ status: "GENERATING", hasAudio: false, createdAt: agoMin(1) })] }],
  ["2. Готова, ролика ещё нет: послушайте и одобрите", { published: false, changed: [] }],
  ["3. Готова, ролик вышел: утвердите и выпустите", {}],
  ["4. Текст длиннее ролика", { clipSec: 9, versions: [v({ audioSec: null })] }],
  ["5. Накладывается на ролик (только что)", { versions: approved(), release: { stage: "MIXING", versionId: "v2", at: null, reason: null, channels: [] } }],
  ["5б. Накладывается дольше обычного", { versions: [v({ approvedAt: agoMin(90) })], release: { stage: "MIXING", versionId: "v2", at: null, reason: null, channels: [] } }],
  ["6. Не получилась", { versions: [v({ status: "FAILED", hasAudio: false, errorCode: "TTS_FAILED" })] }],
  ["7. На ролик не легла", { versions: approved(), mix: { hasMaster: true, error: null, problem: "FAILED" } }],
  ["8. Выйдет по очереди", { versions: approved(), release: { stage: "SCHEDULED", versionId: "v2", at: soon, reason: "Перед ним в очереди другие ролики, выйдет через 15 минут.", channels: [] } }],
  ["9. Выпущено", { versions: approved(), release: { stage: "DONE", versionId: "v2", at: null, reason: null, channels: [
    { channel: "INSTAGRAM", state: "OLD_REMOVED" }, { channel: "FACEBOOK", state: "OLD_REMOVED" }, { channel: "YOUTUBE", state: "OLD_REMOVED" },
    { channel: "TELEGRAM", state: "OLD_REMOVED" }, { channel: "TIKTOK", state: "OLD_MANUAL", url: "https://www.tiktok.com/@royalhome/video/1" }] } }],
  ["10. Всё спокойно: утверждена", { versions: approved(), changed: [] }],
  ["11. Данные изменились, озвучка устарела", { versions: [v({ approvedAt: agoMin(600), stale: true })], autoGenerate: false }],
];

function State({ label, data }: { label: string; data: Partial<PropertyNarrationView> }) {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  client.setQueryData(["property-narration", "dev"], { ...base, ...data });
  return (
    <section className="space-y-2" data-state={label}>
      <p className="text-base text-[var(--muted)]">{label}</p>
      <QueryClientProvider client={client}><PropertyNarrationManager propertyId="dev" placement="card" /></QueryClientProvider>
    </section>
  );
}

export default function NarrationPreviewPlayground() {
  return (
    // Та же обёртка, что у карточки объекта (PropertyDetail): стили .pill живут под .rh2 .scr.
    <div className="rh2 screens"><main className="scr mx-auto max-w-3xl space-y-6 p-4">
      <h1 className="text-xl font-bold">Озвучка в карточке: дев-стенд</h1>
      {STATES.map(([label, data]) => <State key={label} label={label} data={data} />)}
    </main></div>
  );
}
