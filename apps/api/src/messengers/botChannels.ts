import { prisma } from "../db.js";

/**
 * Рубильники бота по каналам: «выключить Instagram, оставив WhatsApp».
 *
 * Раньше рубильник был один на всё (`botEnabled`), а `metaEnabled` гасил сразу
 * три канала Meta. Если бот начинал плохо отвечать в Instagram, унять его можно
 * было только вместе с WhatsApp, где всё было в порядке.
 *
 * Здесь строго один вопрос: ГОВОРИТ ли бот в этом канале. Подключён ли канал
 * вообще (ключи, вебхуки, `metaEnabled`) — вопрос другой и живёт в meta.ts:
 * смешивать их нельзя, потому что владелец обязан мочь принимать входящие и при
 * этом молчать. Выключенный здесь канал по-прежнему складывает сообщения в
 * переписку CRM — ровно так же, как выключенный `botEnabled`.
 *
 * Общий рубильник сильнее: канальный только сужает его, но не включает обратно.
 */
export type BotChannel = "WHATSAPP" | "INSTAGRAM" | "FACEBOOK" | "TELEGRAM";

export const BOT_CHANNELS: BotChannel[] = ["WHATSAPP", "INSTAGRAM", "FACEBOOK", "TELEGRAM"];

/** Поле Settings под каждый канал. Записано таблицей, а не цепочкой `if`: канал
 *  добавляется одной строкой здесь, а не правкой каждой проверки. */
const FIELD_BY_CHANNEL = {
  WHATSAPP: "botWhatsappEnabled",
  INSTAGRAM: "botInstagramEnabled",
  FACEBOOK: "botFacebookEnabled",
  TELEGRAM: "botTelegramEnabled",
} as const satisfies Record<BotChannel, string>;

/** Состояние всех рубильников разом: общий плюс по каналам. */
export interface BotChannelToggles {
  /** Общий рубильник (Настройки → Бот → «Бот отвечает клиентам»). */
  botEnabled: boolean;
  /** Ответ бота разрешён в этом канале (уже с учётом общего рубильника). */
  channels: Record<BotChannel, boolean>;
}

/** Канал диалога в наш перечень. Диалоги хранят канал строкой (см. BotConversation.channel). */
export function asBotChannel(channel: string): BotChannel | null {
  return (BOT_CHANNELS as readonly string[]).includes(channel) ? (channel as BotChannel) : null;
}

/**
 * Все рубильники одним запросом.
 *
 * Нужна там, где решение принимается для СПИСКА диалогов (напоминания в cron.ts
 * идут по 200 штук): отдельный запрос к настройкам на каждый диалог — это N+1 на
 * ровном месте, а настройки за один проход всё равно не меняются.
 *
 * Отказ базы трактуется как «бот работает»: молча замолчавший бот страшнее
 * лишнего ответа, и ровно так же ведёт себя общий рубильник в conversation.ts.
 */
export async function loadBotChannelToggles(): Promise<BotChannelToggles> {
  try {
    const settings = await prisma.settings.findUnique({
      where: { id: "singleton" },
      select: {
        botEnabled: true,
        botWhatsappEnabled: true,
        botInstagramEnabled: true,
        botFacebookEnabled: true,
        botTelegramEnabled: true,
      },
    });
    const botEnabled = settings?.botEnabled ?? true;
    const channels = Object.fromEntries(
      BOT_CHANNELS.map((channel) => [channel, botEnabled && (settings?.[FIELD_BY_CHANNEL[channel]] ?? true)])
    ) as Record<BotChannel, boolean>;
    return { botEnabled, channels };
  } catch {
    return {
      botEnabled: true,
      channels: Object.fromEntries(BOT_CHANNELS.map((c) => [c, true])) as Record<BotChannel, boolean>,
    };
  }
}

/** Каналы личной переписки, где бот отвечает клиентам сам (без Telegram: у него свои таблицы и сторожа). */
export type BotDmChannel = "WHATSAPP" | "INSTAGRAM" | "FACEBOOK" | "WEBSITE";

/**
 * ДОЛЖЕН ЛИ БОТ СЕЙЧАС ОТВЕЧАТЬ В КАНАЛЕ — по всем рубильникам Настроек разом (27.11.2026, сторож «бот замолчал»).
 *
 * То же правило, что у ядра (`legacyBotEnabled` в lib/customerState.ts): общий `botEnabled` И канальный рубильник;
 * у каналов Meta ещё `metaEnabled` (канал Meta выключен — бот там не говорит), у сайта — `botWebsiteChatEnabled`.
 * Нет строки настроек: бот включён, Meta — нет (как `isMetaChannelEnabled` в meta.ts). Сбой базы уходит вызывающему:
 * сторожу лучше пропустить тик, чем решить «выключено» или «включено» наугад.
 */
export async function loadBotAnswerSwitches(): Promise<Record<BotDmChannel, boolean>> {
  const s = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { botEnabled: true, metaEnabled: true, botWhatsappEnabled: true, botInstagramEnabled: true, botFacebookEnabled: true,
      botWebsiteChatEnabled: true },
  });
  const bot = s?.botEnabled ?? true;
  const meta = s?.metaEnabled ?? false;
  return {
    WHATSAPP: bot && meta && (s?.botWhatsappEnabled ?? true),
    INSTAGRAM: bot && meta && (s?.botInstagramEnabled ?? true),
    FACEBOOK: bot && meta && (s?.botFacebookEnabled ?? true),
    WEBSITE: bot && (s?.botWebsiteChatEnabled ?? true),
  };
}

/**
 * Отвечает ли бот в этом канале прямо сейчас.
 *
 * Канал приходит строкой, потому что в диалогах он строка. Незнакомый канал
 * (например, будущий транспорт, для которого рубильника ещё нет) подчиняется
 * только общему рубильнику — иначе новый канал молчал бы без всякой причины.
 */
export async function isBotEnabledForChannel(channel: string): Promise<boolean> {
  const { botEnabled, channels } = await loadBotChannelToggles();
  const known = asBotChannel(channel);
  return known ? channels[known] : botEnabled;
}
