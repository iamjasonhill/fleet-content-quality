import { createHash } from 'node:crypto';

export const SCHEMA_VERSION = 'fleet-content-quality-evidence.v1';
export const PRODUCER_NAME = '@moveroo/fleet-content-quality';
export const PRODUCER_VERSION = '1.0.0';
export const EXTRACTOR_VERSION = 'rendered-main-text.v1';
export const DETECTOR_VERSION = 'fleet-duplicate-signals.v1';

export function sha256(value) {
  const bytes = typeof value === 'string' || Buffer.isBuffer(value)
    ? value
    : canonicalJson(value);
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]),
  );
}

export function normalizeUrl(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Evidence URLs must use HTTP or HTTPS.');
  url.protocol = url.protocol.toLowerCase();
  url.hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  if ((url.protocol === 'https:' && url.port === '443') || (url.protocol === 'http:' && url.port === '80')) {
    url.port = '';
  }
  url.pathname = url.pathname.replace(/\/{2,}/g, '/') || '/';
  url.hash = '';
  const parameters = [...url.searchParams.entries()].sort(([left], [right]) => left.localeCompare(right));
  url.search = '';
  for (const [key, item] of parameters) url.searchParams.append(key, item);
  return url.toString();
}

export function normalizeRepository(value) {
  const ssh = value.trim().match(/^[^@]+@([^:]+):(.+)$/);
  if (ssh) return `${ssh[1].toLowerCase()}/${ssh[2].replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '').toLowerCase()}`;
  const url = new URL(value);
  return `${url.hostname.toLowerCase()}/${url.pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '').toLowerCase()}`;
}

export function pageKey(url) {
  return sha256(normalizeUrl(url));
}

export function configurationDigest(configuration) {
  return sha256(configuration);
}

export function artifactKey({ siteId, source, producer, scope }) {
  const sourceIdentity = {
    commitSha: source.commitSha.toLowerCase(),
    lockfileSha256: source.lockfileSha256,
    ref: source.ref,
    repository: normalizeRepository(source.repositoryUrl),
    runId: source.runId,
  };
  const scopeKeys = [
    'kind', 'completion', 'expectedPages', 'discoveredPages', 'processedPages',
    'excludedPages', 'failedPages', 'extractionFailureCount', 'tooShortCount',
    'capValue', 'capReached', 'exclusions', 'inventoryDigest', 'targetReferences',
  ];
  const scopeIdentity = Object.fromEntries(scopeKeys.filter((key) => Object.hasOwn(scope, key)).map((key) => [key, scope[key]]));
  const identity = {
    configurationDigest: producer.configurationDigest,
    contractMajor: 1,
    detectorVersion: producer.detectorVersion,
    extractorVersion: producer.extractorVersion,
    producerName: producer.name,
    producerVersion: producer.version,
    schemaVersion: SCHEMA_VERSION,
    scopeDigest: sha256(scopeIdentity),
    siteId,
    sourceIdentity,
    sourceKind: 'repository_build',
  };
  return `fcqe:${siteId}:repository_build:${sha256(identity).slice(7)}`;
}

export function clusterKey({ artifactKey: artifact, configurationDigest: digest, siteId }, kind, memberPageKeys) {
  return `fcqc:${siteId}:${sha256({
    artifactKey: artifact,
    configurationDigest: digest,
    kind,
    memberPageKeys: [...memberPageKeys].sort(),
  }).slice(7)}`;
}

export function findingKey({ artifactKey: artifact }, kind, ruleId, clusterId, subjectPageKeys) {
  return `fcqf:${sha256({
    artifactKey: artifact,
    clusterKey: clusterId,
    kind,
    ruleId,
    subjectPageKeys: [...subjectPageKeys].sort(),
  }).slice(7)}`;
}
