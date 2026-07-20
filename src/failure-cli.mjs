#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { mkdir, open, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';
import { artifactKey, canonicalJson, configurationDigest, DETECTOR_VERSION, EXTRACTOR_VERSION, PRODUCER_NAME, PRODUCER_VERSION, SCHEMA_VERSION, sha256 } from './contract.mjs';
import { DEFAULT_CONFIGURATION, validateConfiguration } from './cli.mjs';

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const config = JSON.parse(await readFile(resolve(options.config ?? '.fleet-content-quality.json'), 'utf8'));
  const configuration = { ...DEFAULT_CONFIGURATION, ...(config.detector ?? {}) };
  validateConfiguration(config, configuration, { bindRepository: true });
  const output = resolve('fleet-content-quality-evidence');
  if (options.output && resolve(options.output) !== output) throw new Error('Failure evidence output must use the dedicated fleet-content-quality-evidence directory.');
  const lockfile = resolve(options.lockfile ?? 'package-lock.json');
  const producer = {
    name: PRODUCER_NAME,
    version: PRODUCER_VERSION,
    runtime: process.version,
    extractorVersion: EXTRACTOR_VERSION,
    detectorVersion: DETECTOR_VERSION,
    configurationDigest: configurationDigest(configuration),
  };
  const source = {
    kind: 'repository_build',
    repositoryUrl: config.repository.url,
    commitSha: required(options.commit, 'commit'),
    ref: options.ref ?? process.env.GITHUB_REF ?? 'local',
    lockfileSha256: sha256(await readFile(lockfile)),
    runId: required(options.runId, 'run-id'),
  };
  const scope = {
    kind: 'full_build', completion: 'failed', expectedPages: null, discoveredPages: 0, processedPages: 0,
    excludedPages: 0, failedPages: 0, extractionFailureCount: 0, tooShortCount: 0, capReached: false,
  };
  const artifact = artifactKey({ siteId: config.site.coreSiteId, source, producer, scope });
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  const files = [];
  for (const name of ['pages.ndjson', 'clusters.ndjson', 'findings.ndjson']) files.push(await writeEmptyNdjson(`${output}/${name}`, name));
  const manifest = {
    schemaVersion: SCHEMA_VERSION,
    artifactKey: artifact,
    bundleDigest: sha256(files.map(({ name, sha256: digest, rows }) => ({ name, sha256: digest, rows })).sort((left, right) => left.name.localeCompare(right.name))),
    generatedAt: new Date().toISOString(),
    site: config.site,
    source,
    producer,
    scope,
    files,
    summary: { execution: 'failed', pages: 0, findingsByKind: {} },
    references: [{ kind: 'decision', key: config.approvalReference }],
    boundary: 'Evidence only. This failed run does not grant Standards applicability, cleanup, publication, merge, deployment or provider-write authority.',
    extensions: {
      pilot: {
        calledWorkflowSha: validatedWorkflowSha(options.calledWorkflowSha),
        callerWorkflowRef: options.callerWorkflowRef ?? 'local',
        failureCode: required(options.failureCode, 'failure-code'),
        failedStep: required(options.failedStep, 'failed-step'),
        optionalChecks: config.optionalChecks ?? {},
      },
    },
  };
  await writeFile(`${output}/manifest.json`, `${canonicalJson(manifest)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ output, artifactKey: artifact, bundleDigest: manifest.bundleDigest, completion: 'failed' })}\n`);
}

async function writeEmptyNdjson(path, name) {
  const handle = await open(path, 'w', 0o600);
  await handle.close();
  return { name, mediaType: 'application/x-ndjson', sha256: `sha256:${createHash('sha256').digest('hex')}`, bytes: 0, rows: 0 };
}

function parseArguments(arguments_) {
  const options = {};
  for (let index = 0; index < arguments_.length; index++) {
    const argument = arguments_[index];
    if (!argument.startsWith('--')) throw new Error(`Unknown argument ${argument}.`);
    const value = arguments_[++index];
    if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value.`);
    options[argument.slice(2).replace(/-([a-z])/g, (_, character) => character.toUpperCase())] = value;
  }
  return options;
}

function required(value, label) {
  if (!value) throw new Error(`${label} is required.`);
  return value;
}

function validatedWorkflowSha(value) {
  if (!/^[a-f0-9]{40}$/i.test(value ?? '')) throw new Error('called-workflow-sha must be an immutable 40-character commit SHA.');
  return value.toLowerCase();
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});
