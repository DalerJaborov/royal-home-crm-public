import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { apiImageInputsChanged, apiImagePlan } from './api-image-check.mjs';

const head = 'a'.repeat(40), base = 'b'.repeat(40);
test('docs and browser-only edits do not rebuild the API image', () => {
  for (const files of [[], ['docs/ship.md'], ['apps/api/README.md'], ['apps/web/src/App.tsx']]) {
    assert.equal(apiImageInputsChanged(files), false);
  }
});
test('runtime, dependency, build context and gate edits require a real image check', () => {
  for (const file of ['apps/api/Dockerfile', 'apps/api/src/index.ts', 'apps/api/prisma/schema.prisma',
    'packages/shared/src/index.ts', 'package.json', 'package-lock.json', 'apps/web/package.json',
    '.dockerignore', '.github/workflows/ci.yml', '.github/scripts/api-image-check.mjs']) {
    assert.equal(apiImageInputsChanged([file]), true, file);
  }
});
test('manual verification checks the exact image even without a new diff', () => {
  assert.deepEqual(apiImagePlan({ head, base, files: [], event: 'workflow_dispatch' }),
    { sourceSha: head, baseSha: base, required: true });
  assert.equal(apiImagePlan({ head, base, files: ['docs/ship.md'], event: 'pull_request' }).required, false);
});
test('missing or substituted source identities cannot produce a valid image plan', () => {
  for (const value of ['', 'main', 'a'.repeat(39), 'A'.repeat(40), '$(command)']) {
    assert.throws(() => apiImagePlan({ head: value, base, files: [], event: 'push' }));
    assert.throws(() => apiImagePlan({ head, base: value, files: [], event: 'push' }));
  }
});
test('real Git source planning handles a new push branch and fails closed on invalid base', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'rh-image-plan-'));
  const env = { ...process.env, GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.invalid', GITHUB_EVENT_NAME: 'push',
    API_IMAGE_BASE_SHA: '0'.repeat(40) };
  const git = (...args) => {
    const r = spawnSync('git', args, { cwd: dir, env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr); return r.stdout.trim();
  };
  const script = fileURLToPath(new URL('./api-image-check.mjs', import.meta.url));
  const run = extra => spawnSync(process.execPath, [script, 'plan'], { cwd: dir, env: { ...env, ...extra }, encoding: 'utf8' });
  try {
    git('init', '--quiet');
    writeFileSync(path.join(dir, 'README.md'), 'base'); git('add', '.'); git('commit', '--quiet', '-m', 'base');
    git('update-ref', 'refs/remotes/origin/main', git('rev-parse', 'HEAD'));
    writeFileSync(path.join(dir, 'README.md'), 'docs'); git('add', '.'); git('commit', '--quiet', '-m', 'docs');
    const docs = run(); assert.equal(docs.status, 0, docs.stderr); assert.match(docs.stdout, /required=false/);
    mkdirSync(path.join(dir, 'apps', 'api'), { recursive: true });
    writeFileSync(path.join(dir, 'apps', 'api', 'Dockerfile'), 'FROM node:24-slim');
    git('add', '.'); git('commit', '--quiet', '-m', 'runtime');
    const image = run(); assert.equal(image.status, 0, image.stderr); assert.match(image.stdout, /required=true/);
    assert.ok(image.stdout.includes(`source_sha=${git('rev-parse', 'HEAD')}`));
    const invalid = run({ API_IMAGE_BASE_SHA: 'not-a-commit' });
    assert.equal(invalid.status, 1); assert.doesNotMatch(invalid.stdout, /required=false/);
    const wrongSource = spawnSync(process.execPath, [script, 'check'], { cwd: dir,
      env: { ...env, API_IMAGE_SOURCE_SHA: 'f'.repeat(40) }, encoding: 'utf8' });
    assert.equal(wrongSource.status, 1); assert.match(wrongSource.stderr, /Exact image source SHA required/);
  } finally {
    assert.ok(dir.startsWith(path.join(tmpdir(), 'rh-image-plan-')));
    rmSync(dir, { recursive: true, force: true });
  }
});
