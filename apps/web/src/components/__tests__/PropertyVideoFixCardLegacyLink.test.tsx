import { describe, it, expect, vi } from "vitest";
import React from "react";
import { renderToString } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PropertyVideoFixCard } from "../PropertyVideoFixCard";
import type { Property } from "../../types";

/**
 * Старый объект, у которого от ролика осталась одна ссылка в поле «Instagram» (t.me,
 * YouTube…), а список сетей и готовый ролик пусты (07.10.2026, ОБ-000082). Правка #1091
 * лечила только ссылку на instagram.com (она превращается в канал INSTAGRAM); остальные
 * адреса карточка считала «роликом нет» и сворачивала блок до историй — без «Вернуть
 * монтажёру», загрузки готового ролика и подсказки, где лежит старый пост.
 */
const auth = vi.hoisted(() => ({ role: "ADMIN" as string }));
vi.mock("../../store/auth", () => ({
  useAuthStore: <T,>(select: (s: { agent: { id: string; role: string } }) => T) => select({ agent: { id: "a1", role: auth.role } }),
}));

const legacy = {
  id: "p82",
  shortId: 82,
  type: "APARTMENT",
  status: "AVAILABLE",
  publishedChannels: [],
  videoHandoffStatus: "NONE",
  videoHandoffFinalPath: null,
  instagramUrl: "https://t.me/royalhome_tj/123",
} as unknown as Property;

function render(role: string, p: Property) {
  auth.role = role;
  return renderToString(
    <QueryClientProvider client={new QueryClient()}>
      <PropertyVideoFixCard property={p} canEdit />
    </QueryClientProvider>
  );
}

describe("PropertyVideoFixCard — старый объект со ссылкой t.me и без сетей", () => {
  it("закрытый объект не предлагает новую публикацию, сохраняя снятие старых постов", () => {
    const html = render("ADMIN", { ...legacy, offSite: true, publishedChannels: ["INSTAGRAM"] });
    expect(html).toContain("новые публикации в соцсетях запрещены");
    expect(html).not.toContain("Выложить карточку");
    expect(html).not.toContain("Загрузить и выпустить сразу");
    expect(html).not.toContain("По расписанию");
    expect(html).toContain("Убрать из соцсетей");
  });
  it("руководителю виден полный блок: «Вернуть монтажёру», «Загрузить готовый ролик», ссылка на старый пост", () => {
    const html = render("ADMIN", legacy);
    expect(html).toContain("Ролик и соцсети");
    expect(html).toContain("Вернуть монтажёру");
    expect(html).toContain("Загрузить готовый ролик");
    expect(html).toContain('href="https://t.me/royalhome_tj/123"');
    expect(html).toContain("Ролик выложен вручную");
  });

  it("агенту (canEdit) — «Вернуть монтажёру» и загрузка тоже есть, без кнопок маркетинга", () => {
    const html = render("AGENT", legacy);
    expect(html).toContain("Вернуть монтажёру");
    expect(html).toContain("Загрузить готовый ролик");
    expect(html).not.toContain("Опубликовать сейчас");
  });

  it("сеть за ссылкой не выдумывается: «Убрать из соцсетей» видна, но нажать нечего", () => {
    const html = render("ADMIN", legacy);
    expect(html).toContain("Убрать из соцсетей");
    expect(html).toContain("снимать нечего");
  });

  it("не-адрес в поле выводится текстом, а не ссылкой", () => {
    const html = render("ADMIN", { ...legacy, instagramUrl: "javascript:alert(1)" } as unknown as Property);
    expect(html).not.toContain('href="javascript:');
    expect(html).toContain("javascript:alert(1)");
  });

  it("пустая ссылка, нет сетей и ролика (как у старого объекта) — все кнопки на месте, у любой роли с правом правки", () => {
    for (const role of ["AGENT", "ADMIN", "DIRECTOR", "MARKETING"]) {
      const html = render(role, { ...legacy, instagramUrl: null } as unknown as Property);
      expect(html, role).toContain("Ролик и соцсети");
      expect(html, role).toContain("Вернуть монтажёру");
      expect(html, role).toContain("Загрузить готовый ролик");
      expect(html, role).toContain("Обновить подписи");
    }
    // Те, кому можно снимать посты и выкладывать истории, видят и эти кнопки.
    const admin = render("ADMIN", { ...legacy, instagramUrl: null } as unknown as Property);
    expect(admin).toContain("Убрать из соцсетей");
    expect(admin).toContain("Карточку объекта в истории");
  });

  it("новый объект в конвейере (ждёт видео) тоже рисует блок", () => {
    const html = render("ADMIN", { ...legacy, instagramUrl: null, status: "AWAITING_VIDEO" } as unknown as Property);
    expect(html).toContain("Ролик и соцсети");
  });

  it("объект в корзине (readOnly) блок не рисует", () => {
    auth.role = "ADMIN";
    const html = renderToString(
      <QueryClientProvider client={new QueryClient()}>
        <PropertyVideoFixCard property={legacy} readOnly canEdit />
      </QueryClientProvider>
    );
    expect(html).toBe("");
  });
});
