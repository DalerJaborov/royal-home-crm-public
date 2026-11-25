// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/api", () => ({ api: vi.fn() }));

import { PendingMediaBubble } from "./PendingMediaBubble";
import { api } from "../lib/api";
import { outgoingMediaPollDelayMs, waitOutgoingMediaJob, type OutgoingMediaJobView } from "../lib/mediaUpload";
import type { PendingMediaUpload } from "../store/mediaUploads";

/**
 * Пузырь отправки «как в мессенджере» (25.11.2026): загрузка → «Сжимаем N%» → «Отправляем…» →
 * исчез (реплика пришла) или «Не отправлено» с причиной и «Повторить». Одна разметка на ПК и
 * телефон (раньше — копия в Messages.tsx и MobileChatView.tsx).
 */

afterEach(cleanup);

const base: PendingMediaUpload = {
  localId: "l1",
  file: new File(["x"], "a.mp4", { type: "video/mp4" }),
  previewUrl: "blob:x",
  kind: "video",
  progress: 0,
  status: "uploading",
};

describe("PendingMediaBubble", () => {
  it("загрузка: проценты и «Отменить»", () => {
    const onCancel = vi.fn();
    render(<PendingMediaBubble upload={{ ...base, progress: 42 }} onRetry={vi.fn()} onCancel={onCancel} />);
    expect(screen.getByText("42%")).toBeTruthy();
    fireEvent.click(screen.getByText("Отменить"));
    expect(onCancel).toHaveBeenCalledWith("l1");
  });

  it("сервер сжимает: «Сжимаем 45%»; отправляет: «Отправляем…» и отменить уже нельзя", () => {
    const { rerender } = render(
      <PendingMediaBubble upload={{ ...base, status: "processing", stage: "compress", progress: 45, jobId: "j" }} onRetry={vi.fn()} onCancel={vi.fn()} />
    );
    expect(screen.getByText("Сжимаем 45%")).toBeTruthy();
    expect(screen.getByText("Отменить")).toBeTruthy();
    rerender(<PendingMediaBubble upload={{ ...base, status: "processing", stage: "send", progress: 100, jobId: "j" }} onRetry={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByText("Отправляем…")).toBeTruthy();
    expect(screen.queryByText("Отменить")).toBeNull();
  });

  it("сбой: причина простыми словами и «Повторить»", () => {
    const onRetry = vi.fn();
    const failed = { ...base, status: "error" as const, error: "Окно 24 часа закрыто", jobId: "j" };
    render(<PendingMediaBubble upload={failed} onRetry={onRetry} onCancel={vi.fn()} />);
    expect(screen.getByText("Окно 24 часа закрыто")).toBeTruthy();
    fireEvent.click(screen.getByText("Повторить"));
    expect(onRetry).toHaveBeenCalledWith(failed);
  });
});

describe("исход неизвестен и пузырь после перезагрузки (ревью 25.11)", () => {
  it("файл мог дойти — «Повторить» не показываем, только «Убрать»", () => {
    render(
      <PendingMediaBubble
        upload={{ ...base, status: "error", error: "Проверьте переписку", retryable: false, jobId: "j" }}
        onRetry={vi.fn()}
        onCancel={vi.fn()}
      />
    );
    expect(screen.queryByText("Повторить")).toBeNull();
    expect(screen.getByText("Убрать")).toBeTruthy();
  });

  it("пузырь, поднятый с сервера, без файла и превью — рисуется подложкой, не ломается", () => {
    const { container } = render(
      <PendingMediaBubble upload={{ ...base, file: null, previewUrl: "", status: "processing", stage: "compress", progress: 10, jobId: "j" }} onRetry={vi.fn()} onCancel={vi.fn()} />
    );
    expect(container.querySelector("video, img")).toBeNull();
    expect(screen.getByText("Сжимаем 10%")).toBeTruthy();
  });
});

describe("waitOutgoingMediaJob", () => {
  it("спрашивает, пока не SENT; сбой сети при опросе — не сбой отправки", async () => {
    const answers: Array<OutgoingMediaJobView | Error> = [
      { id: "j", status: "QUEUED", progress: 0, error: null, note: null },
      new Error("сеть"),
      { id: "j", status: "PREPARING", progress: 50, error: null, note: null },
      { id: "j", status: "SENT", progress: 100, error: null, note: null },
    ];
    vi.mocked(api).mockImplementation(async () => {
      const next = answers.shift()!;
      if (next instanceof Error) throw next;
      return next;
    });
    const seen: string[] = [];
    const done = await waitOutgoingMediaJob("c", "j", (job) => seen.push(job.status), undefined, async () => {});
    expect(done.status).toBe("SENT");
    expect(seen).toEqual(["QUEUED", "PREPARING", "SENT"]);
  });

  it("опрос не бесконечный: через полчаса — «проверьте переписку позже», без повтора", async () => {
    vi.mocked(api).mockResolvedValue({ id: "j", status: "PREPARING", progress: 1, error: null, note: null });
    let now = 0;
    const spy = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      const done = await waitOutgoingMediaJob("c", "j", () => {}, undefined, async () => {
        now += 10 * 60_000;
      });
      expect(done).toMatchObject({ status: "FAILED", retryable: false });
    } finally {
      spy.mockRestore();
    }
  });

  it("опрос редеет со временем: не долбить сервер минутами", () => {
    expect(outgoingMediaPollDelayMs(1_000)).toBe(1_500);
    expect(outgoingMediaPollDelayMs(60_000)).toBe(3_000);
    expect(outgoingMediaPollDelayMs(10 * 60_000)).toBe(6_000);
  });
});
