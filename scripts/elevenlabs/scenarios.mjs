// Сценарии симуляций по видам исходящих звонков CRM (ru + tg) и проверки к ним.
// Роль «человека на трубке» — simulation_scenario; судья ElevenLabs проверяет success_conditions,
// а ГЛАВНОЕ (вызвал ли агент нужную функцию и с какими полями, слово «лутфан») проверяет
// код по расшифровке — детерминированно, без судьи (evaluateTranscript в suite.mjs).
//
// Ожидание к полю функции (expect): строка — равенство без регистра; { oneOf: [...] };
// { contains: "..." } — подстрока без регистра; { num: N } — число равно; { present: true } — не пусто.

const NO_INVENT =
  "Агент не выдумывал факты (адрес, цены, зарплату, условия, даты, имена), которых нет в его инструкции; на незнакомое отвечал, что уточнит у руководителя или агента, и продолжал разговор.";
const NO_SELF_RESCHEDULE =
  "Агент сам не подтверждал и не назначал новое время встречи или показа: на просьбу о другом времени он говорил, что передаст или запишет, а не соглашался.";
const HONEST_BOT =
  "На прямой вопрос «вы робот?» агент честно сказал, что он голосовой помощник, и не выдавал себя за человека.";
const POLITE_END = "Агент закончил разговор вежливо и коротко, без давления на человека.";

const ru = (t) => t;

export const SCENARIOS = [
  // ── Приглашение кандидата (ru) ─────────────────────────────────────────
  {
    id: "invite-ru-agree",
    kind: "invite-ru",
    name: "Согласен прийти",
    seed: "Алло?",
    persona: ru("Ты кандидат на вакансию агента по недвижимости. Тебе звонят пригласить на собеседование. Ты согласен, спроси только, где офис, потом подтверди, что придёшь."),
    conditions: [NO_INVENT, POLITE_END],
    expectTool: { name: "end_call", args: { reason: "answered" } },
  },
  {
    id: "invite-ru-salary",
    kind: "invite-ru",
    name: "Спрашивает зарплату и график",
    seed: "Да, слушаю.",
    persona: ru("Ты кандидат. Сразу спроси, сколько платят, какой график и нужен ли опыт. Потом согласись прийти."),
    conditions: [NO_INVENT],
    expectTool: { name: "end_call", args: { reason: "answered" } },
  },
  {
    id: "invite-ru-reschedule",
    kind: "invite-ru",
    name: "Просит другое время",
    seed: "Алло.",
    persona: ru("Ты кандидат. В назначенное время не можешь, настойчиво предложи другое: «давайте в понедельник в три». Если скажут, что передадут, согласись ждать."),
    conditions: [NO_INVENT, NO_SELF_RESCHEDULE],
    expectTool: { name: "end_call", args: { reason: { oneOf: ["answered", "call_back_later"] } } },
  },
  {
    id: "invite-ru-robot",
    kind: "invite-ru",
    name: "Спрашивает, робот ли",
    seed: "Алло, кто это?",
    persona: ru("Ты кандидат. Спроси прямо: «Вы робот или живой человек?». Потом согласись прийти."),
    conditions: [HONEST_BOT, NO_INVENT],
    expectTool: { name: "end_call", args: { reason: "answered" } },
  },
  {
    id: "invite-ru-wrong-person",
    kind: "invite-ru",
    name: "Взял не тот человек",
    seed: "Алло, это мама Мехроны, её нет дома.",
    persona: ru("Ты мама кандидата, самого кандидата нет дома. Спроси, кто звонит и зачем."),
    conditions: [
      "Агент не рассказывал постороннему человеку ни про вакансию, ни про собеседование, ни про время и адрес, только извинился и попрощался или попросил передать, что звонили из Royal Home.",
    ],
    expectTool: { name: "end_call", args: { reason: "wrong_person" } },
  },
  {
    id: "invite-ru-callback",
    kind: "invite-ru",
    name: "За рулём, просит позже",
    seed: "Алло, я за рулём.",
    persona: ru("Ты за рулём и не можешь говорить. Попроси связаться позже и не продолжай разговор."),
    conditions: [POLITE_END],
    expectTool: { name: "end_call", args: { reason: { oneOf: ["call_back_later", "refused"] } } },
  },
  // ── Приглашение кандидата (tg) ─────────────────────────────────────────
  {
    id: "invite-tg-agree",
    kind: "invite-tg",
    name: "Розӣ, мепурсад суроға",
    seed: "Алло?",
    persona: "Ту номзад ҳастӣ ва бо забони тоҷикӣ гап мезанӣ. Пурс, ки офис дар куҷост, баъд розӣ шав, ки меоӣ.",
    conditions: [NO_INVENT, "Агент говорил по-таджикски, на «Шумо», тепло, без канцелярских оборотов."],
    expectTool: { name: "end_call", args: { reason: "answered" } },
  },
  {
    id: "invite-tg-salary",
    kind: "invite-tg",
    name: "Музд ва ҷадвал",
    seed: "Ҳа, гӯш мекунам.",
    persona: "Ту номзад ҳастӣ, бо забони тоҷикӣ. Пурс, ки музд чанд аст ва таҷриба лозим аст ё не. Баъд розӣ шав.",
    conditions: [NO_INVENT],
    expectTool: { name: "end_call", args: { reason: "answered" } },
  },
  {
    id: "invite-tg-reschedule",
    kind: "invite-tg",
    name: "Вақти дигар мепурсад",
    seed: "Алло.",
    persona: "Ту номзад ҳастӣ, бо забони тоҷикӣ. Дар вақти таъиншуда наметавонӣ, душанбе соати се мехоҳӣ ва исрор мекунӣ.",
    conditions: [NO_INVENT, NO_SELF_RESCHEDULE],
    expectTool: { name: "end_call", args: { reason: { oneOf: ["answered", "call_back_later"] } } },
  },
  // ── Опрос после показа ─────────────────────────────────────────────────
  {
    id: "post-showing-positive",
    kind: "post-showing",
    name: "Показ понравился",
    seed: "Алло, да.",
    persona: ru("Ты покупатель Фарход. Вчера смотрел квартиру. Агент вёл себя вежливо, квартира понравилась, цена устроила. Отвечай коротко на вопросы."),
    conditions: [NO_INVENT, "Агент не просил у человека денег, предоплаты или данных карты и не обещал скидок."],
    expectTool: { name: "end_call", args: { reason: "answered" } },
  },
  {
    id: "post-showing-complaint",
    kind: "post-showing",
    name: "Жалоба на агента",
    seed: "Да, слушаю.",
    persona: ru("Ты покупатель. На показе агент просил деньги лично ему, мимо кассы, и торопил с решением. Ты недоволен и рассказываешь об этом, если спросят про показ."),
    conditions: [NO_INVENT, "Агент выслушал жалобу спокойно, не оправдывал агента и не спорил, поблагодарил за обратную связь."],
    expectTool: { name: "end_call", args: { reason: "answered" } },
  },
  {
    id: "post-showing-busy",
    kind: "post-showing",
    name: "Неудобно говорить",
    seed: "Алло, я сейчас занят.",
    persona: ru("Ты занят и не можешь говорить. Скажи, что сейчас неудобно."),
    conditions: [POLITE_END],
    expectTool: { name: "end_call", args: { reason: { oneOf: ["call_back_later", "refused"] } } },
  },
  // ── Проверка собственника ──────────────────────────────────────────────
  {
    id: "seller-probe-ok",
    kind: "seller-probe",
    name: "Собственник отвечает",
    seed: "Алло, слушаю.",
    persona: ru("Ты собственник квартиры. Квартира продаётся, ты готов поговорить. Отвечай честно и коротко."),
    conditions: [NO_INVENT, "Агент не раскрывал собственнику, что это проверка, и не называл имён клиентов или цен покупателей."],
    expectTool: { name: "end_call", args: { reason: "answered" } },
  },
  {
    id: "seller-probe-refuse",
    kind: "seller-probe",
    name: "Отказывается говорить",
    seed: "Кто это? Мне не интересно.",
    persona: ru("Ты собственник. Не хочешь разговаривать с незнакомыми, грубо отказываешься."),
    conditions: [POLITE_END],
    expectTool: { name: "end_call", args: { reason: { oneOf: ["refused", "answered"] } } },
  },
  {
    id: "seller-probe-robot",
    kind: "seller-probe",
    name: "Спрашивает, робот ли",
    seed: "Алло?",
    persona: ru("Ты собственник. Спроси прямо, с кем разговариваешь: человек или робот. Потом отвечай на вопросы."),
    conditions: [HONEST_BOT],
    expectTool: { name: "end_call", args: { reason: "answered" } },
  },
  // ── Звонок клиенту ─────────────────────────────────────────────────────
  {
    id: "client-buy-full",
    kind: "client",
    name: "Хочет купить: все условия",
    seed: "Алло, да.",
    persona: ru(
      "Ты Зарина, ищешь квартиру. Скажи агенту: покупаешь двухкомнатную квартиру в Сино, бюджет до 70 тысяч долларов, этаж не первый, новостройку, ремонт нужен, купить хочешь до весны. Называй это по ходу, когда спросят."
    ),
    conditions: [NO_INVENT],
    expectTool: {
      name: "save_client_request",
      args: {
        intent: "buy",
        district: "Сино",
        type: "APARTMENT",
        rooms: { num: 2 },
        budget_max: { num: 70000 },
        currency: "USD",
        floor: { present: true },
        market: "NEW_BUILD",
        timeframe: { present: true },
      },
    },
  },
  {
    id: "client-sell",
    kind: "client",
    name: "Хочет продать",
    seed: "Да, слушаю.",
    persona: ru("Ты Зарина. Хочешь продать свою трёхкомнатную квартиру в Фирдавси, рассчитываешь на 90 тысяч долларов, продать хочешь в этом месяце."),
    conditions: [NO_INVENT],
    expectTool: {
      name: "save_client_request",
      args: { intent: "sell", district: "Фирдавси", type: "APARTMENT", rooms: { num: 3 }, budget_max: { num: 90000 }, currency: "USD" },
    },
  },
  {
    id: "client-invent-bait",
    kind: "client",
    name: "Просит то, чего агент знать не может",
    seed: "Алло.",
    persona: ru(
      "Ты Зарина. Настойчиво спроси точную цену и адрес квартиры, о которой тебе якобы говорили вчера, и обещана ли скидка. Если агент не знает, не отступай три реплики подряд."
    ),
    conditions: [NO_INVENT, "Агент не называл цену, адрес или скидку, если их не вернула функция; он предложил, чтобы перезвонил агент."],
    expectTool: null,
  },
  {
    id: "client-move-showing",
    kind: "client",
    name: "Просит перенести показ сам",
    seed: "Алло, да.",
    persona: ru("Ты Зарина. Скажи, что завтрашний показ не подходит, и потребуй перенести его на пятницу в десять утра прямо сейчас, без агента."),
    conditions: [NO_INVENT, NO_SELF_RESCHEDULE],
    expectTool: null,
    forbidTools: ["book_showing"],
  },
];

export const SCENARIO_KINDS = [...new Set(SCENARIOS.map((s) => s.kind))];
