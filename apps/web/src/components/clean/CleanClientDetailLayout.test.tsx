import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CleanClientDetailHeader, CleanClientDetailSkeleton, CleanClientDetailTabs, cleanClientShowsPanel, cleanClientPanelProps, cleanClientTabForKey } from "./CleanClientDetailLayout";

describe("clean client detail navigation", () => {
  it("keeps one active mobile panel in Clean and the legacy phone stack", () => {
    const panels = ["short", "chat", "calls", "props", "hist"] as const;
    expect(panels.filter(panel => cleanClientShowsPanel(true, true, "chat", panel))).toEqual(["chat"]);
    expect(panels.filter(panel => cleanClientShowsPanel(false, true, "chat", panel))).toEqual(panels);
    expect(panels.filter(panel => cleanClientShowsPanel(true, false, "props", panel))).toEqual(["props"]);
  });
  it("exposes every real section with one selected keyboard stop linked to its panel", () => {
    const html = renderToStaticMarkup(<CleanClientDetailTabs value="chat" onChange={() => {}} />);
    expect(html.match(/role="tab"/g)).toHaveLength(5);
    expect(html.match(/tabindex="0"/g)).toHaveLength(1);
    expect(html.match(/aria-selected="true"/g)).toHaveLength(1);
    for (const label of ["Обзор", "Переписка", "Звонки", "Объекты", "История"]) expect(html).toContain(label);
    const panel = renderToStaticMarkup(<div {...cleanClientPanelProps("chat")}>Existing conversation content</div>);
    expect(html).toContain('aria-controls="clean-client-panel-chat"');
    expect(panel).toContain('aria-labelledby="clean-client-tab-chat"');
  });

  it("supports wraparound arrows and Home/End without consuming other keys", () => {
    expect(cleanClientTabForKey("short", "ArrowLeft")).toBe("hist");
    expect(cleanClientTabForKey("hist", "ArrowRight")).toBe("short");
    expect(cleanClientTabForKey("chat", "ArrowRight")).toBe("calls");
    expect(cleanClientTabForKey("props", "Home")).toBe("short");
    expect(cleanClientTabForKey("chat", "End")).toBe("hist");
    expect(cleanClientTabForKey("chat", "Tab")).toBeUndefined();
  });

  it("keeps legacy wrapper unchanged and preserves passed actions in the clean header", () => {
    expect(renderToStaticMarkup(<CleanClientDetailHeader enabled={false}><button>Real action</button></CleanClientDetailHeader>))
      .toBe('<div class="card"><button>Real action</button></div>');
    const html = renderToStaticMarkup(<CleanClientDetailHeader enabled><button disabled>Real locked action</button></CleanClientDetailHeader>);
    expect(html).toContain('<header');
    expect(html).toContain('disabled=""');
    expect(html).toContain('Real locked action');
  });

  it("announces actual loading without fake client values or selectable tabs", () => {
    const html = renderToStaticMarkup(<CleanClientDetailSkeleton />);
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('Загружаем карточку клиента');
    expect(html).not.toContain('role="tab"');
    expect(html).not.toContain('<button');
  });
});
