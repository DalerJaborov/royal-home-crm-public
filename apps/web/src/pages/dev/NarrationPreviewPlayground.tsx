import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { PropertyNarrationItem, PropertyNarrationView } from "@royal-home/shared";
import { PropertyNarrationManager } from "../../components/PropertyNarrationManager";

/**
 * Дев-стенд блока озвучки карточки (18.11.2026, макет «поменял, послушал, утвердил») — только
 * `import.meta.env.DEV`, вне входа: кадры ПК/телефона и обе темы без засеянной базы. Каждое состояние —
 * свой QueryClient с готовыми данными; сеть не нужна, пока не нажата кнопка.
 */
const config = {
  modelId: "eleven_v4", autoGenerate: true,
  voices: [{ id: "a", name: "Анна", gender: "female" as const }, { id: "m", name: "Мария", gender: "female" as const }, { id: "i", name: "Игорь", gender: "male" as const }],
  templates: [{ id: "ru-a", name: "Основной", lang: "ru" as const, text: "{вид} в Душанбе, район {район}. {площадь} квадратных метров, {этаж} этаж из {этажность}. Цена {цена}. Звоните в Роял Хоум." }],
};
const facts = { type: "APARTMENT", rooms: 2, areaSqm: "52", floor: 4, totalFloors: 9, district: "Сино", price: "85000", currency: "USD" };
const script = "Двухкомнатная квартира в Душанбе, район Сино. Пятьдесят два квадратных метра, четвёртый этаж из девяти. Цена восемьдесят пять тысяч долларов. Звоните в Роял Хоум.";
const v = (over: Partial<PropertyNarrationItem> = {}): PropertyNarrationItem => ({ id: "v2", revision: 2, script, voiceId: "a", status: "READY", approvedAt: null, stale: false, hasAudio: true,
  errorCode: null, createdAt: new Date().toISOString(), source: "AUTO", templateId: "ru-a", language: "ru", ...over });
const base: PropertyNarrationView = { versions: [v()], suggestedScript: script, facts, config, configured: true, autoGenerate: true, canApprove: false, canApproveAudio: true,
  canDraft: true, sendsEnabled: true, published: true, clipSec: 35, changed: ["цена", "этаж"] };
const soon = new Date(Date.now() + 15 * 60_000).toISOString();
const STATES: Array<[string, Partial<PropertyNarrationView>]> = [
  ["1. Сразу после правки", { versions: [v({ status: "DRAFT", hasAudio: false, generateAfter: new Date().toISOString() })] }],
  ["2. Готово, проверьте", {}],
  ["3. Текст длиннее ролика", { clipSec: 9 }],
  ["4. Выйдет по очереди", { versions: [v({ approvedAt: new Date().toISOString() })], release: { stage: "SCHEDULED", versionId: "v2", at: soon, reason: "Перед ним в очереди другие ролики, выйдет через 15 минут.", channels: [] } }],
  ["5. Выпущено", { versions: [v({ approvedAt: new Date().toISOString() })], release: { stage: "DONE", versionId: "v2", at: null, reason: null, channels: [
    { channel: "INSTAGRAM", state: "OLD_REMOVED" }, { channel: "FACEBOOK", state: "OLD_REMOVED" }, { channel: "YOUTUBE", state: "OLD_REMOVED" },
    { channel: "TELEGRAM", state: "OLD_REMOVED" }, { channel: "TIKTOK", state: "OLD_MANUAL", url: "https://www.tiktok.com/@royalhome/video/1" }] } }],
  ["6. Всё спокойно (наверху карточки)", { versions: [v({ approvedAt: new Date().toISOString() })] }],
];

function State({ label, data, top }: { label: string; data: Partial<PropertyNarrationView>; top?: boolean }) {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  client.setQueryData(["property-narration", "dev"], { ...base, ...data });
  return (
    <section className="space-y-2">
      <p className="text-base text-[var(--muted)]">{label}</p>
      <QueryClientProvider client={client}><PropertyNarrationManager propertyId="dev" placement={top ? "top" : "media"} /></QueryClientProvider>
    </section>
  );
}

export default function NarrationPreviewPlayground() {
  return (
    // Та же обёртка, что у карточки объекта (PropertyDetail): стили .pill живут под .rh2 .scr.
    <div className="rh2 screens"><main className="scr mx-auto max-w-3xl space-y-6 p-4">
      <h1 className="text-xl font-bold">Озвучка в карточке: дев-стенд</h1>
      {STATES.map(([label, data], i) => <State key={label} label={label} data={data} top={i === STATES.length - 1} />)}
    </main></div>
  );
}
