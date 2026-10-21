import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const SHA = /^[a-f0-9]{40}$/;
export function apiImageInputsChanged(files) {
  return files.some(file => !file.toLowerCase().endsWith('.md') && (
    ['package.json', 'package-lock.json', '.dockerignore', 'apps/web/package.json',
      '.github/workflows/ci.yml', '.github/scripts/api-image-check.mjs'].includes(file) ||
    file.startsWith('apps/api/') || file.startsWith('packages/shared/')));
}
export function apiImagePlan({ head, base, files, event }) {
  if (!SHA.test(head) || !SHA.test(base)) throw new Error('Exact image source/base SHA required');
  return { sourceSha: head, baseSha: base, required: event === 'workflow_dispatch' || apiImageInputsChanged(files) };
}
function capture(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.error || result.status !== 0) throw new Error(`${command} ${args[0]} failed (exit ${result.status})`);
  return result.stdout.trim();
}
function plan() {
  const head = capture('git', ['rev-parse', 'HEAD']);
  const requested = process.env.API_IMAGE_BASE_SHA;
  if (requested && !SHA.test(requested)) throw new Error('Invalid image base SHA');
  const baseRef = requested && !/^0+$/.test(requested) ? requested : 'origin/main';
  const base = capture('git', ['merge-base', head, baseRef]);
  const files = capture('git', ['diff', '--name-only', '-z', base, head]).split('\0').filter(Boolean);
  const result = apiImagePlan({ head, base, files, event: process.env.GITHUB_EVENT_NAME });
  console.log(`required=${result.required}\nsource_sha=${result.sourceSha}`);
}
function check() {
  const sourceSha = capture('git', ['rev-parse', 'HEAD']);
  if (!SHA.test(sourceSha) || process.env.API_IMAGE_SOURCE_SHA !== sourceSha) throw new Error('Exact image source SHA required');
  const image = `royalhome-api-offline:${sourceSha}`;
  const report = { sourceSha, image, runtimeNetwork: 'none', runtimeMounts: [], passed: false };
  try {
    const build = spawnSync('docker', ['build', '--progress=plain', '--file', 'apps/api/Dockerfile', '--tag', image, '.'], { stdio: 'inherit' });
    if (build.error || build.status !== 0) throw new Error(`API image build failed (exit ${build.status})`);
    report.imageId = capture('docker', ['image', 'inspect', '--format', '{{.Id}}', image]);
    // No database settings, volumes or network are supplied to this container.
    report.version = capture('docker', ['run', '--rm', '--pull=never', '--network', 'none', '--entrypoint', 'node',
      image, '/repo/node_modules/prisma/build/index.js', '--version']);
    if (!/schema-engine-/i.test(report.version)) throw new Error('Prisma did not report the packaged schema engine');
    report.passed = true;
  } catch (error) {
    report.error = error.message;
    throw error;
  } finally {
    writeFileSync(process.env.API_IMAGE_REPORT || 'api-image-offline-check.json', JSON.stringify(report, null, 2));
  }
  console.log(JSON.stringify(report));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv[2] === 'plan') plan();
    else if (process.argv[2] === 'check') check();
    else throw new Error('Expected plan or check');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
