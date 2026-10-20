#!/usr/bin/env node
/**
 * Разбор разговоров робота-консультанта: забирает с прода сессии LiveVoiceSession
 * (только чтение) и печатает расшифровку с признаками возможных ошибок.
 *
 *   node scripts/robot-calls-review.mjs            новые с прошлого запуска
 *   node scripts/robot-calls-review.mjs --all 24   за последние 24 часа, метку не двигает
 *   node scripts/robot-calls-review.mjs --peek     новые, но метку не двигает
 *
 * Метка «прочитано до» — ~/.claude/robot-calls-review.last (вне репозитория).
 * Доступ — ssh-алиас rh-vps (как в docs/deploy), база в контейнере royalhome-crm-postgres-1.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { formatCallMetrics, formatSummary, parseCallMetrics, stripCallMetrics, summarizeCallMetrics } from "./robot-call-metrics.mjs";

const args = process.argv.slice(2);
const allIdx = args.indexOf("--all");
const hours = allIdx >= 0 ? Number(args[allIdx + 1] ?? 24) : null;
const peek = args.includes("--peek") || hours !== null;
const markFile = join(homedir(), ".claude", "robot-calls-review.last");

let since;
if (hours !== null) {
  since = new Date(Date.now() - hours * 3600_000).toISOString();
} else if (existsSync(markFile)) {
  since = readFileSync(markFile, "utf8").trim();
} else {
  since = new Date(Date.now() - 24 * 3600_000).toISOString();
}
if (Number.isNaN(Date.parse(since))) {
  console.error(`Метка времени испорчена: ${since}`);
  process.exit(2);
}
// В SQL попадает только строго разобранная дата, а не сырой текст из файла.
since = new Date(since).toISOString();

const sql = `
select row_to_json(t) from (
  select id, "channelId", "startedAt", "endedAt", direction, "callerNumber", "endedReason",
         "promptVersion", provider, "recordingUrl", coalesce(transcript,'') as transcript,
         round(extract(epoch from ("endedAt" - "startedAt"))) as sec
  from "LiveVoiceSession"
  where "startedAt" > '${since}'::timestamptz
  order by "startedAt"
  limit 200
) t;`;

let raw;
try {
  raw = execFileSync(
    "ssh",
    ["-o", "ConnectTimeout=15", "-o", "BatchMode=yes", "rh-vps",
      "docker exec -i royalhome-crm-postgres-1 psql -U royalhome_crm -d royal_home_crm -At"],
    { input: sql, encoding: "utf8", timeout: 60_000 }
  );
} catch (e) {
  console.error(`Не удалось прочитать прод: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
}

const rows = raw.split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l));

/** Признаки, на которые смотрит проверяющий. Только подсказки — решает человек. */
function flags(r) {
  const out = [];
  const t = r.transcript;
  const clientLines = t.split("\n").filter((l) => l.startsWith("Клиент:"));
  const botLines = t.split("\n").filter((l) => l.startsWith("Бот:"));
  if (!t.trim()) out.push("пустая расшифровка");
  if (r.endedReason && r.endedReason !== "channel_ended") out.push(`конец: ${r.endedReason}`);
  if (r.sec != null && r.sec < 10) out.push("очень короткий (<10 с)");
  if (botLines.length && !clientLines.length) out.push("клиент молчал");
  if (/\d[\d\s]{4,}\s*(сомони|TJS|\$|долл)/i.test(t)) out.push("бот называл сумму — сверить с объектом");
  if (/(гарантир|обещаю|точно скидк|без комисси)/i.test(t)) out.push("обещание — проверить");
  if (/[A-Za-z]{4,}\s[A-Za-z]{4,}\s[A-Za-z]{4,}/.test(clientLines.join(" "))) {
    out.push("мусорная расшифровка клиента (латиница)");
  }
  if (/(прерва|не расслыш|повторите)/i.test(t)) out.push("робот переспрашивал");
  return out;
}

if (!rows.length) {
  console.log(`Новых разговоров робота нет (с ${since}).`);
} else {
  const metrics = [];
  for (const r of rows) {
    const m = parseCallMetrics(r.transcript);
    metrics.push(m);
    r.transcript = stripCallMetrics(r.transcript);
    const f = flags(r);
    console.log(
      `\n=== ${r.startedAt} | ${r.direction ?? "-"} | ${r.callerNumber ?? "-"} | ${r.sec ?? "?"} с | ${r.provider ?? "-"} | ${r.endedReason ?? "идёт"} | промт ${r.promptVersion ?? "-"}`
    );
    console.log(`id ${r.id}${r.recordingUrl ? " | запись есть" : " | записи нет"}`);
    console.log(`ЗАМЕРЫ: ${formatCallMetrics(m)}`);
    if (f.length) console.log(`ПРИЗНАКИ: ${f.join("; ")}`);
    console.log(r.transcript || "(расшифровки нет)");
  }
  console.log(`\nИтого разговоров: ${rows.length}`);
  console.log(formatSummary(summarizeCallMetrics(metrics)));
}

if (!peek) {
  mkdirSync(dirname(markFile), { recursive: true });
  const lastRaw = rows.length ? rows[rows.length - 1].startedAt : since;
  // startedAt в базе без пояса и означает UTC: без «Z» JS прочтёт его как местное время (сдвиг на 5 ч).
  const lastUtc = /(Z|[+-]dd:?dd)$/.test(lastRaw) ? lastRaw : `${lastRaw}Z`;
  writeFileSync(markFile, new Date(new Date(lastUtc).getTime() + 1000).toISOString());
}
