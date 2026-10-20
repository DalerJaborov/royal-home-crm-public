/**
 * ЖИВОЙ ПРОГОН ОБЛОЖКИ CHATGPT (25.09.2026) — тот же продовый путь
 * (`generateOpenAiCovers` из lib/video/coverOpenAi.ts, слой coverTextLayer.ts),
 * без базы: данные объекта и настройки — аргументами.
 *
 * Ключ берётся из файла (`--key-file`) в переменную процесса и НИКУДА не
 * печатается. Запись расхода в AiLog без базы молча не проходит — это ожидаемо.
 *
 *   cd apps/api
 *   DATABASE_URL=postgresql://x:x@127.0.0.1:1/x npx tsx scripts/cover-live-test.mts \
 *     --key-file <путь> --photo <фото> --logo <png> --set 1|2 --out <папка/префикс> [--story] [--mode OVERLAY|MODEL]
 */
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { generateOpenAiCovers, factsFromValues } from "../src/lib/video/coverOpenAi.js";
import { buildCoverPosterValues } from "../src/lib/video/coverPoster.js";

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

const SETS = {
  "1": { rooms: 3, areaSqm: 112.5, floor: 15, price: 1700000, currency: "TJS", districtName: "Фирдавсӣ", address: null },
  "2": { rooms: 2, areaSqm: 90, floor: 15, price: 890000, currency: "TJS", districtName: "Сино", address: null },
} as const;

const keyFile = arg("--key-file");
const photoPath = arg("--photo");
const logoPath = arg("--logo");
const out = arg("--out");
const set = (arg("--set") ?? "1") as keyof typeof SETS;
const mode = arg("--mode") === "OVERLAY" ? "OVERLAY" : "MODEL";
if (!keyFile || !photoPath || !out) throw new Error("нужны --key-file, --photo, --out");

const apiKey = (await fs.readFile(keyFile, "utf8")).trim();
const values = buildCoverPosterValues(SETS[set], { usdToTjs: 10.9 });
const facts = factsFromValues(values, SETS[set].floor);
await fs.mkdir(path.dirname(out), { recursive: true });

let step = 0;
const started = Date.now();
const result = await generateOpenAiCovers({
  apiKey,
  photo: await fs.readFile(photoPath),
  logo: logoPath ? await fs.readFile(logoPath) : null,
  values,
  facts,
  quality: "high",
  candidates: 1,
  textMode: mode,
  imageModel: (arg("--model") ?? "gpt-image-2.5-sunburst") as "gpt-image-2.5-sunburst",
  photoSource: arg("--photo-source") === "MODEL" ? "MODEL" : "ORIGINAL",
  digitCacheDir: path.join(path.dirname(out), "digits"),
  imagesLeft: 6,
  skipStory: !process.argv.includes("--story"),
  retryDelayMs: 2000,
  trace: ({ aspect, kind, index, data }) => {
    const base = `${out}-${aspect}-${kind}-${index}-${++step}`;
    if (Buffer.isBuffer(data)) void fs.writeFile(`${base}.png`, data);
    else void fs.writeFile(`${base}.json`, JSON.stringify(data, null, 2));
  },
});
const seconds = ((Date.now() - started) / 1000).toFixed(0);
if (!result.ok) {
  console.log(`БРАК за ${seconds} с, $${result.costUsd.toFixed(3)}, картинок ${result.images}: ${result.reason}`);
  process.exit(0);
}
await fs.writeFile(`${out}-square.png`, await sharp(result.square).png().toBuffer());
await fs.writeFile(`${out}-story.png`, await sharp(result.story).png().toBuffer());
console.log(`OK за ${seconds} с, $${result.costUsd.toFixed(3)}, картинок ${result.images}${result.storyNote ? `; вертикаль: ${result.storyNote}` : ""}${result.softNotes.length ? `; ${result.softNotes.join("; ")}` : ""}`);
