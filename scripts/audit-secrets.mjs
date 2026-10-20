#!/usr/bin/env node
/**
 * СТОРОЖ СЕКРЕТОВ И НОМЕРОВ КЛИЕНТОВ (владелец 20.10.2026: «чтобы туда ничего
 * конфиденциального никогда не попало — ни от тебя, ни от Codex»).
 *
 * Скан всей истории 20.10.2026 (gitleaks, 5837 коммитов): ни одного боевого
 * ключа, ни одного .env/ключа SSH/дампа базы — но в docs/ лежали настоящие
 * номера клиентов и личные мобильные сотрудников из разборов. Этот сторож
 * держит оба класса закрытыми:
 *
 *  1. СЕКРЕТЫ — везде: приватные ключи, токены OpenAI/Anthropic/Google/Meta/
 *     Telegram/GitHub/Slack/AWS, файлы .env и ключей, присваивание длинного
 *     значения переменной вида *SECRET/*TOKEN/*KEY/*PASSWORD (кроме тестов и
 *     явных заглушек).
 *  2. НОМЕРА ТЕЛЕФОНОВ — в документах (docs/**, *.md, ops/**): настоящий номер
 *     клиента или сотрудника туда не пишется; писать маской «+992•••••3726»
 *     (`--mask-docs` делает это сам). Тесты и код не проверяются: там вымышленные
 *     номера и служебные номера компании.
 *
 * Режимы:
 *   node scripts/audit-secrets.mjs              добавленные строки ветки против origin/main
 *                                                (+ незакоммиченные) — шаг precheck, значит и ship
 *   node scripts/audit-secrets.mjs --staged     то, что уходит в коммит — хук .githooks/pre-commit
 *   node scripts/audit-secrets.mjs --all-files  все отслеживаемые файлы целиком (разовый аудит)
 *   node scripts/audit-secrets.mjs --mask-docs  заменить номера в документах маской
 *
 * Ложная тревога на строке — пометка `secret-scan: allow` в той же строке (с
 * причиной рядом). Найденное значение в вывод НЕ печатается — только файл,
 * строка и вид находки: сторож не должен сам публиковать то, что ловит.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ALLOW_MARK = "secret-scan: allow";

/** Секреты по виду значения — ловятся в любом файле. */
const SECRET_PATTERNS = [
  ["приватный ключ", /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED |PGP )?PRIVATE KEY( BLOCK)?-----/],
  ["ключ Anthropic", /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ["ключ OpenAI", /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{32,}/],
  ["ключ Google", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["токен Meta", /(?<![A-Za-z0-9+/])EAA[A-Za-z0-9]{60,}/],
  ["токен Telegram-бота", /\b\d{8,10}:AA[A-Za-z0-9_-]{33}\b/],
  ["токен GitHub", /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})/],
  ["токен Slack", /\bxox[abposr]-[A-Za-z0-9-]{10,}/],
  ["ключ AWS", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ["ключ в адресе", /[?&](?:access_token|api_key|apikey|key|token)=[A-Za-z0-9._-]{24,}/i],
];

/** NAME=значение, где имя говорит «секрет». Значение-заглушка — не находка. */
const ASSIGN =
  /\b([A-Z][A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY|ENCRYPTION_KEY|ACCESS_KEY|AUTH_KEY))\b["']?\s*[:=]\s*["']?([^\s"'`,;)}]+)/;
const PLACEHOLDER =
  /^(?:change-?me|example|placeholder|your[-_]|xxx|\*{3,}|<|\$\{|\$\(|\$[A-Z_]|process\.env|env\.|secrets\.|vars\.|undefined|null|true|false|new\b|[/[(]|test|ci-|stand-|replay|ship-test|visual|dummy|fake|redacted|0123456789abcdef|(.)\1{15,}$)|(?:secret|stand|local|dev|test|replay|visual)[-_]/i;

/** Номер телефона: с кодом страны или девять цифр с кодом оператора Таджикистана. */
const PHONE = /(?<![\w+•])(?:(?:\+|00)?992[\s-]?)?\(?(\d{2})\)?[\s-]?(\d{3})[\s-]?(\d{2})[\s-]?(\d{2})(?![\w•])/g;
const OPERATOR_CODES = new Set([
  "00", "01", "10", "11", "12", "17", "18", "20", "30", "40", "41", "44", "50", "51", "55",
  "70", "77", "80", "81", "88", "90", "91", "92", "93", "94", "95", "98", "99",
]);
/** Вымышленные номера тестов и сида и открытый городской номер компании. */
const KNOWN_SAFE_NUMBERS = new Set([
  "900000000", "900000001", "900000002", "901234567", "000000000", "987654321", "900112233",
  "931234567", "123456789", "111111111", "999999999",
  "446501414", // городской номер агентства — публичный, на сайте и в объявлениях
]);
/** Девять цифр подряд в такой строке — скорее хеш или номер правки, чем телефон. */
const HASH_CONTEXT = /(?:коммит|commit|\bsha\b|hash|хеш|\bid\b|tree=|\bmain\b|git (?:show|log|diff)|\d\^|#\d)/i;

const FORBIDDEN_FILE =
  /(?:^|\/)(?:\.env(?!(?:\.[^/]+)*\.example$)(?:\.[^/]+)*|id_rsa|id_ed25519|id_ecdsa)$|\.(?:pem|key|p12|pfx|keystore|jks|dump)$|\.sql\.gz$/i;

export function isDocPath(file) {
  if (/(?:^|\/)node_modules\//.test(file)) return false;
  // Карту собирает программа из кода (номера в ней — из кода, где им и место).
  if (/^docs\/product-/.test(file)) return false;
  // Конфиги станции и сервера (ops/, не .md) — боевые номера там нужны по делу.
  if (/^ops\//.test(file)) return /\.md$/i.test(file);
  return /^docs\//.test(file) || /\.md$/i.test(file);
}

function isTestPath(file) {
  return /(?:^|\/)(?:tests?|__tests__|e2e)\//.test(file) || /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file);
}

/** Находки секретов в одной строке. */
export function findSecrets(line, file) {
  if (line.includes(ALLOW_MARK)) return [];
  // Картинка, вшитая в HTML (data:…;base64,), похожа на что угодно — это не ключ.
  if (/;base64,/.test(line) && !/PRIVATE KEY/.test(line)) return [];
  const out = [];
  for (const [kind, re] of SECRET_PATTERNS) if (re.test(line)) out.push(kind);
  if (!isTestPath(file) && !/\.example$/.test(file)) {
    const m = ASSIGN.exec(line);
    if (m && m[2].length >= 16 && !PLACEHOLDER.test(m[2])) out.push(`значение ${m[1]}`);
  }
  return out;
}

function isRealPhone(match, digits, operator, line) {
  if (KNOWN_SAFE_NUMBERS.has(digits)) return false;
  // Учётки сида (+992 900 000 0NN) и круглые числа — цены, суммы, порты.
  if (/^(?:9000000\d\d|0000000\d\d|\d{4}0{5})$/.test(digits)) return false;
  // Имя файла записи звонка (`out-…-930001001-….wav`) — номер внутри имени, маска его сломает.
  if (/\.(?:wav|mp3|ogg)\b/.test(line) && new RegExp(`-${digits}-`).test(line)) return false;
  const hasCountry = /^(?:\+|00)?992/.test(match);
  if (hasCountry) return true;
  if (!OPERATOR_CODES.has(operator)) return false;
  // Девять цифр подряд без кода страны рядом с «коммит»/«id» — это не номер.
  if (/^\d{9}$/.test(match) && HASH_CONTEXT.test(line)) return false;
  return true;
}

/** Настоящие (не вымышленные) номера телефонов в строке. */
export function findPhones(line) {
  if (line.includes(ALLOW_MARK)) return [];
  const out = [];
  for (const m of line.matchAll(PHONE)) {
    if (isRealPhone(m[0], m[1] + m[2] + m[3] + m[4], m[1], line)) out.push(m[0]);
  }
  return out;
}

/** «+992 93 000 10 43» → «+992•••••1043». Строки с пометкой не трогаются. */
export function maskPhones(text) {
  return text
    .split("\n")
    .map((line) =>
      line.includes(ALLOW_MARK)
        ? line
        : line.replace(PHONE, (whole, a, b, c, d) => (isRealPhone(whole, a + b + c + d, a, line) ? `+992•••••${c}${d}` : whole))
    )
    .join("\n");
}

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 1 << 28 });
}

/** Добавленные строки из unified-диффа: [{file, line, text}]. */
export function addedLines(diff) {
  const out = [];
  let file = null;
  let lineNo = 0;
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("+++ ")) {
      file = raw === "+++ /dev/null" ? null : raw.slice(6);
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) {
      lineNo = Number(hunk[1]);
      continue;
    }
    if (!file || raw.startsWith("--- ")) continue;
    if (raw.startsWith("+")) out.push({ file, line: lineNo++, text: raw.slice(1) });
    else if (!raw.startsWith("-") && !raw.startsWith("\\")) lineNo++;
  }
  return out;
}

export function scanLines(lines) {
  const findings = [];
  for (const { file, line, text } of lines) {
    for (const kind of findSecrets(text, file)) findings.push({ file, line, kind });
    if (isDocPath(file)) for (const _ of findPhones(text)) findings.push({ file, line, kind: "номер телефона в документе" });
  }
  return findings;
}

export function forbiddenFiles(files) {
  return files.filter((f) => FORBIDDEN_FILE.test(f));
}

function main() {
  const root = git(["rev-parse", "--show-toplevel"]).trim();
  const argv = process.argv.slice(2);
  const tracked = () => git(["ls-files"], root).split("\n").filter(Boolean);

  if (argv.includes("--mask-docs")) {
    let changed = 0;
    for (const file of tracked().filter(isDocPath)) {
      const abs = path.join(root, file);
      if (!existsSync(abs)) continue;
      const before = readFileSync(abs, "utf8");
      if (before.includes("\0")) continue;
      const after = maskPhones(before);
      if (after !== before) {
        writeFileSync(abs, after);
        changed++;
        console.log(`  замаскировано: ${file}`);
      }
    }
    console.log(`Номера скрыты маской в ${changed} файл(ах) документов.`);
    return;
  }

  let lines;
  let forbidden;
  if (argv.includes("--all-files")) {
    lines = [];
    const files = tracked();
    forbidden = forbiddenFiles(files);
    for (const file of files) {
      const abs = path.join(root, file);
      if (!existsSync(abs)) continue;
      const body = readFileSync(abs, "utf8");
      if (body.includes("\0")) continue;
      body.split("\n").forEach((text, i) => lines.push({ file, line: i + 1, text }));
    }
  } else if (argv.includes("--staged")) {
    lines = addedLines(git(["diff", "--cached", "-U0", "--no-color", "--no-ext-diff"], root));
    forbidden = forbiddenFiles(git(["diff", "--cached", "--name-only", "--diff-filter=A"], root).split("\n").filter(Boolean));
  } else {
    let base;
    try {
      base = git(["merge-base", "origin/main", "HEAD"], root).trim();
    } catch {
      console.error("audit:secrets — нет origin/main, сравнивать не с чем (git fetch origin main).");
      process.exit(1);
    }
    lines = addedLines(git(["diff", base, "-U0", "--no-color", "--no-ext-diff"], root));
    forbidden = forbiddenFiles(git(["diff", "--name-only", "--diff-filter=A", base], root).split("\n").filter(Boolean));
  }

  const findings = scanLines(lines);
  if (findings.length === 0 && forbidden.length === 0) {
    console.log("Секретов и номеров клиентов в правке нет.");
    return;
  }
  console.error("\nСТОП: в правку попало то, чего в репозитории быть не должно.\n");
  for (const f of forbidden) console.error(`  ${f} — файл секретов/ключей, в git не кладётся`);
  for (const f of findings) console.error(`  ${f.file}:${f.line} — ${f.kind}`);
  console.error(
    [
      "",
      "Секрет: убрать из файла, хранить в .env на сервере или в Настройках CRM; если он уже",
      "  был закоммичен или запушен — считать его утёкшим и сменить у сервиса.",
      "Номер телефона в документе: писать маской «+992•••••3726» (npm run audit:secrets -- --mask-docs).",
      `Ложная тревога: пометка «${ALLOW_MARK}» в той же строке, с причиной.`,
    ].join("\n")
  );
  process.exit(1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
