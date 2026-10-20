import { useState, type KeyboardEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { Clapperboard, Plus } from "lucide-react";
import {
  SOCIAL_VIDEO_STATUS_LABELS,
  destinationKeyOf,
  formatDurationRu,
  type SocialVideoChannelInfo,
  type SocialVideoItem,
} from "@royal-home/shared";
import "../social-videos.css";
import { useAuthStore } from "../store/auth";
import { MarketingTabs } from "../components/SectionTabs";
import { Rh2ErrorState } from "../components/rh2/Rh2ErrorState";
import { ChannelBadge } from "../components/socialVideos/ChannelBadge";
import { useSocialVideoChannels, useSocialVideoList, type SocialVideoTab } from "../hooks/useSocialVideos";
import { exactDateTime } from "../lib/format";
import { destinationLabel, destinationsOfItem, resultOfDestination } from "../lib/socialVideoDestinations";
import { Composer } from "./socialVideos/Composer";
import { VideoDetail } from "./socialVideos/VideoDetail";
import { SOCIAL_VIDEO_STATUS_CHIP, mediaSrc } from "./socialVideos/helpers";

/**
 * «РОЛИКИ В СОЦСЕТИ» (12.10.2026, владелец: «как мне самому добавить ролик из
 * CRM, чтобы он ушёл во все сети — обычный промо-ролик без объекта»).
 *
 * Один адаптивный экран с тремя видами: список, композитор (новый ролик или
 * правка черновика) и карточка ролика с ходом публикации по каналам. Вид держим
 * состоянием, а не маршрутами: композитору нужна свобода уходить к списку и
 * обратно, не теряя введённого. Доступ — маркетинг, директор, администратор
 * (совпадает с сервером: монтажёру `canSeeMarketing` пункт открыл бы, а сервер
 * ответил бы 403).
 */

type View = { kind: "list" } | { kind: "composer"; editId: string | null } | { kind: "detail"; id: string };

const PAGE_SIZE = 30;

const TABS: { key: SocialVideoTab; label: string }[] = [
  { key: "ALL", label: "Все" },
  { key: "DRAFT", label: "Черновики" },
  { key: "SCHEDULED", label: "По расписанию" },
  { key: "PUBLISHING", label: "Публикуются" },
  { key: "DONE", label: "Опубликовано" },
  { key: "ERRORS", label: "С ошибками" },
  { key: "REMOVED", label: "Снятые" },
];

/** Подпись времени под названием: когда выйдет, когда вышло или когда создан. */
function whenLine(item: SocialVideoItem): string {
  if (item.status === "SCHEDULED" && item.scheduledAt) return `Выйдет ${exactDateTime(item.scheduledAt)}`;
  if (item.finishedAt && (item.status === "DONE" || item.status === "PARTIAL" || item.status === "FAILED")) {
    return `${item.status === "FAILED" ? "Не вышло" : "Вышло"} ${exactDateTime(item.finishedAt)}`;
  }
  if (item.status === "REMOVED") return "Снят из соцсетей";
  if (item.status === "PUBLISHING" && item.startedAt) return `Начато ${exactDateTime(item.startedAt)}`;
  return `Создан ${exactDateTime(item.createdAt)}`;
}

function VideoRow({ item, infos, onOpen }: { item: SocialVideoItem; infos: SocialVideoChannelInfo[]; onOpen: () => void }) {
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onOpen();
    }
  };
  // Точки и счётчики — по АДРЕСАМ: два Instagram дают две плашки и два исхода.
  const destinations = destinationsOfItem(item);
  const failed = destinations.filter((d) => resultOfDestination(item.results, d)?.state === "FAILED").length;
  return (
    <div className="row wrapt" role="button" tabIndex={0} onClick={onOpen} onKeyDown={onKey}>
      <span
        aria-hidden="true"
        style={{
          flex: "none",
          width: 54,
          height: 96,
          borderRadius: "var(--r-md)",
          overflow: "hidden",
          background: "var(--track)",
          display: "grid",
          placeItems: "center",
        }}
      >
        {item.coverUrl ? (
          <img src={mediaSrc(item.coverUrl)} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
        ) : (
          // Кадр из самого ролика: #t=0.1 заставляет браузер показать первый кадр без воспроизведения.
          <video
            src={`${mediaSrc(item.videoPath)}#t=0.1`}
            preload="metadata"
            muted
            playsInline
            tabIndex={-1}
            style={{ width: "100%", height: "100%", objectFit: "cover" }}
          />
        )}
      </span>
      <div className="t">
        <b>{item.title}</b>
        <span>
          {whenLine(item)}
          {item.durationSec !== null ? ` · ${formatDurationRu(item.durationSec)}` : ""}
        </span>
        {destinations.length > 0 ? (
          <span style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 6 }}>
            {destinations.map((d) => (
              <ChannelBadge
                key={destinationKeyOf(d)}
                channel={d.channel}
                state={resultOfDestination(item.results, d)?.state}
                size={26}
                label={destinationLabel(d, infos)}
              />
            ))}
          </span>
        ) : (
          <span>Каналы не выбраны</span>
        )}
      </div>
      <span style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6 }}>
        <span className={SOCIAL_VIDEO_STATUS_CHIP[item.status]}>{SOCIAL_VIDEO_STATUS_LABELS[item.status]}</span>
        {failed > 0 && item.status !== "FAILED" && <span className="chip crit">Ошибок: {failed}</span>}
      </span>
    </div>
  );
}

export function SocialVideos() {
  const role = useAuthStore((s) => s.agent?.role);
  const canView = role === "MARKETING" || role === "DIRECTOR" || role === "ADMIN";
  const [params] = useSearchParams();
  // `?new=1` — сразу композитор; `?open=<id>` — сразу карточка ролика (ссылки из «Маркетинга»).
  const [view, setView] = useState<View>(() => {
    const openId = params.get("open");
    if (openId) return { kind: "detail", id: openId };
    return params.get("new") ? { kind: "composer", editId: null } : { kind: "list" };
  });
  const [tab, setTab] = useState<SocialVideoTab>("ALL");
  const [limit, setLimit] = useState(PAGE_SIZE);
  const list = useSocialVideoList(tab, limit, canView);
  const infos = useSocialVideoChannels(canView).data ?? [];

  if (!canView) {
    return (
      <div className="rh2 screens">
        <div className="scr">
          <div className="pg-h">
            <div>
              <h1>Ролики в соцсети</h1>
            </div>
          </div>
          <div className="card tight">
            <div className="empty">
              <p>Раздел доступен маркетингу, директору и администратору.</p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const toList = () => setView({ kind: "list" });

  if (view.kind === "composer") {
    return (
      <Composer
        editId={view.editId}
        onClose={toList}
        onPublished={(id) => setView({ kind: "detail", id })}
        onOpenVideo={(id) => setView({ kind: "detail", id })}
      />
    );
  }
  if (view.kind === "detail") {
    return <VideoDetail id={view.id} onBack={toList} onEdit={(id) => setView({ kind: "composer", editId: id })} />;
  }

  const counts = list.counts;
  const countOf: Record<SocialVideoTab, number | null> = {
    ALL: counts ? Object.values(counts).reduce((sum, n) => sum + n, 0) : null,
    DRAFT: counts?.DRAFT ?? null,
    SCHEDULED: counts?.SCHEDULED ?? null,
    PUBLISHING: counts?.PUBLISHING ?? null,
    DONE: counts?.DONE ?? null,
    ERRORS: counts ? counts.PARTIAL + counts.FAILED : null,
    REMOVED: counts?.REMOVED ?? null,
  };
  const nothingAtAll = countOf.ALL === 0;

  const changeTab = (next: SocialVideoTab) => {
    setTab(next);
    setLimit(PAGE_SIZE);
  };

  return (
    <div className="rh2 screens">
      <div className="scr">
        <div className="pg-h">
          <div>
            <h1>Ролики в соцсети</h1>
            <p className="sub">
              Промо-ролик без объекта: загрузите, опишите своими словами — ИИ напишет подписи, а вы выберете сети и
              время. Здесь же видно, как идёт публикация и где случилась ошибка.
            </p>
          </div>
          <div className="acts">
            <button className="pill" type="button" onClick={() => setView({ kind: "composer", editId: null })}>
              <Plus className="i" aria-hidden />
              Новый ролик
            </button>
          </div>
        </div>

        <MarketingTabs />

        <div className="hscroll">
          <div className="stg sv-tabs" role="tablist" aria-label="Статусы роликов">
            {TABS.map((t) => (
              <button key={t.key} type="button" role="tab" aria-selected={tab === t.key} onClick={() => changeTab(t.key)}>
                <span>{t.label}</span>
                <b>{countOf[t.key] ?? "—"}</b>
              </button>
            ))}
          </div>
        </div>

        <section className="card" style={{ marginTop: 16 }}>
          {list.isLoading && list.items.length === 0 ? (
            <div className="state">
              <span className="sk av" />
              <span className="sk w40" />
              <span className="sk w22" /> Загружаем ролики
            </div>
          ) : list.isError && list.items.length === 0 ? (
            <Rh2ErrorState message={list.error?.message || "Не удалось загрузить ролики."} onRetry={() => void list.refetch()} />
          ) : nothingAtAll && tab === "ALL" ? (
            <div className="empty">
              <span className="ic">
                <Clapperboard className="i" aria-hidden />
              </span>
              <p>
                Роликов пока нет. Загрузите первый — он уйдёт в Instagram, Facebook, YouTube, TikTok, Telegram и
                Threads, куда вы укажете.
              </p>
              <button className="pill" type="button" onClick={() => setView({ kind: "composer", editId: null })}>
                <Plus className="i" aria-hidden />
                Загрузить первый ролик
              </button>
            </div>
          ) : list.items.length === 0 ? (
            <div className="empty">
              <span className="ic">
                <Clapperboard className="i" aria-hidden />
              </span>
              <p>В этой вкладке пока пусто.</p>
            </div>
          ) : (
            <>
              <div className="list">
                {list.items.map((item) => (
                  <VideoRow key={item.id} item={item} infos={infos} onOpen={() => setView({ kind: "detail", id: item.id })} />
                ))}
              </div>
              {list.items.length < list.total && (
                <div className="acts" style={{ marginTop: 12, justifyContent: "center" }}>
                  <button className="pill ghost" type="button" onClick={() => setLimit((n) => n + PAGE_SIZE)}>
                    Показать ещё
                  </button>
                </div>
              )}
            </>
          )}
        </section>
      </div>
    </div>
  );
}
