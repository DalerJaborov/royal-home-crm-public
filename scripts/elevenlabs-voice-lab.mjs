#!/usr/bin/env node
/**
 * Лаборатория голосов ElevenLabs (24.10.2026): подобрать «живой» голос для робота.
 *
 * Запускать НЕ с сервера CRM (ElevenLabs блокирует РФ), а с машины в разрешённой стране.
 * Ключ — только из окружения, в файлы и вывод не попадает:
 *
 *   ELEVENLABS_API_KEY=… node scripts/elevenlabs-voice-lab.mjs voices      — лучшие русские разговорные голоса
 *   ELEVENLABS_API_KEY=… node scripts/elevenlabs-voice-lab.mjs samples     — озвучить приглашение каждым (mp3 + «телефон» 8 кГц)
 *   ELEVENLABS_API_KEY=… node scripts/elevenlabs-voice-lab.mjs agent <voice_id>  — тестовый агент «Royal Home — тест»
 *
 * Файлы — в ./elevenlabs-lab/ рядом с запуском (в git не кладутся).
 */
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const API = "https://api.elevenlabs.io";
const KEY = process.env.ELEVENLABS_API_KEY?.trim();
const OUT = join(process.cwd(), "elevenlabs-lab");
const MODEL = "eleven_v4_turbo";

/** Текст приглашения — как говорит живой менеджер, а не диктор: коротко, числа словами. */
const INVITE_TEXT =
  "Алло, здравствуйте! Это Royal Home, агентство недвижимости. Вы откликались на вакансию агента — " +
  "удобно сейчас пару минут? ... Отлично. Хотим пригласить вас на собеседование, в субботу, двадцать четвёртого, " +
  "в два часа дня. Офис на Бухоро, сорок девять, Бухоро Тауэр, второй этаж. Адрес и карту я вам пришлю эсэмэской. " +
  "Вам такое время подходит?";

/** Промт агента по руководству ElevenLabs (Personality / Goal / Tone / Guardrails), коротко. */
const AGENT_PROMPT = `# Personality
Ты Нигина — менеджер по подбору в агентстве недвижимости Royal Home в Душанбе. Живой, тёплый, спокойный человек, говоришь по телефону как обычный сотрудник, а не как диктор.

# Goal
Пригласить кандидата на собеседование на вакансию «Агент по недвижимости»: суббота, двадцать четвёртое октября, два часа дня. Офис: улица Бухоро, сорок девять, Бухоро Тауэр, второй этаж. Узнать, подходит ли время. Если нет — спросить, когда удобно, и сказать, что передашь руководителю.

# Tone
- Отвечай коротко: одно-два предложения. This step is important.
- Говори разговорно: «ага», «поняла», «смотрите», «секундочку». Можно лёгкие паузы.
- Числа, даты, время и адреса — только словами.
- Адрес целиком не зачитывай дважды: скажи один раз и что пришлёшь его эсэмэской.
- Не перебивай; если человек заговорил — замолчи и слушай.

# Guardrails
- Не обещай приём на работу и зарплату — решение после собеседования.
- Если человек говорит по-таджикски — переходи на таджикский.
- Если отвечает не тот человек — извинись и попрощайся.
- Если не знаешь ответа — честно скажи, что уточнишь у руководителя. This step is important.`;

function need(cond, msg) {
  if (!cond) { console.error(msg); process.exit(1); }
}

async function el(path, init = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    redirect: "manual",
    headers: { "xi-api-key": KEY, ...(typeof init.body === "string" ? { "content-type": "application/json" } : {}) },
    signal: AbortSignal.timeout(60_000),
  });
  if (res.status === 302) throw new Error("ElevenLabs закрыт с этого адреса (geo-restriction) — запускайте с машины вне РФ");
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path}: HTTP ${res.status} ${(await res.text()).slice(0, 400)}`);
  return res;
}

async function topVoices() {
  const params = new URLSearchParams({ page_size: "40", language: "ru", sort: "usage_character_count_1y" });
  params.append("use_cases", "conversational");
  let { voices } = await (await el(`/v1/shared-voices?${params}`)).json();
  if (!voices?.length) {
    // Фильтр use_cases может называться иначе — тогда только язык.
    ({ voices } = await (await el("/v1/shared-voices?page_size=40&language=ru&sort=usage_character_count_1y")).json());
  }
  return (voices ?? []).slice(0, 8);
}

async function cmdVoices() {
  const voices = await topVoices();
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "voices.json"), JSON.stringify(voices, null, 2));
  for (const v of voices) console.log(`${v.voice_id}  ${v.gender ?? "?"}  ${v.age ?? ""}  ${v.name}  — ${v.use_case ?? ""} ${v.accent ?? ""}`);
  console.log(`\nСписок сохранён: ${join(OUT, "voices.json")}`);
}

async function ensureVoice(v) {
  if (v.is_added_by_user) return v.voice_id;
  const res = await el(`/v1/voices/add/${v.public_owner_id}/${v.voice_id}`, {
    method: "POST", body: JSON.stringify({ new_name: `RH test — ${v.name}`.slice(0, 60) }),
  });
  return (await res.json()).voice_id;
}

async function tts(voiceId, format, settings) {
  const res = await el(`/v1/text-to-speech/${voiceId}?output_format=${format}`, {
    method: "POST",
    body: JSON.stringify({ text: INVITE_TEXT, model_id: MODEL, language_code: "ru", apply_text_normalization: "on", voice_settings: settings }),
  });
  return Buffer.from(await res.arrayBuffer());
}

/** μ-law 8 кГц → WAV, чтобы «телефонный» вариант открывался любым плеером. */
function ulawToWav(ulaw) {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + ulaw.length, 4); h.write("WAVE", 8);
  h.write("fmt ", 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(7, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(8000, 24); h.writeUInt32LE(8000, 28); h.writeUInt16LE(1, 32); h.writeUInt16LE(8, 34);
  h.write("data", 36); h.writeUInt32LE(ulaw.length, 40);
  return Buffer.concat([h, ulaw]);
}

async function cmdSamples() {
  const file = join(OUT, "voices.json");
  const voices = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : await topVoices();
  mkdirSync(OUT, { recursive: true });
  // Живее диктора: стабильность ниже середины, скорость чуть выше обычной.
  const settings = { stability: 0.35, similarity_boost: 0.75, style: 0.2, speed: 1.03, use_speaker_boost: true };
  for (const [i, v] of voices.entries()) {
    try {
      const id = await ensureVoice(v);
      const safe = `${String(i + 1).padStart(2, "0")}-${v.name.replace(/[^\p{L}\p{N}]+/gu, "_").slice(0, 30)}`;
      writeFileSync(join(OUT, `${safe}-studio.mp3`), await tts(id, "mp3_44100_128", settings));
      writeFileSync(join(OUT, `${safe}-phone8k.wav`), ulawToWav(await tts(id, "ulaw_8000", settings)));
      console.log(`готово: ${safe}  (voice_id ${id})`);
    } catch (err) {
      console.log(`пропуск ${v.name}: ${err.message}`);
    }
  }
  console.log(`\nСлушайте: ${OUT}  (…-phone8k.wav — так звучит по телефону)`);
}

async function cmdAgent(voiceId) {
  need(voiceId, "Укажите voice_id: node scripts/elevenlabs-voice-lab.mjs agent <voice_id>");
  const body = {
    name: "Royal Home — тест (приглашение)",
    conversation_config: {
      agent: { first_message: "Алло, здравствуйте! Это Royal Home, агентство недвижимости. Вам удобно сейчас пару минут поговорить?", language: "ru", prompt: { prompt: AGENT_PROMPT, llm: "gemini-2.5-flash", temperature: 0.6 } },
      tts: { model_id: MODEL, voice_id: voiceId, stability: 0.35, speed: 1.03, similarity_boost: 0.75, expressive_mode: true, agent_output_audio_format: "ulaw_8000" },
      turn: { turn_timeout: 7, turn_eagerness: "patient", soft_timeout_config: { timeout_seconds: 3, message: "Секундочку…", use_llm_generated_message: true } },
      asr: { quality: "high", provider: "scribe_realtime", user_input_audio_format: "ulaw_8000" },
      conversation: { max_duration_seconds: 300 },
    },
  };
  const res = await el("/v1/convai/agents/create", { method: "POST", body: JSON.stringify(body) });
  const { agent_id } = await res.json();
  console.log(`Агент создан: ${agent_id}\nОткройте https://elevenlabs.io/app/agents/agents/${agent_id} и нажмите «Test AI agent».`);
}

need(KEY, "Нет ELEVENLABS_API_KEY в окружении (ключ вводит владелец в своём терминале).");
const [cmd, arg] = process.argv.slice(2);
const run = { voices: cmdVoices, samples: cmdSamples, agent: () => cmdAgent(arg) }[cmd];
need(run, "Команда: voices | samples | agent <voice_id>");
run().catch((err) => { console.error(err.message); process.exit(1); });
