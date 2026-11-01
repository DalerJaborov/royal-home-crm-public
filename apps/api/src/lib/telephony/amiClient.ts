import net from "node:net";
import { decryptSecretSafe } from "../../crypto.js";
import { prisma } from "../../db.js";
import { ASTERISK_AMI_PORT } from "../settingsConstants.js";

/**
 * Управление станцией из CRM — Asterisk Manager Interface (AMI).
 *
 * ЗАЧЕМ ОН, КОГДА ЕСТЬ ARI. ARI ведёт звонки: позвонить, сбросить, слушать события.
 * Менять НАСТРОЙКИ станции он не умеет вовсе. А владельцу нужно ровно это: поставить
 * оператора на паузу, добавить спам-номер в чёрный список, сменить номер дежурного,
 * на который уходит непринятый звонок, — не открывая панель FreePBX и не вызывая
 * программиста с ключом по SSH (решение 13.08.2026).
 *
 * ОДНО ДЕЙСТВИЕ — ОДНО СОЕДИНЕНИЕ. Постоянного подключения здесь намеренно нет.
 * Действия редкие (нажали кнопку, сохранили настройку), а живой сокет к станции —
 * это ещё один канал, который умеет молча умереть в полуоткрытом состоянии и
 * требует собственного сторожа с ping (как у подписки на события, см. ariEvents.ts).
 * Платить этой сложностью за пару запросов в день незачем: соединение живёт
 * миллисекунды и закрывается.
 *
 * ЧТО ЭТОТ МОДУЛЬ НЕ ДЕЛАЕТ НИКОГДА — действие `Command`. Это полная командная
 * строка Asterisk: им можно прочитать пароли SIP, перенастроить транк, положить
 * станцию. Пользователю AMI в manager.conf оно тоже не даётся. Одна дыра в CRM не
 * должна означать угнанную телефонию агентства.
 *
 * ОТКАЗЫ НЕ БРОСАЮТСЯ. Станция в офисе, CRM на VPS, между ними обратный туннель —
 * недоступность здесь штатна. Все функции возвращают результат с признаком `ok`,
 * а решение «сказать человеку» или «записать в журнал» принимает вызывающий: у
 * кнопки оператора и у фоновой синхронизации оно разное.
 */

/** Станция отвечает мгновенно; всё, что дольше, — это оборванный туннель. */
const AMI_TIMEOUT_MS = 5_000;

export interface AmiCredentials {
  host: string;
  port: number;
  username: string;
  password: string;
}

/**
 * Адрес станции берётся из настроек ARI: станция одна, и держать один и тот же
 * хост в двух полях значит рано или поздно развести их руками. Отдельно задаётся
 * только порт (у AMI он свой — 5038, константа с 01.11.2026 в lib/settingsConstants.ts).
 */
export async function loadAmiCredentials(): Promise<AmiCredentials | null> {
  const settings = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: {
      asteriskAriUrl: true,
      asteriskAmiUsername: true,
      asteriskAmiPassword: true,
    },
  });
  const password = decryptSecretSafe(settings?.asteriskAmiPassword ?? null);
  if (!settings?.asteriskAriUrl || !settings.asteriskAmiUsername || !password) return null;
  let host: string;
  try {
    host = new URL(settings.asteriskAriUrl).hostname;
  } catch {
    return null;
  }
  if (!host) return null;
  return { host, port: ASTERISK_AMI_PORT, username: settings.asteriskAmiUsername, password };
}

/** Один пакет протокола: `Ключ: значение` до пустой строки. Ключи регистронезависимы. */
export type AmiPacket = Record<string, string>;

export type AmiResult =
  | { ok: true; packets: AmiPacket[] }
  | { ok: false; error: string };

/** Разбор пакета AMI. Ключи приводятся к нижнему регистру: станция пишет их
 *  по-разному в разных версиях (`ActionID` и `Actionid` встречаются оба). */
export function parseAmiPacket(raw: string): AmiPacket {
  const packet: AmiPacket = {};
  for (const line of raw.split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    packet[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
  }
  return packet;
}

function serialize(fields: Record<string, string | number>): string {
  return (
    Object.entries(fields)
      .map(([key, value]) => `${key}: ${value}`)
      .join("\r\n") + "\r\n\r\n"
  );
}

/**
 * Ответ на действие получен целиком.
 *
 * Простое действие (DBPut, QueuePause) отвечает одним пакетом с `Response`. Действия
 * со списком (DBGet, QueueStatus) отвечают `Response: Success`, затем сыплют события
 * и заканчивают пакетом, в котором `EventList: Complete` или имя события кончается на
 * `Complete`. Ждать таймаут в первом случае — значит держать кнопку в интерфейсе пять
 * секунд на ровном месте.
 */
function isComplete(packets: AmiPacket[], expectsList: boolean): boolean {
  if (packets.length === 0) return false;
  if (!expectsList) return packets.some((p) => p.response);
  return packets.some((p) => p.eventlist === "Complete" || /complete$/i.test(p.event ?? ""));
}

/**
 * Выполнить одно действие AMI: соединиться, войти, отправить, дождаться, выйти.
 *
 * `expectsList` — действие отвечает списком событий (DBGet, QueueStatus). Для него
 * ждём завершающий пакет, для остальных — первый же `Response`.
 */
export function amiAction(
  creds: AmiCredentials,
  action: string,
  fields: Record<string, string | number> = {},
  options: { expectsList?: boolean; timeoutMs?: number } = {}
): Promise<AmiResult> {
  const timeoutMs = options.timeoutMs ?? AMI_TIMEOUT_MS;
  const expectsList = options.expectsList ?? false;

  return new Promise<AmiResult>((resolve) => {
    const actionId = `crm-${action}-${process.hrtime.bigint().toString(36)}`;
    const collected: AmiPacket[] = [];
    let buffer = "";
    let loggedIn = false;
    let settled = false;

    const socket = net.createConnection({ host: creds.host, port: creds.port });
    socket.setEncoding("utf8");

    const timer = setTimeout(() => {
      finish({ ok: false, error: `станция не ответила за ${Math.round(timeoutMs / 1000)} с` });
    }, timeoutMs);
    // Таймер не должен держать процесс живым: он висит на каждом действии.
    timer.unref?.();

    function finish(result: AmiResult): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Logoff отправляем «вдогонку» и ответа не ждём: соединение всё равно рвём, а
      // станция сама закроет свою сторону. Ошибку записи глотаем — сокет может быть
      // уже мёртв, и падать на прощании было бы нелепо.
      try {
        if (loggedIn) socket.write(serialize({ Action: "Logoff" }));
      } catch {
        /* соединение уже закрыто */
      }
      socket.destroy();
      resolve(result);
    }

    socket.on("error", (err) => {
      finish({ ok: false, error: err instanceof Error ? err.message : String(err) });
    });

    socket.on("close", () => {
      // Станция закрыла соединение, не ответив, — это отказ, а не тишина. Без этой
      // ветки кнопка в интерфейсе просто висела бы до таймаута.
      finish({ ok: false, error: "станция закрыла соединение" });
    });

    socket.on("connect", () => {
      socket.write(
        serialize({
          Action: "Login",
          Username: creds.username,
          Secret: creds.password,
          // События станции CRM слушает через ARI; здесь они только мешали бы —
          // в ответ на действие приезжал бы поток всего, что происходит на АТС.
          Events: "off",
          ActionID: `${actionId}-login`,
        })
      );
    });

    socket.on("data", (chunk: string) => {
      buffer += chunk;
      // Первая строка станции — приветствие `Asterisk Call Manager/x.y.z` без
      // двоеточия-пары; она отсекается тем, что не образует ни одной пары ключ-значение.
      let boundary = buffer.indexOf("\r\n\r\n");
      while (boundary !== -1) {
        const packet = parseAmiPacket(buffer.slice(0, boundary));
        buffer = buffer.slice(boundary + 4);
        boundary = buffer.indexOf("\r\n\r\n");

        if (!loggedIn) {
          if (!packet.response) continue;
          if (packet.response.toLowerCase() !== "success") {
            finish({ ok: false, error: packet.message || "вход в AMI отклонён" });
            return;
          }
          loggedIn = true;
          socket.write(serialize({ Action: action, ActionID: actionId, ...fields }));
          continue;
        }

        // Чужие пакеты (события станции, ответы на Logoff) отбрасываем: на одном
        // соединении их быть не должно, но протокол этого не запрещает.
        if (packet.actionid && packet.actionid !== actionId) continue;
        collected.push(packet);

        const response = collected.find((p) => p.response)?.response?.toLowerCase();
        if (response && response !== "success") {
          finish({ ok: false, error: collected.find((p) => p.message)?.message || `станция отказала: ${response}` });
          return;
        }
        if (isComplete(collected, expectsList)) {
          finish({ ok: true, packets: collected });
          return;
        }
      }
    });
  });
}

/**
 * Одна AMI-сессия на НЕСКОЛЬКО действий подряд: Login один раз, дальше сколько
 * угодно вызовов `send()` строго по очереди (следующий ждёт ответа на предыдущий —
 * протокол AMI на одном соединении не гарантирует, что ActionID вернутся в
 * порядке отправки, если слать несколько сразу), Logoff и закрытие сокета сразу
 * после того, как `run` вернул результат или упал.
 *
 * ЭТО НЕ ПОСТОЯННОЕ СОЕДИНЕНИЕ (см. заголовок модуля) — тот же принцип «одно
 * место вызова — одно соединение», только теперь «одно действие места вызова»
 * может состоять из нескольких команд AMI, а не строго одной. Соединение живёт
 * ровно на время `run` и закрывается сразу после — присматривать за ним между
 * вызовами (ping, переподключение) не нужно, потому что оно никогда не бывает
 * «между вызовами».
 *
 * ЗАЧЕМ (06.09.2026, разбор двойного звонка 05.09.2026 — клиент Шарипов
 * Кодирчон). `redirectChannelToAgent` отправляет подряд до пяти действий
 * (Setvar×3-4 + Redirect), и раньше каждое открывало СВОЙ TCP-сокет и заново
 * проходило Login через туннель офис↔VPS — пока набиралась эта цепочка, станция
 * УЖЕ звонила клиенту дефолтным номером напрямую по диалплану, и звонящий успевал
 * положить трубку раньше, чем CRM успевала перевести звонок. Одна сессия на всю
 * цепочку убирает четыре лишних TCP-соединения и Login из этого пути.
 */
export function withAmiConnection<T>(
  creds: AmiCredentials,
  run: (
    send: (
      action: string,
      fields?: Record<string, string | number>,
      options?: { expectsList?: boolean; timeoutMs?: number }
    ) => Promise<AmiResult>
  ) => Promise<T>
): Promise<T> {
  return new Promise<T>((resolveOuter, rejectOuter) => {
    let settled = false;
    let loggedIn = false;
    let buffer = "";
    // Действие, на чей ответ сейчас ждём, — одно за раз (см. заголовок функции).
    let waiting: {
      actionId: string;
      expectsList: boolean;
      collected: AmiPacket[];
      timer: ReturnType<typeof setTimeout>;
      settle: (result: AmiResult) => void;
    } | null = null;
    let loginTimer: ReturnType<typeof setTimeout> | null = null;

    const socket = net.createConnection({ host: creds.host, port: creds.port });
    socket.setEncoding("utf8");

    function closeSocket(): void {
      try {
        if (loggedIn) socket.write(serialize({ Action: "Logoff" }));
      } catch {
        /* соединение уже закрыто */
      }
      socket.destroy();
    }

    /** Обрывает сессию раз и навсегда: текущее ожидание (если есть) получает
     *  отказ, внешний промис проваливается, сокет закрывается. Вызывать только
     *  до того, как run() успел завершиться сам — после этого сессию закрывает
     *  runResult ниже. */
    function abort(error: string): void {
      if (settled) return;
      settled = true;
      if (loginTimer) clearTimeout(loginTimer);
      if (waiting) {
        clearTimeout(waiting.timer);
        const settle = waiting.settle;
        waiting = null;
        settle({ ok: false, error });
      }
      closeSocket();
      rejectOuter(new Error(error));
    }

    const loginTimeoutMs = AMI_TIMEOUT_MS;
    loginTimer = setTimeout(() => abort(`станция не ответила за ${Math.round(loginTimeoutMs / 1000)} с`), loginTimeoutMs);
    loginTimer.unref?.();

    socket.on("error", (err) => abort(err instanceof Error ? err.message : String(err)));
    socket.on("close", () => abort("станция закрыла соединение"));

    socket.on("connect", () => {
      socket.write(
        serialize({ Action: "Login", Username: creds.username, Secret: creds.password, Events: "off", ActionID: "crm-session-login" })
      );
    });

    function send(
      action: string,
      fields: Record<string, string | number> = {},
      options: { expectsList?: boolean; timeoutMs?: number } = {}
    ): Promise<AmiResult> {
      return new Promise<AmiResult>((resolveAction) => {
        if (settled) {
          resolveAction({ ok: false, error: "AMI-сессия уже закрыта" });
          return;
        }
        const timeoutMs = options.timeoutMs ?? AMI_TIMEOUT_MS;
        const actionId = `crm-${action}-${process.hrtime.bigint().toString(36)}`;
        const timer = setTimeout(() => {
          waiting = null;
          resolveAction({ ok: false, error: `станция не ответила за ${Math.round(timeoutMs / 1000)} с` });
        }, timeoutMs);
        timer.unref?.();
        waiting = { actionId, expectsList: options.expectsList ?? false, collected: [], timer, settle: resolveAction };
        socket.write(serialize({ Action: action, ActionID: actionId, ...fields }));
      });
    }

    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let boundary = buffer.indexOf("\r\n\r\n");
      while (boundary !== -1) {
        const packet = parseAmiPacket(buffer.slice(0, boundary));
        buffer = buffer.slice(boundary + 4);
        boundary = buffer.indexOf("\r\n\r\n");

        if (!loggedIn) {
          if (!packet.response) continue;
          if (loginTimer) {
            clearTimeout(loginTimer);
            loginTimer = null;
          }
          if (packet.response.toLowerCase() !== "success") {
            abort(packet.message || "вход в AMI отклонён");
            return;
          }
          loggedIn = true;
          // run() теперь свободен слать действия своим send(); что бы он ни
          // вернул — сессию закрываем и решаем внешний промис ровно один раз.
          Promise.resolve(run(send)).then(
            (value) => {
              if (settled) return;
              settled = true;
              closeSocket();
              resolveOuter(value);
            },
            (err) => {
              if (settled) return;
              settled = true;
              closeSocket();
              rejectOuter(err instanceof Error ? err : new Error(String(err)));
            }
          );
          continue;
        }

        if (!waiting) continue; // между действиями сессии — чужих пакетов быть не должно, но не падаем на них
        if (packet.actionid && packet.actionid !== waiting.actionId) continue;
        waiting.collected.push(packet);

        const response = waiting.collected.find((p) => p.response)?.response?.toLowerCase();
        if (response && response !== "success") {
          clearTimeout(waiting.timer);
          const settle = waiting.settle;
          const error = waiting.collected.find((p) => p.message)?.message || `станция отказала: ${response}`;
          waiting = null;
          settle({ ok: false, error });
          continue;
        }
        if (isComplete(waiting.collected, waiting.expectsList)) {
          clearTimeout(waiting.timer);
          const settle = waiting.settle;
          const packets = waiting.collected;
          waiting = null;
          settle({ ok: true, packets });
        }
      }
    });
  });
}

/** Проверка связи: вход и `Ping`. Отвечает то же, что кнопка проверки ARI. */
export async function testAmiConnection(creds: AmiCredentials): Promise<{ ok: boolean; error?: string }> {
  const result = await amiAction(creds, "Ping");
  return result.ok ? { ok: true } : { ok: false, error: result.error };
}

/** Пауза перед повторной попыткой ЧТЕНИЯ по AMI — тот же приём и та же величина,
 *  что у `listEndpointsRetrying` в ariClient.ts: короче, чем человек замечает, и
 *  достаточно, чтобы одиночная заминка TCP-туннеля прошла сама. */
const AMI_READ_RETRY_DELAY_MS = 400;

/**
 * Как `amiAction`, но с ОДНОЙ повторной попыткой при отказе — и ТОЛЬКО для
 * действий, которые ЧИТАЮТ состояние станции и ничего не меняют (`GetConfig`,
 * `DBGet`, `QueueStatus`, `Ping` и подобные).
 *
 * ЗАВОДИТЬ СЮДА ЗАПИСЫВАЮЩИЕ ДЕЙСТВИЯ НЕЛЬЗЯ НИКОГДА (`Setvar`, `Redirect`,
 * `QueueAdd`/`QueueRemove`/`QueuePause`, `DBPut`/`DBDel`, и вообще всё, что меняет
 * состояние живого звонка или конфигурацию станции) — см. заголовок модуля: одна
 * попытка на запись уже осознанное решение, а повтор уже принятой команды опаснее
 * одиночного отказа. Повторный `Redirect` перевёл бы уже переведённый канал ещё
 * раз, повторный `QueueAdd` неотличим от «дважды добавили» только если станция
 * сама сочтёт это идемпотентным, а полагаться на это не стоит. Эта обёртка
 * НИЧЕГО не проверяет за вызывающего — на нём гарантия, что `action` из класса
 * чтения.
 *
 * ЗАЧЕМ (20.09.2026, разбор `no_dialplan` на живых звонках). У ARI такой приём уже
 * был (`listEndpointsRetrying`, ariClient.ts) для справочных чтений, а у AMI — нет
 * вовсе, хотя `GetConfig` в dialplanContext.ts — то самое место, где один
 * сорвавшийся запрос превращался в минуту неверных решений по каждому следующему
 * звонку (см. dialplanContext.ts). Перенесено сюда, а не оставлено локальной
 * копией в dialplanContext.ts, чтобы тем же приёмом сразу пользовались и
 * `amiDbGet`/`amiQueueStatus` ниже.
 */
export async function amiActionRetrying(
  creds: AmiCredentials,
  action: string,
  fields: Record<string, string | number> = {},
  options: { expectsList?: boolean; timeoutMs?: number } = {}
): Promise<AmiResult> {
  const first = await amiAction(creds, action, fields, options);
  if (first.ok) return first;
  await new Promise((resolve) => setTimeout(resolve, AMI_READ_RETRY_DELAY_MS));
  return amiAction(creds, action, fields, options);
}

/**
 * Записать значение во внутреннюю базу Asterisk (AstDB).
 *
 * Это и есть способ менять поведение станции, не переписывая её конфигурацию:
 * диалплан читает значение на каждом звонке, а CRM его кладёт. Правка конфигурации
 * потребовала бы `reload` и умела бы сломать телефонию целиком; запись значения не
 * умеет ничего, кроме как поменять число или номер.
 */
export async function amiDbPut(
  creds: AmiCredentials,
  family: string,
  key: string,
  value: string
): Promise<AmiResult> {
  return amiAction(creds, "DBPut", { Family: family, Key: key, Val: value });
}

/** Прочитать значение из AstDB. Ключа нет — `null`, и это не ошибка. */
export async function amiDbGet(
  creds: AmiCredentials,
  family: string,
  key: string
): Promise<{ ok: true; value: string | null } | { ok: false; error: string }> {
  const result = await amiActionRetrying(creds, "DBGet", { Family: family, Key: key }, { expectsList: true });
  if (!result.ok) {
    // «Database entry not found» — штатный ответ на несуществующий ключ, а не отказ.
    if (/not found/i.test(result.error)) return { ok: true, value: null };
    return result;
  }
  const entry = result.packets.find((p) => p.val !== undefined);
  return { ok: true, value: entry?.val ?? null };
}

/** Удалить значение из AstDB (например, снять номер с чёрного списка). */
export async function amiDbDel(creds: AmiCredentials, family: string, key: string): Promise<AmiResult> {
  const result = await amiAction(creds, "DBDel", { Family: family, Key: key });
  // Удаление несуществующего ключа — успех: цель достигнута, значения нет. Та же
  // логика, что у сброса уже завершённого звонка (hangupCall, 404 = успех).
  if (!result.ok && /not found|does not exist/i.test(result.error)) return { ok: true, packets: [] };
  return result;
}

/**
 * ДОБАВИТЬ УЧАСТНИКА В ОЧЕРЕДЬ ВХОДЯЩИХ (19.09.2026, просьба владельца «чтобы у
 * новых сотрудников входящие работали всегда, и дальше тоже сами»).
 *
 * ПОЧЕМУ ЭТО МОЖНО, ХОТЯ РЯДОМ НАПИСАНО, ЧТО СОСТАВ ОЧЕРЕДИ CRM НЕ МЕНЯЕТ.
 * Прежнее рассуждение (operatorQueue.ts) верно ровно наполовину: править список
 * участников В КОНФИГУРАЦИИ станции (`queues_details`) действительно можно было
 * бы только через AMI `Command`, которого у CRM намеренно нет. Но `QueueAdd` —
 * не `Command`: это отдельное действие класса `agent`, того самого, которым CRM
 * уже пользуется для `QueuePause`. То есть доступ был всё это время, а запрет
 * относился к другому способу сделать то же самое.
 *
 * ЧТО ИМЕННО ДЕЛАЕТ. Добавляет ДИНАМИЧЕСКОГО участника — в конфигурации станции
 * не появляется ни строки, перезапуск Asterisk или «Apply Config» в FreePBX его
 * сотрут. Это не недостаток, а ровно тот же расклад, что у мобильного плеча
 * (agentMobileFallback.ts): CRM не переписывает конфигурацию, а держит нужное
 * состояние и возвращает его периодическим обходом. Поэтому добавление обязано
 * идти в паре со сторожем, иначе после первого же «Apply Config» всё вернётся к
 * «новый сотрудник не получает входящие», только теперь молча и с видом, что
 * всё настроено.
 *
 * `Paused: false` указан явно: участник, добавленный сразу на паузе, выглядит
 * добавленным и при этом не звонит — худший из возможных исходов для этой задачи.
 */
export async function amiQueueAdd(
  creds: AmiCredentials,
  queue: string,
  iface: string,
  options: { memberName?: string; penalty?: number } = {}
): Promise<AmiResult> {
  const result = await amiAction(creds, "QueueAdd", {
    Queue: queue,
    Interface: iface,
    Paused: "false",
    ...(options.memberName ? { MemberName: options.memberName } : {}),
    ...(options.penalty !== undefined ? { Penalty: options.penalty } : {}),
  });
  // «Already there» — цель достигнута, участник в очереди. Тот же приём, что у
  // amiDbDel выше: успехом считается состояние, а не то, что его создали мы.
  if (!result.ok && /already/i.test(result.error)) return { ok: true, packets: [] };
  return result;
}

/**
 * УБРАТЬ УЧАСТНИКА ИЗ ОЧЕРЕДИ ВХОДЯЩИХ (20.09.2026, решение владельца: «агенты
 * никогда не должны принимать звонки вместо оператора»).
 *
 * Пара к `amiQueueAdd` и того же класса `agent`, то есть доступна ровно так же.
 * Убирает ДИНАМИЧЕСКОГО участника; статического (прописанного в конфигурации
 * станции) `QueueRemove` не тронет, и это правильно: конфигурацию CRM не правит.
 *
 * ОПАСНОСТЬ ЗДЕСЬ ОБРАТНАЯ ДОБАВЛЕНИЮ, поэтому вызывать только по имени
 * конкретного сотрудника CRM. Участник, которого станция знает, а CRM нет, мог
 * быть записан руками по причине, которой CRM не знает (подменный номер,
 * внешний колл-центр) — такого не трогаем никогда. Отбор — в
 * agentIncomingReadiness.ts, здесь только действие.
 *
 * «Not there» считается успехом: цель — состояние «в очереди его нет», а не сам
 * факт удаления. Тот же приём, что у `amiQueueAdd` с «already there».
 */
export async function amiQueueRemove(creds: AmiCredentials, queue: string, iface: string): Promise<AmiResult> {
  const result = await amiAction(creds, "QueueRemove", { Queue: queue, Interface: iface });
  if (!result.ok && /not (there|in)|unable to remove/i.test(result.error)) return { ok: true, packets: [] };
  return result;
}

/**
 * Поставить оператора очереди на паузу или снять с неё.
 *
 * `iface` — как оператор записан в очереди (`Local/1001@from-queue/n`), а не его
 * внутренний номер: очередь FreePBX дозванивается до операторов Local-каналом, и
 * пауза ставится именно на то, что в ней числится.
 */
export async function amiQueuePause(
  creds: AmiCredentials,
  queue: string,
  iface: string,
  paused: boolean,
  reason?: string
): Promise<AmiResult> {
  return amiAction(creds, "QueuePause", {
    Queue: queue,
    Interface: iface,
    Paused: paused ? "true" : "false",
    ...(reason ? { Reason: reason } : {}),
  });
}

/**
 * Состав очередей и состояние операторов.
 *
 * Без имени очереди станция отдаёт все — так и ищется оператор, когда номер очереди
 * заранее неизвестен. Поле при этом НЕ отправляется вовсе, а не отправляется пустым:
 * пустое значение фильтра разные сборки Asterisk трактуют по-разному, и «все
 * очереди» рискует превратиться в «очередь с пустым именем», то есть ни одной.
 */
export async function amiQueueStatus(creds: AmiCredentials, queue?: string): Promise<AmiResult> {
  return amiActionRetrying(creds, "QueueStatus", queue ? { Queue: queue } : {}, { expectsList: true });
}
