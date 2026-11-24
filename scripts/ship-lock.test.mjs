// Очередь выкатов (21.11.2026): замок refs/ship/lock на GitHub — scripts/ship-lock.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { acquireShipLock, parseLockMessage, lockMessage, LOCK_REF } from "./ship-lock.mjs";

/** GitHub в памяти: ссылки и коммиты, ровно те пути, что зовёт замок. */
function fakeGitHub() {
  const refs = new Map([["heads/main", "main0"]]);
  const commits = new Map([["main0", { sha: "main0", message: "main", tree: { sha: "tree0" } }]]);
  let n = 0;
  const calls = [];
  const fail = (status) => { throw new Error(`GitHub X → ${status}: x`); };
  const gh = {
    async call(method, path, body) {
      calls.push(`${method} ${path}`);
      let m;
      if (method === "GET" && (m = /^\/\{repo\}\/git\/ref\/(.+)$/.exec(path))) {
        const sha = refs.get(m[1]);
        return sha ? { object: { sha } } : fail(404);
      }
      if (method === "GET" && (m = /^\/\{repo\}\/git\/commits\/(.+)$/.exec(path))) return commits.get(m[1]) ?? fail(404);
      if (method === "POST" && path === "/{repo}/git/commits") {
        const sha = `c${++n}`;
        commits.set(sha, { sha, message: body.message, tree: { sha: body.tree } });
        return { sha };
      }
      if (method === "POST" && path === "/{repo}/git/refs") {
        const key = body.ref.replace(/^refs\//, "");
        if (refs.has(key)) fail(422);
        refs.set(key, body.sha);
        return {};
      }
      if (method === "PATCH" && (m = /^\/\{repo\}\/git\/refs\/(.+)$/.exec(path))) { refs.set(m[1], body.sha); return {}; }
      if (method === "DELETE" && (m = /^\/\{repo\}\/git\/refs\/(.+)$/.exec(path))) {
        if (!refs.delete(m[1])) fail(404);
        return null;
      }
      throw new Error(`не ждали ${method} ${path}`);
    },
  };
  const hold = (holder, at) => {
    const sha = `held-${holder}`;
    commits.set(sha, { sha, message: lockMessage(holder, at), tree: { sha: "tree0" } });
    refs.set(LOCK_REF, sha);
    return sha;
  };
  return { gh, refs, calls, hold, commits };
}

const quiet = { log: () => {}, setIntervalImpl: () => null, clearIntervalImpl: () => {} };

test("сообщение замка читается обратно; чужой формат — null", () => {
  assert.deepEqual(parseLockMessage(lockMessage("fix/x", 123)), { holder: "fix/x", at: 123 });
  assert.equal(parseLockMessage("обычный коммит"), null);
});

test("свободно — замок мой; отпустил — ссылки нет", async () => {
  const { gh, refs } = fakeGitHub();
  const release = await acquireShipLock(gh, "fix/a", { ...quiet, now: () => 1000 });
  assert.ok(refs.has(LOCK_REF));
  await release();
  assert.equal(refs.has(LOCK_REF), false);
  await release(); // второй раз — ничего
});

test("занято — ждёт и пишет, кого ждёт; освободилось — берёт", async () => {
  const { gh, refs, hold } = fakeGitHub();
  hold("fix/other", 1000);
  const logs = [];
  let sleeps = 0;
  const release = await acquireShipLock(gh, "fix/a", {
    ...quiet, now: () => 2000, log: (l) => logs.push(l),
    sleep: async () => { sleeps += 1; if (sleeps === 2) refs.delete(LOCK_REF); },
  });
  assert.equal(sleeps, 2);
  assert.ok(logs.some((l) => l.includes("сейчас выкатывает «fix/other»")));
  assert.notEqual(refs.get(LOCK_REF), "held-fix/other");
  await release();
});

test("замок молчит дольше предела — считается брошенным и снимается", async () => {
  const { gh, refs, hold } = fakeGitHub();
  hold("fix/dead", 0);
  const logs = [];
  const release = await acquireShipLock(gh, "fix/a", {
    ...quiet, now: () => 46 * 60_000, log: (l) => logs.push(l), sleep: async () => assert.fail("ждать не должен"),
  });
  assert.ok(logs.some((l) => l.includes("считаю брошенным")));
  assert.notEqual(refs.get(LOCK_REF), "held-fix/dead");
  await release();
});

test("отпустить не снимает ЧУЖОЙ замок (свой признали брошенным и отдали другому)", async () => {
  const { gh, refs, hold } = fakeGitHub();
  const release = await acquireShipLock(gh, "fix/a", { ...quiet, now: () => 1000 });
  hold("fix/next", 5000);
  await release();
  assert.equal(refs.get(LOCK_REF), "held-fix/next");
});

test("признак жизни переставляет ссылку только со своего коммита", async () => {
  const { gh, refs, hold } = fakeGitHub();
  let tick = null;
  let t = 1000;
  await acquireShipLock(gh, "fix/a", { ...quiet, now: () => t, setIntervalImpl: (fn) => { tick = fn; return 1; } });
  const first = refs.get(LOCK_REF);
  t = 6 * 60_000;
  await tick();
  assert.notEqual(refs.get(LOCK_REF), first);
  hold("fix/thief", 7000);
  await tick();
  assert.equal(refs.get(LOCK_REF), "held-fix/thief");
});

test("ошибка GitHub, кроме «занято», не глотается", async () => {
  const gh = { call: async () => { throw new Error("GitHub X → 403: нет прав"); } };
  await assert.rejects(acquireShipLock(gh, "fix/a", quiet), /403/);
});

// 24.11.2026: ship убит снаружи (taskkill /F), замок остался; следующий запуск на той же машине
// ждал собственный брошенный замок до 45 минут.
test("замок умершего процесса этой машины снимается сразу, живого или чужой машины — нет", async () => {
  const { abandonedHere, pidAlive } = await import("./ship-lock.mjs");
  const me = { host: "pc", pid: 10 };
  const dead = () => false, alive = () => true;
  assert.equal(abandonedHere({ host: "pc", pid: 7 }, me, dead), true);
  assert.equal(abandonedHere({ host: "pc", pid: 7 }, me, alive), false, "живой сосед на той же машине");
  assert.equal(abandonedHere({ host: "other", pid: 7 }, me, dead), false, "чужую машину не проверить");
  assert.equal(abandonedHere({ host: null, pid: null }, me, dead), false, "старый формат без host/pid");
  assert.equal(pidAlive(1, () => { throw Object.assign(new Error(), { code: "ESRCH" }); }), false);
  assert.equal(pidAlive(1, () => { throw Object.assign(new Error(), { code: "EPERM" }); }), true);
  const parsed = parseLockMessage(lockMessage("b", 5, { host: "pc", pid: 7 }));
  assert.deepEqual(parsed, { holder: "b", at: 5, host: "pc", pid: 7 });
});

test("acquire: брошенный этой машиной замок забирается без 45 минут ожидания", async () => {
  const { gh, refs, commits } = fakeGitHub();
  commits.set("old", { sha: "old", message: lockMessage("ветка", 1_000, { host: "pc", pid: 7 }), tree: { sha: "tree0" } });
  refs.set(LOCK_REF, "old");
  const logs = [];
  const release = await acquireShipLock(gh, "ветка", { log: (s) => logs.push(s), sleep: async () => { throw new Error("ждать не должен"); },
    now: () => 2_000, owner: { host: "pc", pid: 10 }, alive: () => false, setIntervalImpl: () => null, clearIntervalImpl: () => {} });
  assert.notEqual(refs.get(LOCK_REF), "old");
  assert.ok(logs.some((l) => /умерший процесс 7/.test(l)));
  await release();
  assert.equal(refs.has(LOCK_REF), false);
});
