/**
 * Общие типы событий АТС — вынесены из ariEvents.ts отдельным модулем.
 *
 * incomingCalls.ts тоже описывает канал станции (isInboundChannel, startIncomingCall),
 * а ariEvents.ts вызывает функции incomingCalls.ts при разборе событий. Пока типы
 * жили в ariEvents.ts, `import type { AriChannel } from "./ariEvents.js"` в
 * incomingCalls.ts вместе с обратным импортом функций замыкал цикл
 * (ariEvents.ts → incomingCalls.ts → ariEvents.ts) — правило no-circular считает
 * такой цикл ошибкой независимо от того, что один из импортов только для типов.
 */

export interface AriChannel {
  id: string;
  name: string;
  state: string;
  caller: { number?: string; name?: string };
  /** Когда станция создала канал (ISO, `2026-10-02T09:00:00.000+0500`) — по нему
   *  уборщик живого голоса отличает давнего сироту от свежего канала. */
  creationtime?: string;
  /** app_name/app_data — где канал стоит сейчас (`Stasis` и `royalhome-live-voice,inbound`):
   *  станция отдаёт их в /ari/channels и в событиях с Asterisk 16. */
  dialplan?: { context?: string; exten?: string; priority?: number; app_name?: string; app_data?: string };
}

export type AriEvent = {
  type: string;
  channel?: AriChannel;
  /**
   * ИНИЦИАТОР ДОЗВОНА У СОБЫТИЯ Dial. Отдельное поле, а не `channel`: у Dial поля
   * `channel` в схеме ARI нет вовсе (сверено с /var/lib/asterisk/rest-api/events.json
   * на станции агентства). Именно здесь лежит НАШ канал, когда станция набирает
   * клиента, — см. DIAL_EVENT_HAS_NO_CHANNEL в ariEvents.ts.
   */
  caller?: AriChannel;
  peer?: AriChannel;
  dialstatus?: string;
  /** У события Dial — то, что станция реально набрала: `SIP/out/930001001`. */
  dialstring?: string;
  [key: string]: unknown;
};
