import { Worker } from "node:worker_threads";
import { createRequire } from "node:module";

export const RECRUITMENT_DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const require = createRequire(import.meta.url);

/** Only raw text leaves the worker. No HTML, macros or external links are run.
 * Stream every ZIP entry under byte/count limits before the document parser,
 * then enforce a separate worker's V8 heap and wall time. */
export function recruitmentDocxText(buffer: Buffer): Promise<string> {
  if (!buffer.length || buffer.length > 12 * 1024 * 1024) return Promise.reject(Error("Document size exceeded"));
  return new Promise((resolve, reject) => {
    const worker = new Worker(`
      const { parentPort, workerData } = require('node:worker_threads');
      const mammoth = require(workerData.modulePath);
      const yauzl = require(workerData.zipModulePath);
      const bytes = Buffer.from(workerData.bytes);
      const validate = () => new Promise((resolve, reject) => {
        yauzl.fromBuffer(bytes, { lazyEntries: true, validateEntrySizes: true, strictFileNames: true }, (error, zip) => {
          if (error) { reject(error); return; }
          let declared = 0, actual = 0, count = 0, failed = false;
          const names = new Set();
          const fail = error => { if (!failed) { failed = true; zip.close(); reject(error); } };
          zip.on('error', fail);
          zip.on('entry', entry => {
            declared += entry.uncompressedSize;
            if (++count > 256 || names.has(entry.fileName) || declared > 16 * 1024 * 1024 ||
                entry.uncompressedSize > 8 * 1024 * 1024 || entry.generalPurposeBitFlag & 1) {
              fail(new Error('Archive limits exceeded')); return;
            }
            names.add(entry.fileName);
            zip.openReadStream(entry, (error, stream) => {
              if (error) { fail(error); return; }
              stream.on('error', fail);
              stream.on('data', chunk => {
                actual += chunk.length;
                if (actual > 16 * 1024 * 1024) { stream.destroy(); fail(new Error('Expanded archive too large')); }
              });
              stream.on('end', () => { if (!failed) zip.readEntry(); });
            });
          });
          zip.on('end', () => { if (!failed) { zip.close(); resolve(); } });
          zip.readEntry();
        });
      });
      validate().then(() => mammoth.extractRawText({ buffer: bytes })).then(result => {
        parentPort.postMessage({ text: result.value.slice(0, 32000) });
      }).catch(() => parentPort.postMessage({ error: true }));
    `, { eval: true, workerData: { modulePath: require.resolve("mammoth"), zipModulePath: require.resolve("yauzl"), bytes: buffer },
      resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16 } });
    let settled = false;
    const finish = (error: Error | null, text = "") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      if (error) reject(error); else resolve(text);
    };
    const timer = setTimeout(() => finish(Error("Document processing timed out")), 3000);
    worker.once("message", (value: unknown) => {
      if (!value || typeof value !== "object" || !("text" in value) || typeof value.text !== "string") {
        finish(Error("Document could not be read")); return;
      }
      finish(null, value.text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/gu, "").slice(0, 32000));
    });
    worker.once("error", () => finish(Error("Document processing failed")));
    worker.once("exit", () => { if (!settled) finish(Error("Document worker stopped")); });
  });
}
