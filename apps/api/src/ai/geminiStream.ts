/**
 * РАЗБОР ПОТОКА GEMINI `streamGenerateContent?alt=sse` (31.10.2026, помощник CRM,
 * задача 1.6, docs/design/internal-assistant-architecture-2026-10-31.md).
 *
 * Чистые функции без сети — их проверяют тесты на нарезанных кусках
 * (apps/api/tests/ai-assistant-stream.test.ts), а сетью и повторами занимается
 * callGeminiToolsStream в ai/geminiClient.ts.
 *
 * Что известно о формате и откуда:
 *  - [док] ai.google.dev/api/generate-content: тело ответа — поток экземпляров
 *    GenerateContentResponse; примеры зовут метод с `alt=sse`.
 *  - [вывод] каждое SSE-событие `data: …` — один целый GenerateContentResponse;
 *    текстовые части в нём — ДЕЛЬТЫ, их склейка и есть ответ; finishReason и
 *    usageMetadata приходят в последних событиях (берём последнее увиденное).
 *  - [вывод] сеть режет поток где угодно: посреди строки, посреди JSON, посреди
 *    многобайтной буквы. Поэтому байты → текст идут через TextDecoder({stream}),
 *    а строки собираются в буфере до перевода строки.
 *  - Части реплики (functionCall, thoughtSignature, текст) сохраняются В ТОМ
 *    ВИДЕ И ПОРЯДКЕ, в каком пришли: их возвращают в историю следующего хода, и
 *    подпись размышления, переложенная в другую часть, ломает следующий запрос.
 *  - Вызовы инструментов наружу отдаются только после конца потока: частично
 *    принятый поток вызовов не исполняет никогда.
 */

/** Часть реплики модели — та же форма, что у обычного generateContent. */
export interface GeminiStreamPart {
  text?: string;
  thought?: boolean;
  functionCall?: { name: string; args?: unknown; id?: string; [key: string]: unknown };
  thoughtSignature?: string;
  [key: string]: unknown;
}

export interface GeminiStreamChunk {
  candidates?: { content?: { parts?: GeminiStreamPart[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };
}

/** Поток сломан по форме (битый JSON, вызов без имени) — повторяемый сбой попытки. */
export class GeminiStreamFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GeminiStreamFormatError";
  }
}

/**
 * Сборщик SSE: кормится кусками текста, отдаёт содержимое `data:` целых событий.
 * Событие кончается пустой строкой; несколько строк `data:` одного события
 * склеиваются переводом строки (так велит спецификация SSE). Комментарии (`:`),
 * `event:`/`id:`/`retry:` не нужны и пропускаются. Перевод строки — `\n` или
 * `\r\n`: делим по `\n`, а хвостовой `\r` снимаем, поэтому `\r` и `\n`, попавшие
 * в разные куски, не ломают разбор.
 */
export function createSseDataReader() {
  let buffer = "";
  let data: string[] = [];
  const takeLines = (lines: string[], out: string[]) => {
    for (const raw of lines) {
      const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
      if (line === "") {
        if (data.length) out.push(data.join("\n"));
        data = [];
      } else if (line.startsWith("data:")) {
        data.push(line.slice(line.startsWith("data: ") ? 6 : 5));
      }
    }
  };
  return {
    push(text: string): string[] {
      buffer += text;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      const out: string[] = [];
      takeLines(lines, out);
      return out;
    },
    /** Конец потока: дописать хвост без завершающей пустой строки. */
    end(): string[] {
      const out: string[] = [];
      takeLines(buffer ? [buffer, ""] : [""], out);
      buffer = "";
      return out;
    },
  };
}

/** Итог потока, сведённый к тому же, что отдаёт один ответ generateContent. */
export interface GeminiStreamResult {
  parts: GeminiStreamPart[];
  finishReason: string | undefined;
  blockReason: string | undefined;
  usage: GeminiStreamChunk["usageMetadata"];
}

/**
 * Копилка ответа по событиям. `push` возвращает текстовую дельту события — ровно
 * то, что можно показать человеку (части-размышления `thought: true` не
 * показываются никогда).
 */
export function createToolStreamAccumulator() {
  const parts: GeminiStreamPart[] = [];
  let finishReason: string | undefined;
  let blockReason: string | undefined;
  let usage: GeminiStreamChunk["usageMetadata"];
  const push = (chunk: GeminiStreamChunk): string => {
    if (!chunk || typeof chunk !== "object") throw new GeminiStreamFormatError("кусок потока не объект");
    if (chunk.promptFeedback?.blockReason) blockReason = chunk.promptFeedback.blockReason;
    if (chunk.usageMetadata) usage = chunk.usageMetadata;
    const candidate = chunk.candidates?.[0];
    if (candidate?.finishReason) finishReason = candidate.finishReason;
    let delta = "";
    for (const part of candidate?.content?.parts ?? []) {
      if (part.functionCall) {
        const name = part.functionCall.name;
        if (typeof name !== "string" || !name) throw new GeminiStreamFormatError("вызов инструмента без имени");
      }
      parts.push(part);
      if (typeof part.text === "string" && part.thought !== true) delta += part.text;
    }
    return delta;
  };
  return {
    push,
    /** Разобрать содержимое одного `data:`. Битый JSON — сбой формы потока. */
    pushData(payload: string): string {
      let chunk: GeminiStreamChunk;
      try {
        chunk = JSON.parse(payload) as GeminiStreamChunk;
      } catch {
        throw new GeminiStreamFormatError("битый JSON в событии потока");
      }
      return push(chunk);
    },
    result(): GeminiStreamResult {
      return { parts, finishReason, blockReason, usage };
    },
  };
}
