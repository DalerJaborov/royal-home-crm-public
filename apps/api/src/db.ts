import { txScope, openScope, type StageEventRow, type TxScope } from "./lib/transactionScope.js";
import { PrismaClient } from "./generated/prisma/client.js";
import { makePrismaAdapter } from "./lib/prismaAdapter.js";
import { currentActorId } from "./lib/requestActor.js";

/**
 * ЖУРНАЛ ПЕРЕХОДОВ — ПЕРЕХВАТОМ ЗДЕСЬ, А НЕ ПРАВКОЙ СОРОКА МЕСТ (26.08.2026,
 * ревью, пункт 4). Client.status/workStatus и Deal.stage меняют десятки точек
 * (роуты, бот, cron, автоправила), и новые появляются каждую неделю: ручная
 * запись события в каждой из них гарантированно разъедется с реальностью —
 * ровно грабли «починил в одном месте — ищи все». Один перехват update/updateMany
 * накрывает и сегодняшние точки, и будущие.
 *
 * Цена: лишний SELECT перед записью — ТОЛЬКО когда в data есть отслеживаемое
 * поле; обычные обновления (счётчики, отметки времени) идут как шли.
 *
 * Честные оговорки:
 *  - чтение «до» и запись события живут ВНЕ транзакции вызывающего: событие
 *    может пережить откат (запись есть, перехода не было). Для аналитики
 *    длительностей этапов это шум на уровне погрешности, а тянуть журнал в
 *    каждую транзакцию — значит дать ему право её уронить;
 *  - ВНУТРИ ИНТЕРАКТИВНОЙ ТРАНЗАКЦИИ (`prisma.$transaction(async (tx) => …)`)
 *    «до» читается ТЕМ ЖЕ соединением, что у транзакции, а события пишутся
 *    только после её фиксации (аудит 23.09.2026, круг 3, №78). Раньше чтение
 *    шло вторым соединением пула, пока первое держала транзакция: когда
 *    транзакций со сменой статуса больше, чем соединений (15 на процесс),
 *    все ждали друг друга до pool_timeout, и захваты лидов падали. Откат
 *    транзакции теперь не оставляет в журнале перехода, которого не было.
 *    Механизм — `txScope` ниже: обёртка `$transaction` кладёт `tx` в
 *    AsyncLocalStorage, перехват берёт его оттуда. Пакетная форма
 *    `$transaction([...])` идёт по-старому — колбэка, куда положить `tx`, у
 *    неё нет;
 *  - вложенные записи (deal.update({ client: { update: ... } })) не ловятся —
 *    в коде так статусы не меняют (проверено поиском на 26.08).
 */
const TRACKED = {
  client: { entityType: "CLIENT", fields: ["status", "workStatus"] as const },
  deal: { entityType: "DEAL", fields: ["stage"] as const },
} as const;

/**
 * АДРЕС БАЗЫ ЧИТАЕТСЯ ЗДЕСЬ И ОДИН РАЗ — так же, как раньше, и на это опирается
 * `tests/setup.ts`: он подменяет `DATABASE_URL` ДО первого импорта этого модуля,
 * потому что позже уже поздно. С драйверным адаптером ничего не изменилось:
 * `new Pool({ connectionString })` внутри `PrismaPg` снимает значение в тот же
 * момент, в который его снимал прежний движок.
 *
 * STATEMENT_TIMEOUT ЖИВЁТ В САМОМ АДРЕСЕ, И ПЕРЕХОД НА PG ЭТО НЕ СЛОМАЛ.
 * Инцидент 11-12.09.2026 (крон-тики buyer-thinking-slow-track/no-answer-tail
 * насыщали пул в час пик): `SET statement_timeout` нельзя выполнить один раз на
 * пуле — нет гарантии, что оно осядет на КАЖДОМ соединении, а не только на том,
 * что открыло текущий запрос. Поэтому предел задан параметром соединения
 * `options=-c statement_timeout=60000` в `DATABASE_URL`
 * (docker-compose.prod.yml для api и worker): Postgres применяет его при
 * установке соединения, одинаково на все соединения пула.
 *
 * Раньше этот параметр до сервера доносил движок Prisma. Теперь — драйвер `pg`,
 * и он делает то же самое: `options` разбирается `pg-connection-string` и
 * уходит стартовым параметром соединения. Проверено на живой базе (см. тело
 * merge-коммита), а не выведено из документации, — потому что молчаливая потеря
 * этого предела вернула бы ровно тот инцидент, ради которого его и вводили.
 * Ничего дополнительно в пул передавать не нужно: строка подключения уходит в
 * `PrismaPg` целиком.
 */
const base = new PrismaClient({ adapter: makePrismaAdapter(process.env.DATABASE_URL ?? "") });

/** Новое значение из data: Prisma принимает и `status: "HOT"`, и `status: { set: "HOT" }`. */
function plannedValue(data: Record<string, unknown>, field: string): string | undefined {
  const raw = data[field];
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === "object") {
    const set = (raw as { set?: unknown }).set;
    return typeof set === "string" ? set : undefined;
  }
  return typeof raw === "string" ? raw : undefined;
}

function writeEvents(events: StageEventRow[]): void {
  if (!events.length) return;
  // fire-and-forget: журнал не имеет права уронить или замедлить сам переход.
  void base.stageEvent
    .createMany({ data: events })
    .catch((err) => console.error("[stage-events] запись перехода:", err instanceof Error ? err.message : err));
}

function recordEvents(
  entityType: "CLIENT" | "DEAL",
  rows: Array<{ id: string; [k: string]: unknown }>,
  changes: Array<{ field: string; to: string }>,
  scope: TxScope | undefined
): void {
  const agentId = currentActorId();
  const events: StageEventRow[] = rows.flatMap((row) =>
    changes
      .filter((c) => row[c.field] !== c.to)
      .map((c) => ({
        entityType,
        entityId: row.id,
        field: c.field,
        from: (row[c.field] as string | null) ?? null,
        to: c.to,
        agentId,
      }))
  );
  if (!events.length) return;
  if (scope?.open) scope.pending.push(...events);
  else writeEvents(events);
}

type UpdateHook = {
  args: { where?: unknown; data?: unknown; select?: unknown };
  query: (args: unknown) => Promise<unknown>;
};

function makeHooks(model: keyof typeof TRACKED) {
  const cfg = TRACKED[model];
  const selectBefore = Object.fromEntries([["id", true], ...cfg.fields.map((f) => [f, true])]);
  const changesOf = (data: unknown): Array<{ field: string; to: string }> => {
    if (!data || typeof data !== "object") return [];
    const out: Array<{ field: string; to: string }> = [];
    for (const field of cfg.fields) {
      const to = plannedValue(data as Record<string, unknown>, field);
      if (to !== undefined) out.push({ field, to });
    }
    return out;
  };
  return {
    async update({ args, query }: UpdateHook) {
      const changes = changesOf(args.data);
      if (changes.length) {
        const scope = openScope();
        const reader = (scope ? scope.tx : base) as any;
        const before = await reader[model].findUnique({ where: args.where, select: selectBefore });
        const result = await query(args);
        if (before) recordEvents(cfg.entityType, [before], changes, scope);
        return result;
      }
      return query(args);
    },
    async updateMany({ args, query }: UpdateHook) {
      const changes = changesOf(args.data);
      if (changes.length) {
        const scope = openScope();
        const reader = (scope ? scope.tx : base) as any;
        const before = await reader[model].findMany({ where: args.where, select: selectBefore });
        const result = await query(args);
        // A guarded write can lose a race after the BEFORE read. A zero-row
        // result means there was no transition to record, even if BEFORE matched.
        if (before.length && (result as { count: number }).count > 0) recordEvents(cfg.entityType, before, changes, scope);
        return result;
      }
      return query(args);
    },
    /** Создание — тоже переход: from=null, «первый статус». Дефолтные значения
     *  (NEW/ACTIVE без явного поля в data) журналу не нужны — они и так дефолт;
     *  пишем только явно заданные, чтобы не плодить строку на каждый сид. */
    async create({ args, query }: UpdateHook) {
      const changes = changesOf(args.data);
      const result = (await query(args)) as { id?: string } | null;
      if (changes.length && result && typeof result.id === "string") {
        recordEvents(
          cfg.entityType,
          [{ id: result.id, ...Object.fromEntries(cfg.fields.map((f) => [f, null])) }],
          changes,
          openScope()
        );
      }
      return result;
    },
  };
}

const withHooks = base.$extends({
  query: {
    client: makeHooks("client"),
    deal: makeHooks("deal"),
  },
});

/**
 * БЮДЖЕТ КЛИЕНТА НЕ МОЖЕТ ОКАЗАТЬСЯ «ЗАДОМ НАПЕРЁД» — ПЕРЕХВАТОМ ЗДЕСЬ, А НЕ В
 * КАЖДОЙ ТОЧКЕ ЗАПИСИ (19.09.2026, разбор карточки №298).
 *
 * ЖИВОЙ СЛУЧАЙ: на звонке клиент назвал цену ЗА КВАДРАТНЫЙ МЕТР для стадии
 * котлована («650 доллар») — цену за единицу площади, а не общий бюджет. Разбор
 * звонка (ai/cardFill.ts) применил обычное правило «одна названная сумма —
 * budgetMax», конвертировал в сомони и записал 6027 в budgetMax. budgetMin
 * (463 500, от ПРЕДЫДУЩЕГО звонка) при этом не тронул: lib/cardSuggestions.ts
 * пишет только ИЗМЕНИВШЕЕСЯ поле и не сверяет результат с уже сохранённой
 * ДРУГОЙ половиной пары. Карточка получила «бюджет от 463 500 до 6 027» —
 * задом наперёд и из разных единиц измерения.
 *
 * Точек записи budgetMin/budgetMax в репозитории три десятка (переписка, звонки,
 * импорт, ручная правка карточки, слияние дублей...) — чинить каждую означало бы
 * гарантированно пропустить следующую. Промт (ai/cardFill.ts, ai/leadQualifier.ts,
 * ai/incomingCallLead.ts) чинит ПРИЧИНУ для этого конкретного случая (цена за
 * метр), а перехват здесь — сеть на ВЕСЬ класс: после любой записи, где итоговые
 * budgetMin и budgetMax оба не пусты, min обязан быть ≤ max. Ловит и сегодняшние
 * точки записи, и будущие.
 *
 * ЧТО ДЕЛАЕМ ПРИ НАРУШЕНИИ — БЕЗ ОКНА ПОДТВЕРЖДЕНИЯ (владелец 12.09.2026 запретил
 * переспрос по карточке, см. lib/cardSuggestions.ts). Правка коснулась ОБЕИХ
 * границ разом — цифры просто перепутаны местами, меняем их местами: та же
 * информация, без потери. Правка коснулась ОДНОЙ границы — новое противоречит
 * старому, и какая из двух цифр вернее, было бы гаданием (не выдумывать данные,
 * CLAUDE.md); стираем СТАРУЮ, не участвовавшую в этой записи, и оставляем след в
 * ErrorLog (виден в утреннем отчёте директору) — трассу, а не вопрос.
 *
 * Отдельным `$extends`, а не веткой внутри makeHooks: забота другая (не журнал
 * переходов, а целостность пары значений), и `query(args)` ниже честно проходит
 * СКВОЗЬ трекинг статусов выше — оба перехвата работают независимо.
 *
 * ВНУТРИ ИНТЕРАКТИВНОЙ ТРАНЗАКЦИИ чтение «до» и исправление идут через её `tx`
 * (`openScope`, как в журнале переходов, №78): иначе исправляющий UPDATE шёл бы
 * вторым соединением и ждал снятия блокировки строки, которую держит сама
 * транзакция, — а та ждёт возврата из перехвата. Запись в ErrorLog — отдельная
 * таблица без блокировок на карточку, она идёт по-обычному.
 */
function plannedNumber(data: Record<string, unknown>, field: string): number | null | undefined {
  if (!(field in data)) return undefined;
  let raw = data[field];
  if (raw && typeof raw === "object" && "set" in (raw as object)) raw = (raw as { set: unknown }).set;
  if (raw === null) return null;
  const num = Number(raw);
  return Number.isFinite(num) ? num : undefined;
}

async function fixInvertedBudget(
  clientId: string,
  finalMin: number,
  finalMax: number,
  touchesMin: boolean,
  touchesMax: boolean,
  scope: TxScope | undefined
) {
  const bothTouched = touchesMin && touchesMax;
  const fixedMin = bothTouched ? finalMax : touchesMin ? finalMin : null;
  const fixedMax = bothTouched ? finalMin : touchesMax ? finalMax : null;
  const writer = (scope ? scope.tx : base) as any;
  await writer.client.update({ where: { id: clientId }, data: { budgetMin: fixedMin, budgetMax: fixedMax } });
  void base.errorLog
    .create({
      data: {
        source: "ai",
        message:
          `Бюджет клиента ${clientId} записался задом наперёд (от ${finalMin} до ${finalMax}) — ` +
          `исправлено на ${fixedMin ?? "—"}–${fixedMax ?? "—"}. Проверьте карточку и источник (звонок/переписка).`,
      },
    })
    .catch((err) => console.error("[budget-guard] запись в журнал:", err instanceof Error ? err.message : err));
}

const budgetGuard = {
  async update({ args, query }: UpdateHook) {
    const data = (args.data ?? {}) as Record<string, unknown>;
    const touchesMin = "budgetMin" in data;
    const touchesMax = "budgetMax" in data;
    if (!touchesMin && !touchesMax) return query(args);

    const scope = openScope();
    const reader = (scope ? scope.tx : base) as any;
    const before = (await reader.client.findUnique({
      where: args.where,
      select: { id: true, budgetMin: true, budgetMax: true },
    })) as { id: string; budgetMin: unknown; budgetMax: unknown } | null;
    const result = await query(args);
    if (!before) return result;

    const writtenMin = plannedNumber(data, "budgetMin");
    const writtenMax = plannedNumber(data, "budgetMax");
    const finalMin = touchesMin ? writtenMin : before.budgetMin === null ? null : Number(before.budgetMin);
    const finalMax = touchesMax ? writtenMax : before.budgetMax === null ? null : Number(before.budgetMax);
    if (finalMin == null || finalMax == null || finalMin <= finalMax) return result;

    await fixInvertedBudget(before.id, finalMin, finalMax, touchesMin, touchesMax, scope);
    return result;
  },
  async create({ args, query }: UpdateHook) {
    const result = (await query(args)) as { id?: string } | null;
    const data = (args.data ?? {}) as Record<string, unknown>;
    const min = plannedNumber(data, "budgetMin");
    const max = plannedNumber(data, "budgetMax");
    if (result?.id && min != null && max != null && min > max) {
      // Создание: обе границы пришли ОДНОЙ записью, старой «другой половины»
      // ещё не существует — это просто перепутанные местами цифры, меняем местами.
      await fixInvertedBudget(result.id, min, max, true, true, openScope());
    }
    return result;
  },
};

const withGuard = withHooks.$extends({
  query: {
    client: budgetGuard,
  },
});

const rawTransaction = withGuard.$transaction.bind(withGuard) as (...args: unknown[]) => Promise<unknown>;

/**
 * `$transaction` с областью для журнала переходов (№78, см. шапку файла).
 * Колбэчная форма: `tx` кладётся в `txScope`, события копятся и пишутся после
 * фиксации, при откате — выбрасываются. Пакетная форма — как была.
 */
function scopedTransaction(arg: unknown, options?: unknown): Promise<unknown> {
  if (typeof arg !== "function") return rawTransaction(arg, options);
  const fn = arg as (tx: unknown) => unknown;
  let scope: TxScope | undefined;
  return rawTransaction((tx: unknown) => {
    const own: TxScope = { tx, open: true, pending: [] };
    scope = own;
    return txScope.run(own, () =>
      Promise.resolve()
        .then(() => fn(tx))
        .finally(() => {
          own.open = false;
        })
    );
  }, options).then(
    (result) => {
      if (scope) writeEvents(scope.pending);
      return result;
    },
    (err: unknown) => {
      if (scope) scope.pending.length = 0;
      throw err;
    }
  );
}

export const prisma = withGuard.$extends({
  client: { $transaction: scopedTransaction as typeof withGuard.$transaction },
});

/**
 * Тип клиента после $extends — им, а не голым PrismaClient, обязаны типизироваться
 * параметры функций, принимающих «prisma или транзакцию»: у расширенного клиента
 * другие дженерики делегатов, и старый Prisma.TransactionClient с ним несовместим.
 */
export type Db = typeof prisma;
/** То, что получает колбэк prisma.$transaction(async (tx) => ...) — и сам prisma
 *  тоже подходит (структурно шире): для функций с параметром «клиент или tx». */
export type TxClient = Omit<Db, "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends">;
