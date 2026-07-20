import { createHash } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_CONFIGURATION, validateConfiguration } from '../src/cli.mjs';
import { configurationDigest } from '../src/contract.mjs';

const validConfig = {
  site: { coreSiteId: 4, canonicalDomain: 'movingcars.com.au', canonicalUrl: 'https://movingcars.com.au' },
  repository: { url: 'https://github.com/iamjasonhill/astrosites2026' },
  approvalReference: 'github:issue:762#test',
};

test('detector configuration fails closed on unknown unsafe or excessive values', () => {
  const validate = (overrides, configOverrides = {}) => validateConfiguration(
    { ...validConfig, detector: configOverrides },
    { ...DEFAULT_CONFIGURATION, ...overrides },
  );
  assert.throws(() => validate({}, { typoThreshold: 0.5 }), /Unknown detector/);
  assert.throws(() => validate({ minimumWords: 0 }), /positive integer/);
  assert.throws(() => validate({ highResemblance: 95 }), /0 to 1/);
  assert.throws(() => validate({ containment: Number.NaN }), /finite number/);
  assert.throws(() => validate({ minHashSeeds: 201 }), /reviewed V1 bounds/);
  assert.throws(() => validate({ templateResemblance: 0.99 }), /thresholds/);
  assert.throws(() => validate({ minimumWords: 50 }, { minimumWords: 50 }), /fixed by the reviewed V1 detector/);
});

test('CLI emits a complete digest-reconciled body-free Bossman bundle', async () => {
  const fixture = resolve('test/fixture');
  const output = resolve(fixture, 'fleet-content-quality-evidence');
  await rm(output, { recursive: true, force: true });
  const result = spawnSync(process.execPath, [
    '../../src/cli.mjs', '--config', '.fleet-content-quality.json', '--dist', 'dist',
    '--commit', 'a'.repeat(40), '--ref', 'refs/heads/main', '--run-id', 'fixture:1',
    '--lockfile', '../../package-lock.json', '--called-workflow-sha', 'b'.repeat(40),
    '--caller-workflow-ref', 'fixture/caller@refs/heads/main',
  ], { cwd: fixture, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const manifest = JSON.parse(await readFile(`${output}/manifest.json`, 'utf8'));
  assert.equal(manifest.schemaVersion, 'fleet-content-quality-evidence.v1');
  assert.equal(manifest.scope.completion, 'complete');
  assert.equal(manifest.summary.pages, 1);
  assert.equal(manifest.extensions.pilot.calledWorkflowSha, 'b'.repeat(40));
  const digestRows = [];
  for (const file of manifest.files) {
    const body = await readFile(`${output}/${file.name}`);
    assert.equal(`sha256:${createHash('sha256').update(body).digest('hex')}`, file.sha256);
    assert.equal(body.byteLength, file.bytes);
    assert.equal(body.toString('utf8').trim() === '' ? 0 : body.toString('utf8').trim().split('\n').length, file.rows);
    assert.doesNotMatch(body.toString('utf8'), /"(?:body|html|text|content|excerpt|mainText|mainContent)"\s*:/i);
    digestRows.push({ name: file.name, sha256: file.sha256, rows: file.rows });
  }
  digestRows.sort((left, right) => left.name.localeCompare(right.name));
  const canonical = JSON.stringify(digestRows.map((row) => Object.fromEntries(Object.keys(row).sort().map((key) => [key, row[key]]))));
  assert.equal(manifest.bundleDigest, `sha256:${createHash('sha256').update(canonical).digest('hex')}`);
  assert.match(manifest.boundary, /does not grant Standards applicability/);
  await rm(output, { recursive: true, force: true });
});

test('CLI refuses destructive output paths before deleting anything', () => {
  const fixture = resolve('test/fixture');
  const result = spawnSync(process.execPath, [
    '../../src/cli.mjs', '--config', '.fleet-content-quality.json', '--dist', 'dist', '--output', '.',
    '--commit', 'a'.repeat(40), '--lockfile', '../../package-lock.json',
  ], { cwd: fixture, encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /dedicated fleet-content-quality-evidence directory/);
});

test('failure CLI emits a typed failed bundle with empty logical evidence files', async () => {
  const fixture = resolve('test/fixture');
  const output = resolve(fixture, 'fleet-content-quality-evidence');
  const capConfigPath = resolve(fixture, '.fleet-content-quality-cap-test.json');
  const cap = 123_456;
  await writeFile(capConfigPath, JSON.stringify({ ...validConfig, detector: { maximumCandidateComparisons: cap } }));
  await rm(output, { recursive: true, force: true });
  const result = spawnSync(process.execPath, [
    '../../src/failure-cli.mjs', '--config', '.fleet-content-quality-cap-test.json',
    '--commit', 'a'.repeat(40), '--ref', 'refs/heads/main', '--run-id', 'fixture:failed',
    '--lockfile', '../../package-lock.json', '--called-workflow-sha', 'b'.repeat(40),
    '--caller-workflow-ref', 'fixture/caller', '--failure-code', 'foundation_check_failed', '--failed-step', 'build',
  ], { cwd: fixture, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const manifest = JSON.parse(await readFile(`${output}/manifest.json`, 'utf8'));
  assert.equal(manifest.scope.completion, 'failed');
  assert.equal(manifest.summary.execution, 'failed');
  assert.equal(manifest.summary.pages, 0);
  assert.equal(manifest.extensions.pilot.failedStep, 'build');
  assert.equal(manifest.producer.configurationDigest, configurationDigest({ ...DEFAULT_CONFIGURATION, maximumCandidateComparisons: cap }));
  assert.ok(manifest.files.every((file) => file.bytes === 0 && file.rows === 0));
  await rm(output, { recursive: true, force: true });
  await rm(capConfigPath, { force: true });
});
