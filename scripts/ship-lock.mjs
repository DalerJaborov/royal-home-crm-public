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

export const LOCK_REF = "ship/lock";
export const HEARTBEAT_MS = 5 * 60_000;
export const STALE_MS = 45 * 60_000;
export const POLL_MS = 60_000;

/** Что записано в служебном коммите замка; null — не наш формат. */
export function parseLockMessage(message) {
  const text = String(message ?? "");
  if (!text.startsWith("ship-lock\n")) return null;
  const holder = /^holder: (.+)$/mu.exec(text)?.[1]?.trim();
  const at = Number(/^at: (\d+)$/mu.exec(text)?.[1]);
  return holder && Number.isFinite(at) ? { holder, at } : null;
}

export const lockMessage = (holder, at) => `ship-lock\nholder: ${holder}\nat: ${at}\n`;

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
} = {}) {
  const lockCommit = async (at) => {
    const main = await gh.call("GET", "/{repo}/git/ref/heads/main");
    const mainCommit = await gh.call("GET", `/{repo}/git/commits/${main.object.sha}`);
    const commit = await gh.call("POST", "/{repo}/git/commits", {
      message: lockMessage(holder, at), tree: mainCommit.tree.sha, parents: [main.object.sha],
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
