import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { prisma } from "../db.js";
import { publicAppUrl } from "./crmPublicUrl.js";

/**
 * Вход по отпечатку или лицу (passkey, WebAuthn).
 *
 * ЗАЧЕМ. Пароль на телефоне — самое слабое место входа: его набирают на ходу,
 * поэтому делают коротким и повторяют из других сервисов. Здесь вместо пароля
 * работает то, чем телефон и так разблокируют: отпечаток или лицо.
 *
 * ЧТО ВАЖНО ПОНИМАТЬ ПРО БЕЗОПАСНОСТЬ. Ни отпечаток, ни лицо на сервер не
 * попадают и попасть не могут: они не покидают устройство вообще. Сервер хранит
 * только ОТКРЫТУЮ часть ключа, которой можно лишь проверить подпись — войти по
 * ней нельзя. Поэтому утечка нашей базы не даёт войти ни в один аккаунт, в
 * отличие от утечки паролей.
 *
 * Пароль остаётся: ключ — дополнительный способ, а не замена. Телефон потерян,
 * сломан или сотрудник за чужим компьютером — вход паролем работает как прежде.
 *
 * ПРИВЯЗКА К ДОМЕНУ. Ключ действует только на том домене, где создан: подделать
 * страницу и «поймать» вход нельзя в принципе — браузер просто не отдаст подпись
 * чужому сайту. Отсюда требование к настройкам ниже.
 */

/**
 * Домен, к которому привязываются ключи. Меняется только вместе с адресом CRM —
 * после смены домена все ключи перестанут работать, и сотрудники войдут паролем,
 * а потом привяжут заново. Поэтому берётся из окружения, а не из заголовка
 * запроса: заголовок подделывается, и подмена RP ID — это как раз то, от чего
 * WebAuthn защищает.
 */
/** Глобальный рубильник (Настройки → Система): выключен — сервер отказывает и
 *  входу, и привязке новых устройств, даже если запрос собран мимо интерфейса. */
export async function passkeyLoginEnabled(): Promise<boolean> {
  const settings = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { passkeyLoginEnabled: true },
  });
  return settings?.passkeyLoginEnabled ?? true;
}

/** Вынесено в lib/crmPublicUrl.ts::publicAppUrl (17.09.2026) — второй потребитель,
 *  redirect_uri у TikTok OAuth, был бы иначе собственной копией той же логики. */
function appUrl(): string {
  return publicAppUrl();
}

function rpId(): string {
  try {
    return new URL(appUrl()).hostname;
  } catch {
    return "localhost";
  }
}

function origin(): string {
  return appUrl();
}

const RP_NAME = "Royal Home CRM";

/**
 * Одноразовые случайные строки (challenge), которые устройство подписывает.
 *
 * В памяти процесса, а не в базе: живут секунды и нужны ровно между двумя
 * запросами. Ключ — id сотрудника (для привязки) или сам challenge (для входа,
 * когда мы ещё не знаем, кто идёт). Просроченные подчищаются на каждом обращении,
 * иначе карта росла бы вечно на неудачных попытках.
 */
const challenges = new Map<string, { value: string; expiresAt: number }>();
const CHALLENGE_TTL_MS = 3 * 60_000;
/**
 * Предел на карту заданий. Шаг 1 входа публичный (человек ещё не вошёл), и без
 * предела кто угодно мог бы дёргать его в цикле: чистка по сроку срабатывает
 * только через три минуты, а память процесса растёт всё это время. Лимит по
 * адресу стоит и снаружи (app.ts), это второй рубеж — на случай запросов с
 * разных адресов. Вытесняем самые старые: свежие попытки входа важнее.
 */
const MAX_CHALLENGES = 5_000;

function putChallenge(key: string, value: string): void {
  const now = Date.now();
  for (const [k, v] of challenges) if (v.expiresAt < now) challenges.delete(k);
  while (challenges.size >= MAX_CHALLENGES) {
    const oldest = challenges.keys().next();
    if (oldest.done) break;
    challenges.delete(oldest.value);
  }
  challenges.set(key, { value, expiresAt: now + CHALLENGE_TTL_MS });
}

function takeChallenge(key: string): string | null {
  const entry = challenges.get(key);
  challenges.delete(key);
  if (!entry || entry.expiresAt < Date.now()) return null;
  return entry.value;
}

/** Только для тестов: сбросить состояние между прогонами. */
export function resetPasskeyChallenges(): void {
  challenges.clear();
}

/** Шаг 1 привязки: что устройство должно подписать. */
export async function buildRegistrationOptions(agentId: string) {
  const agent = await prisma.agent.findUnique({
    where: { id: agentId },
    select: { id: true, fullName: true, phone: true, passkeys: { select: { credentialId: true } } },
  });
  if (!agent) return null;

  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: rpId(),
    // Постоянный идентификатор сотрудника, а не случайный при каждой привязке:
    // иначе один и тот же человек выглядит для телефона разными людьми, и в
    // списке паролей устройства копится по записи «Royal Home CRM» на каждую
    // привязку. Ключи от этого не ломаются — вход ищет их по credentialId.
    userID: new TextEncoder().encode(agent.id),
    userName: agent.phone,
    userDisplayName: agent.fullName,
    // Уже привязанные ключи — чтобы устройство не предложило завести второй такой же.
    excludeCredentials: agent.passkeys.map((p) => ({ id: p.credentialId })),
    authenticatorSelection: {
      // Ключ живёт в самом телефоне (отпечаток/лицо), а не на внешнем USB-токене:
      // именно этого просил владелец, и именно это есть у каждого сотрудника.
      //
      // residentKey: "required" — не «желательно». На экране входа телефон не
      // вводят: устройство само должно вспомнить, чей ключ хранит. Такое умеет
      // только «обнаружимый» ключ (discoverable). При "preferred" часть
      // устройств — заметнее всего Windows Hello — сохраняла обычный ключ, и
      // кнопка «Войти по отпечатку» у такого сотрудника не находила ничего.
      residentKey: "required",
      // userVerification: "required" — то же самое по сути: нам нужен именно
      // отпечаток или лицо, а не «ключ на месте, кнопку нажали». Вход по ключу
      // намеренно не спрашивает код 2FA (см. routes/auth.ts) ровно потому, что
      // биометрия уже проверена. При "preferred" устройство имело право её не
      // спрашивать — и тогда обещание «два фактора» переставало быть правдой.
      userVerification: "required",
    },
  });
  putChallenge(`reg:${agentId}`, options.challenge);
  return options;
}

/** Шаг 2 привязки: проверить подпись и сохранить открытую часть ключа. */
export async function confirmRegistration(
  agentId: string,
  response: Parameters<typeof verifyRegistrationResponse>[0]["response"],
  deviceName?: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const expectedChallenge = takeChallenge(`reg:${agentId}`);
  if (!expectedChallenge) return { ok: false, error: "Время привязки истекло — начните заново" };

  try {
    const verification = await verifyRegistrationResponse({
      response,
      expectedChallenge,
      expectedOrigin: origin(),
      expectedRPID: rpId(),
    });
    if (!verification.verified || !verification.registrationInfo) {
      return { ok: false, error: "Устройство не подтвердило ключ" };
    }
    const { credential } = verification.registrationInfo;
    await prisma.passkey.create({
      data: {
        agentId,
        credentialId: credential.id,
        // Открытый ключ приходит бинарным — храним в base64url, как и его id.
        publicKey: Buffer.from(credential.publicKey).toString("base64url"),
        counter: BigInt(credential.counter),
        transports: credential.transports?.join(",") ?? null,
        deviceName: deviceName?.slice(0, 80) || null,
      },
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Не удалось привязать ключ" };
  }
}

/** Шаг 1 входа: случайная строка, которую подпишет устройство. */
export async function buildAuthenticationOptions() {
  const options = await generateAuthenticationOptions({
    rpID: rpId(),
    // Требуем именно проверку человека (отпечаток/лицо/PIN устройства), см.
    // разбор в buildRegistrationOptions: на этом держится отказ от кода 2FA.
    userVerification: "required",
  });
  // Ключ по самому challenge: кто именно входит, узнаём только на втором шаге —
  // устройство само сообщит, каким ключом подписало.
  putChallenge(`auth:${options.challenge}`, options.challenge);
  return options;
}

/**
 * Шаг 2 входа: проверить подпись и вернуть сотрудника.
 *
 * Возвращает null при любой неудаче — вызывающий код отвечает одинаково, не
 * подсказывая, что именно не сошлось: существование ключа тоже не должно
 * утекать наружу.
 */
export async function verifyAuthentication(
  challenge: string,
  response: Parameters<typeof verifyAuthenticationResponse>[0]["response"]
): Promise<{ agentId: string } | null> {
  const expectedChallenge = takeChallenge(`auth:${challenge}`);
  if (!expectedChallenge) return null;

  const stored = await prisma.passkey.findUnique({
    where: { credentialId: response.id },
    select: {
      id: true,
      publicKey: true,
      counter: true,
      transports: true,
      credentialId: true,
      agent: { select: { id: true, isActive: true } },
    },
  });
  // Условие ровно то же, что у входа паролем (routes/auth.ts): отключённая учётка
  // не входит никак. Заморозка сюда НЕ входит намеренно — она запрещает выдачу
  // новой работы, а не работу вообще (см. agents.ts, /freeze): замороженный
  // сотрудник дописывает историю по своим клиентам. Раньше frozenAt проверялся
  // здесь и не проверялся при входе паролем, и получалась несуразица: кнопка
  // «Войти по отпечатку» у замороженного молча не срабатывала, а пароль пускал.
  if (!stored || !stored.agent.isActive) return null;

  try {
    // requireUserVerification библиотека держит включённым по умолчанию: подпись
    // без подтверждённой биометрии здесь не пройдёт. Поэтому и в задании выше
    // стоит "required" — иначе устройство имело право её не спрашивать, человек
    // проходил диалог, а вход всё равно отказывал уже на сервере.
    const verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge,
      expectedOrigin: origin(),
      expectedRPID: rpId(),
      credential: {
        id: stored.credentialId,
        publicKey: new Uint8Array(Buffer.from(stored.publicKey, "base64url")),
        counter: Number(stored.counter),
        transports: stored.transports ? (stored.transports.split(",") as never) : undefined,
      },
    });
    if (!verification.verified) return null;

    // Счётчик подписей растёт с каждым входом. Значение меньше сохранённого —
    // признак того, что ключ скопировали: настоящее устройство так не умеет.
    // Библиотека это проверяет сама, здесь просто сохраняем новое значение.
    await prisma.passkey.update({
      where: { id: stored.id },
      data: { counter: BigInt(verification.authenticationInfo.newCounter), lastUsedAt: new Date() },
    });
    return { agentId: stored.agent.id };
  } catch {
    return null;
  }
}

/** Список привязанных устройств для профиля. */
export async function listPasskeys(agentId: string) {
  return prisma.passkey.findMany({
    where: { agentId },
    select: { id: true, deviceName: true, createdAt: true, lastUsedAt: true },
    orderBy: { createdAt: "desc" },
    take: 20,
  });
}

/** Отвязать устройство (потеряно, продано, сменилось). */
export async function removePasskey(agentId: string, id: string): Promise<boolean> {
  const result = await prisma.passkey.deleteMany({ where: { id, agentId } });
  return result.count > 0;
}
