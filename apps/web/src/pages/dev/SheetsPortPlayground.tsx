import { useEffect, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AddInteractionModal } from "../../components/AddInteractionModal";
import { ClientFormModal } from "../../components/ClientFormModal";
import { CloseDealChoiceModal } from "../../components/CloseDealChoiceModal";
import { DealSubmitModal } from "../../components/DealSubmitModal";
import { DuplicatesModal } from "../../components/DuplicatesModal";
import { HandoverModal } from "../../components/HandoverModal";
import { MatchPanel } from "../../components/match/MatchPanel";
import { MergeClientModal } from "../../components/MergeClientModal";
import { PhotoLightbox } from "../../components/PhotoLightbox";
import { RefuseClientModal } from "../../components/RefuseClientModal";
import { RequestDeleteClientModal } from "../../components/RequestDeleteClientModal";
import { RequestDeletePropertyModal } from "../../components/RequestDeletePropertyModal";
import { TransferClientModal } from "../../components/TransferClientModal";
import type { Client, Property, PropertyPhoto } from "../../types";

/**
 * Дев-стенд переноса окон и шторок клиентов, сделок и объектов на эталон темы
 * «Royal Home 2026» (09.09.2026).
 *
 * ЗАЧЕМ ОН НУЖЕН ИМЕННО ЗДЕСЬ. Все эти окна уходят порталом в `document.body`,
 * то есть за пределы обёртки экрана `.rh2`. Забытая обёртка не ломает ни сборку,
 * ни типы, ни консоль — окно просто рендерится голой разметкой, и увидеть это
 * можно только глазами на ОТКРЫТОМ окне. Стенд открывает каждое из тринадцати
 * окон по ссылке, без входа и без базы: fetch на `/api/v1` подменяется фикстурой,
 * сами компоненты работают своим настоящим кодом.
 *
 * Тот же приём, что в CallsPortPlayground: маршрут и чанк существуют только в
 * `import.meta.env.DEV` и в прод-бандл не попадают.
 */

const AGENTS = [
  { id: "a1", fullName: "Нурмухаммад Сафаров", isActive: true },
  { id: "a2", fullName: "Баходур Рахимов", isActive: true },
];

const DISTRICTS = [
  { id: "d1", name: "Сино" },
  { id: "d2", name: "Фирдавси" },
  { id: "d3", name: "И. Сомони" },
];

const PROPERTIES = [
  {
    id: "p1",
    shortId: 41,
    title: "3-комнатная у парка Рудаки",
    price: "890000",
    currency: "TJS",
    areaSqm: 96,
    rooms: 3,
    status: "AVAILABLE",
    publishedOnSite: true,
    offSite: false,
    district: { id: "d1", name: "Сино" },
    photos: [],
    assignedAgent: { id: "a1", fullName: "Нурмухаммад Сафаров" },
    aiReason: "Совпал район и бюджет, этаж не первый",
  },
  {
    id: "p2",
    shortId: 42,
    title: "2-комнатная, новостройка на Айни",
    price: "640000",
    currency: "TJS",
    areaSqm: 72,
    rooms: 2,
    status: "AVAILABLE",
    publishedOnSite: false,
    offSite: false,
    district: { id: "d2", name: "Фирдавси" },
    photos: [],
    assignedAgent: { id: "a2", fullName: "Баходур Рахимов" },
  },
];

const CLIENT = {
  id: "c1",
  shortId: 227,
  kind: "BUYER",
  fullName: "Далер Хайруллоев",
  lastName: "",
  phone: "+992901234567",
  extraPhones: [],
  source: "PHONE_CALL",
  status: "ACTIVE",
  currency: "TJS",
  budgetMin: "500000",
  budgetMax: "900000",
  desiredRooms: 3,
  desiredDistrictId: "d1",
  desiredDistrict: { id: "d1", name: "Сино" },
  requirementsNotes: "Не первый и не последний этаж, рядом школа.",
  refusalCount: 1,
  interactions: [
    {
      id: "i1",
      type: "SHOWING",
      propertyId: "p1",
      property: { shortId: 41, title: "3-комнатная у парка Рудаки" },
      nextActionDate: new Date(Date.now() + 86400000).toISOString(),
    },
  ],
} as unknown as Client;

/**
 * Кадр-заглушка вместо настоящего фото: `/icon.svg` рисовал крошечный квадрат,
 * и по нему нельзя было судить ни о полях просмотрщика, ни о том, как ведёт
 * себя вертикальный кадр рядом с горизонтальным. Картинка встроена строкой,
 * чтобы стенд не зависел ни от базы, ни от файлов на диске.
 */
function stubPhoto(w: number, h: number, label: string, tone: string): string {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
    `<rect width="${w}" height="${h}" fill="${tone}"/>` +
    `<text x="50%" y="50%" fill="#ffffff" font-family="system-ui,sans-serif" font-size="${Math.round(w / 12)}"` +
    ` text-anchor="middle" dominant-baseline="middle">${label}</text></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

const PHOTOS: PropertyPhoto[] = [
  { id: "ph1", url: stubPhoto(1200, 900, "1", "#4b5a6b"), thumbUrl: "", order: 0 },
  {
    id: "ph2",
    url: stubPhoto(900, 1200, "2", "#6b5a4b"),
    thumbUrl: "",
    order: 1,
    // Кадр с длинной подписью: улучшение ИИ ждёт решения владельца.
    enhancedUrl: stubPhoto(900, 1200, "2", "#6b5a4b"),
  },
  { id: "ph3", url: stubPhoto(1200, 800, "3", "#4b6b5a"), thumbUrl: "", order: 2, originalUrl: "x" },
  { id: "ph4", url: stubPhoto(1200, 900, "4", "#5a4b6b"), thumbUrl: "", order: 3 },
  { id: "ph5", url: stubPhoto(1600, 900, "5", "#6b4b5a"), thumbUrl: "", order: 4 },
];

function stubFor(path: string): unknown {
  if (path.startsWith("/districts")) return DISTRICTS;
  if (path.startsWith("/agents")) return AGENTS;
  if (path.startsWith("/settings")) return { leadMaxTransfers: 3 };
  if (path.startsWith("/clients/duplicates"))
    return [
      {
        clients: [
          {
            id: "c1",
            fullName: "Далер Хайруллоев",
            phone: "+992901234567",
            status: "ACTIVE",
            source: "PHONE_CALL",
            createdAt: new Date().toISOString(),
            assignedAgent: { id: "a1", fullName: "Нурмухаммад Сафаров" },
            _count: { interactions: 7, deals: 1 },
          },
          {
            id: "c2",
            fullName: "Далер Х.",
            phone: "+992901234567",
            status: "NEW",
            source: "INSTAGRAM",
            createdAt: new Date().toISOString(),
            assignedAgent: null,
            _count: { interactions: 1, deals: 0 },
          },
        ],
      },
    ];
  // «Куда уйдёт» (28.09.2026): кадр с закрытым окном Meta — самый частый отказ.
  if (path.includes("/send-target"))
    return {
      channel: "WHATSAPP",
      channelEnabled: true,
      windowOpen: false,
      lastClientMessageAt: new Date(Date.now() - 3 * 86400000).toISOString(),
      smsAvailable: true,
      hint: "Клиент не писал в WhatsApp больше суток — Meta не пропустит сообщение. Отправьте по СМС или скопируйте ссылку.",
    };
  if (path.startsWith("/clients/") && path.includes("/match")) return { unfiltered: false, total: PROPERTIES.length, properties: PROPERTIES };
  if (path.startsWith("/clients")) return { items: [CLIENT], total: 1, page: 1, pageSize: 8 };
  if (path.startsWith("/properties")) return { items: PROPERTIES, total: PROPERTIES.length, page: 1, pageSize: 20 };
  if (path.startsWith("/me")) return { permissions: [] };
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
    // Отказ мессенджера с запасным путём — чтобы кадр показывал и его.
    if (path.includes("/send-properties")) {
      const refusal = {
        error: "Клиент не писал последние 24 часа — Meta не пропускает сообщение. Дождитесь его ответа или позвоните.",
        code: "window_closed",
        fallback: {
          text: "Посмотрите объект:\n\n№42 — 2-комнатная, новостройка на Айни — 640 000 с.\nhttps://crm.royalhome.tj/l/abc",
          links: [{ propertyId: "p2", shortId: 42, url: "https://crm.royalhome.tj/l/abc" }],
        },
      };
      // Подготовка без отправки — так же, как отвечает сервер: 200 и готовые ссылки.
      if (typeof init?.body === "string" && init.body.includes('"prepareOnly":true')) {
        const prepared = { ok: true, prepared: true, sent: 0, fallback: refusal.fallback };
        return Promise.resolve(new Response(JSON.stringify(prepared), { status: 200, headers: { "Content-Type": "application/json" } }));
      }
      return Promise.resolve(new Response(JSON.stringify(refusal), { status: 502, headers: { "Content-Type": "application/json" } }));
    }
    const body = JSON.stringify(stubFor(path));
    return Promise.resolve(new Response(body, { status: 200, headers: { "Content-Type": "application/json" } }));
  };
}

const SHEETS = [
  "client-form",
  "add-interaction",
  "match-panel",
  "close-deal",
  "refuse",
  "transfer",
  "merge",
  "duplicates",
  "request-delete-client",
  "request-delete-property",
  "handover",
  "deal-submit",
  "photo-lightbox",
] as const;
type SheetId = (typeof SHEETS)[number];

function isSheetId(v: string | null): v is SheetId {
  return !!v && (SHEETS as readonly string[]).includes(v);
}

export default function SheetsPortPlayground() {
  installFetchStub();
  const fromUrl = new URLSearchParams(window.location.search).get("sheet");
  const [sheet, setSheet] = useState<SheetId>(isSheetId(fromUrl) ? fromUrl : "client-form");
  // `?photo=N` открывает просмотрщик сразу на нужном кадре: без этого снять
  // первый и последний кадр (там гаснут стрелки) можно было бы только кликами.
  const [lightboxIndex, setLightboxIndex] = useState(() => {
    const n = Number(new URLSearchParams(window.location.search).get("photo"));
    return Number.isInteger(n) && n >= 0 && n < PHOTOS.length ? n : 0;
  });
  const [client] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } })
  );

  // Тема выбирается тем же атрибутом, что и в приложении: снимки нужны в обеих.
  useEffect(() => {
    const root = document.documentElement;
    if (!root.getAttribute("data-theme")) root.setAttribute("data-theme", "royal-home-2026-light");
  }, []);

  const close = () => undefined;

  return (
    <QueryClientProvider client={client}>
      <div style={{ minHeight: "100vh", background: "var(--c-page, #f4f6f9)" }}>
        <div
          data-stand-nav
          style={{ display: "flex", gap: 8, padding: 12, flexWrap: "wrap", fontFamily: "system-ui, sans-serif" }}
        >
          {SHEETS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setSheet(s)}
              aria-pressed={sheet === s}
              style={{
                minHeight: 44,
                padding: "0 14px",
                borderRadius: 999,
                border: "1px solid #999",
                background: sheet === s ? "#222" : "transparent",
                color: sheet === s ? "#fff" : "inherit",
                cursor: "pointer",
              }}
            >
              {s}
            </button>
          ))}
        </div>

        {sheet === "client-form" && <ClientFormModal onClose={close} client={CLIENT} />}
        {sheet === "add-interaction" && <AddInteractionModal clientId="c1" onClose={close} />}
        {sheet === "match-panel" && <MatchPanel mode="client" client={CLIENT} open onClose={close} />}
        {sheet === "close-deal" && <CloseDealChoiceModal client={CLIENT} onClose={close} />}
        {sheet === "refuse" && <RefuseClientModal client={CLIENT} onClose={close} />}
        {sheet === "transfer" && <TransferClientModal client={CLIENT} onClose={close} />}
        {sheet === "merge" && <MergeClientModal client={CLIENT} onClose={close} />}
        {sheet === "duplicates" && <DuplicatesModal onClose={close} />}
        {sheet === "request-delete-client" && <RequestDeleteClientModal client={CLIENT} onClose={close} />}
        {sheet === "request-delete-property" && (
          <RequestDeletePropertyModal propertyId="p1" propertyTitle="3-комнатная у парка Рудаки" onClose={close} />
        )}
        {sheet === "handover" && <HandoverModal agent={{ id: "a1", fullName: "Нурмухаммад Сафаров" }} onClose={close} />}
        {sheet === "deal-submit" && (
          <DealSubmitModal listedPrice="890000" currency="TJS" onSubmit={close} onCancel={close} />
        )}
        {sheet === "photo-lightbox" && (
          <PhotoLightbox photos={PHOTOS} index={lightboxIndex} onClose={close} onIndexChange={setLightboxIndex} />
        )}
      </div>
    </QueryClientProvider>
  );
}

/** Ссылка на тип Property нужна только для проверки фикстуры компилятором. */
export type _PropertyFixture = Property;
