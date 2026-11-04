#!/usr/bin/env node
// Standalone synthetic provider probe. No application imports, DB access or automatic dotenv loading.
import { readFile, open, rename, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parse } from 'dotenv';

const CAP = 2_000_000; // User-authorized $2 ceiling; integer microUSD; reservations are NEVER refunded.
const MAX_INPUT = 4096;
const MAX_OUTPUT = 2048;
const EXPIRES = Date.UTC(2027, 0, 1);
const MODELS = [
  { id: 'gemini-3.1-pro-preview', thinking: 'low', inputCents: 200, outputCents: 1200 },
  { id: 'gemini-3.6-flash', thinking: 'minimal', inputCents: 75, outputCents: 375 },
];
// Standard rates verified 2026-11-03: https://ai.google.dev/gemini-api/docs/pricing
const CASES = [
  { id: 'tg-budget', prompt: 'Ман хона меҷӯям. Буҷетам 650 000 сомонӣ. 2 ҳуҷра лозим, ошёнаи якум не. Хоҳиши маро кӯтоҳ бо суханҳои оддии тоҷикӣ такрор кун. Ҳеҷ чиз илова накун.' },
  { id: 'tg-dates', prompt: 'Пагоҳ соати 14:30 хонаро мебинем. Нарх 720 000 сомонӣ, масоҳат 68 м². Ҳаминро ба муштарӣ бо тоҷикӣ оддӣ навис. Рақамҳо ва вақтро тағйир надеҳ.' },
  { id: 'mixed', prompt: 'Салом, найди 2-комнатную до 550000 сомонӣ, район Сино. Первый этаж не нужен. Коротко повтори требования простыми словами, сохрани смешанный стиль и все ограничения.' },
  { id: 'ru-numbers', prompt: 'Клиент просит квартиру: 3 комнаты, до 980000 сомони, площадь от 75 м². Не предлагать первый и последний этаж. Повтори критерии коротко по-русски, ничего не добавляй.' },
  { id: 'tg-unknown', prompt: 'Нархи хонаи OB-1234 чанд аст? Дар ин санҷиш ба ту нарх дода нашудааст ва ба CRM дастрасӣ надорӣ. Бо тоҷикӣ оддӣ ҷавоб деҳ, рақам насоз.' },
  { id: 'ru-to-tg', prompt: 'Переведи на простой разговорный таджикский без сложных литературных слов: «Показ квартиры завтра в 10:15. Цена 630000 сомони. Если время неудобное, напишите мне». Сохрани все числа.' },
];

function fail(code) { const error = new Error(code); error.safeCode = code; throw error; }
function currentRates() { if (Date.now() < Date.UTC(2026, 10, 3) || Date.now() >= EXPIRES) fail('pricing_expired_or_clock_invalid'); }
function cost(model, input, output) {
  if (![input, output].every(n => Number.isSafeInteger(n) && n >= 0)) fail('invalid_token_count');
  return Number((BigInt(input) * BigInt(model.inputCents) + BigInt(output) * BigInt(model.outputCents) + 99n) / 100n);
}
function options() {
  const args = process.argv.slice(2); const result = { execute: false };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--execute') result.execute = true;
    else if (arg === '--key-from-env') result.keyFromEnv = true;
    else if (arg === '--env-file' || arg === '--output') {
      const value = args[++index]; if (!value || value.startsWith('--')) fail('missing_argument');
      result[arg === '--env-file' ? 'envFile' : 'output'] = resolve(value);
    } else fail('unknown_argument');
  }
  if (result.keyFromEnv && result.envFile) fail('choose_one_key_source');
  if (result.execute && ((!result.envFile && !result.keyFromEnv) || !result.output)) fail('execute_requires_key_source_and_output');
  return result;
}
async function atomicJson(path, value) {
  const temp = `${path}.${process.pid}.tmp`;
  const file = await open(temp, 'wx', 0o600);
  try { await file.writeFile(`${JSON.stringify(value, null, 2)}\n`); await file.sync(); } finally { await file.close(); }
  await rename(temp, path);
}
async function jsonResponse(response, limit) {
  if (!response.body) fail('empty_response');
  const reader = response.body.getReader(); const chunks = []; let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.length; if (size > limit) fail('response_too_large'); chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
async function request(key, model, method, body, timeout, limit) {
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:${method}`, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(timeout),
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key }, body: JSON.stringify(body),
  });
  if (!response.ok) { await response.body?.cancel(); fail(`http_${response.status}`); }
  return jsonResponse(response, limit);
}
function validateLedger(ledger) {
  if (ledger.version !== 1 || ledger.capMicroUsd !== CAP || !Array.isArray(ledger.attempts)) fail('invalid_existing_ledger');
  const seen = new Set(); let sum = 0;
  for (const row of ledger.attempts) {
    const id = `${row.model}/${row.caseId}`;
    if (seen.has(id) || !MODELS.some(m => m.id === row.model) || !CASES.some(c => c.id === row.caseId)
      || !Number.isSafeInteger(row.reservedMicroUsd) || row.reservedMicroUsd < 0) fail('invalid_existing_ledger');
    seen.add(id); sum += row.reservedMicroUsd;
  }
  if (!Number.isSafeInteger(sum) || sum !== ledger.reservedMicroUsd || sum > CAP) fail('invalid_existing_ledger');
}
async function main() {
  const args = options(); currentRates();
  if (!args.execute) {
    console.log(JSON.stringify({ mode: 'dry', networkCalls: 0, readsCredentials: false, capUsd: 2,
      models: MODELS.map(({id, thinking}) => ({id, thinking})), cases: CASES, maxInputTokens: MAX_INPUT, maxOutputTokens: MAX_OUTPUT }, null, 2));
    return;
  }
  if ([args.output, `${args.output}.ledger.json`, `${args.output}.lock`].some(path => path.toLowerCase() === args.envFile?.toLowerCase())
    || args.output.toLowerCase().endsWith('.env')) fail('unsafe_output_path');
  const ledgerPath = `${args.output}.ledger.json`; const lockPath = `${args.output}.lock`;
  let lock;
  try { lock = await open(lockPath, 'wx', 0o600); } catch { fail('probe_locked_or_output_directory_unavailable'); }
  try {
    await lock.writeFile(`${process.pid}\n`); await lock.sync();
    let ledger;
    try { ledger = JSON.parse(await readFile(ledgerPath, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') fail('cannot_read_existing_ledger');
      ledger = { version: 1, capMicroUsd: CAP, reservedMicroUsd: 0, attempts: [] }; }
    validateLedger(ledger);
    if (ledger.attempts.some(row => row.error === 'usage_exceeds_reserved_bound' || row.error === 'budget_exhausted')) fail('ledger_stopped_requires_review');
    // Parse ONLY the explicit file; do not merge into process.env or use other variables from it.
    const key = (args.keyFromEnv ? process.env.GEMINI_API_KEY : parse(await readFile(args.envFile, 'utf8')).GEMINI_API_KEY)?.trim();
    if (!key || /[\r\n]/.test(key)) fail('missing_or_invalid_gemini_key');
    for (const model of MODELS) {
      if (ledger.attempts.some(row => row.model === model.id && (row.error || !['complete', 'incomplete'].includes(row.status)))) continue;
      for (const test of CASES) {
        if (ledger.attempts.some(row => row.model === model.id && row.caseId === test.id)) continue;
        currentRates();
        const row = { model: model.id, thinking: model.thinking, caseId: test.id, prompt: test.prompt,
          status: 'count_started', reservedMicroUsd: 0, startedAt: new Date().toISOString() };
        ledger.attempts.push(row); await atomicJson(ledgerPath, ledger);
        const start = performance.now();
        try {
          const body = { systemInstruction: { parts: [{ text: 'Answer concisely. Preserve numbers and constraints. Do not invent CRM facts. Use ordinary words.' }] },
            contents: [{ role: 'user', parts: [{ text: test.prompt }] }],
            generationConfig: { maxOutputTokens: MAX_OUTPUT, candidateCount: 1, thinkingConfig: { thinkingLevel: model.thinking } } };
          const counted = await request(key, model.id, 'countTokens', { generateContentRequest: { model: `models/${model.id}`, ...body } }, 15000, 16384);
          const input = counted.totalTokens;
          if (!Number.isSafeInteger(input) || input < 1 || input > MAX_INPUT) fail('input_limit_or_invalid_count');
          currentRates();
          row.inputTokensCounted = input; const reserved = cost(model, input, MAX_OUTPUT);
          if (ledger.reservedMicroUsd + reserved > CAP) fail('budget_exhausted');
          row.reservedMicroUsd = reserved; ledger.reservedMicroUsd += reserved; row.status = 'generation_reserved';
          await atomicJson(ledgerPath, ledger); // Durable hold BEFORE paid I/O; no refunds after any outcome.
          const data = await request(key, model.id, 'generateContent', body, 60000, 262144);
          const candidate = data.candidates?.[0];
          row.finishReason = typeof candidate?.finishReason === 'string' ? candidate.finishReason : null;
          row.output = (candidate?.content?.parts ?? []).filter(part => !part.thought && typeof part.text === 'string').map(part => part.text).join('').split(key).join('[redacted]');
          const usage = data.usageMetadata;
          row.usage = null; row.estimatedActualMicroUsd = null;
          if (usage && [usage.promptTokenCount, usage.candidatesTokenCount, usage.thoughtsTokenCount ?? 0].every(n => Number.isSafeInteger(n) && n >= 0)) {
            row.usage = { inputTokens: usage.promptTokenCount, candidateTokens: usage.candidatesTokenCount, thoughtTokens: usage.thoughtsTokenCount ?? 0 };
            row.estimatedActualMicroUsd = cost(model, row.usage.inputTokens, row.usage.candidateTokens + row.usage.thoughtTokens);
            if (row.estimatedActualMicroUsd > reserved) fail('usage_exceeds_reserved_bound');
          }
          row.generationComplete = row.finishReason === 'STOP' && row.output.trim().length > 0;
          row.status = row.generationComplete ? 'complete' : 'incomplete'; // Completion is not a linguistic quality verdict.
        } catch (error) { row.status = 'failed'; row.error = error.safeCode ?? 'transport_or_invalid_response'; }
        row.elapsedMs = Math.round(performance.now() - start);
        await atomicJson(ledgerPath, ledger);
        await atomicJson(args.output, { syntheticOnly: true, billing: 'Conservative reservations, no refunds; estimates are not provider invoices.', ...ledger });
        if (row.error === 'usage_exceeds_reserved_bound' || row.error === 'budget_exhausted') return;
        if (row.error) break; // Stop this model, never retry/fallback or raise thinking.
      }
    }
    await atomicJson(args.output, { syntheticOnly: true, billing: 'Conservative reservations, no refunds; estimates are not provider invoices.', ...ledger });
    console.log(JSON.stringify({ status: 'finished', attempts: ledger.attempts.length, reservedMicroUsd: ledger.reservedMicroUsd }));
  } finally { await lock.close(); await unlink(lockPath); }
}

main().catch(error => { console.error(JSON.stringify({ status: 'stopped', error: error.safeCode ?? 'probe_local_error' })); process.exitCode = 1; });
