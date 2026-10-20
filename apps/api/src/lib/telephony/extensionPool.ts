import { prisma } from "../../db.js";
import { listEndpointsRetrying, loadAriCredentials, type AriEndpoint } from "./ariClient.js";
import { amiDbPut, loadAmiCredentials, type AmiCredentials } from "./amiClient.js";
import { logSystemError } from "../systemError.js";

/**
 * Выдача внутренних номеров сотрудникам.
 *
 * Как это устроено и почему именно так. Номера физически живут на АТС (FreePBX), и
 * создать их оттуда может только администратор АТС. Поэтому номера заводятся с
 * запасом — пул 1003–1020, — а CRM при появлении нового сотрудника берёт из пула
 * первый свободный и закрепляет за ним. Свободный — это тот, который есть на АТС и
 * ещё ни за кем не записан в CRM.
 *
 * Альтернативой было бы создавать эндпоинт на АТС из CRM через её API. Отказались
 * сознательно: это лишний узел, который отказывает молча и в самый неподходящий
 * момент — при заведении сотрудника. Пул же не может «не сработать»: либо свободный
 * номер есть, либо его нет, и тогда об этом честно сообщается директору.
 *
 * Когда пул кончится, администратор добавляет на АТС следующую пачку номеров, и они
 * начинают раздаваться сами — правки кода не нужны.
 */

/** Номера, которые не раздаём автоматически: заведены до появления пула и могут быть
 *  заняты тестовым софтфоном или аппаратом на ресепшене.
 *
 *  «Не раздаём автоматически» — это НЕ «запрещено». Вручную такой номер назначить
 *  можно: на живой станции 1001 закреплён за оператором входящих, и запрет ломал бы
 *  правильную настройку. Резерв защищает только от случайной автовыдачи. */
const RESERVED_EXTENSIONS = new Set(["1001", "1002"]);

/** Почему список номеров с АТС получить не удалось. */
export type ExtensionPoolProblem = "телефония не настроена" | "АТС недоступна";

export interface ExtensionPool {
  /** Внутренние номера, заведённые на АТС (транки отфильтрованы). */
  all: string[];
  /** Свободные для автовыдачи: есть на АТС, не в резерве, ни за кем не закреплены. */
  free: string[];
  /** Заполнено, если АТС не ответила — тогда `all`/`free` пусты и о них нельзя судить. */
  problem?: ExtensionPoolProblem;
}

/**
 * Единственное место, где читается состав пула. Всё остальное (автовыдача, проверка
 * номера, введённого руками, подсказка свободных номеров в интерфейсе) обязано ходить
 * сюда: разъехавшиеся копии этой логики — это два сотрудника на одном номере,
 * а такую поломку замечают недели через две.
 *
 * Никогда не бросает исключение: недоступная АТС не должна ронять ни заведение
 * сотрудника, ни экран настроек.
 */
export async function readExtensionPool(): Promise<ExtensionPool> {
  const creds = await loadAriCredentials();
  if (!creds) return { all: [], free: [], problem: "телефония не настроена" };

  let endpoints: AriEndpoint[];
  try {
    endpoints = await listEndpointsRetrying(creds);
  } catch (err) {
    // До 22.09.2026 отказ доходил до экрана Настроек как голое «АТС недоступна»
    // и терялся насовсем: не заводился новый сотрудник, а разбираться, что
    // именно ответила станция (или не ответила вовсе), можно было только
    // переспросив владельца в моменте.
    void logSystemError(
      "telephony",
      `Пул внутренних номеров — АТС недоступна: ${err instanceof Error ? err.message : String(err)}`, { dedupKey: "Пул внутренних номеров — АТС недоступна: …" }
    );
    return { all: [], free: [], problem: "АТС недоступна" };
  }

  const taken = new Set(
    (
      await prisma.agent.findMany({
        where: { sipExtension: { not: null } },
        select: { sipExtension: true },
      })
    ).map((a) => a.sipExtension as string)
  );

  const all = endpoints
    .map((e) => e.resource)
    // Только внутренние номера: в этом же списке лежат транки («out»), звонить с
    // которых сотрудник не должен и уж тем более не должен получить такой «номер».
    .filter((r) => /^\d{3,5}$/.test(r))
    .sort();

  const free = all.filter((r) => !RESERVED_EXTENSIONS.has(r)).filter((r) => !taken.has(r));
  return { all, free };
}

export interface ExtensionAssignment {
  extension: string | null;
  /** Почему номер не выдан — для журнала и для честного сообщения директору. */
  reason?: ExtensionPoolProblem | "свободных номеров нет";
}

/**
 * Первый свободный внутренний номер или null. Никогда не бросает исключение:
 * заведение сотрудника не должно падать из-за недоступной АТС — человек нужен в
 * системе сразу, а номер ему можно проставить и позже.
 */
export async function pickFreeExtension(): Promise<ExtensionAssignment> {
  const pool = await readExtensionPool();
  if (pool.problem) return { extension: null, reason: pool.problem };
  if (pool.free.length === 0) return { extension: null, reason: "свободных номеров нет" };
  return { extension: pool.free[0] };
}

/** Сколько свободных номеров показываем в подсказке: список должен помогать выбрать,
 *  а не превращаться в простыню на весь экран. */
const FREE_HINT_LIMIT = 12;

export type ExtensionCheck =
  /** Сохранять можно. `warning` — «сохранили, но проверить не смогли». */
  | { ok: true; warning?: string }
  /** Сохранять нельзя, `error` показывается директору как есть. */
  | { ok: false; error: string };

/**
 * Проверка внутреннего номера, вписанного руками (заведение сотрудника с явным
 * номером и правка карточки).
 *
 * Зачем: автовыдача берёт номер из пула и не может ошибиться, а поле ввода принимало
 * что угодно. Опечатка сохранялась молча, и звонки этому сотруднику просто не
 * доходили — без единого следа о причине. Второй случай хуже: один номер на двоих
 * ломает связь обоим сразу.
 *
 * ЧЕГО ЗДЕСЬ СОЗНАТЕЛЬНО НЕ ДЕЛАЕМ — не блокируем сохранение, когда АТС молчит.
 * Тот же принцип, что у автовыдачи («отказ телефонии не критичен — человек всё равно
 * заводится»): директор обязан иметь возможность поправить карточку ночью, когда
 * станция в офисе выключена. Вместо отказа возвращаем предупреждение.
 *
 * @param agentId правящийся сотрудник — его собственный номер конфликтом не считается.
 */
export async function checkManualExtension(extension: string, agentId?: string): Promise<ExtensionCheck> {
  // Сначала занятость: она видна по своей базе и работает даже при мёртвой АТС.
  const holder = await prisma.agent.findFirst({
    where: { sipExtension: extension, ...(agentId ? { id: { not: agentId } } : {}) },
    select: { fullName: true },
  });
  if (holder) {
    return {
      ok: false,
      error: `Внутренний номер ${extension} уже закреплён за сотрудником ${holder.fullName}. Сначала освободите номер у него или выберите другой.`,
    };
  }

  const pool = await readExtensionPool();
  if (pool.problem) {
    return {
      ok: true,
      warning: `Номер ${extension} сохранён, но проверить его на АТС не удалось: ${pool.problem}. Если такого номера на станции нет, звонки по нему не дойдут.`,
    };
  }

  if (!pool.all.includes(extension)) {
    const hint = pool.free.length
      ? ` Свободны: ${pool.free.slice(0, FREE_HINT_LIMIT).join(", ")}.`
      : " Свободных номеров на станции сейчас нет — их добавляет администратор АТС.";
    return { ok: false, error: `На АТС нет внутреннего номера ${extension}.${hint}` };
  }

  // Номер есть на станции и ни за кем не числится. Резервные (1001/1002) сюда попадают
  // намеренно: вручную их назначать можно — см. комментарий у RESERVED_EXTENSIONS.
  return { ok: true };
}

export interface ExtensionStatus {
  extension: string;
  /** true — телефон зарегистрирован на АТС и способен принимать звонки. */
  online: boolean;
}

export interface ExtensionStatusReport {
  /** Ключ — имя аппарата на станции: внутренний номер (`1004`) или браузерная
   *  трубка (`rh-web-1004`). Отсутствие ключа = такого аппарата на станции НЕТ,
   *  но судить об этом можно только когда `problem` пуст. */
  statuses: Map<string, ExtensionStatus>;
  /** Заполнено, если станция не ответила — тогда `statuses` пуста и «нет на АТС»
   *  от «не знаем» не отличить. */
  problem?: ExtensionPoolProblem;
}

/**
 * Состояние телефонов по именам аппаратов — чтобы в Настройках → Сотрудники было
 * видно не только «номер выдан», но и «трубка на связи». Без этого директор узнавал
 * бы о неподключённом софтфоне только когда агент не может позвонить.
 *
 * Тем же ответом закрывается вопрос про браузерный аппарат (`rh-web-<номер>`):
 * заведён ли он на станции вообще и зарегистрирован ли прямо сейчас. Второго
 * механизма опроса для него не заводим — станция одна, и список эндпоинтов у неё
 * тоже один.
 *
 * У chan_sip состояние «unknown» означает «заведён, но ни разу не регистрировался» —
 * для сотрудника это то же самое, что «не подключён», поэтому онлайном считается
 * только явный «online».
 */
export async function getExtensionStatuses(): Promise<ExtensionStatusReport> {
  const creds = await loadAriCredentials();
  const statuses = new Map<string, ExtensionStatus>();
  if (!creds) return { statuses, problem: "телефония не настроена" };
  try {
    for (const e of await listEndpointsRetrying(creds)) {
      statuses.set(e.resource, { extension: e.resource, online: e.state === "online" });
    }
  } catch {
    // АТС недоступна — возвращаем пустую карту с причиной: экран сотрудников обязан
    // открываться и без телефонии, просто без отметок «на связи».
    return { statuses, problem: "АТС недоступна" };
  }
  return { statuses };
}

/**
 * ЗАПИСЬ РАЗГОВОРОВ У ДОБАВОЧНОГО — ВКЛЮЧИТЬ ВСЕГДА (21.09.2026, разбор: у пула
 * «Резерв» (1012–1020), из которого этот файл выдаёт номера новым сотрудникам,
 * `AMPUSER/<ext>/recording/{in,out}/external` заведён администратором станции как
 * `dontcare` — записи звонков у таких добавочных просто нет, ни исходящих, ни
 * входящих. Просьба владельца: «включить всегда у любого нового сотрудника».
 *
 * ЕДИНСТВЕННОЕ МЕСТО, ГДЕ ЭТО ДЕЛАЕТСЯ — как и readExtensionPool выше: вызывается
 * и из автовыдачи (routes/agents.ts, создание сотрудника), и из ручного назначения
 * номера (тот же файл, PATCH), и из сверки сторожа (probeExtensionRecording,
 * stationHealth.ts), которая ловит расхождение, если станцию потом поправили руками
 * или стёрли значение «Apply Config» в FreePBX.
 *
 * КЛЮЧ И ЗНАЧЕНИЕ — ТЕ ЖЕ, ЧТО УЖЕ БЫЛИ РУЧНОЙ ПРАКТИКОЙ (см.
 * docs/archive/telephony-review-2026-08-13.md, таблица «доступные DBPut без
 * Command»): `AMPUSER/<ext>/recording/in/external` и `.../out/external`, значение
 * `always`. Если сопровождающий станции найдёт, что правильный способ — правка
 * таблицы FreePBX, а не AstDB напрямую через AMI, это меняется здесь и только
 * здесь.
 *
 * Никогда не бросает исключение: недоступная АТС не должна ронять выдачу номера
 * сотруднику — он нужен в системе сразу, а сверка сторожа догонит расхождение на
 * ближайшем 15-минутном тике.
 */
export const EXTENSION_RECORDING_KEYS = ["recording/in/external", "recording/out/external"] as const;
export const EXTENSION_RECORDING_VALUE = "always";

export interface ExtensionRecordingResult {
  ok: boolean;
  /** Что не удалось — для журнала и для сторожа; выдачу номера этим не роняем. */
  error?: string;
}

export async function ensureExtensionRecording(
  extension: string,
  creds?: AmiCredentials | null
): Promise<ExtensionRecordingResult> {
  try {
    const credentials = creds ?? (await loadAmiCredentials());
    if (!credentials) return { ok: false, error: "телефония не настроена" };

    const failures: string[] = [];
    for (const key of EXTENSION_RECORDING_KEYS) {
      const written = await amiDbPut(credentials, "AMPUSER", `${extension}/${key}`, EXTENSION_RECORDING_VALUE);
      if (!written.ok) failures.push(`${key}: ${written.error}`);
    }
    if (failures.length > 0) {
      const error = failures.join("; ");
      void logSystemError("telephony", `Запись разговоров у добавочного ${extension} не включена: ${error}`, { dedupKey: "Запись разговоров у добавочного … не включена: …" });
      return { ok: false, error };
    }
    return { ok: true };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    void logSystemError("telephony", `Включение записи у добавочного ${extension} сорвалось: ${error}`, { dedupKey: "Включение записи у добавочного … сорвалось: …" });
    return { ok: false, error };
  }
}
