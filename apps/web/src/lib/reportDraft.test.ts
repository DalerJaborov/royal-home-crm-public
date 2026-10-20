import { describe, expect, it } from "vitest";
import { createReportDraft, reconcileReportDraft, reportDraftConflict } from "./reportDraft";

describe("report draft reconciliation", () => {
  it("preserves a dirty monthly note and editor when the same report refreshes", () => {
    const initial = createReportDraft("month-1", { notes: "original" });
    const editing = { ...initial, editing: true, value: { notes: "my unsaved explanation" } };
    const remote = { notes: "another manager's explanation" };
    expect(reconcileReportDraft(editing, "month-1", remote)).toBe(editing);
    expect(reportDraftConflict(editing, remote)).toBe(true);
    expect(editing.value.notes).toBe("my unsaved explanation");
  });

  it("preserves a voice-only dirty draft, including transcript", () => {
    const initial = createReportDraft("week-1", { notes: "same text", notesVoiceUrl: null as string | null, notesVoiceTranscript: null as string | null });
    const editing = { ...initial, editing: true, value: { ...initial.value, notesVoiceUrl: "/my-voice.webm", notesVoiceTranscript: "my recording" } };
    const remote = { ...initial.value, notes: "changed on server" };
    expect(reconcileReportDraft(editing, "week-1", remote)).toBe(editing);
    expect(reportDraftConflict(editing, remote)).toBe(true);
    expect(editing.value.notesVoiceTranscript).toBe("my recording");
  });

  it("syncs a pristine open editor without closing it", () => {
    const initial = { ...createReportDraft("month-1", { notes: "original" }), editing: true };
    const updated = reconcileReportDraft(initial, "month-1", { notes: "new" });
    expect(updated).toEqual({ id: "month-1", value: { notes: "new" }, baseline: { notes: "new" }, editing: true });
    expect(reportDraftConflict(updated, { notes: "new" })).toBe(false);
  });

  it("resets text, voice, baseline and editing when switching reports", () => {
    const initial = createReportDraft<{ notes: string; notesVoiceUrl: string | null; notesVoiceTranscript: string | null }>("week-1", { notes: "old", notesVoiceUrl: "/old.webm", notesVoiceTranscript: "old recording" });
    const editing = { ...initial, editing: true, value: { ...initial.value, notes: "unsaved" } };
    const remote = { notes: "new month", notesVoiceUrl: null, notesVoiceTranscript: null };
    expect(reconcileReportDraft(editing, "month-2", remote)).toEqual(createReportDraft("month-2", remote));
  });

  it("does not conflict when server matches the draft or returns to baseline", () => {
    const editing = { ...createReportDraft("id", { notes: "original" }), editing: true, value: { notes: "draft" } };
    expect(reportDraftConflict(editing, { notes: "draft" })).toBe(false);
    expect(reportDraftConflict(editing, { notes: "original" })).toBe(false);
  });

  it("requires explicit acknowledgement before saving the local version over a server change", () => {
    const initial = { ...createReportDraft("id", { notes: "original" }), editing: true, value: { notes: "mine" } };
    const remote = { notes: "theirs" };
    const refreshed = reconcileReportDraft(initial, "id", remote);
    expect(reportDraftConflict(refreshed, remote)).toBe(true);
    const acknowledged = { ...refreshed, baseline: remote };
    expect(reportDraftConflict(acknowledged, remote)).toBe(false);
    expect(acknowledged.value.notes).toBe("mine");
    expect(reportDraftConflict(acknowledged, { notes: "newer server edit" })).toBe(true);
  });
});
