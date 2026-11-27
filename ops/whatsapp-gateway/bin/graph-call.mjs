// Единственная дверь шлюза к Graph API Meta. Запускается ВНУТРИ контейнера
// worker CRM (wa-lib.sh → wa_graph): ключ WhatsApp берётся загрузчиком самой CRM
// (loadCredentials: Настройки → .env), в аргументы, переменные окружения и вывод
// не попадает. Тела запросов собраны здесь и только здесь — снаружи приходит
// лишь имя операции.
//
// Операции (WA_OP):
//   health        GET  /<phone>?fields=health_status        — только чтение
//   settings      GET  /<phone>/settings                    — только чтение, без пароля
//   sip-password  GET  /<phone>/settings?include_sip_credentials=true
//                 → в stdout ТОЛЬКО пароль (stdout перенаправлен в файл 600)
//   enable        POST /<phone>/settings — звонки + SIP, кнопка СКРЫТА
//   disable       POST /<phone>/settings — calling.status=DISABLED
//   show-button / show-button-tj / hide-button — видимость кнопки «Позвонить»
//   callback-on / callback-off — callback_permission_status (запрос «разрешить звонок» после звонка клиента);
//                 enable его больше не меняет
//   test-call-button  POST /<phone>/messages — ОДНО сообщение с кнопкой звонка
//                 на номер WA_TEST_TO (только владельцу, для проверочного звонка
//                 при скрытой кнопке). Текст зашит ниже — владелец даёт «да» на
//                 него. ВРЕМЕННОЕ исключение из правила «сообщения — только через
//                 дверь CRM»: в CRM нет сообщения типа voice_call; когда оно
//                 появится там (следующая правка CRM), эту операцию убрать.
//
// Источник полей: https://developers.facebook.com/docs/whatsapp/cloud-api/calling/sip
// (Configure SIP, SDES, Get settings, Include SIP user password) и
// https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/call-settings
// (call_icon_visibility DEFAULT|DISABLE_ALL, callback_permission_status,
//  audio.additional_codecs PCMA|PCMU, call_icons.restrict_to_user_countries),
// https://developers.facebook.com/documentation/business-messaging/whatsapp/support/health-status
// (can_receive_call_sip). Прочитано 17.11.2026.

// stdout оставляем ТОЛЬКО для результата: всё, что модули CRM печатают при
// загрузке, уходит в stderr. Иначе в файл пароля попал бы чужой текст.
const realStdoutWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, ...rest) => process.stderr.write(chunk, ...rest);
for (const k of ["log", "info", "debug"]) console[k] = (...a) => console.error(...a);
const out = (s) => realStdoutWrite(s);

const op = process.env.WA_OP ?? "";
const host = process.env.WA_SIP_HOST ?? "";
const port = Number(process.env.WA_TLS_PORT || "5061");

function bodyFor(name) {
  switch (name) {
    case "enable":
      return {
        calling: {
          status: "ENABLED",
          // Кнопка скрыта до проверочного звонка: иначе (переключатель в кабинете
          // «Показать кнопки» уже «Вкл.») её увидят все клиенты сразу.
          call_icon_visibility: "DISABLE_ALL",
          // callback_permission_status НЕ трогаем (27.11.2026): повторный enable (второй номер, новый
          // сертификат) молча выключал обратные звонки, включённые операцией callback-on. Без поля Meta
          // оставляет прежнее значение [call-settings: все параметры calling — Optional].
          // SDES: без ICE/DTLS, как в примере Meta для Asterisk.
          srtp_key_exchange_protocol: "SDES",
          // G.711 a-law в дополнение к Opus: звук идёт до станции без перекодирования.
          audio: { additional_codecs: ["PCMA"] },
          sip: {
            status: "ENABLED",
            // События call_created/terminate в вебхук CRM (поле calls уже подписано).
            webhook_delivery: "ENABLED",
            servers: [{ hostname: host, port }],
          },
        },
      };
    case "disable":
      // SIP-сервер при этом не стирается: повторное включение вернёт его [SIP → status].
      return { calling: { status: "DISABLED" } };
    case "show-button":
      return { calling: { call_icon_visibility: "DEFAULT" } };
    case "show-button-tj":
      return { calling: { call_icon_visibility: "DEFAULT", call_icons: { restrict_to_user_countries: ["TJ"] } } };
    case "hide-button":
      return { calling: { call_icon_visibility: "DISABLE_ALL" } };
    // Обратные звонки (27.11.2026, «да» владельца): после звонка клиенту показывается запрос «разрешить
    // компании позвонить». Его ответ (interactive.call_permission_reply) CRM принимает с этой даты
    // (messengers/whatsappServiceEvents.ts): просьба о звонке агенту и в очередь CRM.
    case "callback-on":
      return { calling: { callback_permission_status: "ENABLED" } };
    case "callback-off":
      return { calling: { callback_permission_status: "DISABLED" } };
    default:
      return null;
  }
}

// Текст проверочного сообщения (на «да» владельца — дословно этот).
const TEST_TEXT = "Проверка звонка WhatsApp Royal Home. Нажмите кнопку, чтобы позвонить.";
function testMessage(to) {
  return {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "interactive",
    interactive: {
      type: "voice_call",
      body: { text: TEST_TEXT },
      // display_text ≤ 20 знаков, ttl_minutes 1…43200 [call-button-messages-deep-links].
      action: { name: "voice_call", parameters: { display_text: "Позвонить", ttl_minutes: 60 } },
    },
  };
}
const testTo = process.env.WA_TEST_TO ?? "";

const READ_OPS = { health: "?fields=health_status", settings: "/settings", "sip-password": "/settings?include_sip_credentials=true" };

function fail(msg, code = 2) {
  process.stderr.write(`[graph-call] ОШИБКА: ${msg}\n`);
  process.exit(code);
}

if (!(op in READ_OPS) && !bodyFor(op) && op !== "test-call-button") fail(`неизвестная операция «${op}»`);
if (op === "test-call-button" && !/^\d{9,15}$/.test(testTo)) fail("WA_TEST_TO — номер получателя цифрами с кодом страны");
if (bodyFor(op) && op === "enable" && !/^[A-Za-z0-9.-]+$/.test(host)) fail("WA_SIP_HOST не задан или с недопустимыми символами");

// План без запроса (для --dry-run): метод, путь, тело. Ключей тут нет вовсе.
if (process.env.WA_DESCRIBE_ONLY === "1") {
  if (op === "test-call-button") {
    out(`  POST /<WA_PHONE_ID>/messages\n  тело: ${JSON.stringify(testMessage(testTo))}\n`);
    process.exit(0);
  }
  const b = bodyFor(op);
  out(`  ${b ? "POST" : "GET"} /<WA_PHONE_ID>${b ? "/settings" : READ_OPS[op]}\n`);
  if (b) out(`  тело: ${JSON.stringify(b)}\n`);
  process.exit(0);
}

const phoneId = process.env.WA_PHONE_ID ?? "";
if (!/^\d{6,20}$/.test(phoneId)) fail("WA_PHONE_ID не задан");

const dist = process.env.WA_CRM_DIST || "/repo/apps/api/dist";
const meta = await import(`file://${dist}/messengers/meta.js`);
const creds = await meta.loadCredentials();
let token = creds.waToken;
if (creds.waPhoneId && creds.waPhoneId !== phoneId) {
  // Не основной номер (26.11.2026: второй — «Арван», WA_EXTRA_NUMBERS в gateway.env).
  // Он обязан быть заведён в CRM строкой канала (Настройки → Каналы), и ключ берётся
  // ЕГО (accountTokenById — та же дверь, что у отправки сообщений), а не общий:
  // операция у Meta по номеру, которого CRM не знает, — опечатка в gateway.env.
  const accounts = await import(`file://${dist}/messengers/accounts.js`);
  const row = (await accounts.listAccounts("WHATSAPP")).find((r) => r.externalId === phoneId);
  if (!row) fail(`номера ${phoneId} нет в CRM (основной — ${creds.waPhoneId}, других строк WhatsApp с таким id нет). Остановлено.`);
  const own = await accounts.accountTokenById(row.id, "WHATSAPP");
  token = own?.token || undefined;
}
if (!token) fail("в CRM нет ключа WhatsApp для этого номера (Настройки → Каналы / META_WA_TOKEN)");
const redact = (s) => String(s).split(token).join("***");
const base = `https://graph.facebook.com/${meta.GRAPH_VERSION}/${phoneId}`;

async function call(method, path, body) {
  let res;
  try {
    res = await fetch(base + path, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    fail(`сеть/тайм-аут: ${redact(err?.message ?? err)}`, 3);
  }
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text.slice(0, 500) };
  }
  if (!res.ok || json?.error) {
    const e = json?.error ?? {};
    fail(`Meta ответила ${res.status}: ${redact(e.message ?? json.raw ?? "")} (code ${e.code ?? "?"}, subcode ${e.error_subcode ?? "?"})`, 4);
  }
  return json;
}

function stripPasswords(v) {
  if (Array.isArray(v)) return v.map(stripPasswords);
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.entries(v).map(([k, x]) => [k, k === "sip_user_password" ? "<скрыт>" : stripPasswords(x)])
    );
  }
  return v;
}

if (op === "sip-password") {
  const json = await call("GET", READ_OPS[op]);
  const servers = json?.calling?.sip?.servers ?? [];
  const mine = servers.filter((s) => s?.hostname === host);
  if (mine.length === 0) fail(`на номере нет SIP-сервера ${host} (сначала wa-calling.sh enable)`, 5);
  if (mine.length > 1) fail(`на номере несколько записей ${host} от разных приложений — разобрать вручную`, 5);
  const pw = mine[0]?.sip_user_password;
  if (typeof pw !== "string" || pw.length < 8 || /[\r\n]/.test(pw)) fail("Meta не вернула пароль SIP", 5);
  out(pw);
  process.stderr.write("[graph-call] пароль получен (значение не показывается)\n");
  process.exit(0);
}

if (op in READ_OPS) {
  const json = await call("GET", READ_OPS[op]);
  if (op === "health") {
    const ents = json?.health_status?.entities ?? [];
    const rows = ents
      .filter((e) => e.entity_type === "PHONE_NUMBER" || e.entity_type === "APP")
      .map((e) => ({ type: e.entity_type, id: e.id, can_receive_call_sip: e.can_receive_call_sip ?? "—", errors: e.errors ?? [], additional_info: e.additional_info ?? [] }));
    out(JSON.stringify(rows, null, 2) + "\n");
    const phone = rows.find((r) => r.type === "PHONE_NUMBER");
    process.exit(phone?.can_receive_call_sip === "AVAILABLE" ? 0 : 10);
  }
  out(JSON.stringify(stripPasswords(json), null, 2) + "\n");
  process.exit(0);
}

if (op === "test-call-button") {
  const json = await call("POST", "/messages", testMessage(testTo));
  out(JSON.stringify({ message_id: json?.messages?.[0]?.id ?? null }) + "\n");
  process.exit(json?.messages?.[0]?.id ? 0 : 6);
}

const json = await call("POST", "/settings", bodyFor(op));
out(JSON.stringify(json) + "\n");
process.exit(json?.success === true ? 0 : 6);
