import { useEffect, useRef, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AgentPermissionsModal } from "../../components/AgentPermissionsModal";
import { AssistantPanel } from "../../components/AssistantPanel";
import { CommandPalette } from "../../components/CommandPalette";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { DealSubmitModal } from "../../components/DealSubmitModal";
import { FabMenu } from "../../components/FabMenu";
import { FreezeAgentModal } from "../../components/FreezeAgentModal";
import { InstallAppHint } from "../../components/InstallAppHint";
import { KpiBreakdownModal } from "../../components/KpiBreakdownModal";
import { OfflineBanner } from "../../components/OfflineBanner";
import { PointsJournalModal } from "../../components/PointsJournalModal";
import { ProfileMenu } from "../../components/ProfileMenu";
import { StepUpDialog } from "../../components/StepUpDialog";
import { Toasts } from "../../components/Toasts";
import { UploadTaskRow } from "../../components/UploadTaskRow";
import { Rh2Inline } from "../../components/rh2/Rh2Scope";
import { Sheet } from "../../components/ui/Sheet";
import { Toaster } from "../../components/ui/Toaster";
import { useToastStore } from "../../store/toast";
import { useUndoToastStore } from "../../store/undoToast";
import type { UploadTaskView } from "../../lib/uploadQueue";

/**
 * Дев-стенд переноса окон, меню и панелей на эталон «Royal Home 2026»
 * (задача port-sheets-system, 09.09.2026).
 *
 * ЗАЧЕМ ОН ЕСТЬ. Окна открываются из тридцати пяти мест, часть из них требует
 * живой базы, телефонии, отказа сервера с кодом 428 или очереди загрузки с
 * настоящими файлами. Снять облик каждого окна в обеих темах и на двух ширинах
 * через живую CRM означало бы поднять станцию, Postgres и вход в систему ради
 * кадра. Здесь подменяется ровно один слой — `window.fetch` на путях `/api/v1/…`,
 * — а окна рендерятся своим настоящим кодом, со своими хуками, своей разметкой и
 * своими состояниями. Ни один компонент ради стенда не менялся.
 *
 * Тот же приём и тот же файл-сосед, что у `CallsPortPlayground` (перенос
 * «Звонков»). Живёт только в DEV (маршрут регистрирует App.tsx за
 * `import.meta.env.DEV`), в прод-бандл не попадает.
 *
 * ПОЧЕМУ СТЕНДОВ ДВА. Волна окон клиентов, сделок и объектов завела свой стенд
 * с тем же именем файла и тем же адресом (`SheetsPortPlayground`,
 * `/dev/sheets-port?sheet=<ключ>`). Корпус окна у обеих волн теперь ОДИН
 * (`Rh2Sheet` поверх `Rh2Portal`), а вот фикстуры — нет: у каждой волны свои
 * клиенты, объекты, права и подмены путей `/api/v1`, и имена констант в двух
 * файлах совпадают. Сливать их в один файл значило бы переименовывать полсотни
 * фикстур ради стенда, который в прод не уезжает, поэтому стендов оставлено два:
 * этот на `/dev/system-sheets-port?w=<ключ>`, соседний — на `/dev/sheets-port`.
 *
 * Какое окно показать, выбирает `?w=<ключ>` — так скрипт кадров снимает каждое
 * окно отдельным переходом, не изображая клики по живому интерфейсу.
 */

const NOW = "2026-09-09T06:40:00.000Z";

const AGENT_OVERVIEW = {
  agent: {
    id: "a-firuza",
    fullName: "Фируза Каримова",
    phone: "+992 90 000 00 01",
    email: "firuza@royalhome.tj",
    role: "AGENT",
    isActive: true,
    avatarUrl: null,
    lastSeenAt: NOW,
    createdAt: "2025-03-12T06:00:00.000Z",
    kpi: 92,
    sipExtension: "104",
  },
  properties: {
    total: 14,
    available: 9,
    created: 6,
    last: [
      {
        id: "p1",
        shortId: 412,
        title: "Двухкомнатная, Сомони, 78 кв. м",
        price: "620000",
        currency: "TJS",
        status: "AVAILABLE",
        createdAt: NOW,
      },
      {
        id: "p2",
        shortId: 407,
        title: "Дом, Гипрозем, 5 соток",
        price: "1180000",
        currency: "TJS",
        status: "PENDING_REVIEW",
        createdAt: NOW,
      },
      {
        id: "p3",
        shortId: 388,
        title: "Однокомнатная, Фирдавси, 41 кв. м",
        price: "395000",
        currency: "TJS",
        status: "SOLD",
        createdAt: NOW,
      },
    ],
  },
  clients: {
    total: 23,
    last: [
      {
        id: "c1",
        shortId: 41,
        fullName: "Далер Саидов",
        phone: "+992 90 111 11 11",
        status: "SHOWING",
        createdAt: NOW,
        kind: "BUYER",
        firstContactAt: NOW,
        noContactYet: false,
      },
      {
        id: "c2",
        shortId: 44,
        fullName: "Шахзод Рахимов",
        phone: "+992 90 222 22 22",
        status: "NEW",
        createdAt: NOW,
        kind: "BUYER",
        firstContactAt: null,
        noContactYet: true,
      },
      {
        id: "c3",
        shortId: 47,
        fullName: "Манижа Назарова",
        phone: "+992 90 333 33 33",
        status: "CONTACTED",
        createdAt: NOW,
        kind: "SELLER",
        firstContactAt: NOW,
        noContactYet: false,
      },
    ],
  },
  deals: {
    total: 6,
    completed: 4,
    cancelled: 1,
    commissionTotal: 164000,
    last: [
      {
        id: "d1",
        stage: "COMPLETED",
        commissionAmount: "48000",
        currency: "TJS",
        property: { id: "p1", shortId: 412, title: "Двухкомнатная, Сомони, 78 кв. м" },
        client: { id: "c1", shortId: 41, fullName: "Далер Саидов" },
      },
      {
        id: "d2",
        stage: "CONTRACT",
        commissionAmount: null,
        currency: "TJS",
        property: { id: "p2", shortId: 407, title: "Дом, Гипрозем, 5 соток" },
        client: { id: "c3", shortId: 47, fullName: "Манижа Назарова" },
      },
    ],
  },
  kpiHistory: [
    { date: "2026-09-08T19:00:00.000Z", score: 92 },
    { date: "2026-09-07T19:00:00.000Z", score: 74 },
    { date: "2026-09-06T19:00:00.000Z", score: 61 },
    { date: "2026-09-05T19:00:00.000Z", score: 38 },
  ],
};

const KPI = {
  id: "a-firuza",
  fullName: "Фируза Каримова",
  kpi: 92,
  days: [
    {
      date: "2026-09-08T19:00:00.000Z",
      score: 92,
      breakdown: {
        response: { earned: 20, max: 20 },
        crm: { earned: 18, max: 20 },
        discipline: { earned: 16, max: 20 },
        photo: { earned: 10, max: 10 },
        contract: { earned: 20, max: 20 },
        cards: { earned: 8, max: 10 },
      },
    },
    { date: "2026-09-07T19:00:00.000Z", score: 74, breakdown: null },
    { date: "2026-09-06T19:00:00.000Z", score: 61, breakdown: null },
    { date: "2026-09-05T19:00:00.000Z", score: 38, breakdown: null },
  ],
};

const POINTS = {
  total: 34,
  entries: [
    {
      id: "j1",
      agentName: "Далер Джаббаров",
      createdAt: NOW,
      meta: { points: 12, reason: "Закрыл сделку раньше срока" },
    },
    {
      id: "j2",
      agentName: "Далер Джаббаров",
      createdAt: "2026-09-02T06:00:00.000Z",
      meta: { points: -5, reason: "Не перезвонил по пропущенному" },
    },
    {
      id: "j3",
      agentName: "Далер Джаббаров",
      createdAt: "2026-08-28T06:00:00.000Z",
      meta: { points: 27, reason: "Доска почёта, август" },
    },
  ],
};

const PERMISSIONS = {
  agentId: "a-firuza",
  fullName: "Фируза Каримова",
  role: "AGENT",
  roleSummary: "",
  editable: true,
  items: [] as unknown[],
};

const SEARCH_CLIENTS = {
  items: [
    { id: "c1", shortId: 41, fullName: "Далер Саидов", phone: "+992 90 111 11 11" },
    { id: "c2", shortId: 44, fullName: "Шахзод Рахимов", phone: "+992 90 222 22 22" },
  ],
  total: 2,
};

const SEARCH_PROPERTIES = {
  items: [
    {
      id: "p1",
      shortId: 412,
      title: "Двухкомнатная, Сомони, 78 кв. м",
      price: "620000",
      currency: "TJS",
      district: { id: "d1", name: "Сомони" },
    },
  ],
  total: 1,
};

const SEARCH_DEALS = [
  {
    id: "d1",
    client: { id: "c1", fullName: "Далер Саидов" },
    property: { id: "p1", shortId: 412, title: "Двухкомнатная, Сомони, 78 кв. м" },
  },
];

const UPLOAD_TASKS: UploadTaskView[] = [
  {
    id: "u1",
    kind: "photo",
    propertyId: "p1",
    propertyShortId: 412,
    label: "6 фото",
    filenames: [],
    uploadKeys: [],
    totalBytes: 8_400_000,
    status: "uploading",
    attempts: 1,
    error: null,
    createdAt: Date.now(),
  },
  {
    id: "u2",
    kind: "video",
    propertyId: "p1",
    propertyShortId: 412,
    label: "obzor-412.mp4",
    filenames: [],
    uploadKeys: [],
    totalBytes: 148_000_000,
    status: "pending",
    attempts: 0,
    error: null,
    createdAt: Date.now(),
  },
  {
    id: "u3",
    kind: "video",
    propertyId: "p2",
    propertyShortId: 407,
    label: "dom-407.mp4",
    filenames: [],
    uploadKeys: [],
    totalBytes: 92_000_000,
    status: "failed",
    attempts: 3,
    error: "Хранилище видео не настроено",
    createdAt: Date.now(),
  },
];

/**
 * Фикстуры отвечают ФОРМОЙ ответов сервера. Пустая коллекция здесь означала бы,
 * что окно покажет только своё пустое состояние, а перенесённая разметка вообще
 * не попадёт ни в кадр, ни в проверку по DOM: у каждого списка есть записи.
 */
function stubFor(path: string): unknown {
  if (path.startsWith("/auth/step-up")) return { elevated: false, method: "code" };
  if (path.startsWith("/me/active-call")) return null;
  if (path.startsWith("/me")) return { id: "me", fullName: "Далер Джаббаров", role: "DIRECTOR", permissions: null };
  if (path.includes("/permissions")) return PERMISSIONS;
  if (path.includes("/kpi")) return KPI;
  if (path.includes("/overview")) return AGENT_OVERVIEW;
  if (path.includes("/points")) return POINTS;
  if (path.startsWith("/settings")) return { aiAssistantEnabled: true };
  if (path.startsWith("/clients")) return SEARCH_CLIENTS;
  if (path.startsWith("/properties")) return SEARCH_PROPERTIES;
  if (path.startsWith("/deals")) return SEARCH_DEALS;
  if (path.startsWith("/ai/assistant"))
    return {
      reply:
        "У вас 4 показа на этой неделе. Ближайший завтра в 11:00, [Далер Саидов](/clients/41), объект №412. Напомнить за час?",
    };
  return { items: [], total: 0, unread: 0 };
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
    return Promise.resolve(
      new Response(JSON.stringify(stubFor(path)), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
  };
}

/** Права строятся из настоящего реестра, а не выдумываются рядом с ним. */
async function fillPermissions() {
  const shared = await import("@royal-home/shared");
  if (PERMISSIONS.items.length > 0) return;
  PERMISSIONS.items = shared.PERMISSIONS.slice(0, 12).map((p, i) => ({
    id: p.id,
    label: p.label,
    group: p.group,
    hint: "hint" in p ? p.hint : undefined,
    enabled: i % 3 !== 2,
    overridden: i % 4 === 0,
  }));
}

const WINDOWS = [
  "confirm",
  "confirm-fields",
  "stepup",
  "freeze",
  "permissions",
  "kpi",
  "points",
  "palette",
  "profile-menu",
  "fab",
  "assistant",
  "sheet",
  "uploads",
  "toasts",
  "undo",
  "offline",
  "install",
] as const;
type WindowKey = (typeof WINDOWS)[number];

function currentWindow(): WindowKey {
  const w = new URLSearchParams(window.location.search).get("w");
  return (WINDOWS as readonly string[]).includes(w ?? "") ? (w as WindowKey) : "confirm";
}

export default function SystemSheetsPortPlayground() {
  const [client] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } })
  );
  const [ready, setReady] = useState(false);
  const which = currentWindow();

  installFetchStub();

  useEffect(() => {
    const root = document.documentElement;
    if (!root.getAttribute("data-theme")) root.setAttribute("data-theme", "royal-home-2026-light");
    void fillPermissions().then(() => setReady(true));
  }, []);

  // Тосты живут в сторе, а не в пропсах: наполняем стор так же, как это делает
  // приложение, иначе в кадр попало бы пустое место. Сторож `seeded` нужен
  // из-за StrictMode: он вызывает эффект дважды, и в кадре оказывались две
  // одинаковые пары уведомлений вместо одной.
  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current) return;
    seeded.current = true;
    if (which === "undo") {
      useUndoToastStore.getState().push({
        message: "Одобрено · 13:07",
        onUndo: () => undefined,
        durationMs: 600_000,
      });
    }
  }, [which]);

  /**
   * Обычные уведомления живут 2,2 и 5 секунд и гаснут сами. Стенд открывается
   * дольше (первая сборка модулей Vite), и к моменту снимка «Сохранено» успевало
   * исчезнуть: в кадр попадало одно уведомление вместо стопки, и проверка
   * налегания копий друг на друга не выполнялась ВООБЩЕ, оставаясь зелёной.
   * Поэтому здесь стопка поддерживается живой: как только стор опустел, кладём
   * ту же пару снова. Только на стенде; сами компоненты не тронуты.
   */
  useEffect(() => {
    if (which !== "toasts") return;
    const seed = () => {
      const store = useToastStore.getState();
      if (store.toasts.length === 2) return;
      // Пересобираем пару целиком: если досыпать только исчезнувшее, порядок в
      // стопке зависел бы от того, что успело погаснуть, и кадр стал бы разным
      // от прогона к прогону.
      for (const t of store.toasts) store.dismiss(t.id);
      store.show("Клиент сохранён");
      store.show("Не удалось отправить сообщение, проверьте связь", "error");
    };
    seed();
    const timer = setInterval(seed, 300);
    return () => clearInterval(timer);
  }, [which]);

  const noop = () => undefined;

  return (
    <QueryClientProvider client={client}>
      {/* Подложка под окном: без неё шторка висела бы на белом листе и кадр не
          показал бы ни тени, ни стекла — того, ради чего перенос и делается. */}
      <div
        data-stand
        style={{
          minHeight: "100vh",
          padding: 24,
          background: "var(--c-page, #f4f6f9)",
          color: "var(--c-ink, #14161a)",
          fontFamily: "system-ui, sans-serif",
        }}
      >
        <h1 data-stand-title style={{ fontSize: 18, margin: 0 }}>
          Стенд переноса окон: {which}
        </h1>
        <p style={{ maxWidth: 620, opacity: 0.7 }}>
          Экран-хозяин намеренно оставлен на прежнем оформлении: так видно, что облик окна не зависит от него.
        </p>

        {ready && which === "confirm" && (
          <ConfirmDialog
            title="Удалить объект №412?"
            description="Объект и его фотографии исчезнут из CRM и с сайта. Отменить это действие нельзя."
            confirmLabel="Удалить"
            onConfirm={noop}
            onCancel={noop}
          />
        )}
        {/* Тот же ConfirmDialog, но с полями от НЕ перенесённого экрана (сделки):
            так в кадре видно, во что превращается чужая tailwind-разметка внутри
            области темы. */}
        {ready && which === "confirm-fields" && (
          <DealSubmitModal listedPrice="620000" currency="TJS" mode="submit" onSubmit={noop} onCancel={noop} />
        )}
        {ready && which === "stepup" && (
          <StepUpDialog
            description="Разморозка возвращает сотруднику выдачу лидов. Подтвердите, что это вы."
            onConfirmed={noop}
            onCancel={noop}
          />
        )}
        {ready && which === "freeze" && (
          <FreezeAgentModal
            agent={{ id: "a-firuza", fullName: "Фируза Каримова", frozen: false, frozenReason: null }}
            onClose={noop}
          />
        )}
        {ready && which === "permissions" && <AgentPermissionsModal agentId="a-firuza" onClose={noop} />}
        {ready && which === "kpi" && <KpiBreakdownModal agentId="a-firuza" onClose={noop} onManualEdit={noop} />}
        {ready && which === "points" && (
          <PointsJournalModal agentId="a-firuza" agentName="Фируза Каримова" onClose={noop} />
        )}
        {ready && which === "palette" && <CommandPalette onClose={noop} />}
        {ready && which === "profile-menu" && (
          // Кнопка профиля в приложении стоит в правом верхнем углу, и меню
          // позиционируется от неё (px от края экрана). На стенде она оказалась
          // у левого края, и меню уезжало за границу кадра: разбирали бы
          // несуществующий дефект. Ставим её туда, где она живёт на самом деле.
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <ProfileMenu />
          </div>
        )}
        {ready && which === "fab" && <FabMenu open onClose={noop} />}
        {ready && which === "assistant" && (
          <AssistantPanel onClose={noop} initialPrompt="Сколько показов у меня на этой неделе?" />
        )}
        {ready && which === "sheet" && (
          <Sheet
            open
            onClose={noop}
            title="Расход за сентябрь"
            footer={
              <>
                <button type="button" className="pill ghost">
                  Отмена
                </button>
                <button type="button" className="pill">
                  Сохранить
                </button>
              </>
            }
          >
            <p className="state">Примитив-шторка после переноса: разметку рисует общий Rh2Sheet.</p>
          </Sheet>
        )}
        {ready && which === "uploads" && (
          <div style={{ maxWidth: 560, marginTop: 16 }}>
            <Rh2Inline>
              <div className="list">
                {UPLOAD_TASKS.map((task) => (
                  <UploadTaskRow
                    key={task.id}
                    task={task}
                    active={task.status === "uploading"}
                    percent={task.status === "uploading" ? 43 : 0}
                    note={task.propertyShortId ? `объект №${task.propertyShortId}` : undefined}
                  />
                ))}
              </div>
            </Rh2Inline>
          </div>
        )}
        {ready && which === "toasts" && <Toasts />}
        {ready && which === "undo" && <Toaster />}
        {ready && which === "offline" && <OfflineBanner />}
        {ready && which === "install" && <InstallAppHint />}
      </div>
    </QueryClientProvider>
  );
}
