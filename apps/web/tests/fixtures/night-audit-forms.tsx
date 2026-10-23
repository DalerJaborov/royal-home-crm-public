// Component-only fixture: no CRM API, authentication, providers or database.
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { DealSubmitModal } from "../../src/components/DealSubmitModal";
import { initMobileUxFlag } from "../../src/hooks/useMobileUx";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useDeferredClientsFeed } from "../../src/hooks/useClients";
import { Pagination } from "../../src/components/Pagination";
import { EditorDashboard } from "../../src/components/EditorDashboard";
import { MemoryRouter } from "react-router-dom";
import "../../src/index.css";

document.documentElement.dataset.theme = "royal-home-2026-light";
document.documentElement.dataset.shell = "clean";
document.documentElement.dataset.screen = "deals";
initMobileUxFlag();

function Fixture() {
  const [open, setOpen] = useState(true);
  const [attempts, setAttempts] = useState(0);
  return <main><p>Тестовый стенд формы сделки. Вымышленные данные, реальные отправки отключены.</p>
    <output data-testid="attempts">{attempts}</output>
    {!open && <button type="button" onClick={() => setOpen(true)}>Открыть форму</button>}
    {open && <DealSubmitModal listedPrice="100000" currency="TJS" mode="complete" onCancel={() => setOpen(false)} onSubmit={async (body) => {
      setAttempts(value => value + 1);
      const result = await fetch("/night-audit-fixture-save", { method: "POST", body: JSON.stringify(body) });
      if (!result.ok) throw new Error("Тестовый отказ: не хватает документов");
      setOpen(false);
    }} />}
  </main>;
}
function DeferredFeedFixture() {
  const feed = useDeferredClientsFeed();
  return <main><p>Тестовый стенд списка. Вымышленные данные, CRM API подменён.</p>
    <output data-testid="row-count">{feed.items.length}</output>
    <ol>{feed.items.map(item => <li key={item.id}>{item.fullName}</li>)}</ol>
    {feed.total !== undefined && <Pagination variant="loadMore" loading={feed.isFetching} page={feed.page} pageSize={feed.pageSize} total={feed.total} onPageChange={feed.setPage} />}
  </main>;
}
const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
createRoot(document.getElementById("root")!).render(<QueryClientProvider client={query}>
  {new URLSearchParams(location.search).get("mode") === "deferred" ? <DeferredFeedFixture /> :
    new URLSearchParams(location.search).get("mode") === "editor" ? <MemoryRouter><EditorDashboard /></MemoryRouter> : <Fixture />}
</QueryClientProvider>);
