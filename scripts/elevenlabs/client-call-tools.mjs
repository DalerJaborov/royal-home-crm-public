// Функции робота при НАСТОЯЩЕМ исходящем звонке клиенту по кнопке «Звонок роботом» в карточке
// (originateLiveVoiceCallToClient → startLiveVoiceSession без task.tools → LIVE_VOICE_TOOLS моста,
// apps/api/src/lib/telephony/liveVoiceBridge.ts). Это ТРИ функции: save_contact, escalate_to_human, end_call.
// Функций консультанта входящих (search_properties, save_client_request, request_callback, book_showing…)
// у такого звонка НЕТ: они подключены только в liveVoiceConsultant.ts. Набор в suite.mjs «client» (CLIENT_TOOLS +
// PROPERTY_TOOLS) описывает консультанта, а не этот звонок.
// Копия, а не импорт: LIVE_VOICE_TOOLS в мосте не вывозится, а мост тянет базу и станцию. Тест
// elevenlabs-scripts.test.mjs сверяет описания с исходником моста — расхождение сломает тест.
export const CLIENT_CARD_CALL_TOOLS = [
  {
    name: "save_contact",
    description:
      "Сохранить имя собеседника, как только он его назвал. Вызывай молча и сразу, не дожидаясь конца разговора — не полагайся на память до конца звонка. Номер этого человека у нас уже есть (звоним по нему мы), диктовать его не проси.",
    parameters: {
      type: "OBJECT",
      properties: {
        name: { type: "STRING", description: "Имя собеседника, как он представился." },
        phone: {
          type: "STRING",
          description: "Другой номер для связи — ТОЛЬКО если человек сам попросил звонить не на этот, и только полностью. Иначе не передавай.",
        },
      },
      required: ["name"],
    },
  },
  {
    name: "escalate_to_human",
    description:
      "Вызови, когда собеседник ЯВНО просит живого человека/оператора/агента вместо тебя, или когда ты не справляешься и разговор зашёл в тупик. Перед вызовом вслух коротко скажи своими словами, по смыслу «хорошо, попрошу коллегу вам набрать» (это смысл, не дословная фраза), а следующим действием вызови эту функцию — она сама корректно завершит звонок, end_call вызывать не нужно.",
    parameters: {
      type: "OBJECT",
      properties: {
        reason: { type: "STRING", description: "Коротко, почему нужен живой человек — что попросил собеседник или в чём затруднение." },
        by_client_request: {
          type: "BOOLEAN",
          description:
            "true — ТОЛЬКО если собеседник сам прямо попросил живого человека/оператора. false — если ты не справляешься или разговор зашёл в тупик.",
        },
      },
      required: ["reason"],
    },
  },
  {
    name: "end_call",
    description:
      "Вызови это ПОСЛЕ того, как вслух попрощались с собеседником и разговор по сути закончен — например, номер взят и агент перезвонит, либо собеседник прощается сам. Это кладёт трубку, поэтому сначала произнеси прощание, а функцию вызови следующим действием.",
    parameters: {
      type: "OBJECT",
      properties: { reason: { type: "STRING", description: "Коротко, почему разговор закончен." } },
      required: ["reason"],
    },
  },
];
