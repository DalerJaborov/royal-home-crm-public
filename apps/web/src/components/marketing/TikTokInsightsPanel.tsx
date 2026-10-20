import { Link } from "react-router-dom";
import { Eye, Heart, MessageCircle, Share2 } from "lucide-react";
import type { TikTokInsights } from "../../hooks/useMarketing";

/**
 * СТАТИСТИКА TIKTOK (23.09.2026) — аккаунт и ролики, экран «Маркетинг» →
 * вкладка «Каналы», под панелью подключения (ChannelsStatusPanel).
 *
 * Права на статистику (`user.info.profile`, `user.info.stats`, `video.list`)
 * ещё не одобрены TikTok — ревизия только подана, и до одобрения этот блок у
 * владельца честно пуст с объяснением, а не молчит и не падает. Разметка —
 * идиома `theme-2026-proto.css` соседней панели: `.card`/`.sec-t`/`.list`/
 * `.row`/`.chip`/`.quiet`.
 *
 * ОДНА панель на обе ширины — как и вся страница MarketingCenter.tsx, узкую
 * раскладку делают медиазапросы темы.
 */
function formatCount(n: number | null): string {
  return n === null ? "—" : n.toLocaleString("ru-RU");
}

function formatVideoDate(createTime: number | null): string {
  if (createTime === null) return "";
  return new Date(createTime * 1000).toLocaleDateString("ru-RU", { timeZone: "Asia/Dushanbe", day: "2-digit", month: "short", year: "numeric" });
}

export function TikTokInsightsPanel({ data }: { data: TikTokInsights | undefined }) {
  if (!data) {
    return (
      <div className="state" style={{ paddingTop: 0 }}>
        <span className="sk w40" />
        <span className="sk w22" /> Загружаем статистику TikTok
      </div>
    );
  }

  if (!data.available) {
    return (
      <div className="quiet" style={{ marginTop: 0 }}>
        <span className="dot" />
        <span className="txt">
          Статистика TikTok пока недоступна: {data.reason}.{" "}
          {data.missingScopes.length > 0
            ? "Появится, как только TikTok одобрит поданную ревизию приложения — тогда переподключать аккаунт не нужно."
            : ""}
        </span>
      </div>
    );
  }

  const { account, videos } = data;

  return (
    <>
      <div className="row" style={{ marginTop: 0 }}>
        <span className="av ring" aria-hidden="true">
          {account.avatarUrl ? <img src={account.avatarUrl} alt="" /> : (account.displayName ?? "TT").slice(0, 2)}
        </span>
        <div className="t">
          <b>{account.displayName ?? "TikTok"}</b>
          <span>
            {formatCount(account.followerCount)} подписчиков · {formatCount(account.likesCount)} лайков ·{" "}
            {formatCount(account.videoCount)} роликов
            {account.bioDescription ? ` · ${account.bioDescription}` : ""}
          </span>
        </div>
        {account.profileDeepLink && (
          <a className="pill ghost sm" href={account.profileDeepLink} target="_blank" rel="noreferrer">
            Открыть профиль
          </a>
        )}
      </div>

      {videos.length === 0 ? (
        <div className="empty">
          <p>Роликов на аккаунте пока нет.</p>
        </div>
      ) : (
        <div className="list" style={{ marginTop: 12 }}>
          {videos.map((v) => (
            <div className="row wrapt" key={v.id}>
              <span className="thumb" aria-hidden="true">
                {v.coverImageUrl && (
                  <img src={v.coverImageUrl} alt="" style={{ width: "100%", height: "100%", objectFit: "cover", borderRadius: "inherit" }} />
                )}
              </span>
              <div className="t">
                <b>
                  {v.shareUrl ? (
                    <a href={v.shareUrl} target="_blank" rel="noreferrer">
                      {v.title || v.videoDescription || "без названия"}
                    </a>
                  ) : (
                    v.title || v.videoDescription || "без названия"
                  )}
                </b>
                <span>
                  {formatVideoDate(v.createTime)}
                  {v.propertyId && (
                    <>
                      {" · "}
                      <Link className="lk" to={`/properties/${v.propertyId}`}>
                        карточка объекта
                      </Link>
                    </>
                  )}
                </span>
              </div>
              <div className="act" style={{ flexWrap: "wrap", justifyContent: "flex-end", gap: 12 }}>
                <span className="chip mute" title="Просмотры">
                  <Eye className="i" aria-hidden style={{ width: 14, height: 14 }} /> {formatCount(v.viewCount)}
                </span>
                <span className="chip mute" title="Лайки">
                  <Heart className="i" aria-hidden style={{ width: 14, height: 14 }} /> {formatCount(v.likeCount)}
                </span>
                <span className="chip mute" title="Комментарии">
                  <MessageCircle className="i" aria-hidden style={{ width: 14, height: 14 }} /> {formatCount(v.commentCount)}
                </span>
                <span className="chip mute" title="Репосты">
                  <Share2 className="i" aria-hidden style={{ width: 14, height: 14 }} /> {formatCount(v.shareCount)}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
