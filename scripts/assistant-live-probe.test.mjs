import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';

const script = fileURLToPath(new URL('./assistant-live-probe.mjs', import.meta.url));
const preload = `
import { appendFile, readFile } from 'node:fs/promises';
globalThis.fetch = async (url, init) => {
  const input = JSON.parse(init.body);
  if (init.headers['x-goog-api-key'] !== 'synthetic-test-key') throw new Error('wrong synthetic key');
  if (init.redirect !== 'error') throw new Error('redirects enabled');
  const method = String(url).split(':').at(-1);
  await appendFile(process.env.PROBE_TEST_LOG, method + '\\n');
  if (process.env.PROBE_TEST_MODE === 'unauthorized') return new Response('SECRET_ERROR_BODY', {status:401});
  if (method === 'countTokens') {
    if (!input.generateContentRequest.systemInstruction || !input.generateContentRequest.contents || !input.generateContentRequest.generationConfig) throw new Error('partial count');
    return Response.json({totalTokens:4096});
  }
  if (method !== 'generateContent') throw new Error('unexpected network method');
  const ledger = JSON.parse(await readFile(process.env.PROBE_TEST_LEDGER, 'utf8'));
  const last = ledger.attempts.at(-1);
  if (last.status !== 'generation_reserved' || last.reservedMicroUsd <= 0 || ledger.reservedMicroUsd > 2000000) throw new Error('not durably reserved');
  if (input.generationConfig.maxOutputTokens !== 2048) throw new Error('wrong output limit');
  const thinking = input.generationConfig.thinkingConfig.thinkingLevel;
  if (thinking !== 'low' && thinking !== 'minimal') throw new Error('thinking escalation');
  return Response.json({candidates:[{content:{parts:[{text:'hidden',thought:true},{text:'Салом 650000'}]},finishReason:process.env.PROBE_TEST_MODE === 'incomplete' ? 'MAX_TOKENS' : 'STOP'}],
    ...(process.env.PROBE_TEST_MODE === 'unknown_usage' ? {} : {usageMetadata:{promptTokenCount:4096,candidatesTokenCount:30,thoughtsTokenCount:20}})});
};
`;

async function fixture(t, mode = 'success') {
  const dir = await mkdtemp(join(tmpdir(), 'assistant-probe-test-'));
  t.after(() => {
    const target = resolve(dir); const prefix = resolve(tmpdir()) + sep + 'assistant-probe-test-';
    assert.ok(target.toLowerCase().startsWith(prefix.toLowerCase()));
    return rm(target, {recursive:true, force:true});
  });
  const keyFile = join(dir, 'synthetic.env'); const output = join(dir, 'result.json');
  const preloader = join(dir, 'preload.mjs'); const log = join(dir, 'network.log');
  await writeFile(keyFile, 'GEMINI_API_KEY=synthetic-test-key\nUNUSED_SECRET=never-consume\n');
  await writeFile(preloader, preload); await writeFile(log, '');
  const run = (keyFromEnv = false) => new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, ['--import', pathToFileURL(preloader).href, script, '--execute', ...(keyFromEnv ? ['--key-from-env'] : ['--env-file', keyFile]), '--output', output], {
      env: {...process.env, GEMINI_API_KEY:'synthetic-test-key', PROBE_TEST_MODE:mode, PROBE_TEST_LOG:log, PROBE_TEST_LEDGER:output+'.ledger.json'},
      windowsHide:true, stdio:['ignore','pipe','pipe'],
    });
    let stdout=''; let stderr=''; child.stdout.on('data', value=>stdout+=value); child.stderr.on('data',value=>stderr+=value);
    child.once('error',reject); child.once('close',code=>resolveRun({code,stdout,stderr}));
  });
  return {run,output,log,ledger:()=>readFile(output+'.ledger.json','utf8').then(JSON.parse)};
}

test('synthetic generation reserves durably, counts thoughts, rerun makes no calls', async t => {
  const f = await fixture(t); const result = await f.run(); assert.equal(result.code,0,result.stderr);
  const ledger = await f.ledger(); assert.equal(ledger.attempts.length,12);
  assert.equal(ledger.capMicroUsd,2000000);
  assert.equal(ledger.reservedMicroUsd,261120); assert.ok(ledger.reservedMicroUsd<=2000000);
  assert.ok(ledger.attempts.every(row=>row.status==='complete' && row.usage.thoughtTokens===20 && row.output==='Салом 650000'));
  assert.equal(ledger.attempts[0].estimatedActualMicroUsd,8792);
  const calls = await readFile(f.log,'utf8'); assert.equal(calls.trim().split('\n').length,24);
  assert.equal((await f.run()).code,0); assert.equal(await readFile(f.log,'utf8'),calls);
  assert.ok(!(await readFile(f.output,'utf8')).includes('synthetic-test-key'));
});

test('persistent near-full ledger refuses generation before exceeding cap', async t => {
  const f = await fixture(t);
  await writeFile(f.output+'.ledger.json',JSON.stringify({version:1,capMicroUsd:2000000,reservedMicroUsd:1999999,attempts:[{
    model:'gemini-3.1-pro-preview',caseId:'tg-budget',status:'complete',reservedMicroUsd:1999999,
  }]}));
  await f.run(); const ledger=await f.ledger();
  assert.equal(ledger.reservedMicroUsd,1999999); assert.equal(ledger.attempts.at(-1).error,'budget_exhausted');
  assert.equal(await readFile(f.log,'utf8'),'countTokens\n');
  const again=await f.run(); assert.equal(again.code,1); assert.equal(await readFile(f.log,'utf8'),'countTokens\n');
});

test('401 stops each model with no generation reserve and no response-body leak', async t => {
  const f=await fixture(t,'unauthorized'); const result=await f.run();
  const ledger=await f.ledger(); assert.equal(ledger.attempts.length,2); assert.equal(ledger.reservedMicroUsd,0);
  assert.ok(ledger.attempts.every(row=>row.error==='http_401'));
  assert.equal(await readFile(f.log,'utf8'),'countTokens\ncountTokens\n');
  assert.ok(!(result.stdout+result.stderr+await readFile(f.output,'utf8')).includes('SECRET_ERROR_BODY'));
});

test('missing usage never refunds reserved cost', async t => {
  const f=await fixture(t,'unknown_usage'); await f.run(); const ledger=await f.ledger();
  assert.equal(ledger.reservedMicroUsd,261120);
  assert.ok(ledger.attempts.every(row=>row.usage===null && row.estimatedActualMicroUsd===null && row.reservedMicroUsd>0));
});

test('exclusive lock rejects concurrent runner before network', async t => {
  const f=await fixture(t); await writeFile(f.output+'.lock','other-process');
  const result=await f.run(); assert.equal(result.code,1); assert.equal(await readFile(f.log,'utf8'),'');
  assert.equal(await readFile(f.output+'.lock','utf8'),'other-process');
});

test('MAX_TOKENS is explicitly incomplete, no hidden thoughts in output or automatic retries', async t => {
  const f=await fixture(t,'incomplete'); await f.run(); const ledger=await f.ledger();
  assert.equal(ledger.attempts.length,12);
  assert.ok(ledger.attempts.every(row=>row.status==='incomplete' && row.generationComplete===false && row.finishReason==='MAX_TOKENS' && !row.output.includes('hidden')));
  const calls=await readFile(f.log,'utf8'); await f.run(); assert.equal(await readFile(f.log,'utf8'),calls);
});

test('explicit in-memory key source does not require a credential file', async t => {
  const f = await fixture(t); const result = await f.run(true);
  assert.equal(result.code,0,result.stderr);
  assert.equal((await f.ledger()).attempts.length,12);
  assert.ok(!result.stdout.includes('synthetic-test-key'));
});
