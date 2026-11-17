import { createReadStream, type ReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { Response } from "express";
import { ZipArchive } from "archiver";

/** Missing files must not crash the API or masquerade as a complete download. */
export async function streamFileArchive(
  res: Response,
  files: { path: string; name: string }[],
  filename: string,
  level: 0 | 6,
  report: (error: Error) => void,
) {
  try {
    if (!files.length) throw new Error("No readable archive files");
    for (const file of files) if (!(await stat(file.path)).isFile()) throw new Error("Archive source is not a file");
  } catch (error) {
    report(error instanceof Error ? error : new Error(String(error)));
    res.status(409).json({ error: "Не удалось собрать архив: один из файлов недоступен. Обновите карточку или обратитесь к администратору." });
    return;
  }

  const archive = new ZipArchive({ zlib: { level } });
  const sources: ReadStream[] = [];
  let failed = false;
  const stop = () => { for (const source of sources) source.destroy(); archive.abort(); };
  const fail = (error: Error) => {
    if (failed) return;
    failed = true;
    report(error);
    stop();
    if (res.headersSent) res.destroy();
    else {
      res.removeHeader("Content-Disposition");
      res.status(500).json({ error: "Не удалось прочитать файлы архива. Попробуйте ещё раз." });
    }
  };
  archive.on("error", fail);
  archive.on("warning", fail);
  res.once("close", stop);
  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  archive.pipe(res);
  for (const file of files) {
    const source = createReadStream(file.path);
    // archiver does not own source stream errors. Attach before append/open.
    source.on("error", fail);
    sources.push(source);
    archive.append(source, { name: file.name });
  }
  try { await archive.finalize(); } catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
}
