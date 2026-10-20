/**
 * Gemini TTS отдаёт «сырой» PCM (16 бит, моно) без заголовка — <audio> такой поток
 * не проиграет, ему нужен файл с заголовком WAV. Заголовок — фиксированные 44 байта,
 * дешевле собрать на месте воспроизведения, чем гонять их через сеть на каждый ответ.
 */
export function pcmBase64ToWavUrl(base64: string, sampleRateHz: number): string {
  const pcm = base64ToBytes(base64);
  const numChannels = 1;
  const bitsPerSample = 16;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const byteRate = sampleRateHz * blockAlign;

  const header = new ArrayBuffer(44);
  const view = new DataView(header);
  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + pcm.length, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRateHz, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, pcm.length, true);

  const blob = new Blob([header, pcm.buffer as ArrayBuffer], { type: "audio/wav" });
  return URL.createObjectURL(blob);
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function writeAscii(view: DataView, offset: number, text: string) {
  for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
}
