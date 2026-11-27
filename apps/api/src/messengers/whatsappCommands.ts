/**
 * КОМАНДЫ И ПРИВЕТСТВИЕ WHATSAPP (27.11.2026, просьба владельца для обоих номеров: Royal Home и «Арван»).
 *
 * Чистый модуль без базы: его зовёт разбор вебхука (meta.ts::parseIncoming) и скрипт включения у Meta
 * (список команд берётся ОТСЮДА, второй копии нет).
 *
 * ФАКТ (developers.facebook.com/docs/whatsapp/cloud-api/phone-numbers/conversational-components, прочитано 27.11.2026):
 *  - команда — строка, которую человек видит, набрав «/»; до 30 команд, имя ≤ 32 знаков, подсказка ≤ 256, без эмодзи;
 *  - выбранная команда приходит ОБЫЧНЫМ текстовым сообщением, ровно тем текстом, что набран («/имя …»);
 *  - настройка: POST /<PHONE_NUMBER_ID>/conversational_automation { commands, prompts, enable_welcome_message }.
 *
 * Бот понимает команду через ТО ЖЕ ядро, что и обычный текст: команда переводится в слова человека («/харидан» →
 * «Мехоҳам хона харам») в одном месте разбора, и дальше ход идёт как любой другой. Отдельной логики ответа на команду
 * нет — значит, нет и второго места, где бот мог бы ответить иначе, чем на те же слова.
 *
 * Команды по-таджикски, 3–4 штуки (поправка владельца 27.11.2026). Адрес у обоих брендов один: ул. Бухоро 49, 2 этаж.
 */

/** Рубильники (по умолчанию ВКЛ, `off` выключает): каждая новая возможность отдельно. */
type Env = Record<string, string | undefined>;
const isOff = (value: string | undefined) => value?.trim().toLowerCase() === "off";
/** Команды «/…» переводятся в слова человека. Выключено — текст «/харидан» уходит ядру как есть. */
export function whatsappCommandsEnabled(env: Env = process.env): boolean {
  return !isOff(env.WHATSAPP_COMMANDS);
}
/** Приветствие на `request_welcome` (человек впервые открыл чат). */
export function whatsappWelcomeEnabled(env: Env = process.env): boolean {
  return !isOff(env.WHATSAPP_WELCOME);
}
/** Разрешение клиента на звонок (call_permission_reply) — просьба о звонке агенту и в CRM. */
export function whatsappCallbackRequestsEnabled(env: Env = process.env): boolean {
  return !isOff(env.WHATSAPP_CALLBACK_REQUESTS);
}

export interface WhatsappCommand {
  /** Имя без «/», как его видит человек и как оно уходит в Meta. ≤ 32 знаков. */
  name: string;
  /** Подсказка рядом с командой в WhatsApp. ≤ 256 знаков, без эмодзи и без длинного тире. */
  description: string;
  /** Что команда значит словами человека — это и получает ядро бота. */
  phrase: string;
  /** Другие написания той же команды: без таджикских букв, латиницей, по-русски. Нижний регистр. */
  aliases: readonly string[];
}

/** Адрес офиса — один на оба бренда (владелец 27.11.2026). */
export const WHATSAPP_OFFICE_ADDRESS_TG = "Душанбе, кӯчаи Бухоро 49, ошёнаи 2";

export const WHATSAPP_COMMANDS: readonly WhatsappCommand[] = [
  {
    name: "харидан",
    description: "Мехоҳам хона харам",
    phrase: "Мехоҳам хона харам",
    aliases: ["харидан", "харид", "kharidan", "xaridan", "haridan", "купить"],
  },
  {
    name: "фурӯхтан",
    description: "Мехоҳам хонаамро фурӯшам",
    phrase: "Мехоҳам хонаамро фурӯшам",
    aliases: ["фурӯхтан", "фурухтан", "фурӯш", "фуруш", "furukhtan", "furuxtan", "furuhtan", "продать"],
  },
  {
    name: "агент",
    description: "Бо агенти мо гап задан",
    // «бо агент … гап зан» — та же примета, по которой ядро узнаёт просьбу живого человека (ai/operatorHandoff.ts).
    phrase: "Мехоҳам бо агент гап занам",
    aliases: ["агент", "agent", "оператор", "operator", "одам"],
  },
  {
    name: "суроға",
    description: `Суроғаи офис: ${WHATSAPP_OFFICE_ADDRESS_TG}`,
    phrase: "Суроғаи офиси шумо куҷост?",
    aliases: ["суроға", "сурога", "suroga", "surogha", "адрес", "address", "manzil", "манзил"],
  },
];

/** Тело команд для Meta (conversational_automation.commands): имя без «/» и подсказка. */
export function whatsappCommandsForMeta(): Array<{ command_name: string; command_description: string }> {
  return WHATSAPP_COMMANDS.map((c) => ({ command_name: c.name, command_description: c.description }));
}

/** Подсказки начала беседы (ice breakers) — две, по-таджикски (владелец 27.11.2026). Передаются заново при каждом POST. */
export const WHATSAPP_PROMPTS: readonly string[] = ["Мехоҳам хона харам", "Мехоҳам хонаамро фурӯшам"];

const COMMAND_RE = /^\s*\/([^\s/]+)(?:\s+([\s\S]*))?$/u;

/**
 * Текст «/команда …» → слова человека для ядра; null — это не наша команда (обычный текст, «/» посреди фразы,
 * незнакомое имя): тогда текст идёт ядру как есть. Хвост после команды не теряется: «/харидан 3 хонагӣ» →
 * «Мехоҳам хона харам. 3 хонагӣ».
 */
export function whatsappCommandText(text: string | null | undefined): string | null {
  if (!text) return null;
  const match = COMMAND_RE.exec(text);
  if (!match) return null;
  const name = match[1].toLowerCase().normalize("NFC");
  const command = WHATSAPP_COMMANDS.find((c) => c.name === name || c.aliases.includes(name));
  if (!command) return null;
  const rest = match[2]?.trim();
  return rest ? `${command.phrase}. ${rest}` : command.phrase;
}

/**
 * ПРИВЕТСТВИЕ НА ПЕРВОЕ ОТКРЫТИЕ ЧАТА. Язык человека ещё неизвестен (он ничего не написал), поэтому одно сообщение на
 * двух языках: таджикский первым (аудитория чатов таджикоязычная), русский вторым. Один вопрос: купить или продать
 * (правило владельца: сначала «купить/продать»). На «вы»/«шумо», без длинного тире. Таджикский — по скиллу
 * tajik-phrasebook: «Шумо … мехоҳед ё …?» как «Барои харидан мепурсед ё барои иҷора?» (живые фразы агентов).
 */
export function whatsappWelcomeText(brand: string): string {
  const name = brand.trim() || "Royal Home";
  return [
    `Ассалому алейкум! Ин ${name}. Шумо хона харидан мехоҳед ё фурӯхтан?`,
    `Здравствуйте! Это ${name}. Подскажите, вы хотите купить жильё или продать?`,
  ].join("\n\n");
}
