import { describe, expect, it } from "vitest";
import React from "react";
import { renderToString } from "react-dom/server";
import { galleryDots } from "../galleryDots";
import { propertyStageChip } from "../propertyStageChip";
import { videoStageLine } from "../propertyVideoStage";
import { PropertyGallery } from "../../components/property/PropertyGallery";
import type { Property, PropertyPhoto } from "../../types";

/**
 * Карточка объекта как объявление (контракт 06.10.2026, раздел 6): этап ролика с
 * сервера, один чип этапа, галерея без потолка на восьмом кадре.
 */
const vh = (over: Record<string, unknown>) =>
  ({
    status: "SENT_TO_EDITOR",
    queuePosition: null,
    heldAt: null,
    holdReason: null,
    sentAt: "2026-10-03T08:00:00.000Z",
    receivedAt: null,
    montajer: { id: "m1", fullName: "Азиз" },
    clipReview: { status: "NONE" },
    ...over,
  }) as unknown as NonNullable<Property["videoHandoff"]>;

describe("этап ролика — только с сервера", () => {
  it("у монтажёра: «На монтаже с 3 октября · монтажёр Азиз»", () => {
    const line = videoStageLine({ status: "EDITING", videoHandoff: vh({}), videoCount: 0, offSite: false });
    expect(line).toEqual({ tone: "lav", text: "На монтаже с 3 октября · монтажёр Азиз" });
  });

  it("право править не участвует: этап «ждём сырое видео» только у объекта в этом этапе", () => {
    expect(videoStageLine({ status: "AWAITING_VIDEO", videoHandoff: null, videoCount: 0, offSite: false })?.text).toBe(
      "Ждём сырое видео от агента",
    );
    expect(videoStageLine({ status: "AVAILABLE", videoHandoff: null, videoCount: 0, offSite: false })).toBeNull();
    expect(videoStageLine({ status: "AWAITING_VIDEO", videoHandoff: null, videoCount: 0, offSite: true })).toBeNull();
  });

  it("на монтаже плашки «ждём сырое видео» нет, даже если сырых роликов 0", () => {
    const line = videoStageLine({ status: "AWAITING_VIDEO", videoHandoff: vh({}), videoCount: 0, offSite: false });
    expect(line?.text).not.toContain("Ждём сырое видео");
  });

  it("очередь, пауза, готово, снят с монтажа", () => {
    expect(videoStageLine({ status: "EDITING", videoHandoff: vh({ status: "QUEUED", queuePosition: 3 }), videoCount: 1, offSite: false })?.text).toBe(
      "В очереди на монтаж, перед ним 2",
    );
    expect(
      videoStageLine({ status: "EDITING", videoHandoff: vh({ status: "QUEUED", heldAt: "2026-10-04T00:00:00Z", holdReason: "нет звука" }), videoCount: 1, offSite: false }),
    ).toEqual({ tone: "warn", text: "Монтаж отложен: нет звука" });
    expect(
      videoStageLine({ status: "AVAILABLE", videoHandoff: vh({ status: "RECEIVED", receivedAt: "2026-10-05T09:00:00Z" }), videoCount: 0, offSite: false }),
    ).toEqual({ tone: "ok", text: "Ролик готов, получен 5 октября" });
    expect(videoStageLine({ status: "AVAILABLE", videoHandoff: vh({ status: "RECEIVED" }), videoCount: 0, offSite: false })?.text).toBe("Снят с монтажа");
  });
});

describe("один чип этапа", () => {
  const base = { videoHandoffFinalPath: null, scheduledPublishAt: null, videoHandoffStatus: null, publishedChannels: [] };
  it("монтаж красится лавандой, а не тревогой; красный только за просрочку", () => {
    expect(propertyStageChip({ ...base, status: "EDITING", pipeline: { inPipeline: true, daysInStage: 3, overdue: false } } as never).tone).toBe("lav");
    expect(propertyStageChip({ ...base, status: "EDITING", pipeline: { inPipeline: true, daysInStage: 9, overdue: true } } as never).tone).toBe("crit");
    expect(propertyStageChip({ ...base, status: "AVAILABLE", pipeline: null } as never)).toEqual({ tone: "ok", label: "В продаже" });
  });
});

describe("галерея без потолка", () => {
  it("активная точка всегда на текущем кадре, окно сдвигается, кадров может быть сколько угодно", () => {
    for (const current of [0, 7, 8, 9, 13, 39]) {
      const dots = galleryDots(current, 40);
      expect(dots.length).toBeLessThanOrEqual(7);
      expect(dots.filter((d) => d.active).map((d) => d.index)).toEqual([current]);
    }
    expect(galleryDots(0, 3).map((d) => d.index)).toEqual([0, 1, 2]);
    expect(galleryDots(5, 0)).toEqual([]);
  });

  const photos = Array.from({ length: 14 }, (_, i) => ({ id: `p${i}`, url: `/u/${i}.jpg`, thumbUrl: `/t/${i}.jpg`, order: i }) as PropertyPhoto);

  it("одна галерея на экран, счётчик «1 / 14», снимков больше восьми", () => {
    const html = renderToString(<PropertyGallery photos={photos} />).replace(/<!-- -->/g, "");
    expect(html.match(/data-testid="gallery"/g)).toHaveLength(1);
    expect(html).toContain("1 / 14");
    expect(html.match(/rh-gallery-slide/g)).toHaveLength(14);
  });

  it("без фото — заглушка, а не пустая лента", () => {
    const html = renderToString(<PropertyGallery photos={[]} />);
    expect(html).toContain('data-testid="gallery"');
    expect(html).toContain("Фотографий пока нет");
    expect(html).not.toContain("rh-gallery-track");
  });
});
