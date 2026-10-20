/**
 * ГОЛОСА GEMINI И ИХ ПОЛ — ОДНО МЕСТО (02.10.2026, жалоба владельца с живых
 * звонков: женский голос говорил о себе «понял, записал»).
 *
 * Голос выбирается в коде до звонка (Настройки → Бот → Живой голос, два поля:
 * для русского и для таджикского), а промт о нём ничего не знал — без указания
 * модель говорит о себе по-русски в мужском роде. Таблица ниже нужна двум
 * сторонам сразу: сайт пишет в выпадающем списке «женский/мужской», сервер
 * вешает на промт правило рода ОТ ГОЛОСА, КОТОРЫЙ ФАКТИЧЕСКИ ЗВУЧИТ в этом
 * звонке (lib/telephony/liveVoiceBridge.ts → ai/liveVoiceSelfGender.ts).
 *
 * Источник пола: список голосов Google Cloud TTS «Chirp 3: HD» — те же 30 имён,
 * у каждого указан пол. На живых звонках этого репозитория проверены Kore
 * (женский) и Enceladus (мужской). Характер подачи — официальная таблица
 * ai.google.dev/gemini-api/docs/speech-generation.
 */

export type VoiceGender = "female" | "male";

export interface GeminiVoice {
  /** Имя голоса, как его ждёт Gemini (speechConfig.voiceName). */
  value: string;
  /** Характер подачи по-русски. */
  character: string;
  gender: VoiceGender;
}

export const GEMINI_VOICES: readonly GeminiVoice[] = [
  { value: "Zephyr", character: "яркий", gender: "female" },
  { value: "Puck", character: "бодрый", gender: "male" },
  { value: "Charon", character: "дикторский", gender: "male" },
  { value: "Kore", character: "уверенный", gender: "female" },
  { value: "Fenrir", character: "эмоциональный", gender: "male" },
  { value: "Leda", character: "молодой", gender: "female" },
  { value: "Orus", character: "уверенный", gender: "male" },
  { value: "Aoede", character: "лёгкий", gender: "female" },
  { value: "Callirrhoe", character: "непринуждённый", gender: "female" },
  { value: "Autonoe", character: "яркий", gender: "female" },
  { value: "Enceladus", character: "с придыханием", gender: "male" },
  { value: "Iapetus", character: "чёткий", gender: "male" },
  { value: "Umbriel", character: "непринуждённый", gender: "male" },
  { value: "Algieba", character: "гладкий", gender: "male" },
  { value: "Despina", character: "гладкий", gender: "female" },
  { value: "Erinome", character: "чёткий", gender: "female" },
  { value: "Algenib", character: "хрипловатый", gender: "male" },
  { value: "Rasalgethi", character: "дикторский", gender: "male" },
  { value: "Laomedeia", character: "бодрый", gender: "female" },
  { value: "Achernar", character: "мягкий", gender: "female" },
  { value: "Alnilam", character: "уверенный", gender: "male" },
  { value: "Schedar", character: "ровный", gender: "male" },
  { value: "Gacrux", character: "зрелый", gender: "female" },
  { value: "Pulcherrima", character: "напористый", gender: "female" },
  { value: "Achird", character: "дружелюбный", gender: "male" },
  { value: "Zubenelgenubi", character: "разговорный", gender: "male" },
  { value: "Vindemiatrix", character: "нежный", gender: "female" },
  { value: "Sadachbia", character: "живой", gender: "male" },
  { value: "Sadaltager", character: "уверенно-экспертный", gender: "male" },
  { value: "Sulafat", character: "тёплый", gender: "female" },
];

/** Голос по умолчанию у живого голоса и озвучки (liveVoiceBridge.ts, ai/tts.ts). */
export const DEFAULT_GEMINI_VOICE = "Kore";

/**
 * Пол голоса. Неизвестное имя (опечатка в переменной окружения, новый голос
 * Google) — женский: голос по умолчанию Kore женский, и если имя не узнали,
 * скорее всего звучит именно он.
 */
export function voiceGender(name: string | null | undefined): VoiceGender {
  const key = String(name ?? "").trim().toLowerCase();
  const hit = GEMINI_VOICES.find((v) => v.value.toLowerCase() === key);
  return hit ? hit.gender : "female";
}

/** «женский» / «мужской» — подпись в Настройках. */
export function voiceGenderLabel(gender: VoiceGender): string {
  return gender === "female" ? "женский" : "мужской";
}

/** Имя на случай, когда роли нужно представиться по имени (опрос после показа,
 *  проверка продавца): имя совпадает с полом голоса. */
export function voicePersonaName(gender: VoiceGender): string {
  return gender === "female" ? "Мадина" : "Фаррух";
}

/** «сотрудница» / «сотрудник». */
export function voiceStaffNoun(gender: VoiceGender): string {
  return gender === "female" ? "сотрудница" : "сотрудник";
}

/**
 * ПРАВИЛО РОДА ДЛЯ ПРОМТА ЖИВОГО ГОЛОСА — по-русски, с короткой пометкой про
 * таджикский (там у глаголов рода нет). Вешается на системный промт в мосте от
 * имени голоса, который фактически звучит в звонке.
 */
export function selfGenderRule(gender: VoiceGender): string {
  const female = gender === "female";
  const who = female ? "ЖЕНСКИМ" : "МУЖСКИМ";
  const kind = female ? "женском" : "мужском";
  const right = female
    ? "«поняла», «записала», «посмотрела», «не расслышала», «рада», «я сама»"
    : "«понял», «записал», «посмотрел», «не расслышал», «рад», «я сам»";
  const wrong = female ? "«понял», «записал», «рад», «не расслышал»" : "«поняла», «записала», «рада», «не расслышала»";
  const listener = female ? "женщину" : "мужчину";
  const noun = voiceStaffNoun(gender);
  const other = female ? "«сотрудник» или мужским именем" : "«сотрудница» или женским именем";
  return (
    `ТЫ ГОВОРИШЬ ${who} ГОЛОСОМ, ПОЭТОМУ О СЕБЕ — ТОЛЬКО В ${kind.toUpperCase()} РОДЕ: ${right}. ` +
    `О себе ${wrong} — грубая ошибка: человек слышит ${listener}, и такая фраза сразу выдаёт машину. ` +
    `Сомневаешься — строй фразу без прошедшего времени: «ясно», «ага», «сейчас посмотрю», «записываю».\n` +
    `Если где-то выше тебя назвали ${other} — это ошибка текста, а не твоя роль: ты ${noun}, говоришь о себе в ${kind} роде, а то имя не называешь вовсе. ` +
    `Личное имя себе не придумывай никогда: если выше тебе не дано имя, подходящее к твоему голосу, представляйся без имени.\n` +
    `По-таджикски у глаголов рода нет — там это правило не действует, говори как обычно.`
  );
}

/** Короткое напоминание в первую служебную реплику: Gemini Live лучше держит
 *  правило, которое пришло и в промте, и в первой реплике. */
export function selfGenderReminder(gender: VoiceGender): string {
  return gender === "female" ? "(О себе — в женском роде.)" : "(О себе — в мужском роде.)";
}
