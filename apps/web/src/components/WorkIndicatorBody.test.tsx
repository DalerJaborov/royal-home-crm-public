import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { DraftMediaItem } from "../lib/draftUploads";

const state = vi.hoisted(() => ({ items: [] as DraftMediaItem[] }));
vi.mock("../hooks/useDraftMedia", async (original) => ({ ...await original<typeof import("../hooks/useDraftMedia")>(), useDraftMedia: () => state.items }));
vi.mock("../hooks/useUploadQueue", async (original) => ({ ...await original<typeof import("../hooks/useUploadQueue")>(), useUploadSummary: () => ({ active: false }) }));
import { WorkIndicatorBody } from "./WorkIndicatorBody";

const item = (status: DraftMediaItem["status"]): DraftMediaItem => ({ uploadKey: "test-upload", kind: "photo", name: "test.jpg", sizeBytes: 24, loaded: 0, status, error: null, errorKind: null, mediaId: null, previewUrl: null, thumbUrl: null });
const render = () => renderToStaticMarkup(<MemoryRouter initialEntries={["/clients"]}><WorkIndicatorBody /></MemoryRouter>);
describe("global draft upload indicator", () => {
  it("does not cover unrelated pages for an idle saved draft", () => {
    state.items = []; expect(render()).toBe("");
    state.items = [item("ready")]; expect(render()).toBe("");
  });
  it("keeps progress and recoverable failures visible", () => {
    state.items = [item("uploading")]; expect(render()).toContain("Продолжить");
    state.items = [item("failed")]; expect(render()).toContain("не загрузилось");
  });
});
