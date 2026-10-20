import type { ChannelsStatus } from "../../hooks/useMarketing";

/**
 * Панель «Каналы публикации» (01.09.2026) — единый экран статуса
 * автопубликации, собранный по прямой просьбе владельца после разбора: раньше
 * состояние каждого канала было видно только по отдельности (Настройки →
 * Каналы связи, «Здоровье системы»), а «подключено ли всё и работает ли как
 * единая платформа» не отвечал ни один экран. Ничего не решает и не
 * переключает сама — только показывает, что уже собрано в
 * routes/marketing.ts → GET /channels-status.
 *
 * ОДНА на обе ширины: `pages/MarketingCenter.tsx` — единственный экран
 * «Маркетинг», узкую раскладку делают медиазапросы темы (сетка эталона
 * `.chn-grid` сама складывается в одну колонку). Отдельным модулем, а не
 * частью страницы, — чтобы не разрастать и без того длинный файл экрана.
 */

/**
 * Строка канала: точка-статус + подпись + необязательное примечание.
 * Три состояния, не два: "on" (зелёная, работает), "off" (серая, есть, но
 * выключено рубильником), "missing" (красная — подключать нечему, ключей/адреса
 * нет вовсе). Разница важна: выключенный канал владелец решил выключить сам,
 * а незаполненный — забыл или не успел подключить.
 */
function ChannelRow({ state, label, note }: { state: "on" | "off" | "missing"; label: string; note?: string }) {
  return (
    <div className="cl">
      <span className={state === "on" ? "dot ok" : state === "missing" ? "dot crit" : "dot"} />
      <span className="tx">
        {label}
        {note && <small className={state === "missing" ? "crit" : undefined}>{note}</small>}
      </span>
    </div>
  );
}

export function ChannelsStatusPanel({ data }: { data: ChannelsStatus | undefined }) {
  if (!data) {
    return (
      <div className="state">
        <span className="sk w40" />
        <span className="sk w22" /> Загружаем состояние каналов
      </div>
    );
  }
  const { channels } = data;

  return (
    <>
      <div className="quiet">
        <span className={data.autoPublishEnabled ? "dot ok" : "dot"} />
        <span className="txt">
          {data.autoPublishEnabled
            ? "Автопубликация после одобрения включена: объект уходит в каналы сам, как только монтажёр сдал работу."
            : "Автопубликация после одобрения выключена: объект уходит в каналы только вручную."}
        </span>
      </div>
      {data.openErrors > 0 && (
        <div className="quiet crit">
          <span className="dot crit" />
          <span className="txt">
            Открытых ошибок каналов: {data.openErrors}. Опубликовано объектов: {data.publishedCount}.
          </span>
        </div>
      )}

      <div className="chn-grid" style={{ marginTop: 16 }}>
        <div className="chn">
          <h3>
            Instagram <span className="n">{channels.INSTAGRAM.connected ? "подключён" : "не подключён"}</span>
          </h3>
          <ChannelRow
            state={channels.INSTAGRAM.connected ? "on" : "missing"}
            label="Публикация роликов"
            note={channels.INSTAGRAM.connected ? "токен подключён" : "нет токена (Настройки → Каналы связи)"}
          />
          <ChannelRow
            state={!channels.INSTAGRAM.connected ? "missing" : channels.INSTAGRAM.botEnabled ? "on" : "off"}
            label="Бот отвечает в переписке"
          />
          <ChannelRow
            state={!channels.INSTAGRAM.connected ? "missing" : channels.INSTAGRAM.commentsEnabled ? "on" : "off"}
            label="Бот отвечает на комментарии"
          />
        </div>

        <div className="chn">
          <h3>
            Facebook <span className="n">{channels.FACEBOOK.connected ? "подключён" : "не подключён"}</span>
          </h3>
          <ChannelRow
            state={channels.FACEBOOK.connected ? "on" : "missing"}
            label="Публикация видео на Странице"
            note={channels.FACEBOOK.connected ? "токен и ID страницы подключены" : "нет токена или ID страницы"}
          />
          <ChannelRow
            state={!channels.FACEBOOK.connected ? "missing" : channels.FACEBOOK.botEnabled ? "on" : "off"}
            label="Бот отвечает в переписке"
          />
        </div>

        <div className="chn">
          <h3>
            Telegram <span className="n">{channels.TELEGRAM.crosspostConnected ? "подключён" : "не подключён"}</span>
          </h3>
          <ChannelRow
            state={channels.TELEGRAM.crosspostConnected ? "on" : "missing"}
            label="Кросспост в канал"
            note={channels.TELEGRAM.crosspostConnected ? "номер канала задан" : "номер канала не задан"}
          />
          <ChannelRow
            state={
              !channels.TELEGRAM.commentsConnected
                ? "missing"
                : channels.TELEGRAM.commentsEnabled
                  ? "on"
                  : "off"
            }
            label="Бот отвечает на комментарии в обсуждении"
            note={channels.TELEGRAM.commentsConnected ? undefined : "группа-обсуждение не подключена"}
          />
          <ChannelRow state={channels.TELEGRAM.botEnabled ? "on" : "off"} label="Бот отвечает в личных сообщениях" />
          <ChannelRow
            state={channels.TELEGRAM.directMessagesEnabled ? "on" : "off"}
            label="Бот отвечает тем, кто пишет каналу напрямую (Direct Messages)"
          />
        </div>

        <div className="chn">
          <h3>
            YouTube Shorts <span className="n">{channels.YOUTUBE.connected ? "подключён" : "не подключён"}</span>
          </h3>
          <ChannelRow
            state={channels.YOUTUBE.connected ? "on" : "missing"}
            label="Публикация Shorts"
            note={channels.YOUTUBE.connected ? "ключи подключены" : "нет ключей OAuth (Настройки → Каналы связи)"}
          />
        </div>
      </div>

      <div className="chn">
        <h3>
          TikTok <span className="n">{channels.TIKTOK.connected ? `подключён${channels.TIKTOK.username ? ` (@${channels.TIKTOK.username})` : ""}` : "не подключён"}</span>
        </h3>
        <ChannelRow
          state={channels.TIKTOK.connected ? "on" : "missing"}
          label="Публикация видео"
          note={channels.TIKTOK.connected ? "аккаунт подключён" : "нет аккаунта (Настройки → Каналы связи)"}
        />
      </div>

      <div className="quiet" style={{ marginTop: 16 }}>
        <span className="dot" />
        <span className="txt">
          До прохождения ревью приложения TikTok (подаёт владелец, обычно 1-2 недели) публикации уходят только с
          уровнем приватности «Только я» — это ограничение самого TikTok, не настройки CRM. Комментарии под постами
          TikTok не отдаёт по API вообще — ни читать, ни отвечать.
        </span>
      </div>

      <div className="chn">
        <h3>
          Threads{" "}
          <span className="n">
            {channels.THREADS.connected ? `подключён${channels.THREADS.username ? ` (@${channels.THREADS.username})` : ""}` : "не подключён"}
          </span>
        </h3>
        <ChannelRow
          state={channels.THREADS.connected ? "on" : "missing"}
          label="Публикация постов"
          note={channels.THREADS.connected ? "аккаунт подключён" : "нет аккаунта (Настройки → Каналы связи)"}
        />
      </div>

      <div className="quiet" style={{ marginTop: 16 }}>
        <span className="dot" />
        <span className="txt">
          До прохождения ревью приложения Threads публиковать можно только от аккаунтов, добавленных «Threads
          testers» в Meta App Dashboard — это ограничение самой площадки, не настройки CRM.
        </span>
      </div>
    </>
  );
}
