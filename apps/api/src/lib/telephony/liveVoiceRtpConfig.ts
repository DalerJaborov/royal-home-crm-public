/**
 * АДРЕС ЗВУКА ЖИВОГО ГОЛОСА НА СЕРВЕРЕ (02.10.2026) — одно место для моста и Настроек.
 *
 * Звук идёт со станции к CRM отдельным путём (RTP/UDP, см. докстринг
 * liveVoiceBridge.ts), и без двух значений окружения он не доедет вовсе:
 *   LIVE_VOICE_RTP_HOST — адрес CRM, по которому станция достучится до неё по UDP;
 *   LIVE_VOICE_RTP_PORT — один фиксированный порт (на сайте 40800), проброшенный
 *                         в контейнер.
 * Пока их нет, робот брал трубку и молчал, а в Настройках стоял «включено»
 * (аудит 02.10.2026, Д27). Модуль без зависимостей — его читают и Настройки
 * (routes/settings.ts), и мост, и тесты, подменяющие мост целиком.
 */

/** Хост, которым мы представляемся станции для externalMedia (`external_host`). */
export function externalMediaHost(): string | null {
  const host = process.env.LIVE_VOICE_RTP_HOST;
  return host && host.trim() ? host.trim() : null;
}

/** Порт RTP-приёмника; 0 — «пусть ОС выберет» (годится, только если туннель
 *  пробрасывает диапазон портов). Не заданный или неверный порт — тоже 0. */
export function externalMediaPort(): number {
  const raw = Number(process.env.LIVE_VOICE_RTP_PORT);
  return Number.isFinite(raw) && raw >= 0 ? raw : 0;
}

/** Что не так с настройкой звука на сервере; null — всё задано. Текст идёт и в
 *  журнал, и в предупреждение Настроек. */
export function liveVoiceRtpProblem(): string | null {
  const missing: string[] = [];
  if (!externalMediaHost()) missing.push("LIVE_VOICE_RTP_HOST");
  if (externalMediaPort() <= 0) missing.push("LIVE_VOICE_RTP_PORT");
  if (missing.length === 0) return null;
  return (
    `На сервере не задано ${missing.join(" и ")} — станция не сможет прислать звук разговора в CRM, ` +
    "робот возьмёт трубку и промолчит."
  );
}

export function isLiveVoiceRtpConfigured(): boolean {
  return liveVoiceRtpProblem() === null;
}

/**
 * Адрес RTP для тех, кто решает «есть ли куда принимать звук» по одному хосту
 * (режим консультанта на станции, failoverSync/incomingSettings): хост отдаётся
 * только когда задана ВСЯ пара HOST+PORT. Раньше они читали LIVE_VOICE_RTP_HOST
 * напрямую, и при пустом порте станция звала консультанта, который брал трубку и
 * молчал (аудит 02.10.2026, мост, п.2). Чтение переменных — только в этом файле.
 */
export function configuredRtpHost(): string | null {
  return isLiveVoiceRtpConfigured() ? externalMediaHost() : null;
}

/**
 * Куда станция шлёт кадры канала UnicastRTP — по переменным канала
 * UNICASTRTP_LOCAL_ADDRESS/PORT, которые мост читает после создания моста.
 * Порт не число из диапазона 1..65535 — null (раньше Number("abc") = NaN уходил в
 * `socket.send` и бросал синхронно из таймера пейсера, аудит п.11).
 */
export function parseStationRtpTarget(
  address: string | null | undefined,
  port: string | number | null | undefined
): { address: string; port: number } | null {
  const host = typeof address === "string" ? address.trim() : "";
  const n = typeof port === "number" ? port : Number(String(port ?? "").trim());
  if (!host || !Number.isInteger(n) || n <= 0 || n >= 65536) return null;
  return { address: host, port: n };
}

/**
 * Кадр пришёл с адреса/порта, который не обязан быть станцией: решение «свой /
 * чужой» для замка на первого отправителя (аудит п.3). Станция шлёт кадры канала
 * UnicastRTP из того же сокета, адрес и порт которого сообщает UNICASTRTP_LOCAL_*,
 * и порт у каждого канала свой — по нему и отличаем кадры ЭТОГО канала от
 * запоздавших кадров предыдущей сессии или сироты. Адрес за NAT/туннелем может
 * отличаться от сообщённого, поэтому он не сверяется (его при желании сужает
 * LIVE_VOICE_RTP_PEER). Цели нет — «неизвестно»: решает первый кадр, как раньше.
 */
export function rtpSourceMatchesTarget(
  target: { address: string; port: number } | null,
  from: { address: string; port: number }
): "match" | "mismatch" | "unknown" {
  if (!target) return "unknown";
  return from.port === target.port ? "match" : "mismatch";
}

/**
 * Откуда станция имеет право слать звук (Г21): LIVE_VOICE_RTP_PEER — адрес
 * станции в туннеле, `10.9.0.2` или `10.9.0.2:4000` (порт необязателен). Не
 * задано — мост запоминает отправителя первого же настоящего RTP-пакета сессии
 * и чужих после него не слушает.
 */
export function expectedRtpPeer(): { address: string; port: number | null } | null {
  const raw = process.env.LIVE_VOICE_RTP_PEER?.trim();
  if (!raw) return null;
  const colons = raw.split(":").length - 1;
  if (colons === 1) {
    const [address, port] = raw.split(":");
    const n = Number(port);
    return address ? { address, port: Number.isInteger(n) && n > 0 && n < 65536 ? n : null } : null;
  }
  return { address: raw, port: null };
}
