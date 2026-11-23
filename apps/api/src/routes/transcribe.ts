import { Router } from "express";
import { UploadRejectedError, guardedUpload } from "../upload.js";
import { PROXY_SINGLE_REQUEST_MAX_BYTES } from "@royal-home/shared";
import multer from "multer";
import { requireAuth } from "../auth/middleware.js";
import { transcribeAudioResult } from "../ai/transcribe.js";
import { traceMeasured } from "../lib/botTurnTrace.js";
import { memoryUploadBudget } from "../lib/memoryUploadBudget.js";
import { agentSpeechLimiter } from "../lib/agentSpeechLimiter.js";
import { normalizeDictationMime } from "../lib/dictationMime.js";

/**
 * Диктовка голосом в CRM (комментарии взаимодействия, ИИ-ассистент).
 *
 * ПОЧЕМУ MediaRecorder + Gemini, А НЕ Web Speech API БРАУЗЕРА. Прежняя реализация
 * (useSpeechRecognition, теперь удалена) писала через SpeechRecognition — тот
 * жёстко понимает конечный список языков, и таджикского там нет вовсе ни в одном
 * браузере. Владелец 05.08.2026: «не распознаёт таджикский». Здесь тот же путь,
 * что уже год расшифровывает голосовые клиентов из мессенджеров на таджикском
 * (ai/transcribe.ts — единственный провайдер, который пишет таджикскую речь
 * таджикской кириллицей, не фарси).
 */
const upload = guardedUpload({
  name: "dictationUpload",
  maxRequestBytes: PROXY_SINGLE_REQUEST_MAX_BYTES,
  storage: multer.memoryStorage(),
  // 5 МБ с запасом на ~60 секунд webm/opus (потолок длины записи — на фронте).
  // files: 1 — не формальность: без него предел на файл не ограничивает запрос
  // целиком (можно прислать сколько угодно записей по 5 МБ в память процесса).
  // Диктовка всегда одна: обработчик ниже читает req.file (аудит лимитов 21.08.2026).
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    // Safari/iPhone пишут `audio/mp4`, Chrome — `audio/webm;codecs=opus`; часть Android
    // отдаёт чисто звуковую запись с типом `video/webm`/`video/mp4` (контейнер тот же).
    if (!normalizeDictationMime(file.mimetype)) {
      return cb(new UploadRejectedError("Допустимо только аудио"));
    }
    cb(null, true);
  },
});

export const transcribeRouter = Router();

// Платный вызов модели: свой потолок на сотрудника (находка №149).
const transcribeLimiter = agentSpeechLimiter("на расшифровку речи");

transcribeRouter.post("/", requireAuth, transcribeLimiter, memoryUploadBudget, upload.single("audio"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Аудио не передано" });
  // Тип без параметров кодека: поставщик получает чистый `audio/webm`, а не `audio/webm;codecs=opus`.
  const mediaType = normalizeDictationMime(req.file.mimetype) ?? "audio/webm";
  const result = await traceMeasured("asr", () => transcribeAudioResult(req.file!.buffer, req.file!.originalname || "voice.webm", mediaType));
  /**
   * ЧЕСТНЫЙ ОТВЕТ ВМЕСТО «СЕРВЕР ВРЕМЕННО НЕДОСТУПЕН» (20.11.2026, кадры владельца с iPhone).
   *
   * Модель отвечала ПУСТО на голосовой вопрос Ассистенту (в журнале: «модель вернула пустую
   * расшифровку, gemini-3.1-pro-preview»), а маршрут отдавал на это 502. Cloudflare подменяет
   * любое тело 502/503/504 своей страницей, фронт видел ответ без текста и писал «Сервер временно
   * недоступен. Попробуйте через минуту» — хотя сервер работал, а не поняли запись. Два разных
   * исхода разведены и ни один не 5xx:
   *   • речь не разобрана (пустой ответ модели, тишина) — 422, «скажите ещё раз»;
   *   • поставщик не ответил (ключ, квота, таймаут) — 424, причина названа словами.
   * Подробности отказа (модель, код Google) остаются в журнале ошибок CRM, наружу не уходят.
   */
  if (result.failed) {
    const notConfigured = result.reason === "no_key";
    return res.status(424).json({
      error: notConfigured
        ? "Распознавание речи не настроено: не задан ключ ИИ. Напишите текстом, администратор подключит ключ в Настройках."
        : "Сервис распознавания речи сейчас не ответил. Напишите текстом или повторите через минуту.",
    });
  }
  const text = result.text;
  if (!text || !text.trim()) return res.status(422).json({ error: "Речь не распознана. Скажите ещё раз, чуть громче и ближе к микрофону." });
  res.json({ text: text.trim() });
});
