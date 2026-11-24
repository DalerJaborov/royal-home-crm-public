/**
 * ОЧЕРЕДЬ ВЫКАТОВ — ЗАМОК НА GITHUB (21.11.2026, владелец: «Сделай так, чтобы никогда такого не было,
 * все по очереди»).
 *
 * Было: очередь держалась на строках RUNNING/QUEUED в общем файле на машине владельца, а их каждый чат
 * писал и читал сам. 21.11 три чата запустили `npm run ship` одновременно: облачные прогоны встали в
 * очередь на одном раннере, каждый ship сводил ветку с уехавшим main заново, и ни один не доезжал.
 *
 * Теперь `npm run ship` сам берёт замок — ссылку `refs/ship/lock` в репозитории GitHub. Создание
 * ссылки атомарно: второй, кто пытается её создать, получает 422 и ЖДЁТ, печатая, кого ждёт. Замок
 * один на всех — с любой машины, из любого чата, облачного или нет. Ссылка не ветка: сторож веток её
 * не видит, сервер выката смотрит только main.
 *
 * Ссылка указывает на служебный коммит (дерево = дерево main, родитель = main), в его сообщении — кто
 * держит и когда последний раз подал признак жизни. Держатель обновляет признак каждые 5 минут; замок
 * без признака жизни дольше 45 минут считается брошенным (ship убили, машина уснула) и снимается.
 * Снимается замок в любом исходе: успех, остановка, ошибка.
 */

import { hostname } from "node:os";

export const LOCK_REF = "ship/lock";
export const HEARTBEAT_MS = 5 * 60_000;
export const STALE_MS = 45 * 60_000;
export const POLL_MS = 60_000;

/** Что записано в служебном коммите замка; null — не наш формат. host/pid — с 24.11, у старых их нет. */
export function parseLockMessage(message) {
  const text = String(message ?? "");
  if (!text.startsWith("ship-lock\n")) return null;
  const holder = /^holder: (.+)$/mu.exec(text)?.[1]?.trim();
  const at = Number(/^at: (\d+)$/mu.exec(text)?.[1]);
  if (!holder || !Number.isFinite(at)) return null;
  const host = /^host: (.+)$/mu.exec(text)?.[1]?.trim() || null;
  const pid = Number(/^pid: (\d+)$/mu.exec(text)?.[1]) || null;
  return host && pid ? { holder, at, host, pid } : { holder, at };
}

export const lockMessage = (holder, at, owner = null) =>
  `ship-lock\nholder: ${holder}\nat: ${at}\n${owner ? `host: ${owner.host}\npid: ${owner.pid}\n` : ""}`;

/** Жив ли процесс на ЭТОЙ машине. EPERM — жив, но чужой; ESRCH — нет такого. */
export function pidAlive(pid, kill = process.kill.bind(process)) {
  try {
    kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
}

/**
 * Замок брошен ЭТОЙ машиной: тот же компьютер, процесс-держатель уже умер (24.11.2026).
 * Ship, убитый снаружи (taskkill /F — mem-guard, закрытый чат), не успевает отпустить замок,
 * и следующий запуск ждал 45 минут собственный труп; за ночь 24.11 так ушло 10 запусков из 28.
 * Чужую машину проверить нельзя — там остаётся правило 45 минут молчания.
 */
export function abandonedHere(held, { host, pid }, alive = pidAlive) {
  return Boolean(held?.host && held.pid && held.host === host && held.pid !== pid && !alive(held.pid));
}

/**
 * Взять замок; ждать, пока занят. Возвращает функцию «отпустить» (без ошибок, повторный вызов —
 * ничего). `gh` — клиент из ship.mjs (`call(method, path, body, options)`).
 */
export async function acquireShipLock(gh, holder, {
  log = console.log,
  sleep = (ms) => new Promise((res) => setTimeout(res, ms)),
  now = () => Date.now(),
  pollMs = POLL_MS,
  staleMs = STALE_MS,
  heartbeatMs = HEARTBEAT_MS,
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
  owner = { host: hostname(), pid: process.pid },
  alive = pidAlive,
} = {}) {
  const lockCommit = async (at) => {
    const main = await gh.call("GET", "/{repo}/git/ref/heads/main");
    const mainCommit = await gh.call("GET", `/{repo}/git/commits/${main.object.sha}`);
    const commit = await gh.call("POST", "/{repo}/git/commits", {
      message: lockMessage(holder, at, owner), tree: mainCommit.tree.sha, parents: [main.object.sha],
    }, { retries: 2 });
    return commit.sha;
  };
  const current = async () => {
    try {
      const ref = await gh.call("GET", `/{repo}/git/ref/${LOCK_REF}`);
      const commit = await gh.call("GET", `/{repo}/git/commits/${ref.object.sha}`);
      return { sha: ref.object.sha, ...(parseLockMessage(commit.message) ?? { holder: "неизвестно", at: 0 }) };
    } catch (err) {
      if (/→ 404/u.test(String(err?.message))) return null;
      throw err;
    }
  };

  let waitedSince = null;
  let mine = null;
  for (;;) {
    const sha = await lockCommit(now());
    try {
      await gh.call("POST", "/{repo}/git/refs", { ref: `refs/${LOCK_REF}`, sha });
      mine = sha;
      break;
    } catch (err) {
      if (!/→ 422/u.test(String(err?.message))) throw err;
    }
    const held = await current();
    if (!held) continue; // отпустили между попытками — сразу снова
    const silentMs = now() - held.at;
    if (abandonedHere(held, owner, alive)) {
      log(`  очередь выкатов: замок «${held.holder}» оставил умерший процесс ${held.pid} на этой машине — снимаю`);
      // Снимаем только этот коммит замка: если его успели переставить, удалять нельзя.
      const again = await current();
      if (again?.sha === held.sha) { try { await gh.call("DELETE", `/{repo}/git/refs/${LOCK_REF}`); } catch { /* уже сняли */ } }
      continue;
    }
    if (silentMs > staleMs) {
      log(`  очередь выкатов: замок «${held.holder}» молчит ${Math.round(silentMs / 60_000)} мин — считаю брошенным, снимаю`);
      try { await gh.call("DELETE", `/{repo}/git/refs/${LOCK_REF}`); } catch { /* уже сняли */ }
      continue;
    }
    if (waitedSince === null) waitedSince = now();
    log(`  очередь выкатов: сейчас выкатывает «${held.holder}» — жду своей очереди (${Math.round((now() - waitedSince) / 60_000)} мин)`);
    await sleep(pollMs);
  }
  log(`  очередь выкатов: замок мой («${holder}») — остальные ждут, пока не закончу`);

  // Признак жизни: новый служебный коммит, ссылка переставляется только с НАШЕГО коммита.
  let beating = false;
  const beat = setIntervalImpl(async () => {
    if (beating || !mine) return;
    beating = true;
    try {
      const held = await current();
      if (held?.sha !== mine) return;
      const next = await lockCommit(now());
      await gh.call("PATCH", `/{repo}/git/refs/${LOCK_REF}`, { sha: next, force: true });
      mine = next;
    } catch {
      /* связь моргнула — следующий признак через 5 минут, до брошенного далеко */
    } finally {
      beating = false;
    }
  }, heartbeatMs);
  beat?.unref?.();

  return async function release() {
    if (!mine) return;
    const was = mine;
    mine = null;
    clearIntervalImpl(beat);
    try {
      const held = await current();
      // Снимаем только СВОЙ замок: брошенным его могли признать и отдать другому.
      if (held?.sha === was) await gh.call("DELETE", `/{repo}/git/refs/${LOCK_REF}`);
    } catch {
      /* не сняли — через 45 минут молчания замок снимет следующий */
    }
  };
}
