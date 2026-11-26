// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Вложения переписки по прямой подписанной ссылке (25.11.2026, жалоба владельца
 * «фото и видео приходят, но не открываются в CRM»): плитка не качает файл целиком
 * через api() — тег грузит ссылку сам; не открылась — один раз прежним путём.
 */
const apiCalls: string[] = [];
vi.mock("../lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/api")>()),
  api: vi.fn(async (path: string) => {
    apiCalls.push(path);
    return new Blob(["x"], { type: "image/jpeg" });
  }),
}));

const { MessageAttachments, lostAttachmentText } = await import("./MessageAttachments");

afterEach(() => {
  cleanup();
  apiCalls.length = 0;
});

const SRC = "/api/v1/attachments/s/a.jpg?e=1&k=x";

describe("MessageAttachments: прямые ссылки", () => {
  it("фото с src: в ленте миниатюра, ни одного скачивания через api()", () => {
    const { container } = render(
      <MessageAttachments attachments={[{ kind: "image", mime: "image/jpeg", file: "a.jpg", src: SRC, thumb: `${SRC}&v=t` }]} />
    );
    const img = container.querySelector("img")!;
    expect(img.getAttribute("src")).toBe(`${SRC}&v=t`);
    expect(img.getAttribute("loading")).toBe("lazy");
    expect(apiCalls).toEqual([]);
  });

  it("прямая ссылка не открылась — один раз прежним путём (api с заголовком)", async () => {
    const { container } = render(
      <MessageAttachments attachments={[{ kind: "image", mime: "image/jpeg", file: "a.jpg", src: SRC, thumb: `${SRC}&v=t` }]} />
    );
    fireEvent.error(container.querySelector("img")!);
    await vi.waitFor(() => expect(apiCalls).toEqual(["/attachments/a.jpg"]));
  });

  it("видео: preload=metadata; ошибка оригинала — «готовим», 503 повторяется, потом версия для браузера", async () => {
    const statuses = [503, 200];
    const fetchMock = vi.fn(async () => {
      const status = statuses.shift() ?? 200;
      return { ok: status === 200, status, headers: new Headers({ "Retry-After": "2" }) } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { container } = render(
        <MessageAttachments attachments={[{ kind: "video", mime: "video/quicktime", file: "v.mov", src: SRC, play: `${SRC}&v=p` }]} />
      );
      const video = container.querySelector("video")!;
      expect(video.getAttribute("src")).toBe(SRC);
      expect(video.getAttribute("preload")).toBe("metadata");
      fireEvent.error(video);
      await vi.waitFor(() => expect(screen.getByText(/Готовим видео/)).toBeTruthy());
      await vi.advanceTimersByTimeAsync(2500);
      await vi.waitFor(() => expect(container.querySelector("video")?.getAttribute("src")).toBe(`${SRC}&v=p`));
      expect(fetchMock).toHaveBeenCalledTimes(2);
      fireEvent.error(container.querySelector("video")!);
      expect(screen.getByText(/Видео не воспроизводится/)).toBeTruthy();
      expect(apiCalls).toEqual([]);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it("подпись истекла: ошибка видео берёт свежую ссылку из переписки, а не уходит в «не воспроизводится»", () => {
    const one = { kind: "video" as const, mime: "video/mp4", file: "v.mp4", src: `${SRC}&n=1`, play: `${SRC}&n=1&v=p` };
    const { container, rerender } = render(<MessageAttachments attachments={[one]} />);
    // Опрос переписки принёс свежую подпись, а плеер держит старую — и она истекла (403).
    rerender(<MessageAttachments attachments={[{ ...one, src: `${SRC}&n=2`, play: `${SRC}&n=2&v=p` }]} />);
    fireEvent.error(container.querySelector("video")!);
    expect(container.querySelector("video")!.getAttribute("src")).toBe(`${SRC}&n=2`);
    expect(screen.queryByText(/не воспроизводится/)).toBeNull();
    expect(apiCalls).toEqual([]);
  });

  it("подпись истекла у версии для браузера (HEAD 403): берём свежую ссылку, а не «Скачать»", async () => {
    const seen: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (u: string) => {
      seen.push(u);
      const status = u.includes("n=1") ? 403 : 200;
      return { ok: status === 200, status, headers: new Headers() } as Response;
    }));
    try {
      const one = { kind: "video" as const, mime: "video/quicktime", file: "v.mov", src: `${SRC}&n=1`, play: `${SRC}&n=1&v=p` };
      const { container, rerender } = render(<MessageAttachments attachments={[one]} />);
      fireEvent.error(container.querySelector("video")!); // MOV не играет → версия для браузера
      await vi.waitFor(() => expect(screen.getByText(/Обновляем ссылку на видео/)).toBeTruthy());
      rerender(<MessageAttachments attachments={[{ ...one, src: `${SRC}&n=2`, play: `${SRC}&n=2&v=p` }]} />);
      await vi.waitFor(() => expect(container.querySelector("video")?.getAttribute("src")).toBe(`${SRC}&n=2&v=p`));
      expect(seen.some((u) => u.includes("n=2"))).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("голосовое с истёкшей подписью: плеер берёт свежую ссылку, а не пишет «не открылась»", () => {
    const one = { kind: "audio" as const, mime: "audio/mpeg", file: "a.mp3", src: `${SRC}&n=1` };
    const { container, rerender } = render(<MessageAttachments attachments={[one]} inBubble />);
    rerender(<MessageAttachments attachments={[{ ...one, src: `${SRC}&n=2` }]} inBubble />);
    fireEvent.error(container.querySelector("audio")!);
    expect(container.querySelector("audio")!.getAttribute("src")).toBe(`${SRC}&n=2`);
    expect(screen.queryByTestId("rh-audio-failed")).toBeNull();
  });

  it("новая подпись той же ссылки не перезапускает идущее видео; новый файл — с начала", () => {
    const one = { kind: "video" as const, mime: "video/mp4", file: "v.mp4", src: `${SRC}&n=1` };
    const { container, rerender } = render(<MessageAttachments attachments={[one]} />);
    const first = container.querySelector("video")!;
    rerender(<MessageAttachments attachments={[{ ...one, src: `${SRC}&n=2` }]} />);
    expect(container.querySelector("video")).toBe(first);
    expect(first.getAttribute("src")).toBe(`${SRC}&n=1`);
    rerender(<MessageAttachments attachments={[{ ...one, file: "w.mp4", src: `${SRC}&n=3` }]} />);
    expect(container.querySelector("video")!.getAttribute("src")).toBe(`${SRC}&n=3`);
  });

  it("без src (нет права на прямую ссылку) — прежний путь, как раньше", async () => {
    render(<MessageAttachments attachments={[{ kind: "image", mime: "image/jpeg", file: "b.jpg" }]} />);
    await vi.waitFor(() => expect(apiCalls).toEqual(["/attachments/b.jpg"]));
  });

  it("несохранённый файл — причина простыми словами и где открыть", () => {
    render(<MessageAttachments channel="WHATSAPP" attachments={[{ kind: "video", mime: "", file: null, lost: "too_big" }]} />);
    expect(screen.getByText("Клиент прислал видео — больше 16 МБ или длиннее 3 минут, в CRM не сохранилось. Откройте в WhatsApp")).toBeTruthy();
    expect(lostAttachmentText("image", "failed", "INSTAGRAM")).toBe("Клиент прислал фото — не скачалось, в CRM не сохранилось. Откройте в Instagram");
  });

  it("фото по ссылке не отдалось — вместо битой картинки спокойная плашка", () => {
    const { container } = render(<MessageAttachments attachments={[{ kind: "image", mime: "image/jpeg", file: null, url: "/uploads/none.jpg" }]} />);
    fireEvent.error(container.querySelector("img")!);
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText("Фото не загрузилось")).toBeTruthy();
  });
});
