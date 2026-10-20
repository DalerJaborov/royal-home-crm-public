import { Router } from "express";
import { UploadRejectedError } from "../upload.js";
import multer from "multer";
import { requireAuth } from "../auth/middleware.js";
import { transcribeAudio } from "../ai/transcribe.js";
import { memoryUploadBudget } from "../lib/memoryUploadBudget.js";
import { agentSpeechLimiter } from "../lib/agentSpeechLimiter.js";

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
const upload = multer({
  storage: multer.memoryStorage(),
  // 5 МБ с запасом на ~60 секунд webm/opus (потолок длины записи — на фронте).
  // files: 1 — не формальность: без него предел на файл не ограничивает запрос
  // целиком (можно прислать сколько угодно записей по 5 МБ в память процесса).
  // Диктовка всегда одна: обработчик ниже читает req.file (аудит лимитов 21.08.2026).
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (!file.mimetype.startsWith("audio/")) {
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
  const text = await transcribeAudio(req.file.buffer, req.file.originalname || "voice.webm", req.file.mimetype);
  if (text === null) return res.status(502).json({ error: "Не удалось распознать речь" });
  if (!text.trim()) return res.status(422).json({ error: "Речь не распознана — похоже, запись пустая" });
  res.json({ text: text.trim() });
});
