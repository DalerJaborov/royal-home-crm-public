/**
 * ПОДЛОЖКА ОБЛОЖКИ «ROYAL GREEN» — СВЕТЛОЕ ФОТО (владелец 28.09.2026: «нужны
 * светлые такие же фото», эталон — тёплый светлый интерьер).
 *
 * Шаг обязательный для провайдера TEMPLATE: главное фото сначала проходит ретушь
 * Gemini (`ai/photoEnhance.ts::enhancePhotoBuffer`, тот же промт «только свет и
 * цвет, предметы не трогать»). Кэш — по sha256 байтов фото в
 * `uploads/covers/retouch/`: одно фото ретушируется ОДИН раз, перерисовка и добор
 * платят только за новые фото. Ключа Gemini нет или отказ — локальная замена
 * sharp; с 02.10.2026 по умолчанию сильная `strongRetouch` (уровень 2), прежняя мягкая
 * `localRetouch` (normalise, gamma 1.15, контраст, лёгкое тепло) — уровень 1. Её не
 * кэшируем, она дешёвая и при появлении ключа фото должно уйти в Gemini.
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { propertyCoversDir } from "../../upload.js";
import { enhancePhotoBuffer, mimeForExt } from "../../ai/photoEnhance.js";
import { logSystemError } from "../systemError.js";

export type RetouchSource = "gemini" | "gemini-cache" | "local";

const retouchDir = (): string => path.join(propertyCoversDir, "retouch");

/** Локальная замена ретуши — рецепт владельца 28.09.2026. */
export async function localRetouch(input: Buffer): Promise<Buffer> {
  return sharp(input)
    .rotate()
    .normalise()
    .gamma(1.15)
    .linear(1.08, 12)
    .modulate({ saturation: 1.05 })
    .recomb([
      [1.03, 0, 0],
      [0, 1, 0],
      [0, 0, 0.96],
    ])
    .jpeg({ quality: 94 })
    .toBuffer();
}

/**
 * СИЛЬНАЯ ЛОКАЛЬНАЯ КОРРЕКЦИЯ, уровень 2 (владелец 02.10.2026: «мягкой мало, нужен
 * киношный вид как у риелторских сервисов, но настоящий интерьер»). Без ИИ, чистый
 * sharp + арифметика, детерминирована. Порт одобренного по виду прототипа `grade2.cjs`.
 *
 *  1. Баланс белого: «серый мир» + лёгкое тепло, усиление каналов зажато в 0,9…1,12.
 *  2. Тон-маппинг по яркости: размытая основа (`blur`) — «освещение»; тени поднимаем
 *     степенью `lift`, мягкий потолок не даёт выжечь светлое, фактуру усиливаем
 *     степенью `detail` (отношение яркости к основе); цвет по яркости сохраняется.
 *  3. Насыщенность, лёгкий контраст, затем sharpen.
 * БЕЗ `clahe`: на RGB он даёт артефакты (проверено). Расчёт — на копии до 1600 px по
 * большой стороне, результат JPEG q93 (на обложку 1080 хватает с запасом).
 */
const STRONG = { lift: 0.72, detail: 1.35, sat: 1.24, contrast: 1.08, warm: [1.03, 1.0, 0.97], wbMin: 0.9, wbMax: 1.12 } as const;
const STRONG_MAX_SIDE = 1600;

export async function strongRetouch(input: Buffer): Promise<Buffer> {
  const P = STRONG;
  const { data, info } = await sharp(input)
    .rotate()
    .resize({ width: STRONG_MAX_SIDE, height: STRONG_MAX_SIDE, fit: "inside", withoutEnlargement: true })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = info;
  const n = w * h;
  let sr = 0;
  let sg = 0;
  let sb = 0;
  for (let i = 0; i < n; i++) {
    sr += data[i * 3];
    sg += data[i * 3 + 1];
    sb += data[i * 3 + 2];
  }
  const avg = (sr + sg + sb) / (3 * n);
  const clampGain = (v: number): number => Math.min(P.wbMax, Math.max(P.wbMin, v));
  const gain = [clampGain(avg / (sr / n)) * P.warm[0], clampGain(avg / (sg / n)) * P.warm[1], clampGain(avg / (sb / n)) * P.warm[2]];

  const rgb = new Float32Array(n * 3);
  const luma8 = Buffer.alloc(n);
  for (let i = 0; i < n; i++) {
    const r = Math.min(1, (data[i * 3] / 255) * gain[0]);
    const g = Math.min(1, (data[i * 3 + 1] / 255) * gain[1]);
    const b = Math.min(1, (data[i * 3 + 2] / 255) * gain[2]);
    rgb[i * 3] = r;
    rgb[i * 3 + 1] = g;
    rgb[i * 3 + 2] = b;
    luma8[i] = Math.round((0.2126 * r + 0.7152 * g + 0.0722 * b) * 255);
  }
  const sigma = Math.max(8, Math.round(Math.max(w, h) / 22));
  // Размытая «основа». Число каналов на выходе зависит от версии sharp (серый вход может
  // вернуться тремя каналами) — читаем с шагом из info, иначе карта освещения съезжает.
  const blurred = await sharp(luma8, { raw: { width: w, height: h, channels: 1 } }).blur(sigma).raw().toBuffer({ resolveWithObject: true });
  const base = blurred.data;
  const baseStride = blurred.info.channels;

  const toByte = (v: number): number => {
    const c = Math.min(1, Math.max(0, v));
    return Math.round(Math.min(1, Math.max(0, (c - 0.5) * P.contrast + 0.5)) * 255);
  };
  const out = Buffer.alloc(n * 3);
  for (let i = 0; i < n; i++) {
    const r = rgb[i * 3];
    const g = rgb[i * 3 + 1];
    const b = rgb[i * 3 + 2];
    const luma = Math.max(1e-3, 0.2126 * r + 0.7152 * g + 0.0722 * b);
    const lit = Math.max(1e-3, base[i * baseStride] / 255);
    const lifted = Math.pow(lit, P.lift); // тени светлее
    const soft = lifted / (1 + 0.1 * lifted * lifted); // мягкий потолок: пересвет не выжигается
    const luma2 = soft * Math.pow(luma / lit, P.detail); // фактура чётче
    const k = Math.min(3.2, luma2 / luma);
    const rr = r * k;
    const gg = g * k;
    const bb = b * k;
    const y = 0.2126 * rr + 0.7152 * gg + 0.0722 * bb;
    out[i * 3] = toByte(y + (rr - y) * P.sat);
    out[i * 3 + 1] = toByte(y + (gg - y) * P.sat);
    out[i * 3 + 2] = toByte(y + (bb - y) * P.sat);
  }
  return sharp(out, { raw: { width: w, height: h, channels: 3 } })
    .sharpen({ sigma: 0.9, m1: 0.6, m2: 1.2 })
    .jpeg({ quality: 93 })
    .toBuffer();
}

/**
 * Уровень локальной ретуши, когда Gemini не отвечает (и в запасном пути без ИИ):
 * 1 — прежняя мягкая `localRetouch`, 2 — `strongRetouch`. По умолчанию 2 (02.10.2026).
 * Работающий Gemini и его кэш этим не затрагиваются.
 */
export type LocalRetouchLevel = 1 | 2;
export const DEFAULT_LOCAL_RETOUCH_LEVEL: LocalRetouchLevel = 2;

const localByLevel = (level: LocalRetouchLevel, input: Buffer): Promise<Buffer> => (level === 1 ? localRetouch(input) : strongRetouch(input));

/**
 * `localOnly` (02.10.2026) — запасная обложка, когда ChatGPT недоступен: ни одного
 * вызова ИИ, в том числе Gemini. Готовая ретушь из кэша (уже оплачена раньше) берётся,
 * иначе локальная ретушь выбранного уровня; её по-прежнему не кэшируем.
 */
export async function retouchCoverPhoto(
  photoPath: string,
  options: { localOnly?: boolean; level?: LocalRetouchLevel } = {}
): Promise<{ image: Buffer; source: RetouchSource }> {
  const level = options.level ?? DEFAULT_LOCAL_RETOUCH_LEVEL;
  const original = await fs.readFile(photoPath);
  const hash = crypto.createHash("sha256").update(original).digest("hex");
  const cached = path.join(retouchDir(), `${hash}.jpg`);
  try {
    return { image: await fs.readFile(cached), source: "gemini-cache" };
  } catch {
    // нет в кэше — ретушируем
  }
  if (options.localOnly) return { image: await localByLevel(level, original), source: "local" };
  const res = await enhancePhotoBuffer(original, mimeForExt(photoPath));
  if (res.ok) {
    const image = await sharp(res.image).jpeg({ quality: 94 }).toBuffer();
    await fs.mkdir(retouchDir(), { recursive: true });
    await fs.writeFile(cached, image).catch((err: unknown) => {
      void logSystemError("storage", `Ретушь обложки не записалась в кэш: ${String(err)}`, { dedupKey: "cover-retouch-cache-write" });
    });
    return { image, source: "gemini" };
  }
  if (res.error !== "Ключ Gemini не настроен") {
    void logSystemError("ai", `Ретушь фото обложки через Gemini не удалась (${res.error}) — локальная замена`, {
      dedupKey: "cover-retouch-gemini-fail",
    });
  }
  return { image: await localByLevel(level, original), source: "local" };
}
