import { useEffect, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Calls } from "../Calls";
import { Telephony } from "../Telephony";
import { CallWindow } from "../../components/CallWindow";

/**
 * Дев-стенд переноса «Звонков», «Телефонии» и окна звонка на эталон
 * «Royal Home 2026» (задача port-calls, 09.09.2026).
 *
 * Зачем он есть: экраны висят на живой телефонии, базе и входе в CRM, а снимать
 * облик надо в обеих темах и на двух ширинах. Поднимать станцию ради кадра
 * незачем, поэтому здесь подменяется ровно один слой — `window.fetch` на путях
 * `/api/v1/…`, — и экраны рендерятся своим настоящим кодом, со своими хуками,
 * своей разметкой и своими состояниями. Ни один компонент ради стенда не
 * менялся: фикстуры повторяют форму ответов сервера (см. hooks/useCalls.ts,
 * hooks/useActiveCall.ts).
 *
 * Живёт только в DEV (маршрут регистрирует App.tsx за `import.meta.env.DEV`),
 * в прод-бандл не попадает.
 */

const NOW = new Date("2026-09-09T11:40:00.000Z").toISOString();
const EARLIER = new Date("2026-09-09T07:12:00.000Z").toISOString();
const YESTERDAY = new Date("2026-09-08T13:44:00.000Z").toISOString();

const CALLS = {
  items: [
    {
      id: "in-1",
      createdAt: NOW,
      notes: null,
      hasRecording: true,
      durationSec: 134,
      transcript: "Салом, ман дар бораи хона занг задам…",
      transcriptRu: null,
      transcriptionStage: null,
      transcriptionProgress: null,
      agent: { id: "a-sobir", fullName: "Собир Назаров", avatarUrl: null },
      client: { id: "c-daler", shortId: 41, fullName: "Далер Саидов" },
      analysis: {
        score: 38,
        summary: "Не выяснил, что человеку нужно, и не договорился о шаге.",
        greeted: true,
        foundNeed: false,
        presentedValue: false,
        handledObjection: false,
        agreedNextStep: false,
        objections: ["Дорого, я подумаю", "Далеко от школы"],
        agreements: [],
        coaching:
          "На «дорого» отвечайте не скидкой, а сравнением: что входит в цену и чего нет у соседних домов. И заканчивайте разговор датой.",
        summaryTj: "Мизоҷ нархро гарон донист, розигӣ ба қадами оянда нашуд.",
      },
    },
    {
      id: "in-2",
      createdAt: EARLIER,
      notes: null,
      hasRecording: true,
      durationSec: 391,
      transcript: "Здравствуйте, я по объявлению…",
      transcriptRu: null,
      transcriptionStage: null,
      transcriptionProgress: null,
      agent: { id: "a-manizha", fullName: "Манижа Юсупова", avatarUrl: null },
      client: { id: "c-firuza", shortId: 118, fullName: "Фируза Каримова" },
      analysis: {
        score: 88,
        summary: "Показ назначен на завтра, 11:00.",
        greeted: true,
        foundNeed: true,
        presentedValue: true,
        handledObjection: true,
        agreedNextStep: true,
        objections: [],
        agreements: ["Показ завтра в 11:00, объект №118"],
        coaching: null,
        summaryTj: null,
      },
    },
    {
      id: "in-3",
      createdAt: EARLIER,
      notes: null,
      hasRecording: true,
      durationSec: 182,
      transcript: null,
      transcriptRu: null,
      transcriptionStage: "TRANSCRIBING",
      transcriptionProgress: 62,
      agent: { id: "a-firuza", fullName: "Фируза Каримова", avatarUrl: null },
      client: { id: "c-shahzod", shortId: 77, fullName: "Шахзод Рахимов" },
      analysis: null,
    },
    {
      id: "in-4",
      createdAt: YESTERDAY,
      notes: null,
      hasRecording: false,
      durationSec: 11,
      transcript: "Алло",
      transcriptRu: null,
      transcriptionStage: null,
      transcriptionProgress: null,
      agent: { id: "a-sobir", fullName: "Собир Назаров", avatarUrl: null },
      client: { id: "c-manizha", shortId: 12, fullName: "Манижа Назарова" },
      analysis: null,
    },
  ],
  total: 104,
  page: 1,
  pageSize: 4,
  ownOnly: false,
};

const INCOMING = {
  items: [
    {
      id: "ic-991",
      phone: "+992 90 000 00 00",
      startedAt: NOW,
      endedAt: NOW,
      answered: false,
      talkSeconds: null,
      answeredBy: null,
      answeredByName: null,
      client: null,
      callbackAgent: null,
      qualifiedAt: null,
      qualifiedBy: null,
      irrelevant: false,
      autoCreatedClient: false,
    },
    {
      id: "ic-992",
      phone: "+992 91 111 11 11",
      startedAt: EARLIER,
      endedAt: EARLIER,
      answered: true,
      talkSeconds: 214,
      answeredBy: "1004",
      answeredByName: "Манижа Юсупова",
      client: { id: "c-firuza", shortId: 118, fullName: "Фируза Каримова", kind: "BUYER" as const },
      callbackAgent: null,
      qualifiedAt: null,
      qualifiedBy: null,
      irrelevant: false,
      autoCreatedClient: false,
    },
  ],
  total: 41,
  periodTotal: 41,
  missed: 3,
  unqualified: 4,
  page: 1,
  pageSize: 2,
  days: 30,
};

const SUMMARY = {
  days: 30,
  total: 104,
  averageScore: 64,
  steps: { greeted: 96, foundNeed: 71, presentedValue: 58, handledObjection: 44, agreedNextStep: 41 },
  agents: [],
  objections: [
    { text: "Дорого", count: 21 },
    { text: "Далеко от школы", count: 9 },
  ],
};

const INSIGHTS = {
  days: 7,
  calls: 63,
  strengths: ["Здороваются и представляются почти всегда"],
  weaknesses: ["Возражение «дорого» закрывают скидкой, а не ценностью"],
  demand: ["Двухкомнатные в Сино", "Дома с ремонтом до 60 000"],
  actions: ["Провести разбор двух худших разговоров на планёрке"],
  createdAt: NOW,
};

const TELEPHONY = {
  station: { configured: true, online: true, registered: 7, total: 9 },
  extensions: [
    { agentId: "a1", fullName: "Манижа Юсупова", extension: "1004", online: true, knownToStation: true },
    { agentId: "a2", fullName: "Собир Назаров", extension: "1005", online: true, knownToStation: true },
    { agentId: "a3", fullName: "Фируза Каримова", extension: "1006", online: true, knownToStation: true },
    { agentId: "a4", fullName: "Шахзод Рахимов", extension: "1007", online: false, knownToStation: true },
    { agentId: "a5", fullName: "Нилуфар Сафарова", extension: "1008", online: false, knownToStation: false },
  ],
  live: {
    incoming: [
      {
        channelId: "l1",
        phone: "+992 91 111 11 11",
        clientName: "Фируза Каримова",
        clientShortId: 118,
        answered: true,
        answeredBy: "1004",
        answeredByName: "Манижа",
        seconds: 154,
      },
      {
        channelId: "l2",
        phone: "+992 90 000 00 00",
        clientName: null,
        clientShortId: null,
        answered: false,
        answeredBy: null,
        answeredByName: null,
        seconds: 27,
      },
    ],
    outgoing: [
      { channelId: "l3", clientName: "Далер Саидов", clientShortId: 41, state: "ringing_client", seconds: 19 },
    ],
  },
  today: { incoming: 41, outgoing: 63, missed: 3, unqualified: 4 },
  settings: {
    operators: 0,
    pushEnabled: true,
    panelEnabled: true,
    autoCreateClient: true,
    hoursEnabled: true,
    hoursStart: "09:00",
    hoursEnd: "20:00",
    forwardPhone: "+992 90 000 00 00",
    primaryTarget: "queue" as const,
    primaryExtension: null,
  },
};

const ACTIVE_CALL = {
  channelId: "cw-1",
  clientId: "c-rustam",
  clientShortId: 41,
  clientName: "Рустам Назаров",
  dialingTo: "1005",
  state: "ringing_client" as const,
  startedAt: NOW,
  answeredAt: null,
  talkSeconds: 0,
  outcome: null,
  cancelled: false,
  clientRang: false,
};

const AGENTS = [
  { id: "a-sobir", fullName: "Собир Назаров", role: "AGENT", sipExtension: "1005" },
  { id: "a-manizha", fullName: "Манижа Юсупова", role: "AGENT", sipExtension: "1004" },
  { id: "a-firuza", fullName: "Фируза Каримова", role: "AGENT", sipExtension: "1006" },
];

/** Ответы стенда по пути запроса. Форма — как у сервера, не придумана. */
function stubFor(path: string): unknown {
  if (path.startsWith("/me/active-call")) return ACTIVE_CALL;
  if (path.startsWith("/me/queue-pause")) return { available: true, paused: false, queue: "1001" };
  if (path.startsWith("/me")) return { permissions: ["calls.transcripts", "calls.ownTranscripts"] };
  if (path.startsWith("/calls/telephony/dashboard")) return TELEPHONY;
  if (path.startsWith("/calls/incoming")) return INCOMING;
  if (path.startsWith("/calls/summary")) return SUMMARY;
  if (path.startsWith("/calls/insights")) return INSIGHTS;
  if (path.startsWith("/calls/feed")) return { items: [], nextBefore: null };
  if (path.startsWith("/calls")) return CALLS;
  if (path.startsWith("/agents")) return AGENTS;
  if (path.startsWith("/settings")) return { incomingForwardPhone: "+992 90 000 00 00" };
  if (path.startsWith("/dashboard/counters")) return { ok: true };
  return {};
}

let installed = false;
function installFetchStub() {
  if (installed) return;
  installed = true;
  const real = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const marker = "/api/v1";
    const at = url.indexOf(marker);
    if (at === -1) return real(input as RequestInfo, init);
    const path = url.slice(at + marker.length);
    const body = JSON.stringify(stubFor(path));
    return Promise.resolve(new Response(body, { status: 200, headers: { "Content-Type": "application/json" } }));
  };
}

type Screen = "calls" | "telephony" | "call-window";

export default function CallsPortPlayground() {
  const [screen, setScreen] = useState<Screen>("calls");
  const [client] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } })
  );

  installFetchStub();

  // Тема выбирается тем же атрибутом, что и в приложении: снимки нужны в обеих.
  useEffect(() => {
    const root = document.documentElement;
    if (!root.getAttribute("data-theme")) root.setAttribute("data-theme", "royal-home-2026-light");
  }, []);

  return (
    <QueryClientProvider client={client}>
      <div style={{ minHeight: "100vh", background: "var(--c-page, #f6f6f4)" }}>
        <div
          data-stand-nav
          style={{ display: "flex", gap: 8, padding: 12, flexWrap: "wrap", fontFamily: "system-ui, sans-serif" }}
        >
          {(["calls", "telephony", "call-window"] as Screen[]).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setScreen(s)}
              aria-pressed={screen === s}
              style={{
                minHeight: 44,
                padding: "0 14px",
                borderRadius: 999,
                border: "1px solid #999",
                background: screen === s ? "#222" : "transparent",
                color: screen === s ? "#fff" : "inherit",
                cursor: "pointer",
              }}
            >
              {s}
            </button>
          ))}
        </div>
        {screen === "calls" && <Calls />}
        {screen === "telephony" && <Telephony />}
        {screen === "call-window" && <CallWindow />}
      </div>
    </QueryClientProvider>
  );
}
