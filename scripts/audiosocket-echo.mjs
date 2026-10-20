#!/usr/bin/env node
/**
 * ЭХО-СЕРВЕР AUDIOSOCKET — шаг 0 проверки голосового ИИ-контура (12.09.2026).
 *
 * Зачем: до того как подключать Gemini Live, надо убедиться, что звук вообще ходит
 * между станцией (Asterisk/FreePBX) и нашим сервером, и с какой задержкой. Эхо-сервер
 * ничего не понимает и ничего не думает — он возвращает ровно те кадры, которые
 * получил. Всё, что услышит звонящий, — собственный голос с задержкой канала.
 *
 * ПОЧЕМУ AUDIOSOCKET, А НЕ EXTERNALMEDIA. Существующий мост
 * apps/api/src/lib/telephony/liveVoiceBridge.ts гоняет звук через ARI ExternalMedia,
 * то есть по RTP/UDP, а обратный туннель со станции пробрасывает только TCP-порты
 * (ARI 8088, AMI 5038). Поэтому тот мост физически не может получить ни одного
 * аудио-пакета — это записано в нём самом как нерешённая загвоздка. AudioSocket
 * работает ПО TCP и ложится в тот же туннель той же механикой.
 *
 * Протокол AudioSocket (кадр): [тип 1 байт][длина 2 байта big-endian][данные]
 *   0x00 — завершение, 0x01 — UUID звонка (16 байт), 0x10 — аудио,
 *   0xff — ошибка. Аудио: SLIN, 8 кГц, 16 бит, моно, кадры по 20 мс (320 байт).
 *
 * Запуск:  node scripts/audiosocket-echo.mjs --port 8090
 * Диалплан: exten => 777,1,Answer()
 *           same  => n,AudioSocket(00000000-0000-0000-0000-000000000001,HOST:8090)
 *           same  => n,Hangup()
 */

import net from "node:net";

const TYPE_TERMINATE = 0x00;
const TYPE_UUID = 0x01;
const TYPE_AUDIO = 0x10;
const TYPE_ERROR = 0xff;

const args = process.argv.slice(2);
const portArg = args.indexOf("--port");
const PORT = portArg >= 0 ? Number(args[portArg + 1]) : 8090;
const HOST = "0.0.0.0";

/** Разбирает поток в кадры; возвращает остаток, не составивший полный кадр. */
function readFrames(buffer, onFrame) {
  let offset = 0;
  while (buffer.length - offset >= 3) {
    const type = buffer[offset];
    const length = buffer.readUInt16BE(offset + 1);
    if (buffer.length - offset < 3 + length) break;
    onFrame(type, buffer.subarray(offset + 3, offset + 3 + length));
    offset += 3 + length;
  }
  return buffer.subarray(offset);
}

function frame(type, payload = Buffer.alloc(0)) {
  const head = Buffer.alloc(3);
  head[0] = type;
  head.writeUInt16BE(payload.length, 1);
  return Buffer.concat([head, payload]);
}

const server = net.createServer((socket) => {
  socket.setNoDelay(true);

  const stats = {
    uuid: null,
    frames: 0,
    bytes: 0,
    startedAt: Date.now(),
    lastFrameAt: 0,
    gaps: [],
  };
  let rest = Buffer.alloc(0);

  console.log(`[${new Date().toISOString()}] звонок подключился: ${socket.remoteAddress}`);

  socket.on("data", (chunk) => {
    rest = readFrames(Buffer.concat([rest, chunk]), (type, payload) => {
      if (type === TYPE_UUID) {
        stats.uuid = payload.toString("hex");
        console.log(`  uuid звонка: ${stats.uuid}`);
        return;
      }
      if (type === TYPE_AUDIO) {
        const now = Date.now();
        if (stats.lastFrameAt) stats.gaps.push(now - stats.lastFrameAt);
        stats.lastFrameAt = now;
        stats.frames += 1;
        stats.bytes += payload.length;
        // эхо: тот же кадр обратно, без единой обработки
        socket.write(frame(TYPE_AUDIO, payload));
        return;
      }
      if (type === TYPE_ERROR) {
        console.warn(`  станция сообщила об ошибке: ${payload.toString("hex")}`);
        return;
      }
      if (type === TYPE_TERMINATE) {
        console.log("  станция закрыла поток");
        socket.end();
      }
    });
  });

  socket.on("close", () => {
    const seconds = (Date.now() - stats.startedAt) / 1000;
    const gaps = stats.gaps.slice().sort((a, b) => a - b);
    const p = (q) => (gaps.length ? gaps[Math.min(gaps.length - 1, Math.floor(gaps.length * q))] : 0);
    console.log(
      `  итог: ${stats.frames} кадров за ${seconds.toFixed(1)} с ` +
        `(${(stats.frames / Math.max(seconds, 0.001)).toFixed(1)} кадр/с, ожидается ~50), ` +
        `${stats.bytes} байт звука`,
    );
    console.log(
      `  разрывы между кадрами: медиана ${p(0.5)} мс, 95-я ${p(0.95)} мс, максимум ${gaps.at(-1) ?? 0} мс ` +
        `(ожидается ровно 20 мс; всплески = проблема сети или туннеля)`,
    );
  });

  socket.on("error", (err) => console.error(`  ошибка сокета: ${err.message}`));
});

server.listen(PORT, HOST, () => {
  console.log(`эхо-сервер AudioSocket слушает ${HOST}:${PORT}`);
  console.log("ожидание звонка на тестовый внутренний номер…");
});
