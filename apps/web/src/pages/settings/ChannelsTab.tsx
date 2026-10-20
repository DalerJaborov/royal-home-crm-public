import { useEffect, useRef, useState } from "react";
import { GEMINI_VOICES, voiceGenderLabel } from "@royal-home/shared";
import { api } from "../../lib/api";
import { dushanbeDate, dushanbeDayKey, dushanbeTime, dushanbeTodayKey } from "../../lib/date";
import { MessengerAccounts } from "./MessengerAccounts";
import { useSearchParams } from "react-router-dom";
import {
  AtSign,
  CalendarClock,
  Clapperboard,
  Megaphone,
  MessageSquare,
  Music2,
  PhoneCall,
  PhoneIncoming,
  Send,
  Server,
  Volume2,
  Youtube,
} from "lucide-react";
import {
  useSettings,
  useUpdateSettings,
  useTestAsteriskConnection,
  useTestInstagramInsights,
  useTestAsteriskAmi,
  useTelephonyAudioStatus,
  useStationTraffic,
  useRotateMetaCatalogFeedKey,
} from "../../hooks/useSettings";
import { useMetaCatalogFeedStatus } from "../../hooks/useMarketing";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { SwitchRow } from "../../components/Switch";
import { SettingsSection, SettingsGroupLabel } from "../../components/settings/SettingsSection";
import { pcmBase64ToWavUrl } from "../../lib/pcmToWav";
import { SecretKeyEditor } from "../../components/SecretKeyEditor";
import { useAgents } from "../../hooks/useAgents";
import { useConnectAds, useDisconnectAds } from "../../hooks/useAds";
import { useConnectTikTok, useDisconnectTikTok, useTikTokCreatorInfo } from "../../hooks/useTikTok";
import { useConnectThreads, useDisconnectThreads, useThreadsProfile } from "../../hooks/useThreads";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { consultantInboundState, CONSULTANT_BLOCKED_NOTE, CONSULTANT_OVERRIDES_NOTE } from "../../lib/consultantInbound";

/**
 * Вкладка «Каналы связи» — через что CRM разговаривает с клиентами и отвечает
 * ли на сообщения бот.
 *
 * Раньше оба рубильника жили внутри карточки «ИИ (Anthropic API)». Логика была
 * техническая — «это же про бота», — а искали их как «где включить Instagram»,
 * то есть по каналу, а не по модели. Ключи ИИ остались в своей вкладке: они про
 * то, чем бот думает, а не про то, куда он пишет.
 *
 * Разметка — эталон темы «Royal Home 2026» (screens/settings.html, раздел
 * «Каналы связи», и screens/settings-bot.html — идиома длинной вкладки):
 * подписи групп `.grp-lab`, разделы-складки `.acc` (SettingsSection), внутри
 * строки `.mod` с тумблером `.tgl`, ключи — строки `.key-row` с маской `.msk`,
 * поля — `.fld` с подписью `.lab`, развилки — капсулы `.seg`, пояснения и
 * предупреждения — тихие строки `.quiet`, без карточек-уведомлений.
 *
 * Порядок разделов и состав настроек не менялись: длинное полотно разложено по
 * складкам, каждая настройка осталась на своём месте внутри своей темы.
 */
/** Как называть каналы Meta в интерфейсе — коды приходят с сервера как есть. */
const CHANNEL_NAMES: Record<string, string> = {
  WHATSAPP: "WhatsApp",
  INSTAGRAM: "Instagram",
  FACEBOOK: "Messenger",
};

import { OpenAiCoversSection } from "./OpenAiCoversSection";

export function ChannelsTab({ area }: { area?: "messengers" | "publishing" | "advertising" | "phone" } = {}) {
  const { data: settings } = useSettings();
  const updateSettings = useUpdateSettings();
  // silent: SecretKeyEditor ниже сам показывает «Ключ сохранён»/ошибку под полем —
  // отдельный инстанс хука, чтобы общий тост остался у тумблеров и обычных полей рядом.
  const updateSecretKey = useUpdateSettings({ silent: true });
  const [searchParams, setSearchParams] = useSearchParams();
  const readyChannels = settings?.metaChannelsConfigured ?? [];

  const botEnabled = settings?.botEnabled ?? true;
  const metaEnabled = settings?.metaEnabled ?? false;
  const metaConfigured = settings?.metaConfigured ?? false;
  const metaAdsEnabled = settings?.metaAdsEnabled ?? false;
  const connectAds = useConnectAds();
  const disconnectAds = useDisconnectAds();
  /** Facebook вернул человека сюда с результатом — показываем его словами. */
  const adsResult = searchParams.get("ads");
  const adsNotice =
    adsResult === "connected"
      ? { tone: "ok" as const, text: "Кабинет подключён — маркер получен и сохранён." }
      : adsResult === "cancelled"
        ? { tone: "ok" as const, text: "Подключение отменено — в Facebook не подтвердили доступ." }
        : adsResult === "error"
          ? { tone: "error" as const, text: searchParams.get("message") || "Не удалось подключить кабинет." }
          : null;
  const adsSyncedAt = settings?.metaAdsSyncedAt
    ? new Date(settings.metaAdsSyncedAt).toLocaleString("ru-RU", { timeZone: "Asia/Dushanbe", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })
    : null;

  return (
    <>
      {/* Обложки (28.09.2026): переключатель «наш шаблон | ChatGPT»; при шаблоне
          раздел сам показывает список шаблонов (CoverTemplatesSection). */}
      {(!area || area === "publishing") && <OpenAiCoversSection templateHeading={area ? "Шаблоны обложек" : undefined} />}
      {(!area || area === "messengers") && <>
      <SettingsGroupLabel>Мессенджеры</SettingsGroupLabel>

      <SettingsSection
        icon={MessageSquare}
        title="WhatsApp, Instagram и Messenger через Meta"
        badge={
          metaEnabled
            ? readyChannels.length > 0
              ? `работают: ${readyChannels.map((c) => CHANNEL_NAMES[c]).join(", ")}`
              : "включено"
            : "выключено"
        }
        defaultOpen
      >
        {/* Рубильник бота переехал во вкладку «Бот» — вместе с промтом, паузами и
            напоминаниями. Здесь остались каналы: через что CRM разговаривает с
            клиентами и какими ключами. Две копии одного тумблера в разных вкладках
            сбивают с толку сильнее, чем один переход по ссылке. */}
        <div className="quiet">
          <span className={botEnabled ? "dot ok" : "dot warn"} />
          <span className="txt">
            {botEnabled ? "Бот сейчас включён" : "Бот сейчас выключен — сообщения копятся, ответов нет"}. Рубильник
            бота, его промт и напоминания — во вкладке «Помощник».
          </span>
          <button className="lnk" type="button" onClick={() => setSearchParams({ tab: "bot" }, { replace: true })}>
            Открыть
          </button>
        </div>

        <SwitchRow
          title="Отвечать через Meta"
          on={metaEnabled}
          onToggle={() => updateSettings.mutate({ metaEnabled: !metaEnabled })}
          hint={
            metaEnabled
              ? readyChannels.length > 0
                ? `Работают: ${readyChannels.map((c) => CHANNEL_NAMES[c]).join(", ")}.`
                : "Сообщения приходят в «Сообщения» напрямую, без посредника."
              : "Переписки не приходят и не уходят. Включать после того, как вебхук подтверждён в панели Meta и подключён хотя бы один канал."
          }
          warning={
            metaEnabled && !metaConfigured
              ? "Заполнены не все ключи ниже: нужны секрет приложения, проверочная строка и хотя бы один канал — WhatsApp (маркер вместе с номером), Instagram (аккаунт в списке или маркер) или Страница Facebook (маркер вместе с её идентификатором)."
              : null
          }
        />

        {/* Ключи Meta — здесь же, рядом с рубильником. Раньше их надо было вписывать
            в файл на сервере по SSH: для владельца это непроходимый шаг, а ключи
            Claude и Gemini давно вводятся прямо в CRM — теперь и эти так же. */}
        <div className="grp-lab">Ключи Meta</div>
        <div className="quiet">
          <span className="dot crit" />
          <span className="txt">
            Берутся в панели Meta for Developers. Хранятся в базе зашифрованными и наружу больше не показываются,
            только последние символы.
          </span>
        </div>

        <SecretKeyEditor
          title="Секрет приложения"
          description="Настройки приложения → Основное → «Секрет приложения». Им Meta подписывает каждое входящее сообщение — без него мы не отличим настоящий вебхук от подделки."
          placeholder="Секрет приложения из панели Meta"
          configured={settings ? !!settings.metaAppSecretMasked : undefined}
          masked={settings?.metaAppSecretMasked}
          source={settings?.metaAppSecretSource}
          onSave={(v) => updateSecretKey.mutateAsync({ metaAppSecret: v })}
          onClear={() => updateSecretKey.mutateAsync({ metaAppSecret: "" })}
        />

        <SecretKeyEditor
          title="Проверочная строка вебхука"
          description="Придумывается вами и вписывается в двух местах: здесь и в панели Meta при подключении вебхука. Значения должны совпасть, иначе Meta не примет адрес."
          placeholder="Например: rh-meta-…"
          configured={settings ? !!settings.metaVerifyTokenMasked : undefined}
          masked={settings?.metaVerifyTokenMasked}
          source={settings?.metaVerifyTokenSource}
          onSave={(v) => updateSecretKey.mutateAsync({ metaVerifyToken: v })}
          onClear={() => updateSecretKey.mutateAsync({ metaVerifyToken: "" })}
        />

        <SecretKeyEditor
          title="Маркер доступа WhatsApp"
          description="WhatsApp → «Шаг 1. Попробуйте» → «Сгенерировать маркер». Временный живёт сутки; для постоянной работы нужен маркер системного пользователя."
          placeholder="Маркер доступа"
          configured={settings ? !!settings.metaWaTokenMasked : undefined}
          masked={settings?.metaWaTokenMasked}
          source={settings?.metaWaTokenSource}
          onSave={(v) => updateSecretKey.mutateAsync({ metaWaToken: v })}
          onClear={() => updateSecretKey.mutateAsync({ metaWaToken: "" })}
        />

        <PlainSetting
          title="Идентификатор номера WhatsApp"
          description="Phone Number ID с той же страницы. Не секрет — просто номер отправителя."
          placeholder="1129773893562843"
          value={settings?.metaWaPhoneId ?? ""}
          pending={updateSettings.isPending}
          onSave={(v) => updateSettings.mutate({ metaWaPhoneId: v })}
        />

        {/* Список аккаунтов — над одиночным маркером: он теперь запасной путь
            для тех, кто ещё не завёл аккаунты списком. */}
        <MessengerAccounts />

        <SecretKeyEditor
          title="Маркер Instagram"
          description="ЗАПАСНОЙ путь: пока в списке «Аккаунты Instagram» выше есть основной аккаунт с маркером, работа идёт по ЕГО маркеру, а это поле не используется — перевыпущенный маркер вписывать в аккаунт, кнопкой с ключом. Само поле: Instagram → «Настройка API для входа в Instagram» → «Сгенерировать маркер». Показывается один раз."
          placeholder="Маркер доступа Instagram"
          configured={settings ? !!settings.metaIgTokenMasked : undefined}
          masked={settings?.metaIgTokenMasked}
          source={settings?.metaIgTokenSource}
          onSave={(v) => updateSecretKey.mutateAsync({ metaIgToken: v })}
          onClear={() => updateSecretKey.mutateAsync({ metaIgToken: "" })}
        />

        <InstagramInsightsTestButton configured={!!settings?.metaIgTokenAvailable} />

        <SecretKeyEditor
          title="Маркер удаления Instagram"
          description="Отдельный от маркера переписки выше — тот ходит на graph.instagram.com и удалять не умеет вовсе. Этот получается через Facebook Login (не «Настройка API для входа в Instagram»): права instagram_basic + instagram_manage_contents, Standard access без App Review. Не задан — «Убрать из соцсетей» по-прежнему оставляет Instagram в ручном списке, как раньше."
          placeholder="Маркер доступа (Facebook Login)"
          configured={settings ? !!settings.metaIgManageTokenMasked : undefined}
          masked={settings?.metaIgManageTokenMasked}
          source={settings?.metaIgManageTokenSource}
          onSave={(v) => updateSecretKey.mutateAsync({ metaIgManageToken: v })}
          onClear={() => updateSecretKey.mutateAsync({ metaIgManageToken: "" })}
        />

        <SecretKeyEditor
          title="Секрет приложения Instagram"
          description="Там же, где маркер: «Секрет приложения Instagram» рядом с идентификатором приложения Instagram. У входа через Instagram своё приложение со своим секретом — им Meta подписывает сообщения из Instagram, поэтому секрета приложения Facebook мало."
          placeholder="Секрет приложения Instagram"
          configured={settings ? !!settings.metaIgAppSecretMasked : undefined}
          masked={settings?.metaIgAppSecretMasked}
          source={settings?.metaIgAppSecretSource}
          onSave={(v) => updateSecretKey.mutateAsync({ metaIgAppSecret: v })}
          onClear={() => updateSecretKey.mutateAsync({ metaIgAppSecret: "" })}
        />

        <SecretKeyEditor
          title="Маркер Страницы Facebook"
          description="Для переписки в Messenger. Берётся у системного пользователя с доступом к Странице — маркер самой Страницы, не личный."
          placeholder="Маркер Страницы"
          configured={settings ? !!settings.metaPageTokenMasked : undefined}
          masked={settings?.metaPageTokenMasked}
          source={settings?.metaPageTokenSource}
          onSave={(v) => updateSecretKey.mutateAsync({ metaPageToken: v })}
          onClear={() => updateSecretKey.mutateAsync({ metaPageToken: "" })}
        />

        <PlainSetting
          title="Идентификатор Страницы Facebook"
          description="Page ID из настроек Страницы. Не секрет — адрес отправителя в Messenger."
          placeholder="102929531407747"
          value={settings?.metaPageId ?? ""}
          pending={updateSettings.isPending}
          onSave={(v) => updateSettings.mutate({ metaPageId: v })}
        />

        <FacebookCrosspostSetting
          key={(settings?.facebookCrosspostPageIds ?? []).join("\n")}
          value={settings?.facebookCrosspostPageIds ?? []}
          pending={updateSettings.isPending}
          onSave={(list) => updateSettings.mutate({ facebookCrosspostPageIds: list })}
        />

        <FacebookGroupsSetting
          key={(settings?.facebookShareGroups ?? []).join("\n")}
          value={settings?.facebookShareGroups ?? []}
          pending={updateSettings.isPending}
          onSave={(list) => updateSettings.mutate({ facebookShareGroups: list })}
        />

        <div className="quiet">
          <span className="dot" />
          <span className="txt">
            Рубильник бота и рубильники каналов независимы: можно принимать сообщения, но отвечать вручную — для
            этого выключите бота, оставив канал включённым.
          </span>
        </div>
      </SettingsSection>

      <SettingsSection icon={Send} title="Telegram" badge="своим ботом">
        <div className="quiet">
          <span className="dot" />
          <span className="txt">
            Работает своим ботом, отдельно от Meta: включается токеном на сервере (TELEGRAM_BOT_TOKEN), рубильника
            здесь нет. Бот отвечает только клиентам, которые написали ему сами.
          </span>
        </div>
      </SettingsSection>

      </>}
      {(!area || area === "publishing") && <PublicationsSection />}

      {/* РЕКЛАМНЫЙ КАБИНЕТ — отдельным блоком от каналов связи: это не переписка,
          а деньги, и маркер здесь нужен со своим правом (ads_read), которого у
          маркеров выше нет. Отчёт по объектам живёт в разделе «Реклама». */}
      {(!area || area === "advertising") && <>
      <SettingsGroupLabel>Реклама</SettingsGroupLabel>

      <SettingsSection
        icon={Megaphone}
        title="Расходы по объектам"
        badge={metaAdsEnabled ? (adsSyncedAt ? `сверка: ${adsSyncedAt}` : "включено") : "выключено"}
      >
        <SwitchRow
          title="Считать расходы на рекламу из кабинета Meta"
          on={metaAdsEnabled}
          onToggle={() => updateSettings.mutate({ metaAdsEnabled: !metaAdsEnabled })}
          hint={
            metaAdsEnabled
              ? adsSyncedAt
                ? `Последняя сверка: ${adsSyncedAt}. Обновляется раз в час, последние 7 дней перечитываются заново.`
                : "Сверки ещё не было — первая пройдёт в течение часа или по кнопке ниже."
              : "Раздел «Реклама» будет пустым: CRM не ходит в рекламный кабинет вовсе."
          }
          warning={
            metaAdsEnabled && !settings?.metaAdsConfigured
              ? "Нужны маркер с правом ads_read и номер кабинета — оба поля ниже."
              : null
          }
        />

        {/* ГЛАВНЫЙ ПУТЬ — кнопка. Ручной ввод маркера остался ниже запасным: 20.08.2026
            перенести маркер руками не вышло вовсе (не работал буфер обмена), а 200
            символов с клавиатуры не набирают. */}
        <div className="mod">
          <div className="t">
            <b>Подключение кабинета</b>
            <span style={{ whiteSpace: "normal" }}>
              Нажмите кнопку, подтвердите доступ в окне Facebook — и вернётесь обратно. Маркер CRM получит сама:
              копировать и вставлять ничего не нужно.
            </span>
          </div>
          <div className="acts">
            {settings?.metaAdsConfigured && (
              <button
                className="pill ghost sm"
                type="button"
                onClick={() => disconnectAds.mutate()}
                disabled={disconnectAds.isPending}
                title="Маркер будет стёрт, синхронизация выключена. Собранная статистика останется."
              >
                Отвязать
              </button>
            )}
            <button
              className="pill sm"
              type="button"
              onClick={() => connectAds.mutate()}
              disabled={connectAds.isPending}
            >
              <Megaphone className="i" aria-hidden="true" />
              {settings?.metaAdsConfigured ? "Переподключить" : "Подключить кабинет"}
            </button>
          </div>
        </div>

        {adsNotice && (
          <div className={adsNotice.tone === "error" ? "quiet crit" : "quiet"} role="status">
            <span className={adsNotice.tone === "error" ? "dot crit" : "dot ok"} />
            <span className="txt">{adsNotice.text}</span>
          </div>
        )}
        {connectAds.isError && (
          <div className="quiet crit" role="alert">
            <span className="dot crit" />
            <span className="txt">
              {connectAds.error instanceof Error ? connectAds.error.message : "Не удалось начать подключение"}
            </span>
          </div>
        )}

        <SecretKeyEditor
          title="Маркер рекламного кабинета"
          description="Запасной путь, если кнопка выше недоступна: Graph API Explorer → приложение → разрешение ads_read → «Generate Access Token». Маркер оттуда живёт пару часов — CRM сама обменяет его на 60-дневный и дальше будет продлевать."
          placeholder="Маркер с правом ads_read"
          configured={settings ? !!settings.metaAdsTokenMasked : undefined}
          masked={settings?.metaAdsTokenMasked}
          source={settings?.metaAdsTokenSource}
          onSave={(v) => updateSecretKey.mutateAsync({ metaAdsToken: v })}
          onClear={() => updateSecretKey.mutateAsync({ metaAdsToken: "" })}
        />

        <PlainSetting
          title="Номера рекламных кабинетов"
          description="ID из Ads Manager (вид act_1234567890). Несколько — через запятую: своя реклама и реклама подрядчика складываются в один отчёт, но каждое объявление помнит свой кабинет."
          placeholder="act_751587752930155, act_1234567890"
          value={settings?.metaAdAccountId ?? ""}
          pending={updateSettings.isPending}
          onSave={(v) => updateSettings.mutate({ metaAdAccountId: v })}
        />

        {/* Секретное поле, а не обычное (аудит №4, 27.08): значение больше не
            приходит с сервера — GET /settings отдаёт только признак «задан».
            Раньше этот секрет уезжал в ответ открытым текстом. */}
        <SecretKeyEditor
          title="Секрет бюджетных оповещений Google"
          description="Придумайте строку (буквы и цифры, 20+ символов) и вставьте её же в адрес подписки Pub/Sub в Google Cloud. Это подтверждение подлинности: Pub/Sub свои запросы не подписывает, и без секрета в адресе кто угодно мог бы слать нам поддельные оповещения о бюджете."
          placeholder="например, rh-budget-9f3k2m8x1q"
          configured={settings ? settings.googleBudgetTokenConfigured : undefined}
          // Маски нет намеренно: секрет не шифруется в базе, и показывать даже
          // его хвост незачем — «задан/не задан» достаточно для настройки.
          masked={null}
          source={null}
          onSave={(v) => updateSettings.mutateAsync({ googleBudgetToken: v })}
          onClear={() => updateSettings.mutateAsync({ googleBudgetToken: "" })}
        />

        <PlainSetting
          title="Номер приложения Meta"
          description="ID приложения (developers.facebook.com → «Мои приложения»). Нужен только для обмена короткого маркера на 60-дневный — без него маркер придётся менять руками каждые пару часов."
          placeholder="1684679092586215"
          value={settings?.metaAppId ?? ""}
          pending={updateSettings.isPending}
          onSave={(v) => updateSettings.mutate({ metaAppId: v })}
        />
      </SettingsSection>

      <MetaCatalogFeedSection />
      </>}

      {(!area || area === "phone") && <>
      <SettingsGroupLabel>Телефония</SettingsGroupLabel>

      {/* Этап 4 (телефония): подключение к Asterisk ARI и его проверка. Звонок из
          карточки клиента (и теперь единой кнопкой CallClientButton во всех местах,
          где раньше была голая tel:) уже работает поверх этих кредов — см.
          POST /clients/:id/call и docs/telephony-sip-numbering.md. */}
      <SettingsSection
        icon={PhoneCall}
        title="Подключение к станции (ARI)"
        badge={settings?.asteriskConfigured ? "настроено" : "не настроено"}
      >
        <div className="quiet">
          <span className="dot" />
          <span className="txt">
            Подключение к серверу Asterisk (REST Interface). Проверка связи ниже, а звонок агент совершает кнопкой
            «Позвонить» в карточке клиента — там уже используются эти же креды и SIP-номер (Настройки → Сотрудники →
            «Внутренний номер»).
          </span>
        </div>

        <PlainSetting
          title="URL сервера ARI"
          description="Например: http://217.11.178.238:8088 — адрес и порт HTTP из ari.conf/http.conf на сервере Asterisk."
          placeholder="http://адрес-сервера:8088"
          value={settings?.asteriskAriUrl ?? ""}
          pending={updateSettings.isPending}
          onSave={(v) => updateSettings.mutate({ asteriskAriUrl: v })}
        />

        <PlainSetting
          title="Логин ARI"
          description="Пользователь из ari.conf на сервере (секция [general] или отдельный [user])."
          placeholder="royalhome"
          value={settings?.asteriskAriUsername ?? ""}
          pending={updateSettings.isPending}
          onSave={(v) => updateSettings.mutate({ asteriskAriUsername: v })}
        />

        <SecretKeyEditor
          title="Пароль ARI"
          description="Пароль того же пользователя. Хранится в базе зашифрованным."
          placeholder="Пароль пользователя ARI"
          configured={settings ? !!settings.asteriskAriPasswordMasked : undefined}
          masked={settings?.asteriskAriPasswordMasked}
          source={settings?.asteriskAriPasswordMasked ? "settings" : null}
          onSave={(v) => updateSecretKey.mutateAsync({ asteriskAriPassword: v })}
          onClear={() => updateSecretKey.mutateAsync({ asteriskAriPassword: "" })}
        />

        {/* Куда станция звонит сотруднику перед соединением с клиентом. Пока софтфоны
            не розданы — на мобильный; когда появятся, режим переключается здесь, без
            участия программиста и без перезапуска. */}
        <AgentDialModeSetting />

        <AsteriskTestButton configured={!!settings?.asteriskConfigured} />

        <StationTrafficRow />
      </SettingsSection>

      <AmiSection />

      {/* Живой голос по телефону переехал в «Помощник» (BotTab.tsx, 13.09.2026,
          просьба владельца «всё вместе про бота») — тумблер, тестовый номер,
          личность/голос/язык и исходящий тестовый звонок теперь одной складкой там. */}

      <IncomingCallsSection />

      <CallWhisperSetting />

      <NightModeSetting />

      <TelephonyAudioSetting />
      </>}
    </>
  );
}

/**
 * ПУБЛИКАЦИИ — передача монтажёру и кросспостинг
 * (docs/video-pipeline-handoff-only-04-09-2026.md).
 *
 * Автомонтаж удалён 04.09.2026: ролик режет живой монтажёр, CRM отдаёт ему
 * сырое видео и принимает готовое (VideoHandoffFields ниже). Автопубликация —
 * отдельный рубильник нарочно: можно обкатать передачу монтажёру, оставив
 * вставку ссылки в Instagram за человеком, и только потом отдельным решением
 * разрешить CRM публиковать самой.
 */
function PublicationsSection() {
  const { data: settings } = useSettings();
  const updateSettings = useUpdateSettings();
  // silent: SecretKeyEditor ниже сам показывает «Ключ сохранён»/ошибку под полем.
  const updateSecretKey = useUpdateSettings({ silent: true });
  const autoPublishOn = settings?.autoPublishEnabled ?? false;
  const instagramStoriesOn = settings?.instagramStoriesEnabled ?? false;
  const facebookStoriesOn = settings?.facebookStoriesEnabled ?? false;
  const dailyStoriesOn = settings?.dailyStoriesEnabled ?? false;
  const dailyStoriesCount = settings?.dailyStoriesCount ?? 3;
  const dailyStoriesHour = settings?.dailyStoriesHourDushanbe ?? 11;
  const photoPostsOn = settings?.photoPostsEnabled ?? false;
  const photoPostAfterHours = settings?.photoPostAfterHours ?? 24;
  const repostsOn = settings?.repostsEnabled ?? false;
  const repostAfterDays = settings?.repostAfterDays ?? 21;
  const repostMaxRounds = settings?.repostMaxRounds ?? 3;
  const digestsOn = settings?.digestsEnabled ?? false;
  const digestWeekday = settings?.digestWeekday ?? 5;
  const digestHour = settings?.digestHourDushanbe ?? 12;
  const agentSharePostOn = settings?.agentSharePostTelegram ?? true;

  return (
    <>
      <SettingsGroupLabel>Публикации</SettingsGroupLabel>

      <SettingsSection
        icon={Clapperboard}
        title="Передача монтажёру и кросспостинг"
        badge={autoPublishOn ? "публикует сама" : "ссылку вставляет человек"}
      >
        <SwitchRow
          title="Публиковать готовый ролик во все подключённые соцсети самостоятельно"
          on={autoPublishOn}
          onToggle={() => updateSettings.mutate({ autoPublishEnabled: !autoPublishOn })}
          hint={
            autoPublishOn
              ? "Как только монтажёр вернул готовый ролик, CRM сама публикует его во все подключённые сети: Instagram, Facebook, Telegram-канал, YouTube, TikTok и Threads."
              : "Ролик сам не выходит ни в одну сеть — ни в Instagram и Facebook, ни в Telegram, YouTube, TikTok и Threads. Ссылку на Instagram вставляет человек сам. Обложка для сайта (если обложки ChatGPT включены выше) рисуется и при выключенном рубильнике."
          }
          warning={
            autoPublishOn && (!settings?.metaIgTokenAvailable || !settings?.metaPageTokenMasked)
              ? "Не хватает ключей выше: для Instagram — аккаунта Instagram в списке или маркера, для Facebook — маркера Страницы. Публикация в канал без ключа не пройдёт."
              : null
          }
        />

        <SwitchRow
          title="Публиковать ролик ещё и в истории Instagram"
          on={instagramStoriesOn}
          onToggle={() => updateSettings.mutate({ instagramStoriesEnabled: !instagramStoriesOn })}
          hint={
            instagramStoriesOn
              ? "Сразу после успешной публикации в Reels CRM выкладывает тот же ролик в истории — ролики длиннее 60 секунд режутся на несколько последовательных историй."
              : "Кнопкой «Выложить в истории» в карточке объекта можно опубликовать и без этого рубильника — он включает только автомат вслед за Reels."
          }
          warning={instagramStoriesOn && !settings?.metaIgTokenAvailable ? "Нет ни аккаунта Instagram в списке выше, ни маркера Instagram — публикация не пройдёт." : null}
        />

        <PlainSetting
          title="Соавторы по умолчанию (до 3 ников)"
          description="Соавтор получит приглашение в Instagram, пост появится в его ленте после принятия. Ник агента-хозяина объекта добавляется сам."
          placeholder="ник1, ник2, ник3"
          value={settings?.instagramCollaborators ?? ""}
          pending={updateSettings.isPending}
          onSave={(v) => updateSettings.mutate({ instagramCollaborators: v || null })}
        />

        <SwitchRow
          title="Сторис в Facebook (те же, что в Instagram)"
          on={facebookStoriesOn}
          onToggle={() => updateSettings.mutate({ facebookStoriesEnabled: !facebookStoriesOn })}
          hint={
            facebookStoriesOn
              ? "То же самое медиа, что уходит в истории Instagram (ролик, «цена снижена», «продано», карточка объекта), публикуется ещё и на Странице Facebook. Работает поверх рубильника выше — если истории Instagram выключены, Facebook тоже ничего не получит."
              : "Истории уходят только в Instagram — Страница Facebook сторис не получает, даже если рубильник выше включён."
          }
          warning={facebookStoriesOn && !settings?.metaPageTokenMasked ? "Маркер Facebook (Страница) не задан выше — публикация не пройдёт." : null}
        />

        <SwitchRow
          title="Ежедневная подборка сторис"
          on={dailyStoriesOn}
          onToggle={() => updateSettings.mutate({ dailyStoriesEnabled: !dailyStoriesOn })}
          hint={
            dailyStoriesOn
              ? "Каждый день в заданный час CRM сама выбирает несколько объектов и публикует их карточки в сторис — не только по событиям (снижение цены, ролик, «продано»), а вообще, для охвата."
              : "Сторис выходят только по событиям — снижение цены, готовый ролик, печать «Продано», ручные кнопки в карточке объекта."
          }
        />
        {dailyStoriesOn && (
          <div className="mod">
            <div className="t">
              <b>Сколько объектов и в какой час</b>
              <span style={{ whiteSpace: "normal" }}>
                Объекты выбираются сами: сначала те, у кого сторис не было дольше всего (или не было никогда), затем
                более новые. Объект без единой истории за последние 7 дней и с хотя бы одной фотографией.
              </span>
            </div>
            <div className="acts">
              <span className="nf">
                <input
                  type="number"
                  min={1}
                  max={20}
                  inputMode="numeric"
                  aria-label="Объектов в день"
                  defaultValue={dailyStoriesCount}
                  disabled={updateSettings.isPending}
                  onBlur={(e) => {
                    const n = Number(e.target.value);
                    if (Number.isInteger(n) && n >= 1 && n <= 20 && n !== dailyStoriesCount) {
                      updateSettings.mutate({ dailyStoriesCount: n });
                    }
                  }}
                />
                <span className="u">объектов</span>
              </span>
              <span className="nf">
                <input
                  type="number"
                  min={0}
                  max={23}
                  inputMode="numeric"
                  aria-label="Час запуска подборки (Душанбе)"
                  defaultValue={dailyStoriesHour}
                  disabled={updateSettings.isPending}
                  onBlur={(e) => {
                    const n = Number(e.target.value);
                    if (Number.isInteger(n) && n >= 0 && n <= 23 && n !== dailyStoriesHour) {
                      updateSettings.mutate({ dailyStoriesHourDushanbe: n });
                    }
                  }}
                />
                <span className="u">час (Душанбе)</span>
              </span>
            </div>
          </div>
        )}

        {/* ФОТО-ПОСТЫ ДЛЯ ОБЪЕКТОВ БЕЗ РОЛИКА (28.09.2026, agent-brief.md, решение
            владельца 26.09.2026) — объект с фото, но без ролика, сегодня не
            публикуется нигде вовсе. Выключено по умолчанию, как и остальные
            рубильники автопубликации. */}
        <SwitchRow
          title="Публиковать фото-постом объекты без ролика"
          on={photoPostsOn}
          onToggle={() => updateSettings.mutate({ photoPostsEnabled: !photoPostsOn })}
          hint={
            photoPostsOn
              ? `Объект с фото, но без ролика, публикуется каруселью в Instagram, фото-постом на Странице Facebook и альбомом в Telegram-канал — через ${photoPostAfterHours} ч после одобрения. Когда придёт ролик, он выйдет как обычно, фото-пост не удаляется.`
              : "Кнопкой «Опубликовать фото-пост сейчас» в карточке объекта можно опубликовать и без этого рубильника — он включает только автомат по расписанию."
          }
          warning={
            photoPostsOn && (!settings?.metaIgTokenAvailable || !settings?.metaPageTokenMasked)
              ? "Не хватает ключей выше: для Instagram — аккаунта Instagram в списке или маркера, для Facebook — маркера Страницы. Публикация в канал без ключа не пройдёт."
              : null
          }
        />
        {photoPostsOn && (
          <PhotoPostAfterHoursField value={photoPostAfterHours} pending={updateSettings.isPending} onSave={(n) => updateSettings.mutate({ photoPostAfterHours: n })} />
        )}

        {/* ПОВТОРНЫЕ ПОКАЗЫ (28.09.2026, agent-brief.md reposts-digests, решение
            владельца 26.09.2026) — объект живёт месяцами, а показывается один
            раз в день загрузки. Новый круг публикации теми же фото, с новым
            крючком, через N дней после последнего показа. */}
        <SwitchRow
          title="Повторные показы объектов"
          on={repostsOn}
          onToggle={() => updateSettings.mutate({ repostsEnabled: !repostsOn })}
          hint={
            repostsOn
              ? `Объект в продаже получает новый круг публикации (теми же фото, с новым текстом) через ${repostAfterDays} дн. после последнего показа, не больше ${repostMaxRounds} раз.`
              : "Кнопкой «Показать ещё раз сейчас» в карточке объекта можно опубликовать повтор и без этого рубильника — он включает только автомат по расписанию."
          }
          warning={
            repostsOn && (!settings?.metaIgTokenAvailable || !settings?.metaPageTokenMasked)
              ? "Не хватает ключей выше: для Instagram — аккаунта Instagram в списке или маркера, для Facebook — маркера Страницы. Публикация в канал без ключа не пройдёт."
              : null
          }
        />
        {repostsOn && (
          <RepostRulesFields
            afterDays={repostAfterDays}
            maxRounds={repostMaxRounds}
            pending={updateSettings.isPending}
            onSaveAfterDays={(n) => updateSettings.mutate({ repostAfterDays: n })}
            onSaveMaxRounds={(n) => updateSettings.mutate({ repostMaxRounds: n })}
          />
        )}

        {/* ПОДБОРКИ ОБЪЕКТОВ (28.09.2026, agent-brief.md reposts-digests) —
            «5 квартир до 400 000 сомони в Сино» раз в неделю, одним постом. */}
        <SwitchRow
          title="Еженедельная подборка объектов"
          on={digestsOn}
          onToggle={() => updateSettings.mutate({ digestsEnabled: !digestsOn })}
          hint={
            digestsOn
              ? `Раз в неделю (${WEEKDAY_NAMES[digestWeekday]}, ${digestHour}:00 по Душанбе) CRM собирает 3-5 объектов в один пост — по очереди «квартиры до бюджета в районе», «новое за неделю», «N-комнатные в районе».`
              : "Кнопкой «Собрать подборку сейчас» в Центре маркетинга можно опубликовать подборку и без этого рубильника."
          }
        />
        {digestsOn && (
          <DigestScheduleFields
            weekday={digestWeekday}
            hour={digestHour}
            pending={updateSettings.isPending}
            onSaveWeekday={(n) => updateSettings.mutate({ digestWeekday: n })}
            onSaveHour={(n) => updateSettings.mutate({ digestHourDushanbe: n })}
          />
        )}

        <SwitchRow
          title="Присылать агенту его пост в Telegram"
          on={agentSharePostOn}
          onToggle={() => updateSettings.mutate({ agentSharePostTelegram: !agentSharePostOn })}
          hint={
            agentSharePostOn
              ? "После публикации ответственный агент получает в Telegram готовый пост со ссылками на все каналы и кнопками «Поделиться» — у личных профилей охват обычно больше, чем у Страницы. Сотрудник может выключить рассылку себе в профиле."
              : "Агенты продолжают получать обычный пуш о публикации, но готовый пост для «Поделиться» в Telegram не присылается никому."
          }
        />

        <VideoHandoffFields />

        <PlainSetting
          title="Канал Telegram для кросспоста"
          description="Номер канала (вида -1001234567890), где бот уже добавлен администратором. Тот же бот, что отвечает клиентам (TELEGRAM_BOT_TOKEN на сервере) — здесь только адрес канала."
          placeholder="-1001234567890"
          value={settings?.telegramChannelId ?? ""}
          pending={updateSettings.isPending}
          onSave={(v) => updateSettings.mutate({ telegramChannelId: v })}
        />
        <TelegramExtraChatsSetting
          value={settings?.telegramExtraChatIds ?? ""}
          pending={updateSettings.isPending}
          onSave={(v) => updateSettings.mutate({ telegramExtraChatIds: v })}
        />
        <PlainSetting
          title="Группа-обсуждение Telegram-канала"
          description="Номер группы обсуждений, привязанной к каналу выше (не сам канал — у них разные номера). Бот отвечает на комментарии под постами тем же ползунком «Отвечать на комментарии» (Настройки → Помощник), что и в Instagram. Пусто — бот в группе молчит."
          placeholder="-1001234567890"
          value={settings?.telegramDiscussionGroupId ?? ""}
          pending={updateSettings.isPending}
          onSave={(v) => updateSettings.mutate({ telegramDiscussionGroupId: v })}
        />
        <SwitchRow
          title="Отвечать тем, кто пишет каналу напрямую (Direct Messages)"
          on={settings?.telegramDirectMessagesEnabled ?? false}
          onToggle={() => updateSettings.mutate({ telegramDirectMessagesEnabled: !(settings?.telegramDirectMessagesEnabled ?? false) })}
          hint="Кнопка «Написать» под каналом — отдельный рубильник от группы-обсуждения выше и от личных сообщений боту. Бот ведёт такой диалог до заявки сам. В «Сообщениях» этих переписок пока нет: если бот не смог ответить, напишите клиенту из самого Telegram."
        />
      </SettingsSection>

      <PublishScheduleSection />

      {/* YouTube Shorts (31.08.2026) — отдельные ключи OAuth2 Google, не Meta.
          refresh_token владелец получает один раз вручную (Google OAuth Playground
          или консоль Google Cloud) — полноценный consent-flow в интерфейсе CRM
          не реализован (см. lib/socialPublish.ts). */}
      <SettingsSection icon={Youtube} title="YouTube Shorts">
        <div className="quiet">
          <span className="dot" />
          <span className="txt">
            Вертикальный ролик, присланный монтажёром, автоматически становится YouTube Shorts — отдельного
            переключателя формата у YouTube нет. Обложку сам YouTube для Shorts не принимает (ограничение платформы).
            Ключи ниже — из проекта в Google Cloud Console (OAuth-приложение) и refresh_token канала, полученный один
            раз через OAuth-согласие.
          </span>
        </div>
        <PlainSetting
          title="Идентификатор приложения (Client ID)"
          description="Идентификатор OAuth-приложения Google. Не секрет."
          placeholder="xxxxxxxx.apps.googleusercontent.com"
          value={settings?.youtubeClientId ?? ""}
          pending={updateSettings.isPending}
          onSave={(v) => updateSettings.mutate({ youtubeClientId: v })}
        />
        <SecretKeyEditor
          title="Секрет приложения (Client Secret)"
          description="Секрет того же OAuth-приложения — из той же карточки в Google Cloud Console."
          placeholder="Client Secret"
          configured={settings ? !!settings.youtubeClientSecretMasked : undefined}
          masked={settings?.youtubeClientSecretMasked}
          source={settings?.youtubeClientSecretSource ?? null}
          onSave={(v) => updateSecretKey.mutateAsync({ youtubeClientSecret: v })}
          onClear={() => updateSecretKey.mutateAsync({ youtubeClientSecret: "" })}
        />
        <SecretKeyEditor
          title="Ключ доступа к каналу (refresh token)"
          description="Долгоживущий токен, выпущенный один раз через OAuth-согласие владельца канала (Google OAuth Playground с тремя правами: youtube.upload — публиковать ролики, youtube.force-ssl — читать, отвечать и скрывать комментарии, yt-analytics.readonly — статистика; с одним youtube.upload бот комментарии не видит вовсе). Показывается один раз — если потеряли, получите заново тем же способом."
          placeholder="Refresh token"
          configured={settings ? !!settings.youtubeRefreshTokenMasked : undefined}
          masked={settings?.youtubeRefreshTokenMasked}
          source={settings?.youtubeRefreshTokenSource ?? null}
          onSave={(v) => updateSecretKey.mutateAsync({ youtubeRefreshToken: v })}
          onClear={() => updateSecretKey.mutateAsync({ youtubeRefreshToken: "" })}
        />
      </SettingsSection>

      {/* TikTok Content Posting API (17.09.2026) — в отличие от YouTube, consent-flow
          делает сама CRM (кнопка ниже): redirect_uri обязан быть зарегистрирован в
          приложении TikTok и быть https, вписать его вручную в готовый токен нельзя.
          См. routes/tiktok.ts, lib/socialPublish.ts. */}
      <SettingsSection icon={Music2} title="TikTok">
        <TikTokChannelSection />
      </SettingsSection>

      {/* Threads (Meta), 23.09.2026 — шестой канал автопубликации. Своё приложение
          (App ID/App Secret из use case «Threads API»), не совпадающее с Facebook
          App ID, хотя аккаунт Threads привязан к нашему Instagram. См.
          routes/threads.ts, lib/socialPublish.ts. */}
      <SettingsSection icon={AtSign} title="Threads">
        <ThreadsChannelSection />
      </SettingsSection>
    </>
  );
}

/** Подписи privacy_level_options TikTok по-русски — коды приходят с сервера как есть. */
const TIKTOK_PRIVACY_LABELS: Record<string, string> = {
  PUBLIC_TO_EVERYONE: "Все",
  MUTUAL_FOLLOW_FRIENDS: "Взаимные подписчики",
  FOLLOWER_OF_CREATOR: "Подписчики",
  SELF_ONLY: "Только я",
};

/**
 * TikTok (17.09.2026). Разметка — идиома этого же файла (SettingsSection ->
 * .mod/.fld/.seg/.quiet), ничего нового не вводится (договор задания).
 *
 * Тумблеры и радио живут в Настройках (Settings.tiktok*) — тот же контракт, что
 * у остальных полей этой вкладки: PATCH /settings сохраняет их немедленно, здесь
 * нет отдельной кнопки «Сохранить» под блоком «Как публиковать».
 */
function TikTokChannelSection() {
  const { data: settings } = useSettings();
  const updateSettings = useUpdateSettings();
  const updateSecretKey = useUpdateSettings({ silent: true });
  const [searchParams, setSearchParams] = useSearchParams();
  const connectTikTok = useConnectTikTok();
  const disconnectTikTok = useDisconnectTikTok();
  const [confirmingDisconnect, setConfirmingDisconnect] = useState(false);

  const connected = !!settings?.tiktokConnectedAt;
  const { data: creatorInfo } = useTikTokCreatorInfo(connected);

  /** TikTok вернул человека сюда с результатом — показываем и стираем параметр
   *  из адреса, чтобы обновление страницы не показывало тост повторно. */
  const tiktokResult = searchParams.get("tiktok");
  useEffect(() => {
    if (!tiktokResult) return;
    const next = new URLSearchParams(searchParams);
    next.delete("tiktok");
    next.delete("reason");
    setSearchParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tiktokResult]);
  const tiktokNotice =
    tiktokResult === "ok"
      ? { tone: "ok" as const, text: "Аккаунт TikTok подключён." }
      : tiktokResult === "error"
        ? {
            tone: "error" as const,
            text:
              searchParams.get("reason") === "state"
                ? "Подтверждение устарело или подделано — нажмите «Подключить» ещё раз."
                : searchParams.get("reason") === "not-configured"
                  ? "Не заполнены Client key и Client secret TikTok выше."
                  : searchParams.get("reason") === "cancelled"
                    ? "Подключение отменено — в TikTok не подтвердили доступ."
                    : decodeURIComponent(searchParams.get("reason") || "Не удалось подключить аккаунт TikTok."),
          }
        : null;

  const privacyOptions = creatorInfo?.privacyLevelOptions ?? [];
  const brandMode = settings?.tiktokBrandMode ?? "NONE";

  return (
    <>
      <div className="quiet">
        <span className="dot" />
        <span className="txt">
          Ключи ниже — из проекта в TikTok for Developers (приложение «Royal Home Tj CRM»). До прохождения ревью
          приложения аккаунт TikTok должен быть приватным (в приложении TikTok: Настройки → Конфиденциальность →
          Приватный аккаунт) — это требование к самому аккаунту, а не к уровню приватности ролика.
        </span>
      </div>
      <PlainSetting
        title="Идентификатор приложения (Client key)"
        description="Идентификатор приложения TikTok for Developers. Не секрет."
        placeholder="Client key"
        value={settings?.tiktokClientKey ?? ""}
        pending={updateSettings.isPending}
        onSave={(v) => updateSettings.mutate({ tiktokClientKey: v })}
      />
      <SecretKeyEditor
        title="Секрет приложения (Client Secret)"
        description="Секрет того же приложения — из той же карточки в TikTok for Developers."
        placeholder="Client Secret"
        configured={settings ? !!settings.tiktokClientSecretMasked : undefined}
        masked={settings?.tiktokClientSecretMasked}
        source={settings?.tiktokClientSecretSource ?? null}
        onSave={(v) => updateSecretKey.mutateAsync({ tiktokClientSecret: v })}
        onClear={() => updateSecretKey.mutateAsync({ tiktokClientSecret: "" })}
      />

      {tiktokNotice && (
        <div className={tiktokNotice.tone === "error" ? "quiet crit" : "quiet"} role="status" style={{ marginTop: "var(--s2)" }}>
          <span className={tiktokNotice.tone === "error" ? "dot crit" : "dot ok"} />
          <span className="txt">{tiktokNotice.text}</span>
        </div>
      )}
      {connectTikTok.isError && (
        <div className="quiet crit" role="alert" style={{ marginTop: "var(--s2)" }}>
          <span className="dot crit" />
          <span className="txt">
            {connectTikTok.error instanceof Error ? connectTikTok.error.message : "Не удалось начать подключение"}
          </span>
        </div>
      )}

      {!connected ? (
        <div className="mod" style={{ marginTop: "var(--s3)" }}>
          <div className="t">
            <b>Аккаунт не подключён</b>
            <span style={{ whiteSpace: "normal" }}>
              Нужен бизнес-аккаунт @royal.home.tjk — войдите под ним в окне TikTok, которое откроет кнопка.
            </span>
          </div>
          <div className="acts">
            <button
              className="pill sm"
              type="button"
              onClick={() => connectTikTok.mutate()}
              disabled={connectTikTok.isPending || !settings?.tiktokClientKey || !settings?.tiktokClientSecretMasked}
              title={
                !settings?.tiktokClientKey || !settings?.tiktokClientSecretMasked
                  ? "Сначала заполните Client key и Client secret выше"
                  : undefined
              }
            >
              <Music2 className="i" aria-hidden="true" />
              Подключить аккаунт TikTok
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="mod" style={{ marginTop: "var(--s3)" }}>
            <div className="t">
              {settings?.tiktokCreatorAvatarUrl && (
                <img
                  src={settings.tiktokCreatorAvatarUrl}
                  alt=""
                  width={32}
                  height={32}
                  style={{ borderRadius: "50%", marginBottom: "var(--s2)" }}
                />
              )}
              <b>
                {settings?.tiktokCreatorNickname || "Аккаунт подключён"}
                {settings?.tiktokCreatorUsername ? ` · @${settings.tiktokCreatorUsername}` : ""}
              </b>
              <span>
                Подключён{" "}
                {settings?.tiktokConnectedAt
                  ? new Date(settings.tiktokConnectedAt).toLocaleString("ru-RU", { timeZone: "Asia/Dushanbe", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })
                  : ""}
              </span>
            </div>
            <div className="acts">
              <button className="pill ghost sm" type="button" onClick={() => setConfirmingDisconnect(true)}>
                Отключить
              </button>
            </div>
          </div>

          {confirmingDisconnect && (
            <ConfirmDialog
              title="Отключить TikTok?"
              description="Токен доступа будет отозван и стёрт. Публикация новых роликов в TikTok остановится, ключи приложения (Client key/secret) сохранятся — подключить можно будет заново одной кнопкой."
              confirmLabel="Отключить"
              onConfirm={() => {
                disconnectTikTok.mutate();
                setConfirmingDisconnect(false);
              }}
              onCancel={() => setConfirmingDisconnect(false)}
            />
          )}

          <div className="grp-lab" style={{ marginTop: "var(--s4)" }}>
            Как публиковать
          </div>

          <div className="fld">
            <span className="lab">Кто видит ролик</span>
            <select
              className="inp"
              style={{ maxWidth: 280 }}
              aria-label="Кто видит ролик"
              value={settings?.tiktokPrivacyLevel ?? ""}
              onChange={(e) => updateSettings.mutate({ tiktokPrivacyLevel: e.target.value || null })}
              disabled={updateSettings.isPending}
            >
              <option value="">Выберите…</option>
              {privacyOptions.map((opt) => (
                <option key={opt} value={opt}>
                  {TIKTOK_PRIVACY_LABELS[opt] ?? opt}
                </option>
              ))}
            </select>
          </div>

          <SwitchRow
            title="Разрешить комментарии"
            on={settings?.tiktokAllowComments ?? false}
            disabled={!!creatorInfo?.commentDisabled}
            onToggle={() => updateSettings.mutate({ tiktokAllowComments: !(settings?.tiktokAllowComments ?? false) })}
            hint="Выключено по умолчанию — требование ревью приложения TikTok."
            warning={creatorInfo?.commentDisabled ? "запрещено настройками аккаунта" : null}
          />
          <SwitchRow
            title="Разрешить дуэты"
            on={settings?.tiktokAllowDuet ?? false}
            disabled={!!creatorInfo?.duetDisabled}
            onToggle={() => updateSettings.mutate({ tiktokAllowDuet: !(settings?.tiktokAllowDuet ?? false) })}
            hint="Выключено по умолчанию — требование ревью приложения TikTok."
            warning={creatorInfo?.duetDisabled ? "запрещено настройками аккаунта" : null}
          />
          <SwitchRow
            title="Разрешить стичи"
            on={settings?.tiktokAllowStitch ?? false}
            disabled={!!creatorInfo?.stitchDisabled}
            onToggle={() => updateSettings.mutate({ tiktokAllowStitch: !(settings?.tiktokAllowStitch ?? false) })}
            hint="Выключено по умолчанию — требование ревью приложения TikTok."
            warning={creatorInfo?.stitchDisabled ? "запрещено настройками аккаунта" : null}
          />

          <SwitchRow
            title="Коммерческий контент"
            on={brandMode !== "NONE"}
            onToggle={() => updateSettings.mutate({ tiktokBrandMode: brandMode === "NONE" ? "ORGANIC" : "NONE" })}
            hint="Выключено по умолчанию. Включайте, если ролик рекламирует товар/услугу — своё агентство или чужой бренд."
          />
          {brandMode !== "NONE" && (
            <div className="seg" role="group" aria-label="Тип коммерческого контента" style={{ marginTop: "var(--s2)" }}>
              <button type="button" aria-selected={brandMode === "ORGANIC"} onClick={() => updateSettings.mutate({ tiktokBrandMode: "ORGANIC" })}>
                Свой бренд
              </button>
              <button type="button" aria-selected={brandMode === "BRANDED"} onClick={() => updateSettings.mutate({ tiktokBrandMode: "BRANDED" })}>
                Брендированный контент
              </button>
            </div>
          )}
          {brandMode === "ORGANIC" && (
            <p className="msg" style={{ color: "var(--faint)" }}>
              Видео получит метку «Promotional content».
            </p>
          )}
          {brandMode === "BRANDED" && (
            <p className="msg" style={{ color: "var(--faint)" }}>
              Видео получит метку «Paid partnership».
            </p>
          )}

          <div className="quiet" style={{ marginTop: "var(--s3)" }}>
            <span className="dot" />
            <span className="txt">
              Публикуя, вы соглашаетесь с{" "}
              <a href="https://www.tiktok.com/legal/page/global/music-usage-confirmation/en" target="_blank" rel="noreferrer">
                TikTok Music Usage Confirmation
              </a>
              {brandMode === "BRANDED" && (
                <>
                  {" "}
                  и{" "}
                  <a href="https://www.tiktok.com/legal/page/global/bc-policy/en" target="_blank" rel="noreferrer">
                    Branded Content Policy
                  </a>
                </>
              )}
              . После публикации ролик появится в профиле через несколько минут.
            </span>
          </div>
        </>
      )}
    </>
  );
}

/**
 * Threads (Meta), 23.09.2026 — тот же рецепт разметки, что TikTokChannelSection
 * (SettingsSection -> .mod/.fld/.quiet), ничего нового не вводится. Проще
 * TikTok: нет privacy-level/allow-тумблеров и брендированного контента —
 * Threads их не спрашивает, договор задания это подтверждает.
 */
function ThreadsChannelSection() {
  const { data: settings } = useSettings();
  const updateSettings = useUpdateSettings();
  const updateSecretKey = useUpdateSettings({ silent: true });
  const [searchParams, setSearchParams] = useSearchParams();
  const connectThreads = useConnectThreads();
  const disconnectThreads = useDisconnectThreads();
  const [confirmingDisconnect, setConfirmingDisconnect] = useState(false);

  const connected = !!settings?.threadsConnectedAt;
  const { data: profile } = useThreadsProfile(connected);

  /** Threads вернул человека сюда с результатом — показываем и стираем параметр
   *  из адреса, тот же приём, что у TikTok. */
  const threadsResult = searchParams.get("threads");
  useEffect(() => {
    if (!threadsResult) return;
    const next = new URLSearchParams(searchParams);
    next.delete("threads");
    next.delete("reason");
    setSearchParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadsResult]);
  const threadsNotice =
    threadsResult === "ok"
      ? { tone: "ok" as const, text: "Аккаунт Threads подключён." }
      : threadsResult === "error"
        ? {
            tone: "error" as const,
            text:
              searchParams.get("reason") === "state"
                ? "Подтверждение устарело или подделано — нажмите «Подключить» ещё раз."
                : searchParams.get("reason") === "not-configured"
                  ? "Не заполнены App ID и App Secret Threads выше."
                  : searchParams.get("reason") === "cancelled"
                    ? "Подключение отменено — в Threads не подтвердили доступ."
                    : decodeURIComponent(searchParams.get("reason") || "Не удалось подключить аккаунт Threads."),
          }
        : null;

  const avatarUrl = profile?.avatarUrl ?? settings?.threadsAvatarUrl ?? null;
  const username = profile?.username ?? settings?.threadsUsername ?? null;
  const connectedAt = profile?.connectedAt ?? settings?.threadsConnectedAt ?? null;
  const tokenExpiresAt = profile?.tokenExpiresAt ?? settings?.threadsTokenExpiresAt ?? null;

  return (
    <>
      <div className="quiet">
        <span className="dot" />
        <span className="txt">
          App ID и секрет берутся в Meta App Dashboard → приложение → Threads API (это не Facebook App ID). Пока
          приложение не прошло App Review, публиковать можно только от аккаунтов, добавленных «Threads testers».
        </span>
      </div>
      <PlainSetting
        title="App ID"
        description="Идентификатор приложения из use case «Threads API». Не секрет."
        placeholder="App ID"
        value={settings?.threadsAppId ?? ""}
        pending={updateSettings.isPending}
        onSave={(v) => updateSettings.mutate({ threadsAppId: v })}
      />
      <SecretKeyEditor
        title="App Secret"
        description="Секрет того же приложения — из той же карточки в Meta App Dashboard."
        placeholder="App Secret"
        configured={settings ? !!settings.threadsAppSecretMasked : undefined}
        masked={settings?.threadsAppSecretMasked}
        source={settings?.threadsAppSecretSource ?? null}
        onSave={(v) => updateSecretKey.mutateAsync({ threadsAppSecret: v })}
        onClear={() => updateSecretKey.mutateAsync({ threadsAppSecret: "" })}
      />

      {threadsNotice && (
        <div className={threadsNotice.tone === "error" ? "quiet crit" : "quiet"} role="status" style={{ marginTop: "var(--s2)" }}>
          <span className={threadsNotice.tone === "error" ? "dot crit" : "dot ok"} />
          <span className="txt">{threadsNotice.text}</span>
        </div>
      )}
      {connectThreads.isError && (
        <div className="quiet crit" role="alert" style={{ marginTop: "var(--s2)" }}>
          <span className="dot crit" />
          <span className="txt">
            {connectThreads.error instanceof Error ? connectThreads.error.message : "Не удалось начать подключение"}
          </span>
        </div>
      )}

      {!connected ? (
        <div className="mod" style={{ marginTop: "var(--s3)" }}>
          <div className="t">
            <b>Аккаунт не подключён</b>
            <span style={{ whiteSpace: "normal" }}>Аккаунт Threads, привязанный к нашему Instagram.</span>
          </div>
          <div className="acts">
            <button
              className="pill sm"
              type="button"
              onClick={() => connectThreads.mutate()}
              disabled={connectThreads.isPending || !settings?.threadsAppId || !settings?.threadsAppSecretMasked}
              title={
                !settings?.threadsAppId || !settings?.threadsAppSecretMasked
                  ? "Сначала заполните App ID и App Secret выше"
                  : undefined
              }
            >
              <AtSign className="i" aria-hidden="true" />
              Подключить аккаунт
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="mod" style={{ marginTop: "var(--s3)" }}>
            <div className="t">
              {avatarUrl && (
                <img src={avatarUrl} alt="" width={32} height={32} style={{ borderRadius: "50%", marginBottom: "var(--s2)" }} />
              )}
              <b>{username ? `@${username}` : "Аккаунт подключён"}</b>
              <span>
                Подключён {connectedAt ? new Date(connectedAt).toLocaleString("ru-RU", { timeZone: "Asia/Dushanbe", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : ""}
                {tokenExpiresAt
                  ? ` · токен до ${new Date(tokenExpiresAt).toLocaleString("ru-RU", { timeZone: "Asia/Dushanbe", day: "numeric", month: "short" })}`
                  : ""}
              </span>
            </div>
            <div className="acts">
              <button className="pill ghost sm" type="button" onClick={() => setConfirmingDisconnect(true)}>
                Отключить
              </button>
            </div>
          </div>

          {confirmingDisconnect && (
            <ConfirmDialog
              title="Отключить Threads?"
              description="Токен доступа будет забыт (Threads не даёт его отозвать программно). Публикация новых постов в Threads остановится, ключи приложения (App ID/App Secret) сохранятся — подключить можно будет заново одной кнопкой."
              confirmLabel="Отключить"
              onConfirm={() => {
                disconnectThreads.mutate();
                setConfirmingDisconnect(false);
              }}
              onCancel={() => setConfirmingDisconnect(false)}
            />
          )}
        </>
      )}
    </>
  );
}

/**
 * РУЧНАЯ ПЕРЕДАЧА ВИДЕО МОНТАЖЁРУ ЧЕРЕЗ TELEGRAM (01.09.2026, lib/videoHandoff.ts) —
 * единственный путь подготовки ролика с 04.09.2026: можно включить его или
 * ни одного. Тумблер стоит под двумя пикерами намеренно, как и остальные развилки
 * в этом файле — сначала «кому», потом «включать ли», чтобы владелец не включил
 * рубильник, глядя на пустой выбор монтажёра.
 */
function VideoHandoffFields() {
  const { data: settings } = useSettings();
  const { data: agents } = useAgents();
  const updateSettings = useUpdateSettings();

  const handoffOn = settings?.videoHandoffEnabled ?? false;
  const montajerId = settings?.videoMontajerAgentId ?? "";
  const rawReviewOn = settings?.rawReviewRequired ?? true;
  const clipReviewOn = settings?.clipReviewEnabled ?? false;

  return (
    <>
      {/* «Модератор видео по умолчанию» убран 23.09.2026: выбор сохранялся, но пуш
          «Объект ждёт проверки» никому по этому полю не уходит — ни одна строка сервера это поле не читает (проверено поиском 23.09.2026).
          Поле videoModeratorAgentId остаётся в базе. */}
      <div className="mod">
        <div className="t">
          <b>Монтажёр ручной передачи</b>
          <span style={{ whiteSpace: "normal" }}>
            Единственный, кто получает сырые ролики в очереди (строго один объект в работе одновременно). Привязывает
            личный Telegram-чат сам, в своём Профиле.
          </span>
        </div>
        <div className="acts">
          <select
            className="inp"
            style={{ maxWidth: 220 }}
            aria-label="Монтажёр ручной передачи"
            value={montajerId}
            onChange={(e) => updateSettings.mutate({ videoMontajerAgentId: e.target.value || null })}
            disabled={updateSettings.isPending}
          >
            <option value="">Не назначен</option>
            {(agents ?? []).map((a) => (
              <option key={a.id} value={a.id}>
                {a.fullName}
              </option>
            ))}
          </select>
        </div>
      </div>

      <SwitchRow
        title="Передавать сырое видео монтажёру вручную через Telegram/CRM"
        on={handoffOn}
        onToggle={() => updateSettings.mutate({ videoHandoffEnabled: !handoffOn })}
        hint={
          handoffOn
            ? "После одобрения фото и видео CRM ставит объект в очередь и отправляет сырой ролик монтажёру. Ответ тем же чатом (или загрузка через карточку объекта) публикует пост без второй модерации."
            : "CRM не передаёт сырое видео монтажёру — объект просто ждёт в очереди монтажа, ролик забирают вручную."
        }
        warning={handoffOn && !montajerId ? "Монтажёр не выбран — объекты будут копиться в очереди без единой отправки." : null}
      />

      {/* 25.09.2026, владелец: «выключи временно одобрение роликов от агентов —
          пусть сразу идут монтажёру». Сервер: lib/propertyReview.ts::autoApproveIfRawReviewOff. */}
      <SwitchRow
        title="Проверять фото и видео агентов перед монтажом"
        on={rawReviewOn}
        onToggle={() => updateSettings.mutate({ rawReviewRequired: !rawReviewOn })}
        hint={
          rawReviewOn
            ? "Новый объект ждёт, пока модератор одобрит фото и видео, — только потом уходит монтажёру."
            : "Выключено — объект уходит монтажёру сразу после загрузки видео. Фото и видео одобряются автоматически, модераторам ничего не приходит."
        }
      />

      {/* 25.09.2026: ролик от монтажёра — модератору в Telegram (видео с кнопками)
          и в карточку объекта. Сервер: lib/clipReview.ts. */}
      <SwitchRow
        title="Готовый ролик проверяет модератор перед публикацией (в Telegram и в карточке)"
        on={clipReviewOn}
        onToggle={() => updateSettings.mutate({ clipReviewEnabled: !clipReviewOn })}
        hint={
          clipReviewOn
            ? "Ролик от монтажёра не встаёт в расписание, пока модератор не нажмёт «Одобрить». Кто получает ролики в Telegram — включается в Профиле («Готовые ролики на проверку»)."
            : "Принятый ролик сразу встаёт в расписание публикаций — монтажёр и есть последняя проверка."
        }
      />
    </>
  );
}

/**
 * РАСПИСАНИЕ ВЫХОДА РОЛИКОВ (23.09.2026, владелец: «все это должно быть в
 * настройках в дашборде»).
 *
 * До этого дня сетка была вшита в код: окно 09:00–21:00, 90 минут между
 * публикациями, часы 12–14 и 19–21. Поменять их означало выпустить новую
 * версию, а объяснить, откуда они взялись, не мог никто — это были умолчания,
 * поставленные без решения владельца.
 *
 * НИЧЕГО НЕ СЧИТАЕТ САМ: пишет поля, по которым считает сервер
 * (lib/publishScheduleRules.ts). Как расписание сложилось на самом деле, видно
 * в кабинете маркетинга → «Расписание» — там причина у каждого ролика.
 */
function PublishScheduleSection() {
  const { data: settings } = useSettings();
  const updateSettings = useUpdateSettings();

  const scheduleOn = settings?.publishScheduleEnabled ?? true;
  const heatmapOn = settings?.publishScheduleUseHeatmap ?? true;
  const instagramOnlineOn = settings?.publishScheduleUseInstagramOnline ?? true;

  return (
    <SettingsSection
      icon={CalendarClock}
      title="Расписание выхода роликов"
      badge={scheduleOn ? (heatmapOn ? "по тепловой карте" : "по своим часам") : "выходят сразу"}
    >
      <SwitchRow
        title="Расставлять ролики по времени"
        on={scheduleOn}
        onToggle={() => updateSettings.mutate({ publishScheduleEnabled: !scheduleOn })}
        hint={
          scheduleOn
            ? "Принятый от монтажёра ролик встаёт в ближайший подходящий час, а не уходит сразу. Пачка из десяти роликов не уйдёт одним залпом."
            : "Каждый принятый ролик публикуется сразу по приёму. Десять роликов подряд уйдут один за другим."
        }
      />

      <SwitchRow
        title="Брать часы выхода из тепловой карты"
        on={heatmapOn}
        onToggle={() => updateSettings.mutate({ publishScheduleUseHeatmap: !heatmapOn })}
        hint={
          heatmapOn
            ? "Часы считаются по реальным обращениям клиентов — звонки, комментарии, переписки. Пока обращений мало, расписание само возвращается к постоянным часам ниже и честно пишет об этом."
            : "Ролики выходят в постоянные часы, заданные ниже, независимо от того, когда клиенты активны."
        }
        warning={scheduleOn ? null : "Расписание выключено ползунком выше — эта настройка ни на что не влияет."}
      />

      <SwitchRow
        title="Для часов выхода верить статистике Instagram"
        on={instagramOnlineOn}
        onToggle={() => updateSettings.mutate({ publishScheduleUseInstagramOnline: !instagramOnlineOn })}
        hint={
          instagramOnlineOn
            ? "Часы берутся из того, когда наши подписчики Instagram в сети, — это считает сам Instagram. Сервер забирает эти данные раз в сутки; пока их меньше недели, часы считаются по обращениям клиентов."
            : "Часы считаются только по обращениям клиентов, статистика Instagram не учитывается."
        }
        warning={
          !scheduleOn
            ? "Расписание выключено ползунком выше — эта настройка ни на что не влияет."
            : !heatmapOn
              ? "Тепловая карта выключена ползунком выше — ролики выходят в постоянные часы, эта настройка ни на что не влияет."
              : null
        }
      />

      <PublishWindowFields />
    </SettingsSection>
  );
}

/** «09:00» ⇄ минуты от полуночи — формат <input type="time">. */
function minToTime(min: number): string {
  const h = Math.floor(min / 60) % 24;
  const m = min % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}
function timeToMin(value: string): number | null {
  const m = /^(\d{2}):(\d{2})$/.exec(value);
  if (!m) return null;
  const min = Number(m[1]) * 60 + Number(m[2]);
  return min >= 0 && min <= 24 * 60 ? min : null;
}

/** Плоский список пар минут ⇄ «12:00-14:00, 19:00-21:00». */
function windowsToText(flat: number[]): string {
  const parts: string[] = [];
  for (let i = 0; i + 1 < flat.length; i += 2) parts.push(`${minToTime(flat[i])}-${minToTime(flat[i + 1])}`);
  return parts.join(", ");
}
function textToWindows(text: string): number[] | null {
  const trimmed = text.trim();
  if (trimmed === "") return [];
  const flat: number[] = [];
  for (const piece of trimmed.split(",")) {
    const [rawStart, rawEnd, ...rest] = piece.trim().split("-");
    if (rest.length > 0 || rawEnd === undefined) return null;
    const start = timeToMin(rawStart.trim());
    const end = timeToMin(rawEnd.trim());
    if (start === null || end === null || start >= end) return null;
    flat.push(start, end);
  }
  return flat.length <= 12 ? flat : null;
}

function PublishWindowFields() {
  const { data: settings } = useSettings();
  const updateSettings = useUpdateSettings();

  const startMin = settings?.publishScheduleWindowStartMin ?? 9 * 60;
  const endMin = settings?.publishScheduleWindowEndMin ?? 21 * 60;
  const gapMin = settings?.publishScheduleMinGapMin ?? 90;
  const days = settings?.publishScheduleHeatmapDays ?? 90;
  const lead = settings?.publishScheduleLeadHours ?? 1;
  const windowsValue = windowsToText(settings?.publishSchedulePriorityWindows ?? []);

  /**
   * Черновик догоняет сервер, пока человек не начал править, — тот же приём и по
   * той же причине, что в PlainSetting ниже: поле рисуется раньше ответа
   * /settings, и без этого один клик записал бы поверх настройки пустоту.
   */
  const [windowsDraft, setWindowsDraft] = useState(windowsValue);
  const [windowsTouched, setWindowsTouched] = useState(false);
  useEffect(() => {
    if (!windowsTouched) setWindowsDraft(windowsValue);
  }, [windowsValue, windowsTouched]);
  const parsedWindows = textToWindows(windowsDraft);

  return (
    <>
      <div className="mod">
        <div className="t">
          <b>Рабочее окно публикаций</b>
          <span style={{ whiteSpace: "normal" }}>
            Раньше начала и позже конца ролики не выходят: ночной пост статистически мёртв. Слот, вышедший за конец
            окна, переносится на следующий день.
          </span>
        </div>
        <div className="acts">
          <input
            className="inp"
            type="time"
            style={{ maxWidth: 120 }}
            aria-label="Начало окна публикаций"
            value={minToTime(startMin)}
            disabled={updateSettings.isPending}
            onChange={(e) => {
              const min = timeToMin(e.target.value);
              if (min !== null && min !== startMin) updateSettings.mutate({ publishScheduleWindowStartMin: min });
            }}
          />
          <input
            className="inp"
            type="time"
            style={{ maxWidth: 120 }}
            aria-label="Конец окна публикаций"
            value={minToTime(endMin)}
            disabled={updateSettings.isPending}
            onChange={(e) => {
              const min = timeToMin(e.target.value);
              if (min !== null && min !== endMin) updateSettings.mutate({ publishScheduleWindowEndMin: min });
            }}
          />
        </div>
      </div>

      <div className="mod">
        <div className="t">
          <b>Минимум между публикациями</b>
          <span style={{ whiteSpace: "normal" }}>
            Ровно это и не даёт пачке роликов уйти залпом. Меньше часа лента читается как рассылка, и сами площадки
            начинают придерживать отправку (TikTok отвечает на это прямой ошибкой).
          </span>
        </div>
        <div className="acts">
          <span className="nf">
            <input
              type="number"
              min={5}
              max={480}
              inputMode="numeric"
              aria-label="Минут между публикациями"
              defaultValue={gapMin}
              disabled={updateSettings.isPending}
              onBlur={(e) => {
                const n = Number(e.target.value);
                if (Number.isInteger(n) && n >= 5 && n <= 480 && n !== gapMin) {
                  updateSettings.mutate({ publishScheduleMinGapMin: n });
                }
              }}
            />
            <span className="u">минут</span>
          </span>
        </div>
      </div>

      <div className="mod">
        <div className="t">
          <b>Постоянные часы выхода</b>
          <span style={{ whiteSpace: "normal" }}>
            Куда метит первый ролик пачки, когда тепловая карта выключена или в ней ещё мало обращений. Формат:
            «12:00-14:00, 19:00-21:00». Не больше шести отрезков.
          </span>
        </div>
        <div className="acts">
          <input
            className="inp"
            style={{ maxWidth: 240 }}
            aria-label="Постоянные часы выхода"
            placeholder="12:00-14:00, 19:00-21:00"
            value={windowsDraft}
            disabled={updateSettings.isPending}
            onChange={(e) => {
              setWindowsTouched(true);
              setWindowsDraft(e.target.value);
            }}
          />
          <button
            className="pill sm"
            type="button"
            disabled={!windowsTouched || parsedWindows === null || windowsDraft === windowsValue || updateSettings.isPending}
            onClick={() => {
              if (parsedWindows === null) return;
              updateSettings.mutate({ publishSchedulePriorityWindows: parsedWindows });
              setWindowsTouched(false);
            }}
          >
            Сохранить
          </button>
        </div>
        {/* Условный рендер, а не hidden: на flex-элементе hidden не срабатывает. */}
        {windowsTouched && parsedWindows === null && (
          <p className="msg" style={{ color: "var(--crit)" }}>
            Не разобрали. Каждый отрезок — «ЧЧ:ММ-ЧЧ:ММ», конец позже начала, отрезки через запятую.
          </p>
        )}
      </div>

      <div className="mod">
        <div className="t">
          <b>Глубина тепловой карты</b>
          <span style={{ whiteSpace: "normal" }}>
            За сколько дней считать активность клиентов. Меньше месяца — мало событий на 168 клеток недели, больше
            трёх — в расчёт попадает прошлый сезон, а спрос на жильё сезонный.
          </span>
        </div>
        <div className="acts">
          <span className="nf">
            <input
              type="number"
              min={7}
              max={365}
              inputMode="numeric"
              aria-label="Дней в тепловой карте"
              defaultValue={days}
              disabled={updateSettings.isPending}
              onBlur={(e) => {
                const n = Number(e.target.value);
                if (Number.isInteger(n) && n >= 7 && n <= 365 && n !== days) {
                  updateSettings.mutate({ publishScheduleHeatmapDays: n });
                }
              }}
            />
            <span className="u">дней</span>
          </span>
        </div>
      </div>

      <div className="mod">
        <div className="t">
          <b>Насколько раньше часа пик выкладывать</b>
          <span style={{ whiteSpace: "normal" }}>
            Пост должен успеть разойтись до того, как аудитория выйдет в сеть. Ноль — публиковать ровно в час пик.
          </span>
        </div>
        <div className="acts">
          <span className="nf">
            <input
              type="number"
              min={0}
              max={6}
              inputMode="numeric"
              aria-label="Часов до пика"
              defaultValue={lead}
              disabled={updateSettings.isPending}
              onBlur={(e) => {
                const n = Number(e.target.value);
                if (Number.isInteger(n) && n >= 0 && n <= 6 && n !== lead) {
                  updateSettings.mutate({ publishScheduleLeadHours: n });
                }
              }}
            />
            <span className="u">часа</span>
          </span>
        </div>
      </div>
    </>
  );
}

/** Куда станция звонит сотруднику перед соединением с клиентом. */
const AGENT_DIAL_MODES = [
  {
    value: "auto",
    title: "Сам выберет (рекомендуется)",
    hint: "Аппарат сотрудника на связи — звоним на него бесплатно; выключен — на мобильный.",
  },
  {
    value: "mobile",
    title: "На мобильный сотрудника",
    hint: "Ничего устанавливать не нужно. Оплачиваются два плеча: до сотрудника и до клиента.",
  },
  {
    value: "extension",
    title: "На внутренний номер (софтфон)",
    hint: "Плечо до сотрудника бесплатное. Нужен софтфон на телефоне или IP-аппарат на столе.",
  },
] as const;

function AgentDialModeSetting() {
  const { data: settings } = useSettings();
  const updateSettings = useUpdateSettings();
  const mode = settings?.asteriskAgentDialMode ?? "mobile";
  const current = AGENT_DIAL_MODES.find((m) => m.value === mode);

  return (
    <div className="mod" style={{ display: "block" }}>
      <div className="t">
        <b>Куда звонить сотруднику</b>
        <span style={{ whiteSpace: "normal" }}>
          При звонке из CRM станция сначала звонит самому сотруднику, а после ответа соединяет с клиентом. Клиент в
          обоих случаях видит номер агентства, личный номер сотрудника ему не показывается.
        </span>
      </div>
      <div className="hscroll" style={{ marginTop: "var(--s2)" }}>
        <div className="seg" role="group" aria-label="Куда звонить сотруднику">
          {AGENT_DIAL_MODES.map((option) => (
            <button
              key={option.value}
              type="button"
              title={option.hint}
              aria-selected={mode === option.value}
              onClick={() => updateSettings.mutate({ asteriskAgentDialMode: option.value })}
            >
              {option.title}
            </button>
          ))}
        </div>
      </div>
      <p className="msg" style={{ color: "var(--faint)" }}>
        {current?.hint}
      </p>
    </div>
  );
}

/**
 * КРОССПОСТИНГ НА ПАРТНЁРСКИЕ СТРАНИЦЫ FACEBOOK (28.09.2026, agent brief
 * docs/agent-briefs/facebook-crosspost-28-09.md, серверная часть —
 * lib/facebookCrosspost.ts). Список id — тем же приёмом, что «Откуда станция
 * отдаёт входящие» ниже: textarea по строке, весь список виден сразу.
 *
 * Сама связь Страниц настраивается не в CRM (владелец подтверждает её один раз
 * у партнёра в Settings → Crossposting) — «Проверить» лишь показывает, какие
 * из введённых id уже подтверждены, через GET /marketing/facebook-crosspost-check.
 */
const MAX_FACEBOOK_CROSSPOST_PAGES = 20;

/** Textarea → список id: по одному в строке, пустые строки и повторы отбрасываются. */
function parseFacebookCrosspostPageIds(text: string): string[] {
  const list = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return [...new Set(list)];
}

interface FacebookCrosspostCheckRow {
  id: string;
  name: string | null;
  confirmed: boolean;
}

function FacebookCrosspostSetting({
  value,
  pending,
  onSave,
}: {
  value: string[];
  pending: boolean;
  onSave: (list: string[]) => void;
}) {
  const [draft, setDraft] = useState(value.join("\n"));
  const parsed = parseFacebookCrosspostPageIds(draft);
  const changed = parsed.join("\n") !== value.join("\n");
  const tooMany = parsed.length > MAX_FACEBOOK_CROSSPOST_PAGES;
  const badId = parsed.find((id) => !/^\d{5,20}$/.test(id));
  const error = tooMany
    ? `Слишком много строк: не больше ${MAX_FACEBOOK_CROSSPOST_PAGES}.`
    : badId
      ? `Id Страницы — только цифры (не похоже: «${badId}»).`
      : null;

  const [checking, setChecking] = useState(false);
  const [checkResult, setCheckResult] = useState<FacebookCrosspostCheckRow[] | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);

  const runCheck = async () => {
    setChecking(true);
    setCheckError(null);
    try {
      const res = await api<{ pages: FacebookCrosspostCheckRow[] }>("/marketing/facebook-crosspost-check");
      setCheckResult(res.pages);
    } catch (err) {
      setCheckError(err instanceof Error ? err.message : "Не удалось проверить");
      setCheckResult(null);
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className={error ? "fld bad" : "fld"} style={{ marginTop: "var(--s4)" }}>
      <span className="lab">Партнёрские Страницы для кросспостинга (id по одному в строке)</span>
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        rows={4}
        spellCheck={false}
        placeholder={"102929531407747"}
        aria-label="Id партнёрских Страниц Facebook для кросспостинга"
      />
      <span className="msg">
        {error ??
          "Партнёр один раз подтверждает связь у себя: Настройки Страницы → Crossposting. После публикации ролика он увидит его во вкладке Crossposted videos и опубликует одной кнопкой."}
      </span>
      <div className="wrap" style={{ marginTop: "var(--s2)" }}>
        <button className="pill" type="button" onClick={() => onSave(parsed)} disabled={!changed || !!error || pending}>
          Сохранить
        </button>
        <button className="pill ghost" type="button" onClick={runCheck} disabled={checking || value.length === 0}>
          {checking ? "Проверяю…" : "Проверить"}
        </button>
      </div>
      {checkError && (
        <div className="quiet crit">
          <span className="dot crit" />
          <span className="txt">{checkError}</span>
        </div>
      )}
      {checkResult && (
        <div className="acts" style={{ flexWrap: "wrap", marginTop: "var(--s2)" }}>
          {checkResult.length === 0 && <span className="chip mute">Список пуст</span>}
          {checkResult.map((row) => (
            <span key={row.id} className={row.confirmed ? "chip ok" : "chip crit"} title={row.id}>
              <span>{row.name ?? row.id}</span>
              <span>{row.confirmed ? "подтверждена" : "не подтверждена"}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * КОНТЕКСТЫ ВХОДЯЩИХ — единственная настройка телефонии, которую задаёт не CRM,
 * а чужая система: имя контекста диалплана живёт в FreePBX и меняется без выката.
 * Один такой случай уже стоил недели потерянных входящих (11.08.2026), после чего
 * список переехал из константы в Настройки — но до сих пор задавался только
 * запросом к API, то есть для владельца был недоступен.
 *
 * Копия встроенного списка ЗДЕСЬ — намеренно текстом, а не новым роутом ради
 * четырёх слов: человеку нужно видеть, что именно работает, когда поле пусто.
 * Источник правды — apps/api/src/lib/telephony/incomingCalls.ts
 * (DEFAULT_INBOUND_CONTEXT_PREFIXES + DEFAULT_INBOUND_CONTEXTS_EXACT).
 */
const DEFAULT_INBOUND_CONTEXTS_HINT = "from-trunk, from-pstn, from-did-direct, from-sip-external, ext-queues";

/** Пределы те же, что в Zod-схеме PATCH /settings: 50 строк, 100 символов на строку. */
const MAX_INBOUND_CONTEXTS = 50;
const MAX_INBOUND_CONTEXT_LENGTH = 100;

/** Один чат из ответа GET /marketing/telegram-chats-check. */
interface TelegramChatCheckResult {
  chatId: string;
  title: string | null;
  canWrite: boolean;
  error?: string;
}

/**
 * ДОПОЛНИТЕЛЬНЫЕ ЧАТЫ TELEGRAM (26.09.2026, «ролик уходит в несколько
 * Telegram-групп»). Текстом, по строке на чат — тот же формат, что у
 * InboundContextsSetting ниже: значение вводят один раз, но переносят его
 * глазами из чужого списка, textarea читается целиком. Сервер сам разбирает,
 * чистит и проверяет формат (lib/telegramChats.ts::parseTelegramChatIds) —
 * здесь дублировать регулярки незачем, только показать сохранённый текст и
 * кнопку «Проверить» (GET /marketing/telegram-chats-check — тот же
 * getChat/getChatMember, что суточная самопроверка).
 */
function TelegramExtraChatsSetting({
  value,
  pending,
  onSave,
}: {
  value: string;
  pending: boolean;
  onSave: (value: string | null) => void;
}) {
  const [draft, setDraft] = useState(value);
  // Тот же приём, что PlainSetting ниже (аудит 22.08.2026, раунд 6): черновик
  // догоняет сервер, пока человек не начал печатать, иначе пустой первый ответ
  // навсегда перекрывает то, что реально сохранено.
  const touched = useRef(false);
  useEffect(() => {
    if (!touched.current) setDraft(value);
  }, [value]);

  const [checking, setChecking] = useState(false);
  const [checkResult, setCheckResult] = useState<{ configured: boolean; chats: TelegramChatCheckResult[] } | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);

  const changed = draft !== value;

  async function handleCheck() {
    setChecking(true);
    setCheckError(null);
    try {
      setCheckResult(await api<{ configured: boolean; chats: TelegramChatCheckResult[] }>("/marketing/telegram-chats-check"));
    } catch (err) {
      setCheckError(err instanceof Error ? err.message : "Не удалось проверить");
    } finally {
      setChecking(false);
    }
  }

  return (
    <div className="fld" style={{ marginTop: "var(--s4)" }}>
      <span className="lab">Дополнительные группы и каналы</span>
      <textarea
        value={draft}
        onChange={(e) => {
          touched.current = true;
          setDraft(e.target.value);
        }}
        rows={4}
        spellCheck={false}
        placeholder={"-1001234567890\n@my_realty_group"}
        aria-label="Дополнительные чаты Telegram"
      />
      <span className="msg">
        Добавьте бота в группу с правом писать и вставьте номер чата (у групп он начинается с -100) или @имя, по одному в строке. Основной канал выше
        остаётся как есть.
      </span>
      <div className="wrap" style={{ marginTop: "var(--s2)" }}>
        <button
          className="pill"
          type="button"
          onClick={() => {
            touched.current = false;
            onSave(draft.trim() ? draft : null);
          }}
          disabled={!changed || pending}
        >
          Сохранить
        </button>
        <button className="pill ghost" type="button" onClick={handleCheck} disabled={checking}>
          {checking ? "Проверяем…" : "Проверить"}
        </button>
      </div>
      {checkError && (
        <div className="quiet warn">
          <span className="dot warn" />
          <span className="txt">{checkError}</span>
        </div>
      )}
      {checkResult && (
        <div className="quiet" style={{ marginTop: "var(--s2)" }}>
          <span className="txt">
            {checkResult.chats.length === 0
              ? "Дополнительных чатов не настроено — сохраните список выше и нажмите «Проверить» ещё раз."
              : checkResult.chats
                  .map(
                    (c) =>
                      `${c.title ?? c.chatId}: ${c.canWrite ? "бот может писать" : `не может писать (${c.error ?? "неизвестная причина"})`}`
                  )
                  .join("; ")}
          </span>
        </div>
      )}
    </div>
  );
}

/** Текст textarea → список контекстов: по одному в строке, пустые строки и повторы отбрасываются. */
function parseInboundContexts(text: string): string[] {
  const list = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return [...new Set(list)];
}

/**
 * Список контекстов входящих: textarea по строке на контекст — тот же формат,
 * что у остальных построчных настроек («Чем не занимаемся» во вкладке «Бот»).
 * Чипы здесь были бы хуже: значение вводят один раз, зато переносят его глазами
 * из чужой панели, а из textarea видно сразу весь список.
 */
function InboundContextsSetting({
  value,
  pending,
  onSave,
}: {
  value: string[];
  pending: boolean;
  onSave: (list: string[]) => void;
}) {
  const [draft, setDraft] = useState(value.join("\n"));
  const parsed = parseInboundContexts(draft);
  const changed = parsed.join("\n") !== value.join("\n");
  const tooMany = parsed.length > MAX_INBOUND_CONTEXTS;
  const tooLong = parsed.find((entry) => entry.length > MAX_INBOUND_CONTEXT_LENGTH);
  const error = tooMany
    ? `Слишком много строк: не больше ${MAX_INBOUND_CONTEXTS}.`
    : tooLong
      ? `Слишком длинное имя контекста: не больше ${MAX_INBOUND_CONTEXT_LENGTH} символов.`
      : null;

  return (
    <div className={error ? "fld bad" : "fld"} style={{ marginTop: "var(--s4)" }}>
      <span className="lab">Откуда станция отдаёт входящие</span>
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        rows={4}
        spellCheck={false}
        placeholder={"from-trunk\next-queues"}
        aria-label="Контексты входящих звонков"
      />
      <span className="msg">
        {error ??
          "Имена контекстов из настроек АТС — по ним CRM понимает, что звонок пришёл снаружи, а не уходит от нас. По одному в строке. Сравнение идёт по началу имени, поэтому строка from-trunk покрывает и from-trunk-sip-out."}
      </span>
      <div className="wrap" style={{ marginTop: "var(--s2)" }}>
        <button className="pill" type="button" onClick={() => onSave(parsed)} disabled={!changed || !!error || pending}>
          Сохранить
        </button>
        {value.length > 0 && (
          <button
            className="pill ghost"
            type="button"
            disabled={pending}
            onClick={() => {
              setDraft("");
              onSave([]);
            }}
          >
            Вернуть встроенные
          </button>
        )}
      </div>
      <div className="quiet">
        <span className="dot" />
        <span className="txt">
          {/*
            Подсказка говорит о СОХРАНЁННОМ значении, а человек смотрит на поле. Пока
            набранное не сохранено, «поле пустое» рядом с непустым полем читается как
            враньё — поэтому у неподтверждённого набора свой, третий текст.
          */}
          {value.length === 0 && parsed.length > 0
            ? `Набранное ещё не сохранено — пока работает встроенный список: ${DEFAULT_INBOUND_CONTEXTS_HINT}.`
            : value.length === 0
              ? `Сейчас поле пустое — работает встроенный список: ${DEFAULT_INBOUND_CONTEXTS_HINT}. Пока входящие доходят, менять здесь нечего.`
              : `Свой список заменяет встроенный целиком, поэтому очередь ext-queues вписывают руками. Встроенный был: ${DEFAULT_INBOUND_CONTEXTS_HINT}.`}
        </span>
      </div>
      <div className="quiet warn">
        <span className="dot warn" />
        <span className="txt">
          Значение спрашивают у того, кто настраивал станцию. Неверное — и входящие звонки перестают доходить в CRM:
          не будет ни журнала входящих, ни окна оператора, ни задач по пропущенным, хотя на самой станции звонки идут
          как обычно.
        </span>
      </div>
    </div>
  );
}

/**
 * ГРУППЫ FACEBOOK ДЛЯ РУЧНОЙ РАЗДАЧИ (28.09.2026, docs/agent-briefs/facebook-groups-share-28-09.md).
 * Тот же формат, что InboundContextsSetting — textarea по строке, «Сохранить» —
 * только строка вида «Название | ссылка», а не голый контекст. Пределы те же,
 * что в Zod-схеме PATCH /settings (routes/settings.ts): 50 строк, 300 символов.
 */
const MAX_SHARE_GROUPS = 50;
const MAX_SHARE_GROUP_LENGTH = 300;

function FacebookGroupsSetting({
  value,
  pending,
  onSave,
}: {
  value: string[];
  pending: boolean;
  onSave: (list: string[]) => void;
}) {
  const [draft, setDraft] = useState(value.join("\n"));
  const parsed = draft
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const changed = parsed.join("\n") !== value.join("\n");
  const tooMany = parsed.length > MAX_SHARE_GROUPS;
  const tooLong = parsed.find((entry) => entry.length > MAX_SHARE_GROUP_LENGTH);
  const badLine = parsed.find((entry) => !entry.includes("|") || entry.split("|")[1]?.trim().length === 0);
  const error = tooMany
    ? `Слишком много строк: не больше ${MAX_SHARE_GROUPS}.`
    : tooLong
      ? `Слишком длинная строка: не больше ${MAX_SHARE_GROUP_LENGTH} символов.`
      : badLine
        ? `Формат строки: «Название | ссылка». Не хватает разделителя «|» или ссылки: «${badLine}».`
        : null;

  return (
    <div className={error ? "fld bad" : "fld"} style={{ marginTop: "var(--s4)" }}>
      <span className="lab">Группы для раздачи</span>
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        rows={4}
        spellCheck={false}
        placeholder={"Недвижимость Душанбе | https://www.facebook.com/groups/123456789\nКупи-продай квартиры | https://www.facebook.com/groups/987654321"}
        aria-label="Группы Facebook для раздачи объектов"
      />
      <span className="msg">
        {error ??
          "Публикует человек: CRM копирует текст и открывает группу. Текст для каждой группы свой, чтобы Facebook не считал спамом. По одной группе в строке."}
      </span>
      <div className="wrap" style={{ marginTop: "var(--s2)" }}>
        <button className="pill" type="button" onClick={() => onSave(parsed)} disabled={!changed || !!error || pending}>
          Сохранить
        </button>
      </div>
      <div className="quiet">
        <span className="dot" />
        <span className="txt">
          {value.length === 0
            ? "Список пуст — блок «Раздать по группам Facebook» в карточке объекта и строка в утренней сводке директора не показываются."
            : `Групп в списке: ${value.length}.`}
        </span>
      </div>
    </div>
  );
}

/** Обычное (несекретное) поле настройки с кнопкой сохранения. Разметка — `.fld`
 *  эталона: подпись `.lab`, поле, пояснение `.msg`. */
export function PlainSetting({
  title,
  description,
  placeholder,
  value,
  pending,
  onSave,
}: {
  title: string;
  description: string;
  placeholder: string;
  value: string;
  pending: boolean;
  onSave: (value: string) => void;
}) {
  /**
   * ЧЕРНОВИК ДОГОНЯЕТ СЕРВЕР, ПОКА ЧЕЛОВЕК НЕ НАЧАЛ ПРАВИТЬ (аудит 22.08.2026,
   * раунд 6). Это была НАСТОЯЩАЯ ПОТЕРЯ НАСТРОЕК, а не только косметика.
   *
   * `useState(value)` берёт значение ОДИН раз при монтировании. Вкладка
   * рисуется раньше, чем приходит ответ `/settings`, то есть первым значением
   * почти всегда была пустая строка — и она оставалась в поле навсегда, даже
   * когда настройки приезжали. Дальше `changed` считался как «пусто ≠
   * act_751587752930155» → кнопка «Сохранить» АКТИВНА, и один клик записывал
   * пустую строку поверх рабочего идентификатора кабинета, адреса ARI, логина
   * AMI, номера страницы Facebook и так далее.
   *
   * Зависимость — на СТРОКУ `value`, а не на объект настроек: объект
   * пересоздаётся каждые 25 секунд опросом (queryClient.ts), и эффект по нему
   * стирал бы набранное посреди слова. Тот же приём уже стоит в BotTab.tsx.
   * `touched` дополнительно запирает синхронизацию, как только человек начал
   * печатать: пришедший в этот момент ответ сервера не должен трогать его текст.
   */
  const [draft, setDraft] = useState(value);
  const [touched, setTouched] = useState(false);
  useEffect(() => {
    if (!touched) setDraft(value);
  }, [value, touched]);
  const changed = draft.trim() !== value;
  return (
    <div className="fld" style={{ marginTop: "var(--s4)" }}>
      <span className="lab">{title}</span>
      <input
        value={draft}
        onChange={(e) => {
          setTouched(true);
          setDraft(e.target.value);
        }}
        placeholder={placeholder}
        aria-label={title}
      />
      <span className="msg">{description}</span>
      <div className="wrap" style={{ marginTop: "var(--s2)" }}>
        <button
          className="pill"
          type="button"
          onClick={() => {
            onSave(draft.trim());
            // Сохранили — снова следуем за сервером: ответ подтвердит записанное,
            // а чужая правка того же поля больше не будет заблокирована.
            setTouched(false);
          }}
          disabled={!touched || !changed || pending}
        >
          Сохранить
        </button>
      </div>
    </div>
  );
}

/**
 * «ЧЕРЕЗ СКОЛЬКО ЧАСОВ ПОСЛЕ ОДОБРЕНИЯ» — фото-посты (28.09.2026, agent-brief.md).
 * Тот же приём, что у «Минимум между публикациями» в PublishScheduleSection ниже:
 * обычный `<input type="number">` с фиксацией на `onBlur`, без черновика/кнопки —
 * значение маленькое и меняется редко, лишний «Сохранить» здесь не нужен.
 */
function PhotoPostAfterHoursField({ value, pending, onSave }: { value: number; pending: boolean; onSave: (hours: number) => void }) {
  return (
    <div className="mod" style={{ marginTop: "var(--s2)" }}>
      <div className="t">
        <b>Через сколько часов после одобрения</b>
        <span>Ролик обычно успевает за сутки — фото-пост не обгоняет его совсем свежим объектам.</span>
      </div>
      <div className="acts">
        <span className="nf">
          <input
            type="number"
            min={1}
            max={720}
            inputMode="numeric"
            aria-label="Часов после одобрения"
            defaultValue={value}
            disabled={pending}
            onBlur={(e) => {
              const n = Number(e.target.value);
              if (Number.isInteger(n) && n >= 1 && n <= 720 && n !== value) onSave(n);
            }}
          />
          <span className="u">часов</span>
        </span>
      </div>
    </div>
  );
}

/** «Через N дней» / «не больше N раз» — те же два числовых поля рядом, что
 *  просит задание §3 (28.09.2026, agent-brief.md reposts-digests). */
function RepostRulesFields({
  afterDays,
  maxRounds,
  pending,
  onSaveAfterDays,
  onSaveMaxRounds,
}: {
  afterDays: number;
  maxRounds: number;
  pending: boolean;
  onSaveAfterDays: (days: number) => void;
  onSaveMaxRounds: (rounds: number) => void;
}) {
  return (
    <div className="mod" style={{ marginTop: "var(--s2)" }}>
      <div className="t">
        <b>Через сколько дней и сколько раз</b>
        <span>Каждый круг — новый текст, а при снижении цены с прошлого показа — крючок про новую цену.</span>
      </div>
      <div className="acts">
        <span className="nf">
          <input
            type="number"
            min={1}
            max={180}
            inputMode="numeric"
            aria-label="Через сколько дней"
            defaultValue={afterDays}
            disabled={pending}
            onBlur={(e) => {
              const n = Number(e.target.value);
              if (Number.isInteger(n) && n >= 1 && n <= 180 && n !== afterDays) onSaveAfterDays(n);
            }}
          />
          <span className="u">дней</span>
        </span>
        <span className="nf">
          <input
            type="number"
            min={1}
            max={20}
            inputMode="numeric"
            aria-label="Не больше раз"
            defaultValue={maxRounds}
            disabled={pending}
            onBlur={(e) => {
              const n = Number(e.target.value);
              if (Number.isInteger(n) && n >= 1 && n <= 20 && n !== maxRounds) onSaveMaxRounds(n);
            }}
          />
          <span className="u">раз максимум</span>
        </span>
      </div>
    </div>
  );
}

const WEEKDAY_NAMES = ["воскресенье", "понедельник", "вторник", "среда", "четверг", "пятница", "суббота"];

/** День недели (0-6, как Date#getDay) и час по Душанбе — та же пара полей,
 *  что у ежедневной подборки сторис выше, плюс выбор дня. */
function DigestScheduleFields({
  weekday,
  hour,
  pending,
  onSaveWeekday,
  onSaveHour,
}: {
  weekday: number;
  hour: number;
  pending: boolean;
  onSaveWeekday: (weekday: number) => void;
  onSaveHour: (hour: number) => void;
}) {
  return (
    <div className="mod" style={{ marginTop: "var(--s2)" }}>
      <div className="t">
        <b>День и час публикации</b>
        <span>По времени Душанбе.</span>
      </div>
      <div className="acts">
        <span className="nf">
          <select
            aria-label="День недели"
            defaultValue={weekday}
            disabled={pending}
            onChange={(e) => {
              const n = Number(e.target.value);
              if (n !== weekday) onSaveWeekday(n);
            }}
          >
            {WEEKDAY_NAMES.map((name, idx) => (
              <option key={idx} value={idx}>
                {name}
              </option>
            ))}
          </select>
        </span>
        <span className="nf">
          <input
            type="number"
            min={0}
            max={23}
            inputMode="numeric"
            aria-label="Час публикации (Душанбе)"
            defaultValue={hour}
            disabled={pending}
            onBlur={(e) => {
              const n = Number(e.target.value);
              if (Number.isInteger(n) && n >= 0 && n <= 23 && n !== hour) onSaveHour(n);
            }}
          />
          <span className="u">час (Душанбе)</span>
        </span>
      </div>
    </div>
  );
}

/**
 * ПРОВЕРКА СТАТИСТИКИ INSTAGRAM (21.09.2026). Права на статистику выдаются в
 * кабинете Meta, а видно ли их маркеру — знает только сервер: маркер хранится
 * зашифрованным, и с рабочего места его никто не читает. Кнопка спрашивает
 * сервер и показывает ответ словами, а не кодом ошибки Meta.
 */
function InstagramInsightsTestButton({ configured }: { configured: boolean }) {
  const test = useTestInstagramInsights();
  const result = test.data;
  return (
    <div className="wrap" style={{ marginTop: "var(--s4)" }}>
      <button className="pill ghost" type="button" onClick={() => test.mutate()} disabled={!configured || test.isPending}>
        {test.isPending ? "Проверяю…" : "Проверить статистику"}
      </button>
      {result && (
        <span className={result.ok ? "saved on" : "saved"} style={result.ok ? undefined : { color: "var(--crit)" }}>
          {result.ok
            ? `Статистика доступна${result.username ? ` для ${result.username}` : ""}: часов с числами — ${result.hours ?? 0}`
            : (result.error ?? "Статистика недоступна")}
        </span>
      )}
      {result?.source && (
        <span className="saved">
          Проверен маркер аккаунта «{result.source}» из списка выше — это поле сейчас запасное.
        </span>
      )}
      {!configured && (
        <span className="saved">Сначала добавьте аккаунт Instagram в список выше или сохраните маркер Instagram.</span>
      )}
    </div>
  );
}

/** Кнопка «Проверить связь» с сервером Asterisk ARI — использует уже СОХРАНЁННЫЕ
 *  креды (см. POST /settings/asterisk-test), не то, что сейчас в полях формы выше. */
function AsteriskTestButton({ configured }: { configured: boolean }) {
  const test = useTestAsteriskConnection();
  return (
    <>
      <div className="wrap" style={{ marginTop: "var(--s4)" }}>
        <button className="pill ghost" type="button" onClick={() => test.mutate()} disabled={!configured || test.isPending}>
          {test.isPending ? "Проверяю…" : "Проверить связь"}
        </button>
        {test.data && (
          <span className={test.data.ok ? "saved on" : "saved"} style={test.data.ok ? undefined : { color: "var(--crit)" }}>
            {test.data.ok ? `Связь есть, Asterisk ${test.data.version ?? ""}` : test.data.error}
          </span>
        )}
      </div>
      {!configured && (
        <div className="quiet">
          <span className="dot" />
          <span className="txt">Заполните и сохраните URL, логин и пароль выше.</span>
        </div>
      )}
      {test.isError && (
        <div className="quiet crit" role="alert">
          <span className="dot crit" />
          <span className="txt">Не удалось проверить связь</span>
        </div>
      )}
    </>
  );
}

/**
 * ФИД КАТАЛОГА META ДЛЯ РЕКЛАМЫ (Advantage+ catalog ads, home_listings, 28.09.2026).
 *
 * Реклама сама (кабинет, бюджет, включить показы) — дело владельца в Commerce
 * Manager, наша часть только фид: тумблер и одноразовая ссылка с ключом, тем же
 * приёмом, что и ключ станции подсказок ниже («показывается один раз, дальше
 * только маска» — CallWhisperSetting). Счётчик в бейдже — сколько объектов
 * реально уйдёт в CSV прямо сейчас (GET /marketing/meta-catalog-feed/status).
 */
function MetaCatalogFeedSection() {
  const { data: settings } = useSettings();
  const updateSettings = useUpdateSettings();
  const { data: status } = useMetaCatalogFeedStatus();
  const rotateKey = useRotateMetaCatalogFeedKey();
  const [issued, setIssued] = useState<{ key: string; url: string | null } | null>(null);
  const [copied, setCopied] = useState(false);

  const enabled = settings?.metaCatalogFeedEnabled ?? false;

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Буфер обмена недоступен — ссылка всё равно видна текстом, можно скопировать руками.
    }
  }

  async function rotate() {
    const result = await rotateKey.mutateAsync();
    setIssued(result);
    if (result.url) void copy(result.url);
  }

  return (
    <SettingsSection
      icon={Megaphone}
      title="Фид каталога для рекламы Meta"
      badge={enabled ? `в фиде ${status?.count ?? "…"} объектов` : "выключено"}
    >
      <SwitchRow
        title="Отдавать фид каталога"
        on={enabled}
        hint={
          enabled
            ? "Meta забирает CSV по ссылке ниже раз в час — все объекты в продаже уходят в Advantage+ catalog ads."
            : "Ссылка ниже отвечает 404 всем, даже с верным ключом."
        }
        onToggle={() => updateSettings.mutate({ metaCatalogFeedEnabled: !enabled })}
      />

      {enabled && (
        <div className="card flat">
          <div className="sec-h stack">
            <h2>Ссылка на фид</h2>
            <span className="note">
              Commerce Manager → Каталоги → Недвижимость → Источники данных → Запланированный фид: вставьте ссылку,
              обновление раз в час.
            </span>
          </div>
          <div className="wrap" style={{ marginTop: "var(--s3)" }}>
            <button className="pill ghost sm" type="button" onClick={rotate} disabled={rotateKey.isPending}>
              {settings?.metaCatalogFeedKeyMasked ? "Обновить ключ" : "Сгенерировать ключ"}
            </button>
            {settings?.metaCatalogFeedKeyMasked && !issued && (
              <span className="saved">
                Ключ {settings.metaCatalogFeedKeyMasked}. Показать ссылку снова нельзя — только выпустить новую.
              </span>
            )}
          </div>
          {issued?.url && (
            <div className="quiet crit">
              <span className="dot crit" />
              <span className="txt">
                Скопируйте сейчас — второй раз ссылка не показывается.{" "}
                <code style={{ wordBreak: "break-all" }}>{issued.url}</code>
              </span>
              <button className="pill ghost sm" type="button" onClick={() => copy(issued.url as string)}>
                {copied ? "Скопировано" : "Скопировать"}
              </button>
            </div>
          )}
          {issued && !issued.url && (
            <div className="quiet crit">
              <span className="dot crit" />
              <span className="txt">
                Ключ выпущен, но на сервере не настроен CRM_PUBLIC_URL — полную ссылку собрать не удалось. Соберите
                вручную: .../api/v1/public/meta-catalog/home-listings.csv?key={issued.key}
              </span>
            </div>
          )}
        </div>
      )}
    </SettingsSection>
  );
}

/**
 * УПРАВЛЕНИЕ СТАНЦИЕЙ (AMI) — второй доступ к той же АТС, и это не дубль настройки.
 *
 * Через ARI (выше) CRM ЗВОНИТ: набирает, сбрасывает, слушает события. Менять
 * поведение станции он не умеет вовсе. Всё, ради чего заведён этот раздел, —
 * правило «если оператор не ответил», кнопка «отошёл» и чёрный список — делается
 * только через AMI. Без него телефония работает как раньше, но перечисленное
 * остаётся недоступным, и интерфейс обязан объяснять это, а не молчать.
 *
 * Адрес не спрашивается намеренно: станция одна, хост берётся из адреса ARI. Два
 * поля с одним адресом рано или поздно разъезжаются руками.
 */
function AmiSection() {
  const { data: settings } = useSettings();
  const updateSettings = useUpdateSettings();
  // silent: пароль ниже — SecretKeyEditor со своей плашкой, Логин/Порт рядом остаются на тосте.
  const updateSecretKey = useUpdateSettings({ silent: true });
  const test = useTestAsteriskAmi();
  const configured = !!settings?.asteriskAmiConfigured;

  return (
    <SettingsSection icon={Server} title="Управление станцией из CRM (AMI)" badge={configured ? "настроено" : "не настроено"}>
      <div className="quiet">
        <span className="dot" />
        <span className="txt">
          Отдельный доступ к той же АТС (интерфейс управления, порт 5038). Нужен, чтобы менять настройки телефонии
          отсюда: куда уводить непринятый звонок, кто из операторов сейчас на месте, какие номера считать спамом.
          Звонки работают и без него.
        </span>
      </div>
      <div className="quiet warn">
        <span className="dot warn" />
        <span className="txt">
          Пользователя для CRM заводят на станции с урезанными правами — без доступа к её командной строке. Иначе одна
          дыра в CRM означает угнанную телефонию агентства.
        </span>
      </div>

      <PlainSetting
        title="Логин"
        description="Пользователь из manager.conf на станции — тот, что заведён специально для CRM."
        placeholder="royalhome-crm"
        value={settings?.asteriskAmiUsername ?? ""}
        pending={updateSettings.isPending}
        onSave={(v) => updateSettings.mutate({ asteriskAmiUsername: v })}
      />

      <SecretKeyEditor
        title="Пароль"
        description="Пароль того же пользователя. Хранится в базе зашифрованным."
        placeholder="Пароль пользователя AMI"
        configured={settings ? !!settings.asteriskAmiPasswordMasked : undefined}
        masked={settings?.asteriskAmiPasswordMasked}
        source={settings?.asteriskAmiPasswordMasked ? "settings" : null}
        onSave={(v) => updateSecretKey.mutateAsync({ asteriskAmiPassword: v })}
        onClear={() => updateSecretKey.mutateAsync({ asteriskAmiPassword: "" })}
      />

      <PortSetting
        key={settings?.asteriskAmiPort ?? 5038}
        value={settings?.asteriskAmiPort ?? 5038}
        pending={updateSettings.isPending}
        onSave={(port) => updateSettings.mutate({ asteriskAmiPort: port })}
      />

      <div className="wrap" style={{ marginTop: "var(--s4)" }}>
        <button className="pill ghost" type="button" onClick={() => test.mutate()} disabled={!configured || test.isPending}>
          {test.isPending ? "Проверяю…" : "Проверить и применить"}
        </button>
        {test.data && (
          <span className={test.data.ok ? "saved on" : "saved"} style={test.data.ok ? undefined : { color: "var(--crit)" }}>
            {test.data.ok ? "Связь есть, настройки записаны в станцию" : test.data.error}
          </span>
        )}
      </div>
      {!configured && (
        <div className="quiet">
          <span className="dot" />
          <span className="txt">Заполните логин и пароль выше — адрес берётся из настроек ARI.</span>
        </div>
      )}
      {test.isError && (
        <div className="quiet crit" role="alert">
          <span className="dot crit" />
          <span className="txt">Не удалось проверить связь</span>
        </div>
      )}
    </SettingsSection>
  );
}

// LiveVoiceSection/LiveVoiceOutboundTestCall переехали в BotTab.tsx (13.09.2026,
// см. комментарий у места их прежнего рендера выше). PlainSetting/WHISPER_VOICES
// ниже экспортированы — BotTab их импортирует, чтобы не заводить вторую копию.

/*
 * Раздела «Звонки прямо в браузере» здесь больше нет (владелец 18.08.2026).
 * Браузерный софтфон удалён целиком вместе с рабочим местом оператора входящих:
 * звонки уходят прямо агентам на мобильный, куда дозванивается станция. Настройки
 * адреса соединения и передатчика звука обслуживали только его, и без трубки в
 * браузере настраивать ими нечего.
 */

/**
 * Порт управления станцией. Отдельным полем, а не общим PlainSetting: там кнопка
 * «Сохранить» осталась бы активной на «пять тысяч» и молча ничего не делала —
 * худший вид отказа, когда человек не понимает, сохранилось у него или нет.
 */
function PortSetting({
  value,
  pending,
  onSave,
}: {
  value: number;
  pending: boolean;
  onSave: (port: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  const port = Number(draft);
  const valid = Number.isInteger(port) && port > 0 && port < 65536;
  return (
    <div className={valid ? "mod" : "mod bad"}>
      <div className="t">
        <b>Порт</b>
        <span>5038 — стандартный. Менять только если на станции его изменили.</span>
      </div>
      <div className="acts">
        <span className="nf">
          <input value={draft} onChange={(e) => setDraft(e.target.value)} inputMode="numeric" placeholder="5038" aria-label="Порт AMI" />
        </span>
        <button className="pill sm" type="button" onClick={() => onSave(port)} disabled={!valid || port === value || pending}>
          Сохранить
        </button>
      </div>
      {!valid && <p className="msg">Порт — число от 1 до 65535.</p>}
    </div>
  );
}

/**
 * «Входящие звонки» — рабочее место оператора, настраиваемое без правки кода.
 *
 * Владелец 10.08.2026: входящие принимает один админ (Нурмухаммад), позже операторов
 * станет больше. Поэтому здесь СПИСОК СОТРУДНИКОВ, а не роль: роль означает права в
 * CRM, а не то, у кого на столе звонит телефон, и наём оператора не должен требовать
 * выката кода.
 *
 * Переадресация тут только ЗАПИСЫВАЕТСЯ. Уводит звонок сама АТС (Fail Over очереди),
 * и это не упрощение, а замысел: правило обязано срабатывать именно тогда, когда CRM
 * недоступна — иначе лежащая CRM утащила бы за собой и телефонию.
 */
/** Три настройки рабочего места оператора — списком, с текстом на каждое положение. */
const INCOMING_TOGGLES = [
  {
    field: "incomingAutoCreateClient",
    title: "Заводить карточку по незнакомому номеру",
    onHint: "Звонок с номера, которого нет в базе, сразу становится карточкой клиента.",
    offHint: "Такие звонки остаются только в журнале входящих (курьеры, реклама).",
  },
  {
    field: "incomingAssignOnQualify",
    title: "Передавать агенту сразу после выбора типа обращения",
    onHint: "Как только оператор выбрал тип обращения, карточка уходит агенту очередью по KPI.",
    offHint: "Карточка ждёт, пока руководитель назначит ответственного сам.",
  },
  {
    field: "incomingPanelEnabled",
    title: "Показывать окно оператора во время разговора",
    onHint: "Пока идёт разговор, оператор видит звонящего и может записать обращение.",
    offHint: "Звонки по-прежнему записываются в журнал, но окна во время разговора не будет.",
  },
  {
    field: "incomingPushEnabled",
    title: "Присылать уведомление о звонке на телефон",
    onHint: "Оператор узнаёт о звонке, даже когда CRM закрыта: уведомление приходит на телефон и на компьютер.",
    offHint: "О звонке можно узнать только в открытой CRM или по звонящей трубке.",
  },
] as const;

/**
 * ЧАСЫ ПРИЁМА ВХОДЯЩИХ.
 *
 * Отдельно от «Рабочих часов» в разделе «Команда»: те решают, когда готовый лид
 * уходит агенту, эти — когда CRM вправе поднимать оператора уведомлением. Сведи их
 * в одну настройку — и сдвиг рабочего дня агентства молча переставил бы смену
 * оператора, а понять это по названию «рабочие часы» человек не может.
 *
 * Сохраняем ПО УХОДУ ИЗ ПОЛЯ, а не на каждое нажатие: у поля времени стрелки и
 * посегментный ввод, и сохранение на каждое изменение отправило бы «09:00 → 00:00 →
 * 04:00 → 04:30» — три запроса, из которых два записывают бессмыслицу.
 */
function IncomingHoursSetting() {
  const { data: settings } = useSettings();
  const updateSettings = useUpdateSettings();
  const on = settings?.incomingHoursEnabled ?? false;
  const start = settings?.incomingHoursStart ?? "09:00";
  const end = settings?.incomingHoursEnd ?? "21:00";

  const save = (field: "incomingHoursStart" | "incomingHoursEnd", value: string) => {
    // Пустое поле (человек стёр время и ушёл) не сохраняем: пустая граница
    // означала бы «неизвестно когда», а настройка обязана иметь ответ всегда.
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) return;
    if (value === (field === "incomingHoursStart" ? start : end)) return;
    updateSettings.mutate({ [field]: value });
  };

  return (
    <>
      <SwitchRow
        title="Часы уведомлений о пропущенных звонках"
        on={on}
        hint={
          on
            ? `Пуш о пропущенном звонке (агенту и руководителю) приходит с ${start} до ${end}. В остальное время звонок записывается в журнал молча. Сами звонки станция принимает круглосуточно.`
            : "Пуш о пропущенном звонке приходит круглосуточно. Сами звонки эта настройка не трогает."
        }
        onToggle={() => updateSettings.mutate({ incomingHoursEnabled: !on })}
      />
      {on && (
        <div className="mod">
          <div className="t">
            <b>Когда присылать уведомления</b>
            <span>Границы понимают окно через полночь.</span>
          </div>
          <div className="acts">
            {(
              [
                { field: "incomingHoursStart", label: "Уведомлять с", value: start },
                { field: "incomingHoursEnd", label: "Уведомлять до", value: end },
              ] as const
            ).map(({ field, label, value }) => (
              <span className="nf" key={field}>
                <input
                  type="time"
                  defaultValue={value}
                  key={value}
                  onBlur={(e) => save(field, e.target.value)}
                  disabled={updateSettings.isPending}
                  aria-label={label}
                  style={{ width: 112 }}
                />
              </span>
            ))}
          </div>
        </div>
      )}
      <div className="quiet">
        <span className="dot" />
        <span className="txt">
          Это не «Рабочие часы» из раздела «Сотрудники»: те определяют, когда лид уходит агенту и когда консультант
          на телефоне отвечает сразу. Здесь — только когда CRM беспокоит пушем о пропущенном звонке. На станцию,
          очередь, ночное правило и консультанта эти часы не влияют. Журнал входящих ведётся круглосуточно, и задача
          перезвонить по пропущенному ставится в любое время.
        </span>
      </div>
    </>
  );
}

function IncomingCallsSection() {
  const { data: settings } = useSettings();
  const updateSettings = useUpdateSettings();
  return (
    <SettingsSection icon={PhoneIncoming} title="Входящие звонки">
      {/* Списка «Кто принимает входящие» здесь больше нет (владелец 18.08.2026):
          роль оператора входящих отменена целиком. Звонки уходят прямо агентам, а
          карточка и тип обращения заводятся автоматически из расшифровки разговора —
          отмечать, кому показывать окно разбора, стало нечего и незачем. Всё, что
          ниже, работает на самой станции и от оператора никогда не зависело. */}
      <div className="quiet">
        <span className="dot" />
        <span className="txt">
          Клиент, которого нет в базе, заводится карточкой в момент звонка. Тип обращения CRM определяет сама по
          расшифровке разговора, после чего клиент уходит агенту обычной очередью по KPI.
        </span>
      </div>

      {/* Тумблеры, а не галочки: настройка вступает в силу сразу, а галочка
          обещает «ещё где-то нажать Сохранить» — такой кнопки здесь нет. */}
      {INCOMING_TOGGLES.map(({ field, title, onHint, offHint }) => {
        const on = settings?.[field] ?? true;
        return (
          <SwitchRow
            key={field}
            title={title}
            on={on}
            hint={on ? onHint : offHint}
            onToggle={() => updateSettings.mutate({ [field]: !on })}
          />
        );
      })}

      {/*
        ВЫБОРА ЗДЕСЬ БОЛЬШЕ НЕТ — И ЭТО НАПИСАНО ВИДИМЫМ ТЕКСТОМ (разбор 30.08.2026).

        Раньше стояли переключатели «Другое / Покупатель». При значении «Покупатель»
        КАЖДЫЙ отвеченный звонок и каждое сообщение автоответчика становилось
        карточкой покупателя, то есть лидом в раздаче агентам ещё до всякой
        квалификации. Возможность убрана и на сервере: схема настроек принимает
        только «OTHER» (routes/settings.ts), а чтение отдаёт «OTHER» при любом
        содержимом колонки (lib/telephony/incomingSettings.ts).

        Серых переключателей вместо этого не оставляем: неактивный элемент управления
        читается как «у вас нет прав», а причина здесь совсем другая — так решено.
        Поэтому вместо выбора стоит строка, объясняющая, почему выбирать нечего.
      */}
      <div className="grp-lab">Тип карточки до разбора</div>
      <div className="quiet">
        <span className="dot" />
        <span className="txt">
          Входящий звонок всегда попадает в «Прочие обращения» — агенту он раздаётся только после разбора, когда
          понятно, покупатель это или продавец. Иначе лидом становился бы каждый звонок, включая ошибочные и
          сообщения автоответчика.
        </span>
      </div>

      <IncomingHoursSetting />

      <InboundContextsSetting
        key={(settings?.incomingInboundContexts ?? []).join("\n")}
        value={settings?.incomingInboundContexts ?? []}
        pending={updateSettings.isPending}
        onSave={(list) => updateSettings.mutate({ incomingInboundContexts: list })}
      />

      <PrimaryTargetSetting />

      <NoAnswerRuleSetting />

      <RouteToAgentSetting />

      <RoutingModeSetting />
    </SettingsSection>
  );
}

/**
 * ПОДСКАЗКА АГЕНТУ О ЗВОНЯЩЕМ (владелец 20.08.2026: «агент ответил на звонок, но даже
 * не знает, с кем общается»).
 *
 * Три вещи, которые этот экран обязан показывать живыми данными, а не обещаниями:
 * ЧТО именно услышит агент (настоящая фраза о настоящем клиенте), СКОЛЬКО это секунд
 * (клиент в это время слушает гудки) и ДОХОДИТ ЛИ всё это до станции. Настройка, про
 * которую нельзя понять, работает она или нет, уже стоила агентству двух суток тишины
 * вместо музыки ожидания (15.08.2026) — здесь этой ошибки быть не должно.
 */
const WHISPER_PARTS_UI = [
  { key: "label", title: "«Исходящий»", hint: "Метка направления. На входящих не звучит: агент и так знает, что ему звонят." },
  { key: "name", title: "Имя", hint: "Всегда первым — если агент отвлёкся, услышать он должен имя." },
  { key: "role", title: "Покупатель или продавец", hint: "«харидор» / «фурӯшанда»." },
  { key: "anchor", title: "Объект и район", hint: "«манзил дар Сомонӣ» — то, чем клиент отличается от остальных." },
  { key: "budget", title: "Бюджет", hint: "«то 150 ҳазор доллар»." },
  { key: "promise", title: "Договорённость", hint: "Незакрытое обещание с датой — «ваъда: пагоҳ»." },
  { key: "recency", title: "Когда общались", hint: "«сӯҳбати охирин: дирӯз»." },
  { key: "aiHint", title: "Зацепка от ИИ", hint: "Короткая фраза по истории. Пишет модель — она может и ошибиться." },
] as const;

/** Готовые составы: три частых случая, чтобы не собирать фразу по кубику. */
const WHISPER_PRESETS = [
  { title: "Коротко", parts: ["name", "role"] },
  { title: "Средне", parts: ["name", "role", "anchor"] },
  { title: "Подробно", parts: ["name", "role", "anchor", "budget", "recency"] },
] as const;

/** Голоса синтеза, проверенные на таджикском 20.08.2026. */
export const WHISPER_VOICES = [
  { value: "Kore", title: "Kore — женский, ровный" },
  { value: "Charon", title: "Charon — мужской, низкий" },
  { value: "Orus", title: "Orus — мужской, твёрдый" },
  { value: "Achernar", title: "Achernar — женский, мягкий" },
] as const;

/**
 * ВЕСЬ КАТАЛОГ ГОЛОСОВ GEMINI (13.09.2026, «полный выбор голосов») — 30 штук.
 * С 02.10.2026 — из общей таблицы packages/shared/src/geminiVoices.ts вместе с
 * полом голоса: сервер по той же таблице велит роботу говорить о себе в роде
 * голоса, а здесь пол виден в выпадающем списке. Живой голос по телефону
 * выбирает из этого полного списка (BotTab.tsx), подсказка агенту — из
 * проверенной четвёрки выше.
 */
export const GEMINI_VOICE_CATALOG = GEMINI_VOICES.map((v) => ({
  value: v.value,
  title: `${v.value} — ${v.character}, ${voiceGenderLabel(v.gender)}`,
}));

interface CallWhisperStatus {
  hasStationToken: boolean;
  stationFetchedAt: string | null;
  ready: number;
  readyIncoming: number;
  readyOutgoing: number;
  longestMs: number | null;
  sample: { text: string; durationMs: number; direction: string; language: string } | null;
}

function CallWhisperSetting() {
  const { data: settings } = useSettings();
  const updateSettings = useUpdateSettings();
  const [issuedToken, setIssuedToken] = useState<string | null>(null);
  const [tokenPending, setTokenPending] = useState(false);

  const enabled = settings?.callWhisperEnabled ?? false;
  const onIncoming = settings?.callWhisperIncoming ?? true;
  const onOutgoing = settings?.callWhisperOutgoing ?? false;
  const language = (settings?.callWhisperLanguage ?? "tg") as "tg" | "ru";
  const voice = settings?.callWhisperVoice ?? "Kore";

  const { data: status } = useQuery<CallWhisperStatus>({
    queryKey: ["call-whisper"],
    queryFn: () => api<CallWhisperStatus>("/settings/call-whisper"),
    // Обновляется фоновой озвучкой и заходами станции — обе снаружи этого экрана.
    refetchInterval: enabled ? 30_000 : false,
  });

  const issueToken = async () => {
    setTokenPending(true);
    try {
      const result = await api<{ token: string }>("/settings/call-whisper/token", { method: "POST" });
      setIssuedToken(result.token);
    } finally {
      setTokenPending(false);
    }
  };

  return (
    <SettingsSection icon={Volume2} title="Подсказка агенту о звонящем" badge={enabled ? "звучит" : "выключена"}>
      <SwitchRow
        title="Подсказка агенту перед соединением"
        on={enabled}
        hint={
          enabled
            ? "Прежде чем соединить, станция говорит агенту в ухо, кто звонит. Клиент этого не слышит — он слушает гудки."
            : "Агент берёт трубку, не зная, с кем будет говорить."
        }
        onToggle={() => updateSettings.mutate({ callWhisperEnabled: !enabled })}
      />

      {enabled && (
        <>
          <SwitchRow
            title="На входящих звонках"
            on={onIncoming}
            hint={onIncoming ? "Клиент звонит — агент слышит, кто это, ещё до «алло»." : "На входящих подсказка не звучит."}
            onToggle={() => updateSettings.mutate({ callWhisperIncoming: !onIncoming })}
          />
          <SwitchRow
            title="На исходящих звонках"
            on={onOutgoing}
            hint={
              onOutgoing
                ? "Когда агент звонит сам — короткое напоминание, кому именно. Полезно при звонках по задачам."
                : "Агент сам выбрал, кому звонит, — подсказка не нужна. Требует отдельной правки на АТС."
            }
            onToggle={() => updateSettings.mutate({ callWhisperOutgoing: !onOutgoing })}
          />

          {onIncoming && (
            <WhisperComposition
              direction="in"
              title="Что говорить на входящем"
              parts={settings?.callWhisperIncomingParts ?? ["name", "role", "anchor"]}
              language={language}
              voice={voice}
              pending={updateSettings.isPending}
              onChange={(parts) => updateSettings.mutate({ callWhisperIncomingParts: parts })}
            />
          )}

          {onOutgoing && (
            <WhisperComposition
              direction="out"
              title="Что говорить на исходящем"
              parts={settings?.callWhisperOutgoingParts ?? ["label", "name", "role"]}
              language={language}
              voice={voice}
              pending={updateSettings.isPending}
              onChange={(parts) => updateSettings.mutate({ callWhisperOutgoingParts: parts })}
            />
          )}

          <div className="mod">
            <div className="t">
              <b>Язык и голос</b>
              <span style={{ whiteSpace: "normal" }}>
                У каждого сотрудника язык можно поменять в его карточке (Настройки → Сотрудники), там же есть «не
                играть мне».
              </span>
            </div>
            <div className="acts">
              <select
                className="inp"
                style={{ maxWidth: 160 }}
                aria-label="Язык подсказки по умолчанию"
                value={language}
                onChange={(e) => updateSettings.mutate({ callWhisperLanguage: e.target.value })}
                disabled={updateSettings.isPending}
              >
                <option value="tg">Таджикский</option>
                <option value="ru">Русский</option>
              </select>
              <select
                className="inp"
                style={{ maxWidth: 220 }}
                aria-label="Голос подсказки"
                value={voice}
                onChange={(e) => updateSettings.mutate({ callWhisperVoice: e.target.value })}
                disabled={updateSettings.isPending}
              >
                {WHISPER_VOICES.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.title}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="card flat">
            <div className="sec-h stack">
              <h2>Станция</h2>
              <span className="note">
                {status?.ready
                  ? `Готово подсказок: ${status.ready} (входящих ${status.readyIncoming}, исходящих ${status.readyOutgoing}).`
                  : "Подсказки ещё не озвучены — фоновая озвучка проходит раз в пять минут."}
                {status?.longestMs ? ` Самая длинная — ${(status.longestMs / 1000).toFixed(1)} с.` : ""}
              </span>
            </div>
            <div className="quiet">
              <span className={status?.stationFetchedAt ? "dot ok" : "dot warn"} />
              <span className="txt">
                {status?.stationFetchedAt
                  ? `Станция забирала файлы ${new Date(status.stationFetchedAt).toLocaleString("ru-RU", { timeZone: "Asia/Dushanbe" })}.`
                  : "Станция за файлами ещё не приходила — проверьте скрипт и ключ на АТС (инструкция у администратора)."}
              </span>
            </div>
            <div className="wrap" style={{ marginTop: "var(--s3)" }}>
              <button className="pill ghost sm" type="button" onClick={issueToken} disabled={tokenPending}>
                {status?.hasStationToken ? "Выдать новый ключ станции" : "Выдать ключ станции"}
              </button>
              {status?.hasStationToken && !issuedToken && (
                <span className="saved">Ключ выдан. Показать его снова нельзя — только заменить.</span>
              )}
            </div>
            {issuedToken && (
              <div className="quiet crit">
                <span className="dot crit" />
                <span className="txt">
                  Скопируйте сейчас — второй раз ключ не показывается. Вставить в скрипт на АТС:{" "}
                  <code style={{ wordBreak: "break-all" }}>{issuedToken}</code>
                </span>
              </div>
            )}
          </div>
        </>
      )}
    </SettingsSection>
  );
}

/**
 * Состав фразы и живой предпросмотр.
 *
 * Фраза показывается НА НАСТОЯЩЕМ КЛИЕНТЕ и обновляется на каждое переключение —
 * бесплатно, потому что текст собирается сервером без синтеза речи. Озвучка стоит
 * денег, поэтому звук — только по кнопке.
 */
function WhisperComposition({
  direction,
  title,
  parts,
  language,
  voice,
  pending,
  onChange,
}: {
  direction: "in" | "out";
  title: string;
  parts: string[];
  language: "tg" | "ru";
  voice: string;
  pending: boolean;
  onChange: (parts: string[]) => void;
}) {
  const [playing, setPlaying] = useState(false);
  const [playError, setPlayError] = useState<string | null>(null);

  const preview = useQuery<{ text: string; clientName: string }>({
    queryKey: ["call-whisper-preview", direction, language, [...parts].sort().join(",")],
    queryFn: () =>
      api<{ text: string; clientName: string }>("/settings/call-whisper/preview", {
        method: "POST",
        body: { direction, language, parts, voice },
      }),
    retry: false,
  });

  const toggle = (key: string) => {
    onChange(parts.includes(key) ? parts.filter((p) => p !== key) : [...parts, key]);
  };

  const listen = async () => {
    setPlaying(true);
    setPlayError(null);
    try {
      const result = await api<{ audioBase64: string; sampleRateHz: number }>("/settings/call-whisper/preview", {
        method: "POST",
        body: { direction, language, parts, voice, speak: true },
      });
      const url = pcmBase64ToWavUrl(result.audioBase64, result.sampleRateHz);
      const audio = new Audio(url);
      // Ссылку освобождаем после проигрывания: иначе каждый клик оставляет в памяти
      // вкладки по файлу, и за день их накапливается сотня.
      audio.addEventListener("ended", () => URL.revokeObjectURL(url), { once: true });
      await audio.play();
    } catch {
      setPlayError("Не удалось озвучить — проверьте ключ Gemini и «Здоровье системы».");
    } finally {
      setPlaying(false);
    }
  };

  // На исходящем метка направления уместна, на входящем — нет (см. WHISPER_PARTS_UI).
  const available = WHISPER_PARTS_UI.filter((part) => part.key !== "label" || direction === "out");

  return (
    <div className="card flat">
      <div className="sec-h stack">
        <h2>{title}</h2>
        <span className="note">Готовые составы: три частых случая, чтобы не собирать фразу по кубику</span>
      </div>

      <div className="seg" role="group" aria-label={`Готовые составы: ${title}`}>
        {WHISPER_PRESETS.map((preset) => (
          <button
            key={preset.title}
            type="button"
            disabled={pending}
            onClick={() => onChange(direction === "out" ? ["label", ...preset.parts] : [...preset.parts])}
          >
            {preset.title}
          </button>
        ))}
      </div>

      {available.map((part) => (
        <SwitchRow
          key={part.key}
          title={part.title}
          on={parts.includes(part.key)}
          hint={part.hint}
          onToggle={() => toggle(part.key)}
        />
      ))}

      <div className="grp-lab">Агент услышит</div>
      {preview.data ? (
        <div className="quiet">
          <span className="dot ok" />
          <span className="txt">
            «{preview.data.text}» Пример собран по карточке клиента {preview.data.clientName}.
          </span>
        </div>
      ) : (
        <div className="quiet">
          <span className="dot" />
          <span className="txt">
            {preview.isError ? "Показать не на ком: нет клиента с ответственным агентом." : "Собираем фразу…"}
          </span>
        </div>
      )}
      <div className="wrap" style={{ marginTop: "var(--s2)" }}>
        <button className="pill ghost sm" type="button" onClick={listen} disabled={playing || !preview.data}>
          {playing ? "Озвучиваем…" : "Прослушать"}
        </button>
        {playError && (
          <span className="saved" style={{ color: "var(--crit)" }}>
            {playError}
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * НОЧНОЙ РЕЖИМ (владелец 14.08.2026: «когда нас нет — звук автоответчика»).
 *
 * В нерабочее время очередь операторов пропускается вовсе: звонить в пустой офис —
 * значит заставить клиента слушать музыку впустую. Исполняет станция (правило
 * работает и при лежащей CRM), границы понимают окно через полночь.
 */
const NIGHT_ACTIONS = [
  { value: "none", title: "Как днём", hint: "Ночного режима нет — звонки идут в очередь круглосуточно." },
  {
    value: "forward",
    title: "Сразу дежурному",
    hint: "Без очереди — на номер дежурного из правила выше.",
  },
  {
    value: "voicemail",
    title: "Сразу автоответчик",
    hint: "Приветствие, сигнал, запись. Утром сообщение уже в CRM: карточка, расшифровка, задача перезвонить.",
  },
] as const;

/**
 * КОНСУЛЬТАНТ ПЕРЕКРЫВАЕТ ПРАВИЛА НИЖЕ (аудит роботов, Д23, 02.10.2026).
 *
 * Пока на входящих включён консультант (ИИ), станция читает режим консультанта
 * ПЕРЕД ночным правилом и правилом «если оператор не ответил» и уводит звонок к
 * нему (ops/asterisk/extensions_custom.conf, ветка `ai`): оба правила не
 * срабатывают, хотя в форме выглядят рабочими. Ночь для консультанта — не
 * «Нерабочее время» отсюда, а рабочие часы из «Сотрудники → Когда лиды уходят
 * агентам» (Settings.workHoursStart/End). Только подпись: поведение станции не
 * меняется. Не видно, если консультант выключен.
 */
function ConsultantOverridesNotice({ rule }: { rule: "night" | "noAnswer" }) {
  const { data: settings } = useSettings();
  const mode = settings?.liveVoiceInboundMode ?? "off";
  // Три состояния (lib/consultantInbound.ts): консультант не выбран — подписи нет;
  // выбран, но не может брать трубку (нет адреса/порта звука на сервере — аудит
  // 02.10.2026, п. 5 — или на станции старый диалплан без его ветки) — правила ниже
  // работают, и плашка «не действует» была бы ложью, поэтому честно говорим обратное.
  const state = consultantInboundState(settings);
  if (state === "off" || !settings) return null;
  if (state === "blocked") {
    return (
      <div className="quiet">
        <span className="dot" />
        <span className="txt">{CONSULTANT_BLOCKED_NOTE}</span>
      </div>
    );
  }
  const start = settings.workHoursStart;
  const end = settings.workHoursEnd;
  return (
    <div className="quiet warn" role="status">
      <span className="dot warn" />
      <span className="txt">
        {rule === "night"
          ? mode === "always"
            ? "Сейчас это правило не действует: на входящих включён консультант (ИИ), он отвечает на каждый звонок первым, в том числе ночью."
            : `Сейчас это правило не действует: на входящих включён консультант (ИИ), и звонок идёт к нему. Ночью он берёт трубку сразу — по рабочим часам из «Сотрудники → Когда лиды уходят агентам» (вне ${start}–${end}), а не по границам ниже.`
          : mode === "always"
            ? "Сейчас это правило не действует: на входящих включён консультант (ИИ), он отвечает на каждый звонок первым."
            : "Сейчас это правило не действует: на входящих включён консультант (ИИ). Оператору звонят столько секунд, сколько задано в «ИИ-ассистент → Живой голос по телефону», потом трубку берёт консультант."}{" "}
        Чтобы вернуть это правило, выберите «Не берёт» в «ИИ-ассистент → Живой голос по телефону».
      </span>
    </div>
  );
}

function NightModeSetting() {
  const { data: settings } = useSettings();
  const updateSettings = useUpdateSettings();
  const action = settings?.incomingNightAction ?? "none";
  const current = NIGHT_ACTIONS.find((o) => o.value === action);

  return (
    <SettingsSection icon={PhoneIncoming} title="Нерабочее время" badge={current?.title}>
      <ConsultantOverridesNotice rule="night" />
      <div className="quiet">
        <span className="dot" />
        <span className="txt">
          Ночью и в выходные часы операторов в офисе нет — звонок не ждёт очередь, а сразу идёт по этому правилу.
          Выполняет станция.
        </span>
      </div>

      <div className="seg" role="group" aria-label="Что делать в нерабочее время">
        {NIGHT_ACTIONS.map((option) => (
          <button
            key={option.value}
            type="button"
            title={option.hint}
            aria-selected={action === option.value}
            onClick={() => updateSettings.mutate({ incomingNightAction: option.value })}
          >
            {option.title}
          </button>
        ))}
      </div>
      <div className="quiet">
        <span className="dot" />
        <span className="txt">{current?.hint}</span>
      </div>

      {action !== "none" && (
        <div className="mod">
          <div className="t">
            <b>Границы нерабочего времени</b>
            <span>Окно через полночь считается правильно.</span>
          </div>
          <div className="acts">
            <TimeField
              label="Нерабочее время с"
              value={settings?.incomingNightStart ?? "21:00"}
              onSave={(v) => updateSettings.mutate({ incomingNightStart: v })}
            />
            <TimeField
              label="Нерабочее время до"
              value={settings?.incomingNightEnd ?? "09:00"}
              onSave={(v) => updateSettings.mutate({ incomingNightEnd: v })}
            />
          </div>
        </div>
      )}
      {action === "forward" && !(settings?.incomingForwardPhone ?? "").trim() && (
        <div className="quiet warn">
          <span className="dot warn" />
          <span className="txt">
            Не указан номер дежурного (правило «Если оператор не ответил») — ночью правило не действует, звонки пойдут
            как днём.
          </span>
        </div>
      )}
    </SettingsSection>
  );
}

/** Поле времени ЧЧ:ММ — сохраняет по уходу из поля, встроенная проверка браузера. */
function TimeField({ label, value, onSave }: { label: string; value: string; onSave: (v: string) => void }) {
  return (
    <span className="nf">
      <input
        type="time"
        defaultValue={value}
        aria-label={label}
        onBlur={(e) => e.target.value && e.target.value !== value && onSave(e.target.value)}
        style={{ width: 112 }}
      />
    </span>
  );
}

/** «7,2 ГБ», «0,6 МБ», «10 ГБ»: десятичная запятая, лишний «,0» отброшен. */
function trafficVolumeLabel(mb: number): string {
  const inGb = mb >= 1024;
  const text = (inGb ? mb / 1024 : mb).toFixed(1).replace(/.0$/, "").replace(".", ",");
  return `${text} ${inGb ? "ГБ" : "МБ"}`;
}

/**
 * ТРАФИК СТАНЦИИ ЗА МЕСЯЦ. Станция ходит к CRM по платному каналу (≈100 сомони за
 * 10 ГБ), поэтому владелец видит расход здесь, а не узнаёт из счёта. Предупреждение
 * директору при 70 и 90 % уходит отдельно, в журнал (cron «telephony-station-traffic»).
 */
function StationTrafficRow() {
  const { data, isLoading } = useStationTraffic();
  const traffic = data?.stationTraffic ?? null;
  const pct = traffic ? Math.round(traffic.pct) : 0;
  const tone = traffic && traffic.pct >= 90 ? "crit" : traffic && traffic.pct >= 70 ? "warn" : null;
  return (
    <div className="quiet">
      <span className="dot" />
      <span className="txt">
        {isLoading
          ? "Трафик станции за месяц: загружаем…"
          : traffic
            ? `Трафик станции за месяц: ${trafficVolumeLabel(traffic.usedMb)} из ${trafficVolumeLabel(traffic.limitMb)} (${pct} %)`
            : "Трафик станции за месяц: нет данных"}
      </span>
      {tone && <span className={`chip ${tone}`}>{tone === "crit" ? "лимит почти исчерпан" : "больше 70 % лимита"}</span>}
    </div>
  );
}

/**
 * ЗВУКИ ТЕЛЕФОНИИ. Файл сохраняется в CRM, а станция забирает его сама в течение
 * пяти минут (у CRM нет записи на диск АТС, и не должно быть). Поэтому честная
 * подпись «заработает в течение 5 минут», а не мгновенное «готово».
 */
function TelephonyAudioSetting() {
  return (
    <SettingsSection icon={Volume2} title="Звуки телефонии">
      <div className="quiet">
        <span className="dot" />
        <span className="txt">mp3 или wav. Станция подхватывает новый файл в течение пяти минут.</span>
      </div>
      <AudioUploadRow kind="moh" title="Музыка ожидания" hint="Играет клиенту, пока он ждёт оператора в очереди." />
      <AudioUploadRow
        kind="queue"
        title="Приветствие очереди"
        hint="Играет до соединения с оператором. Например: «Оставайтесь на линии — соединяем вас с оператором»."
      />
      <AudioUploadRow
        kind="greeting"
        title="Приветствие автоответчика"
        hint="Например: «Вы позвонили в Royal Home. Оставьте сообщение после сигнала — мы перезвоним»."
      />
      <AudioUploadRow
        kind="agentDeclined"
        title="«Агент вам перезвонит»"
        hint="Играет клиенту, если его закреплённый агент явно отклонил звонок или занят (см. «Сколько звонить агенту»). Например: «Ваш агент сейчас не может ответить, он вам перезвонит». После этого звонок всё равно уходит в общую очередь — на всякий случай, если перезвонить не получится."
      />
    </SettingsSection>
  );
}

/*
 * Отсюда убраны «Звук и вибрация на входящий звонок» и «Кнопка „Позвонить через
 * мобильный“ при плохой связи» (18.08.2026): звонок играл в браузере на входящий
 * софтфона, а кнопка жила в панели управления браузерной трубкой. Софтфона больше
 * нет — включать и выключать было бы нечего. Звуки САМОЙ СТАНЦИИ (музыка ожидания,
 * приветствие автоответчика) остались выше, в TelephonyAudioSetting: они играют
 * клиенту на линии и к браузеру отношения не имеют.
 */

/** «сегодня в 14:05» — коротко, без даты, если файл свежий. Всё по Душанбе
 *  (lib/date.ts): экран директорский, открывается и из поездок — по поясу
 *  устройства подпись врала и про день, и про час (26.08.2026). */
function uploadedWhen(iso: string): string {
  const time = dushanbeTime(iso);
  const sameDay = dushanbeDayKey(iso) === dushanbeTodayKey();
  return sameDay ? `сегодня в ${time}` : `${dushanbeDate(iso)} в ${time}`;
}

function AudioUploadRow({
  kind,
  title,
  hint,
}: {
  kind: "moh" | "greeting" | "queue" | "agentDeclined";
  title: string;
  hint: string;
}) {
  const [state, setState] = useState<"idle" | "busy" | "done" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const { data: status } = useTelephonyAudioStatus();
  const qc = useQueryClient();
  const current = status?.[kind] ?? null;

  async function handleFile(file: File) {
    setState("busy");
    setMessage(null);
    try {
      const form = new FormData();
      form.append("audio", file);
      await api(`/settings/telephony-audio/${kind}`, { method: "POST", body: form, isForm: true });
      // «Что сейчас лежит» обязано обновиться сразу — иначе видно только собственный
      // тост, а строка «сейчас: …» ниже осталась бы от предыдущей загрузки.
      await qc.invalidateQueries({ queryKey: ["telephony-audio"] });
      setState("done");
      setMessage("Загружено и приведено к формату станции — подхватит в течение 5 минут.");
    } catch (err) {
      setState("error");
      setMessage(err instanceof Error ? err.message : "Не удалось загрузить");
    }
  }

  return (
    <div className="mod">
      <div className="t">
        <b>{title}</b>
        <span style={{ whiteSpace: "normal" }}>{hint}</span>
      </div>
      <div className="acts">
        <input
          ref={inputRef}
          type="file"
          accept="audio/mpeg,audio/wav,.mp3,.wav"
          style={{ display: "none" }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void handleFile(f);
            e.target.value = "";
          }}
        />
        <button className="pill ghost sm" type="button" onClick={() => inputRef.current?.click()} disabled={state === "busy"}>
          {state === "busy" ? "Загружаю…" : "Загрузить файл"}
        </button>
      </div>
      {/* Честное состояние сервера, а не только память браузера: без него после
          перезагрузки страницы владелец не мог узнать, лежит ли файл вообще.
          Устаревший mp3 (загрузка до 15.08.2026) станции недоступен — она ходит
          только за .wav. Раньше строка ниже писала «файл загружен» и в этом
          случае, из-за чего поломку нельзя было увидеть с экрана вообще. */}
      {current?.stale ? (
        <p className="msg">Файл в устаревшем формате — станция его не забирает. Загрузите заново, чтобы заработало.</p>
      ) : (
        <p className="msg" style={{ color: "var(--faint)" }}>
          {current ? `Сейчас: файл загружен ${uploadedWhen(current.uploadedAt)}` : "Сейчас: играет штатная мелодия станции"}
        </p>
      )}
      {message && (
        <p className="msg" style={{ color: state === "error" ? "var(--crit)" : "var(--ok)" }}>
          {message}
        </p>
      )}
    </div>
  );
}

/**
 * ЕСЛИ ОПЕРАТОР НЕ ОТВЕТИЛ — главная дыра телефонии до 13.08.2026.
 *
 * Очередь на станции устроена так, что клиент попадает в неё, даже когда все
 * операторы офлайн (а вечером офлайн все), и не выходит оттуда никогда: слушает
 * музыку, пока не бросит трубку. Ни звонка дежурному, ни сообщения, ни следа —
 * потерянный клиент, о котором никто не узнал.
 *
 * Теперь правило выбирается здесь, а исполняет его САМА СТАНЦИЯ (CRM только
 * кладёт значения в её базу). Так и задумано: правило обязано работать именно
 * тогда, когда CRM недоступна — упал контейнер, оборвался туннель, идёт выкат.
 */
/**
 * КУДА ИДЁТ ВХОДЯЩИЙ В ПЕРВУЮ ОЧЕРЕДЬ (решение владельца 21.08.2026: «Нурмухаммаду
 * пусть ничего не идёт, звонок прямо на 44 650-14-14 идёт на SIP»).
 *
 * Исполняет станция, как и правило ниже: CRM кладёт внутренний номер в её базу,
 * диалплан читает значение на каждом звонке. Отдельного «выключателя» на станции
 * нет намеренно — режим задаётся самим номером, иначе появилось бы состояние
 * «режим включён, номера нет», в котором звонок уходит в тишину.
 */
const PRIMARY_TARGETS = [
  {
    value: "queue",
    title: "Операторам в очередь",
    hint: "Как было с запуска телефонии: звонок звонит у операторов на приёме.",
  },
  {
    value: "extension",
    title: "Прямо на SIP-аппарат",
    hint: "Звонок идёт только на указанный внутренний номер — например, на софтфон в телефоне. Операторы при этом не звонят вовсе.",
  },
] as const;

function PrimaryTargetSetting() {
  const { data: settings } = useSettings();
  const updateSettings = useUpdateSettings();
  const target = settings?.incomingPrimaryTarget ?? "queue";
  const extension = settings?.incomingPrimaryExtension ?? "";
  const amiReady = !!settings?.asteriskAmiConfigured;
  const current = PRIMARY_TARGETS.find((o) => o.value === target);

  return (
    <>
      <div className="grp-lab">Куда идёт входящий звонок</div>
      <div className="quiet">
        <span className="dot" />
        <span className="txt">Решает станция, а не CRM: правило действует и тогда, когда CRM недоступна.</span>
      </div>
      {settings?.liveVoiceInboundMode === "always" && <ConsultantOverrideNote />}

      <div className="seg" role="group" aria-label="Куда идёт входящий звонок">
        {PRIMARY_TARGETS.map((option) => (
          <button
            key={option.value}
            type="button"
            title={option.hint}
            aria-selected={target === option.value}
            onClick={() => updateSettings.mutate({ incomingPrimaryTarget: option.value })}
          >
            {option.title}
          </button>
        ))}
      </div>
      <div className="quiet">
        <span className="dot" />
        <span className="txt">{current?.hint}</span>
      </div>

      {/* Условный рендер, а не hidden: класс flex перебивает [hidden] — грабля этого проекта. */}
      {target === "extension" && (
        <>
          <PlainSetting
            key={extension}
            title="Внутренний номер аппарата"
            description="Номер, заведённый на станции. Например, 1021 — софтфон в телефоне директора."
            placeholder="1021"
            value={extension}
            pending={updateSettings.isPending}
            onSave={(v) => updateSettings.mutate({ incomingPrimaryExtension: v.replace(/\D/g, "") })}
          />
          {!extension.trim() && (
            <div className="quiet warn">
              <span className="dot warn" />
              <span className="txt">
                Пока номер не указан, звонки идут операторам, как раньше: звонить некуда — это хуже прежнего поведения.
              </span>
            </div>
          )}
          {!amiReady && (
            <div className="quiet warn">
              <span className="dot warn" />
              <span className="txt">Правило не доедет до станции: не настроено управление станцией (раздел выше).</span>
            </div>
          )}
        </>
      )}
    </>
  );
}

const NO_ANSWER_ACTIONS = [
  {
    value: "none",
    title: "Ничего не делать",
    hint: "Клиент слышит гудки, пока не положит трубку сам или пока его сеть не сбросит звонок (обычно через 30–60 секунд).",
  },
  {
    value: "forward",
    title: "Позвонить дежурному",
    hint: "Станция переводит звонок на номер ниже. Клиент почти всегда с кем-то поговорит; плечо платное.",
  },
  {
    value: "voicemail",
    title: "Предложить оставить сообщение",
    hint: "CRM расшифрует сообщение, заведёт карточку и поставит задачу перезвонить. Бесплатно.",
  },
  {
    value: "both",
    title: "Дежурному, потом сообщение",
    hint: "Сначала звонок дежурному, если и он не взял — запись сообщения. Максимум шансов не потерять клиента.",
  },
] as const;

function NoAnswerRuleSetting() {
  const { data: settings } = useSettings();
  const updateSettings = useUpdateSettings();
  const action = settings?.incomingNoAnswerAction ?? "none";
  const seconds = settings?.incomingNoAnswerSeconds ?? 20;
  const phone = settings?.incomingForwardPhone ?? "";
  const needsPhone = action === "forward" || action === "both";
  const amiReady = !!settings?.asteriskAmiConfigured;
  const current = NO_ANSWER_ACTIONS.find((o) => o.value === action);

  return (
    <>
      <div className="grp-lab">Если оператор не ответил</div>
      <ConsultantOverridesNotice rule="noAnswer" />
      <div className="quiet">
        <span className="dot" />
        <span className="txt">
          Выполняет станция, а не CRM: правило должно срабатывать и тогда, когда CRM недоступна.
        </span>
      </div>

      <div className="hscroll">
        <div className="seg" role="group" aria-label="Если оператор не ответил">
          {NO_ANSWER_ACTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              title={option.hint}
              aria-selected={action === option.value}
              onClick={() => updateSettings.mutate({ incomingNoAnswerAction: option.value })}
            >
              {option.title}
            </button>
          ))}
        </div>
      </div>
      <div className="quiet">
        <span className="dot" />
        <span className="txt">{current?.hint}</span>
      </div>

      {/* Условный рендер, а не hidden: правило [hidden] лежит в слое base и класс
          flex его перебивает — блок остался бы видимым (грабля этого проекта). */}
      {action !== "none" && (
        <>
          <SecondsSetting
            key={seconds}
            value={seconds}
            pending={updateSettings.isPending}
            onSave={(v) => updateSettings.mutate({ incomingNoAnswerSeconds: v })}
          />
          {needsPhone && (
            <PlainSetting
              title="Номер дежурного"
              description="Куда станция переводит звонок. Обычно мобильный того, кто на смене."
              placeholder="+992 XX XXX XX XX"
              value={phone}
              pending={updateSettings.isPending}
              onSave={(v) => updateSettings.mutate({ incomingForwardPhone: v })}
            />
          )}
          {needsPhone && !phone.trim() && (
            <div className="quiet warn">
              <span className="dot warn" />
              <span className="txt">
                Пока номер не указан, правило не действует: станция оставит звонок в очереди, как раньше.
              </span>
            </div>
          )}
          {!amiReady && (
            <div className="quiet warn">
              <span className="dot warn" />
              <span className="txt">Правило не доедет до станции: не настроено управление станцией (раздел выше).</span>
            </div>
          )}
        </>
      )}
    </>
  );
}

/** Сколько секунд звонок ждёт оператора. Отдельным полем — у него свой предел и свой смысл. */
/**
 * «Звонок известного клиента — сразу его агенту» (решение владельца 16.08.2026,
 * прямая отмена правила «входящие только оператору» от 08.08.2026).
 *
 * ВЫКЛЮЧЕНО ПО УМОЛЧАНИЮ и включается здесь же, одним тумблером: возможность
 * трогает живую телефонию, по которой приходит каждый лид агентства, и владельцу
 * нужен способ выключить её в ту же секунду, если она поведёт себя не так.
 *
 * Про запасной путь сказано прямо: запись голосовой почты исполняет СТАНЦИЯ, а не
 * очередь операторов (владелец 29.08.2026 — звонок известного клиента в очередь не
 * уходит ни при каком исходе). Человек, читающий эту настройку, должен понимать,
 * что при выключенной CRM клиент всё равно попадёт к оператору по обычному приёму,
 * — иначе тумблер выглядит страшнее, чем он есть.
 */
function RouteToAgentSetting() {
  const { data: settings } = useSettings();
  const updateSettings = useUpdateSettings();
  const on = settings?.incomingRouteToAssignedAgent ?? false;
  const seconds = settings?.incomingRouteRingSeconds ?? 150;
  const amiReady = !!settings?.asteriskAmiConfigured;
  const consultant = consultantInboundState(settings) === "active";
  const fallbackWord = consultant ? "трубку берёт консультант" : "переходит на голосовую почту";

  return (
    <>
      <SwitchRow
        title="Звонок известного клиента — сразу его агенту"
        on={on}
        hint={
          on
            ? seconds === 0
              ? "Станция звонит ответственному, пока клиент сам не положит трубку — дальше звонок никуда не переходит."
              : `Станция звонит ответственному ${seconds} с; не взял — ${fallbackWord}, в очередь операторов не уходит.`
            : "Все входящие идут в общую очередь операторов, как раньше."
        }
        onToggle={() => updateSettings.mutate({ incomingRouteToAssignedAgent: !on })}
      />

      {/* Условный рендер, а не hidden: правило [hidden] лежит в слое base и класс
          flex его перебивает — блок остался бы видимым (грабля этого проекта). */}
      {on && (
        <>
          <RingSecondsSetting
            key={seconds}
            value={seconds}
            consultant={consultant}
            pending={updateSettings.isPending}
            onSave={(v) => updateSettings.mutate({ incomingRouteRingSeconds: v })}
          />
          <div className="quiet">
            <span className="dot" />
            <span className="txt">
              Переводятся только звонки клиентов, которых агент уже принял в работу. Незнакомый номер, карточка без
              ответственного, карточка из Корзины и закрытая сделка идут в очередь как раньше. Нет связи с трубкой
              агента — звоним ему на мобильный, тем же путём, что и при звонке из карточки.
            </span>
          </div>
          {!amiReady && (
            <div className="quiet warn">
              <span className="dot warn" />
              <span className="txt">Перевод не заработает: не настроено управление станцией (раздел выше).</span>
            </div>
          )}
          <div className="quiet warn">
            <span className="dot warn" />
            <span className="txt">
              Требует настройки на самой АТС (контекст royalhome-agent-route). Пока её нет, CRM ничего не переводит и
              пишет об этом в «Здоровье системы» — звонки при этом не теряются.
            </span>
          </div>
        </>
      )}
    </>
  );
}

/**
 * КАК МАРШРУТИЗИРОВАТЬ НЕЗНАКОМЫЙ ЗВОНОК — ЗАГОТОВКА НА БУДУЩЕЕ (владелец 20.08.2026).
 *
 * Список вариантов, которые обсуждались: очередь по KPI (как у лидов из чата),
 * возврат отдельной роли оператора, голосовое меню («нажмите 1 для продажи, 2
 * для покупки…»). Каждый требует своей настройки диалплана на станции — работы,
 * которую делает не выкат CRM, а тот, у кого есть доступ к FreePBX (см.
 * ROUTE_CONTEXT в inboundRouting.ts — та же история).
 *
 * «Звонить сразу всем агентам» в списке НЕ БЫЛО и не будет: владелец предложил
 * это же 18.08.2026, но в тот же день 20.08.2026 передумал — агенты путают
 * такой звонок со своим собственным клиентом (телефон звонит у всех разом, и
 * непонятно, кому он на самом деле адресован, пока не возьмёшь трубку). Решение
 * не «пока не сделано», а «решили не делать» — не предлагать эту идею снова.
 *
 * Переключатель ЗДЕСЬ ничего не включает на линии сам по себе: он лишь
 * запоминает намерение и кладёт его в базу станции (AstDB, как и правило "если
 * оператор не ответил"), чтобы будущий диалплан мог его прочитать, не дожидаясь
 * ещё одного выката. `live: true` — варианты, которые станция реально исполняет
 * прямо сейчас. Честность подписи важнее удобства: тумблер, который выглядит
 * включённым, но ничего не делает, — хуже отсутствующего.
 *
 * "kpi_queue" И "dedicated_operator" ПОЛУЧИЛИ `live: true` 20.08.2026:
 * отдельная настройка станции им НЕ понадобилась — оба уводят незнакомый
 * звонок через ТОТ ЖЕ контекст `royalhome-agent-route` (AMI Redirect), которым
 * уже пользуется перевод известному клиенту, просто выбирают агента иначе:
 * "kpi_queue" — лучшим по Royal Score (lib/telephony/kpiQueueRouting.ts,
 * `pickAgentForLead`, тот же алгоритм, что у лидов из чата), "dedicated_operator"
 * — по календарной ротации списка ниже (lib/telephony/dutyRosterRouting.ts).
 * "ivr_menu" — единственный, кому диалплан правда нужен (DTMF-меню).
 */
const ROUTING_MODES = [
  {
    value: "assigned_then_forward",
    title: "Как сейчас: своему агенту, потом дежурному",
    hint: "Работает прямо сейчас. Известного клиента станция уводит его агенту (настройка выше), незнакомого — по правилу «если оператор не ответил».",
    live: true,
  },
  {
    value: "kpi_queue",
    title: "Очередь по KPI",
    hint: "Незнакомый звонок и клиент без агента уходят лучшему свободному по Royal Score — тем же переводом, что известному клиенту. Отдельной настройки станции не требует.",
    live: true,
  },
  {
    value: "dedicated_operator",
    title: "Дежурный по очереди",
    hint: "Лёгкая версия вместо удалённой 18.08.2026 роли оператора — без рабочего места и отдельных прав, просто список ниже. Кто дежурит сегодня, выбирается по календарному дню. Отдельной настройки станции не требует.",
    live: true,
  },
  {
    value: "ivr_menu",
    title: "Голосовое меню (IVR)",
    hint: "«Нажмите 1 для продажи, 2 для покупки…». Нужна отдельная настройка станции.",
    live: false,
  },
] as const;

function RoutingModeSetting() {
  const { data: settings } = useSettings();
  const updateSettings = useUpdateSettings();
  const mode = settings?.incomingRoutingMode ?? "assigned_then_forward";
  const amiReady = !!settings?.asteriskAmiConfigured;
  const current = ROUTING_MODES.find((o) => o.value === mode);

  return (
    <>
      <div className="grp-lab">Как маршрутизировать незнакомый звонок</div>
      <div className="quiet">
        <span className="dot" />
        <span className="txt">
          «Очередь по KPI» и «Дежурный по очереди» уже работают — переиспользуют тот же перевод, что и «своему
          агенту». «Голосовое меню» ждёт отдельной настройки станции.
        </span>
      </div>

      <div className="hscroll">
        <div className="seg" role="group" aria-label="Как маршрутизировать незнакомый звонок">
          {ROUTING_MODES.map((option) => (
            <button
              key={option.value}
              type="button"
              title={option.hint}
              aria-selected={mode === option.value}
              // «Скоро» — не выбирается: станция этот режим не исполняет, а выбор
              // уезжал в неё через AMI (routingModeSync.ts) как рабочий.
              disabled={!option.live && mode !== option.value}
              onClick={() => updateSettings.mutate({ incomingRoutingMode: option.value })}
            >
              {option.title}
              {!option.live && <span className="n">скоро</span>}
            </button>
          ))}
        </div>
      </div>
      <div className="quiet">
        <span className={current?.live ? "dot" : "dot warn"} />
        <span className="txt">
          {current?.hint}
          {current && !current.live ? " Пока не работает на линии: настройка станции ещё не сделана." : ""}
        </span>
      </div>

      {mode !== "assigned_then_forward" && !amiReady && (
        <div className="quiet warn">
          <span className="dot warn" />
          <span className="txt">Выбор не доедет до станции: не настроено управление станцией (раздел выше).</span>
        </div>
      )}

      {mode === "dedicated_operator" && <DutyRosterSetting />}
    </>
  );
}

/**
 * СПИСОК ДЕЖУРНЫХ — порядок в списке и есть порядок ротации (владелец 20.08.2026).
 * Кто дежурит сегодня, сервер считает сам по календарному дню (Душанбе) — здесь
 * только порядок; никакого «курсора» или «кто дежурил вчера» хранить не нужно.
 * Показываем только активных сотрудников — уволенного агента в списке дежурных
 * сервер тоже пропустит (agent_not_found в журнале), но заводить его туда заново
 * незачем.
 */
function DutyRosterSetting() {
  const { data: settings } = useSettings();
  const updateSettings = useUpdateSettings();
  const { data: agents } = useAgents();
  const roster = settings?.incomingDutyAgentIds ?? [];

  const byId = new Map((agents ?? []).map((a) => [a.id, a]));
  const available = (agents ?? []).filter((a) => a.isActive && !roster.includes(a.id));

  const save = (next: string[]) => updateSettings.mutate({ incomingDutyAgentIds: next });
  const move = (index: number, delta: number) => {
    const next = [...roster];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    save(next);
  };
  const remove = (index: number) => save(roster.filter((_, i) => i !== index));

  return (
    <>
      <div className="grp-lab">Список дежурных, по порядку</div>
      <div className="quiet">
        <span className="dot" />
        <span className="txt">
          Кто дежурит сегодня, считается по календарному дню — сам список только задаёт порядок ротации. Пустой список
          — дежурить некому, звонок остаётся на прежнем дежурном номере.
        </span>
      </div>

      {roster.length === 0 && (
        <div className="quiet warn">
          <span className="dot warn" />
          <span className="txt">Список пуст — добавьте хотя бы одного сотрудника.</span>
        </div>
      )}

      <div className="list">
        {roster.map((agentId, index) => {
          const agent = byId.get(agentId);
          return (
            <div className="row" key={agentId}>
              <span className="av">{index + 1}</span>
              <div className="t">
                <b>{agent?.fullName ?? "Сотрудник удалён"}</b>
                {agent && !agent.sipExtension && <span>Нет внутреннего номера, звонок пропустит его</span>}
              </div>
              <div className="act">
                <button
                  className="pill ghost sm"
                  type="button"
                  onClick={() => move(index, -1)}
                  disabled={index === 0}
                  aria-label={`Выше: ${agent?.fullName ?? "сотрудник"}`}
                >
                  Выше
                </button>
                <button
                  className="pill ghost sm"
                  type="button"
                  onClick={() => move(index, 1)}
                  disabled={index === roster.length - 1}
                  aria-label={`Ниже: ${agent?.fullName ?? "сотрудник"}`}
                >
                  Ниже
                </button>
                <button
                  className="pill ghost sm"
                  type="button"
                  onClick={() => remove(index)}
                  aria-label={`Убрать: ${agent?.fullName ?? "сотрудник"}`}
                >
                  Убрать
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {available.length > 0 && (
        <label className="fld" style={{ marginTop: "var(--s3)" }}>
          <span className="lab">Добавить дежурного</span>
          <select
            value=""
            onChange={(e) => {
              if (e.target.value) save([...roster, e.target.value]);
            }}
          >
            <option value="">Выберите сотрудника</option>
            {available.map((a) => (
              <option key={a.id} value={a.id}>
                {a.fullName}
              </option>
            ))}
          </select>
        </label>
      )}
    </>
  );
}

/** Сколько звонить агенту, прежде чем перейти на голосовую почту (владелец
 *  29.08.2026: «пусть ждёт много, 2-3 минуты, а потом уже голосовая почта» —
 *  звонок больше не возвращается в очередь операторов ни при каком исходе).
 *  0 — без ограничения (владелец 20.08.2026): звонить, пока клиент сам не
 *  положит трубку. */
function RingSecondsSetting({
  value,
  consultant,
  pending,
  onSave,
}: {
  value: number;
  /** Консультант на входящих действует (lib/consultantInbound.ts): не взял агент —
   *  трубку берёт он, а не голосовая почта. */
  consultant: boolean;
  pending: boolean;
  onSave: (value: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  const parsed = Number(draft);
  const valid = Number.isInteger(parsed) && (parsed === 0 || (parsed >= 5 && parsed <= 300));
  const next = consultant ? "трубку берёт консультант" : "звонок переходит на голосовую почту";
  return (
    <div className={valid ? "mod" : "mod bad"}>
      <div className="t">
        <b>Сколько звонить агенту</b>
        <span style={{ whiteSpace: "normal" }}>
          {value === 0
            ? `Сейчас без ограничения: станция звонит агенту, пока клиент сам не положит трубку, дальше звонок никуда не переходит.`
            : `Сейчас ${value} с. Не взял агент — ${next}, в очередь операторов звонок не возвращается.`}{" "}
          0 — без ограничения. Реальный потолок всё равно ставит оператор связи звонящего (обычно 30–60 секунд гудков
          до сброса неотвеченного звонка), а не CRM.
        </span>
      </div>
      <div className="acts">
        <span className="nf">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            inputMode="numeric"
            aria-label="Сколько звонить агенту"
          />
          <span className="u">секунд</span>
        </span>
        <button className="pill sm" type="button" onClick={() => onSave(parsed)} disabled={!valid || parsed === value || pending}>
          Сохранить
        </button>
      </div>
      {!valid && <p className="msg">Допустимо 0 (без ограничения) либо от 5 до 300 секунд.</p>}
      {consultant && (value === 0 || value > 25) && (
        <p className="msg">
          Сеть звонящего обычно сбрасывает гудки через 30–60 секунд — при таком ожидании клиент может положить трубку
          раньше, чем до него дойдёт консультант. Меньше 25 секунд — консультант успеет наверняка.
        </p>
      )}
    </div>
  );
}

/**
 * ПОМЕТКА «ЭТО ПРАВИЛО СЕЙЧАС ЗАМЕНЯЕТ КОНСУЛЬТАНТ» (28.09.2026). Правила остаются
 * доступными: владелец может готовить их на случай, когда консультанта выключат, —
 * а сохранённые значения никто не трогает. Задача пометки — чтобы экран не
 * показывал рабочим правило, которое станция сейчас пропускает (см.
 * lib/consultantInbound.ts), и наоборот.
 */
function ConsultantOverrideNote() {
  const { data: settings } = useSettings();
  const state = consultantInboundState(settings);
  if (state === "off") return null;
  return (
    <div className={state === "active" ? "quiet warn" : "quiet"}>
      <span className={state === "active" ? "dot warn" : "dot"} />
      <span className="txt">{state === "active" ? CONSULTANT_OVERRIDES_NOTE : CONSULTANT_BLOCKED_NOTE}</span>
    </div>
  );
}

function SecondsSetting({
  value,
  pending,
  onSave,
}: {
  value: number;
  pending: boolean;
  onSave: (value: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  const parsed = Number(draft);
  const valid = Number.isInteger(parsed) && parsed >= 5 && parsed <= 300;
  return (
    <div className={valid ? "mod" : "mod bad"}>
      <div className="t">
        <b>Сколько ждать оператора</b>
        <span>20 секунд — это примерно четыре гудка: дольше человек начинает класть трубку.</span>
      </div>
      <div className="acts">
        <span className="nf">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            inputMode="numeric"
            aria-label="Сколько ждать оператора"
          />
          <span className="u">секунд</span>
        </span>
        <button className="pill sm" type="button" onClick={() => onSave(parsed)} disabled={!valid || parsed === value || pending}>
          Сохранить
        </button>
      </div>
      {!valid && <p className="msg">Допустимо от 5 до 300 секунд.</p>}
    </div>
  );
}
