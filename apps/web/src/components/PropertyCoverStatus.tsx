import { useRef } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Property } from "../types";
import { api } from "../lib/api";
import { useAuthStore } from "../store/auth";

/**
 * ОБЛОЖКА ОБЪЕКТА на карточке (25.09.2026, v2; 29.09.2026 — видно саму обложку
 * и можно заменить своей, владелец: «видеть и заменять если что»).
 *
 * Показывает квадрат и вертикаль, строку «обложка не создана: причина», кнопки
 * «Перерисовать обложку» (мимо кэша, заново) и «Заменить своей» (картинка с
 * устройства: квадрат, вертикаль или обе — недостающую сервер соберёт сам).
 * Своя обложка сразу уходит первой картинкой на сайт; в соцсети — со следующей
 * публикации: у уже вышедших постов площадки обложку не меняют.
 *
 * Права — как у публикации (маркетинг, директор, админ: requireMarketingRole
 * на сервере). Один компонент на оба вида карточки — PropertyDetail рендерит
 * его и на телефоне, и на компьютере. Идиома «Royal Home 2026»: `.quiet`, `.dot`, `.pill`.
 */
const PUBLISH_ROLES = new Set(["MARKETING", "DIRECTOR", "ADMIN"]);

export function PropertyCoverStatus({ property, readOnly }: { property: Property; readOnly: boolean }) {
  const role = useAuthStore((s) => s.agent?.role);
  const qc = useQueryClient();
  const squareRef = useRef<HTMLInputElement>(null);
  const storyRef = useRef<HTMLInputElement>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ["property"] });
  const regenerate = useMutation({
    // Генерация идёт до нескольких минут: две картинки, проверки, выбор лучшей.
    mutationFn: () =>
      api<{ squareUrl: string; storyUrl: string }>(`/properties/${property.id}/cover/regenerate`, {
        method: "POST",
        timeoutMs: 600_000,
      }),
    onSettled: refresh,
  });
  const replace = useMutation({
    mutationFn: (files: { square?: File; story?: File }) => {
      const form = new FormData();
      if (files.square) form.append("square", files.square);
      if (files.story) form.append("story", files.story);
      return api<{ squareUrl: string; storyUrl: string }>(`/properties/${property.id}/cover/upload`, {
        method: "POST",
        body: form,
        isForm: true,
      });
    },
    onSettled: refresh,
  });

  const canEdit = !readOnly && !!role && PUBLISH_ROLES.has(role);
  const error = property.socialCoverError;
  const hasCover = !!property.socialCoverSquareUrl;
  if (!error && !canEdit && !hasCover) return null;
  if (!error && !hasCover && !property.videoHandoffFinalPath && !canEdit) return null;

  const busy = regenerate.isPending || replace.isPending;
  const failure = regenerate.error ?? replace.error;
  const pick = (kind: "square" | "story") => (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (file) replace.mutate({ [kind]: file });
  };

  return (
    <div className="quiet" style={{ display: "flex", flexDirection: "column", gap: 8 }} role="status">
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span className={`dot${error ? " warn" : ""}`} />
        <span className="txt" style={{ flex: "1 1 200px", minWidth: 0, overflowWrap: "anywhere" }}>
          {regenerate.isPending
            ? "Рисуем обложку… до нескольких минут"
            : replace.isPending
              ? "Ставим вашу обложку…"
              : failure
                ? failure instanceof Error
                  ? failure.message
                  : "Обложка не создана"
                : error
                  ? `Обложка не создана: ${error}`
                  : hasCover
                    ? "Обложка для соцсетей"
                    : "Обложки пока нет"}
        </span>
      </div>

      {hasCover && (
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-start" }}>
          <a href={property.socialCoverSquareUrl!} target="_blank" rel="noreferrer">
            <img
              src={property.socialCoverSquareUrl!}
              alt="Обложка, квадрат"
              style={{ width: "min(46vw, 200px)", borderRadius: 12, display: "block" }}
            />
          </a>
          {property.socialCoverStoryUrl && (
            <a href={property.socialCoverStoryUrl} target="_blank" rel="noreferrer">
              <img
                src={property.socialCoverStoryUrl}
                alt="Обложка, вертикаль"
                style={{ width: "min(26vw, 113px)", borderRadius: 12, display: "block" }}
              />
            </a>
          )}
        </div>
      )}

      {canEdit && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button type="button" className="pill ghost sm" onClick={() => regenerate.mutate()} disabled={busy}>
            Перерисовать обложку
          </button>
          <button type="button" className="pill ghost sm" onClick={() => squareRef.current?.click()} disabled={busy}>
            Заменить квадрат
          </button>
          <button type="button" className="pill ghost sm" onClick={() => storyRef.current?.click()} disabled={busy}>
            Заменить вертикаль
          </button>
          <input ref={squareRef} type="file" accept="image/*" onChange={pick("square")} style={{ display: "none" }} />
          <input ref={storyRef} type="file" accept="image/*" onChange={pick("story")} style={{ display: "none" }} />
        </div>
      )}
      {canEdit && hasCover && (
        <span className="txt">
          На сайте новая обложка сразу; в соцсетях — со следующей публикации (у вышедших постов площадки обложку не
          меняют).
        </span>
      )}
    </div>
  );
}
