#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { mkdir, open, readFile, rm, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import process from 'node:process';
import { analyseRenderedSite, materializeFindings } from './analyse.mjs';
import {
  artifactKey, canonicalJson, configurationDigest, DETECTOR_VERSION, EXTRACTOR_VERSION,
  normalizeRepository, normalizeUrl, PRODUCER_NAME, PRODUCER_VERSION, SCHEMA_VERSION, sha256,
} from './contract.mjs';

export const DEFAULT_CONFIGURATION = Object.freeze({
  minimumWords: 100,
  shingleWords: 5,
  minHashSeeds: 20,
  lshBands: 5,
  maximumCandidateComparisons: 50_000_000,
  calibratedResemblance: 0.95,
  highResemblance: 0.95,
  containment: 0.8,
  templateResemblance: 0.8,
});

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) return printHelp();
  const configPath = resolve(options.config ?? '.fleet-content-quality.json');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  const configuration = { ...DEFAULT_CONFIGURATION, ...(config.detector ?? {}) };
  validateConfiguration(config, configuration);
  const output = resolve(options.output ?? 'fleet-content-quality-evidence');
  const expectedOutput = resolve('fleet-content-quality-evidence');
  if (output !== expectedOutput) throw new Error('Evidence output must be the dedicated fleet-content-quality-evidence directory under the current workspace.');
  const dist = resolve(options.dist ?? config.dist ?? 'dist');
  const lockfile = resolve(options.lockfile ?? 'package-lock.json');
  const generatedAt = new Date().toISOString();
  const started = process.hrtime.bigint();
  const memoryBefore = process.memoryUsage().rss;
  const analysis = await analyseRenderedSite({ dist, canonicalUrl: config.site.canonicalUrl, configuration });
  const inventoryDigest = sha256(analysis.pages.map((page) => page.pageKey).sort());
  const lockfileSha256 = sha256(await readFile(lockfile));
  const producer = {
    name: PRODUCER_NAME,
    version: PRODUCER_VERSION,
    runtime: process.version,
    extractorVersion: EXTRACTOR_VERSION,
    detectorVersion: DETECTOR_VERSION,
    configurationDigest: configurationDigest(configuration),
  };
  const extractionFailureCount = analysis.pages.filter((page) => page.extraction.status === 'failed').length;
  const tooShortCount = analysis.pages.filter((page) => page.extraction.status === 'too_short').length;
  const scope = {
    kind: 'full_build',
    completion: analysis.candidateCapReached ? 'partial' : 'complete',
    expectedPages: analysis.pages.length,
    discoveredPages: analysis.pages.length,
    processedPages: analysis.pages.length,
    excludedPages: 0,
    failedPages: 0,
    extractionFailureCount,
    tooShortCount,
    ...(analysis.candidateCapReached ? { capValue: configuration.maximumCandidateComparisons } : {}),
    capReached: analysis.candidateCapReached,
    inventoryDigest,
  };
  const source = {
    kind: 'repository_build',
    repositoryUrl: config.repository.url,
    commitSha: requiredEnvironmentOrConfig('commit SHA', options.commit, config.repository.commitSha, 'GITHUB_SHA'),
    ref: options.ref ?? config.repository.ref ?? process.env.GITHUB_REF ?? 'local',
    lockfileSha256,
    runId: options.runId ?? config.repository.runId ?? githubRunId(),
  };
  const artifact = artifactKey({ siteId: config.site.coreSiteId, source, producer, scope });
  const manifestIdentity = { siteId: config.site.coreSiteId, artifactKey: artifact, configurationDigest: producer.configurationDigest };
  const { clusters, findings } = materializeFindings(analysis.pages, analysis.clusterSpecs, manifestIdentity);
  const rows = {
    'pages.ndjson': analysis.pages.map(({ _analysis, ...page }) => page),
    'clusters.ndjson': clusters,
    'findings.ndjson': findings,
  };
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  const files = [];
  for (const [name, logicalRows] of Object.entries(rows)) {
    files.push(await writeNdjson(`${output}/${name}`, name, logicalRows));
  }
  const findingCounts = {};
  for (const finding of findings) findingCounts[finding.kind] = (findingCounts[finding.kind] ?? 0) + 1;
  const durationMs = Number(process.hrtime.bigint() - started) / 1_000_000;
  const manifest = {
    schemaVersion: SCHEMA_VERSION,
    artifactKey: artifact,
    bundleDigest: sha256(files.map(({ name, sha256: digest, rows: count }) => ({ name, sha256: digest, rows: count })).sort((left, right) => left.name.localeCompare(right.name))),
    generatedAt,
    site: config.site,
    source,
    producer,
    scope,
    files,
    summary: { execution: analysis.candidateCapReached ? 'partial' : 'succeeded', pages: analysis.pages.length, findingsByKind: findingCounts },
    references: [{ kind: 'decision', key: config.approvalReference }],
    boundary: 'Evidence only. This artifact does not grant Standards applicability, cleanup, publication, merge, deployment or provider-write authority.',
    extensions: {
      pilot: {
        calledWorkflowSha: validatedWorkflowSha(options.calledWorkflowSha ?? process.env.FLEET_CONTENT_CALLED_WORKFLOW_SHA),
        callerWorkflowRef: options.callerWorkflowRef ?? process.env.FLEET_CONTENT_CALLER_WORKFLOW_REF ?? 'local',
        durationMs: Math.round(durationMs),
        maximumRssBytes: Math.max(memoryBefore, process.resourceUsage().maxRSS * 1024),
        renderedHtmlFiles: analysis.files.length,
        candidateComparisons: analysis.comparisonCount,
        optionalChecks: config.optionalChecks ?? {},
      },
    },
  };
  await writeFile(`${output}/manifest.json`, `${canonicalJson(manifest)}\n`);
  process.stdout.write(`${JSON.stringify({ output, artifactKey: artifact, bundleDigest: manifest.bundleDigest, pages: analysis.pages.length, findings: findings.length, durationMs: Math.round(durationMs) })}\n`);
}

function parseArguments(arguments_) {
  const options = {};
  for (let index = 0; index < arguments_.length; index++) {
    const argument = arguments_[index];
    if (argument === '--help' || argument === '-h') options.help = true;
    else if (argument.startsWith('--')) {
      const key = argument.slice(2).replace(/-([a-z])/g, (_, character) => character.toUpperCase());
      const value = arguments_[++index];
      if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value.`);
      options[key] = value;
    } else throw new Error(`Unknown argument ${argument}.`);
  }
  return options;
}

export function validateConfiguration(config, detector) {
  const detectorKeys = [
    'minimumWords', 'shingleWords', 'minHashSeeds', 'lshBands', 'maximumCandidateComparisons',
    'calibratedResemblance', 'highResemblance', 'containment', 'templateResemblance',
  ];
  const unknown = Object.keys(config.detector ?? {}).filter((key) => !detectorKeys.includes(key));
  if (unknown.length) throw new Error(`Unknown detector configuration: ${unknown.join(', ')}.`);
  if (!Number.isInteger(config.site?.coreSiteId) || config.site.coreSiteId < 1) throw new Error('site.coreSiteId must be a positive integer.');
  if (!config.site?.canonicalDomain || !config.site?.canonicalUrl) throw new Error('site canonicalDomain and canonicalUrl are required.');
  if (!config.repository?.url) throw new Error('repository.url is required.');
  if (!config.approvalReference) throw new Error('approvalReference is required.');
  const pilot = PILOT_SITES.find((site) => site.siteId === config.site.coreSiteId);
  if (!pilot || pilot.domain !== config.site.canonicalDomain.toLowerCase() || pilot.repository !== normalizeRepository(config.repository.url)) {
    throw new Error('Site, domain and repository must match one exact issue #762 pilot tuple.');
  }
  const canonical = normalizeUrl(config.site.canonicalUrl);
  if (canonical !== `https://${pilot.domain}/`) throw new Error('site.canonicalUrl must be the canonical HTTPS origin for the pilot domain.');
  if (process.env.GITHUB_REPOSITORY && normalizeRepository(`${process.env.GITHUB_SERVER_URL ?? 'https://github.com'}/${process.env.GITHUB_REPOSITORY}`) !== pilot.repository) {
    throw new Error('Checked-out GitHub repository does not match the declared pilot repository.');
  }
  for (const key of ['minimumWords', 'shingleWords', 'minHashSeeds', 'lshBands', 'maximumCandidateComparisons']) {
    if (!Number.isInteger(detector[key]) || detector[key] < 1) throw new Error(`${key} must be a positive integer.`);
  }
  if (detector.minimumWords > 10_000 || detector.shingleWords > 20 || detector.minHashSeeds > 200 || detector.lshBands > 50 || detector.maximumCandidateComparisons > 100_000_000) {
    throw new Error('Detector resource controls exceed reviewed V1 bounds.');
  }
  for (const key of ['calibratedResemblance', 'highResemblance', 'containment', 'templateResemblance']) {
    if (typeof detector[key] !== 'number' || !Number.isFinite(detector[key]) || detector[key] < 0 || detector[key] > 1) throw new Error(`${key} must be a finite number from 0 to 1.`);
  }
  if (detector.minHashSeeds % detector.lshBands !== 0) throw new Error('minHashSeeds must divide evenly across lshBands.');
  if (detector.templateResemblance > detector.highResemblance || detector.calibratedResemblance < detector.highResemblance) {
    throw new Error('Similarity thresholds must preserve template <= high <= calibrated ordering.');
  }
  for (const key of detectorKeys.filter((key) => key !== 'maximumCandidateComparisons')) {
    if (detector[key] !== DEFAULT_CONFIGURATION[key]) throw new Error(`${key} is fixed by the reviewed V1 detector and cannot be overridden per Site.`);
  }
}

const PILOT_SITES = Object.freeze([
  { siteId: 15, domain: 'supercheapcartransport.com.au', repository: 'github.com/iamjasonhill/mm-supercheapcartransport' },
  { siteId: 4, domain: 'movingcars.com.au', repository: 'github.com/iamjasonhill/astrosites2026' },
  { siteId: 6, domain: 'movemycar.com.au', repository: 'github.com/iamjasonhill/mm-movemycar' },
]);

async function writeNdjson(path, name, rows) {
  const handle = await open(path, 'w', 0o600);
  const digest = createHash('sha256');
  let bytes = 0;
  try {
    for (const row of rows) {
      const line = `${JSON.stringify(row)}\n`;
      await handle.write(line);
      digest.update(line);
      bytes += Buffer.byteLength(line);
    }
  } finally {
    await handle.close();
  }
  return { name, mediaType: 'application/x-ndjson', sha256: `sha256:${digest.digest('hex')}`, bytes, rows: rows.length };
}

function validatedWorkflowSha(value) {
  if (value === undefined && !process.env.GITHUB_ACTIONS) return 'local';
  if (typeof value !== 'string' || !/^[a-f0-9]{40}$/i.test(value)) throw new Error('called workflow SHA must be an immutable 40-character commit SHA.');
  return value.toLowerCase();
}

function requiredEnvironmentOrConfig(label, option, configured, environmentKey) {
  const value = option ?? configured ?? process.env[environmentKey];
  if (!value) throw new Error(`${label} is required via argument, configuration or ${environmentKey}.`);
  return value;
}

function githubRunId() {
  return process.env.GITHUB_RUN_ID ? `github:${process.env.GITHUB_RUN_ID}:${process.env.GITHUB_RUN_ATTEMPT ?? '1'}` : `local:${Date.now()}`;
}

function printHelp() {
  process.stdout.write('Usage: fleet-content-quality [--config path] [--dist path] [--output fleet-content-quality-evidence] [--commit sha] [--ref ref] [--run-id id] [--lockfile path] [--called-workflow-sha sha] [--caller-workflow-ref ref]\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
