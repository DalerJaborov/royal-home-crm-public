import { describe, expect, it } from "vitest";
import React from "react";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { QueueStages } from "../MarketingCenter";

/**
 * Аудит 04.10.2026, WEB-PAGES18: «Очередь пуста» скрывала вкладки стадий, и к
 * «Ждут публикации» нельзя было перейти, хотя недавно выпущенные объекты есть.
 */
const render = (props: Partial<React.ComponentProps<typeof QueueStages>>) =>
  renderToString(
    <MemoryRouter>
      <QueueStages
        items={[]}
        listState={null}
        pager={null}
        summary={{ awaitingReview: 0, awaitingPhotos: 0, awaitingVideo: 0, editing: 0 }}
        stage="PENDING_REVIEW"
        onStage={() => {}}
        queueEmpty
        recentlyPublished={{ total: 10, windowDays: 7, items: [] } as never}
        publishedItems={[]}
        publishedPager={null}
        {...props}
      />
    </MemoryRouter>,
  );

describe("QueueStages: пустой конвейер", () => {
  it("вкладки стадий остаются, включая «Ждут публикации» со своим счётчиком", () => {
    const html = render({});
    expect(html).toContain("Ждут публикации");
    expect(html).toContain("<b>10</b>");
    expect(html).toContain("Очередь пуста");
  });

  it("пока сводка не пришла или упала, «Очередь пуста» не утверждается", () => {
    const html = render({ queueEmpty: false, summary: undefined });
    expect(html).not.toContain("Очередь пуста");
    expect(html).toContain("Ждут публикации");
  });

  it("ошибка списка показывается вместо списка, вкладки на месте", () => {
    const html = render({ queueEmpty: false, listState: <div>ОШИБКА-ЗАГРУЗКИ</div> });
    expect(html).toContain("ОШИБКА-ЗАГРУЗКИ");
    expect(html).toContain("Ждут фото");
  });
});
