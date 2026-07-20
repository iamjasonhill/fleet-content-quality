import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analysePage, detectFindings, materializeFindings, routeUrl } from '../src/analyse.mjs';
import { artifactKey, configurationDigest, normalizeUrl, pageKey, sha256 } from '../src/contract.mjs';

const configuration = {
  minimumWords: 5, shingleWords: 2, minHashSeeds: 20, lshBands: 5,
  maximumCandidateComparisons: 1_000, calibratedResemblance: 0.95,
  highResemblance: 0.95, containment: 0.8, templateResemblance: 0.8,
};

test('normalizes routes and contract identities deterministically', () => {
  assert.equal(routeUrl('https://example.test', 'index.html'), 'https://example.test/');
  assert.equal(routeUrl('https://example.test', 'routes/one/index.html'), 'https://example.test/routes/one/');
  assert.equal(normalizeUrl('HTTPS://EXAMPLE.TEST:443/a//b?z=2&a=1#x'), 'https://example.test/a/b?a=1&z=2');
  assert.equal(pageKey('https://example.test/'), sha256('https://example.test/'));
});

test('extracts evidence without retaining page bodies', () => {
  const page = analysePage({
    url: 'https://example.test/route/', configuration,
    html: '<html><head><title>A Route</title><meta name="description" content="Route description"><link rel="canonical" href="https://example.test/route/"></head><body><nav>noise</nav><main><h1>A Route</h1>one two three four five six</main><footer>noise</footer></body></html>',
  });
  assert.equal(page.extraction.status, 'success');
  assert.equal(page.canonical.state, 'self');
  assert.equal(page.extraction.wordCount, 8);
  assert.ok(!JSON.stringify(page).includes('one two three'));
});

test('emits the calibrated duplicate-owner candidate as evidence only', () => {
  const makePage = (url) => analysePage({
    url, configuration,
    html: `<html><head><title>Same Route</title><meta name="description" content="Same description"><link rel="canonical" href="${url}"></head><body><main><h1>Same</h1>one two three four five six seven eight nine ten</main></body></html>`,
  });
  const pages = [makePage('https://example.test/a/'), makePage('https://example.test/b/')];
  const detected = detectFindings(pages, configuration);
  const artifact = 'fcqe:1:repository_build:'.concat('a'.repeat(64));
  const result = materializeFindings(pages, detected.clusterSpecs, { siteId: 1, artifactKey: artifact, configurationDigest: configurationDigest(configuration) });
  assert.ok(result.findings.some((finding) => finding.kind === 'calibrated_duplicate_owner_candidate'));
  assert.ok(result.findings.some((finding) => finding.kind === 'high_resemblance_candidate'));
  assert.ok(result.findings.some((finding) => finding.kind === 'asymmetric_containment_candidate'));
  assert.ok(result.findings.every((finding) => !Object.hasOwn(finding, 'severity')));
});

test('marks unsupported canonical schemes invalid', () => {
  const page = analysePage({
    url: 'https://example.test/', configuration,
    html: '<html><head><link rel="canonical" href="javascript:alert(1)"></head><body><main>one two three four five six</main></body></html>',
  });
  assert.equal(page.canonical.state, 'invalid');
});

test('reports a deterministic candidate cap instead of claiming complete detection', () => {
  const capped = { ...configuration, maximumCandidateComparisons: 1 };
  const makePage = (slug) => analysePage({
    url: `https://example.test/${slug}/`, configuration: capped,
    html: `<html><head><title>Same</title><meta name="description" content="Same"><link rel="canonical" href="https://example.test/${slug}/"></head><body><main>one two three four five six seven eight</main></body></html>`,
  });
  const result = detectFindings([makePage('a'), makePage('b'), makePage('c')], capped);
  assert.equal(result.candidateCapReached, true);
  assert.equal(result.comparisonCount, 1);
  const exactBoundary = detectFindings([makePage('a'), makePage('b')], capped);
  assert.equal(exactBoundary.candidateCapReached, false);
  assert.equal(exactBoundary.comparisonCount, 1);
});

test('aggregates a thousand-page common template without retaining pair edges', () => {
  const dense = { ...configuration, maximumCandidateComparisons: 1_000_000 };
  const base = analysePage({
    url: 'https://example.test/base/', configuration: dense,
    html: '<html><head><title>Same</title><meta name="description" content="Same"><link rel="canonical" href="https://example.test/base/"></head><body><main>one two three four five six seven eight</main></body></html>',
  });
  const pages = Array.from({ length: 1_000 }, (_, index) => ({
    ...base,
    pageKey: `sha256:${index.toString(16).padStart(64, '0')}`,
    canonical: { state: 'self', pageKey: `sha256:${index.toString(16).padStart(64, '0')}`, url: `https://example.test/${index}/` },
  }));
  const result = detectFindings(pages, dense);
  assert.equal(result.candidateCapReached, false);
  assert.equal(result.comparisonCount, 499_500);
  const calibrated = result.clusterSpecs.find((cluster) => cluster.kind === 'calibrated_duplicate_owner_candidate');
  assert.equal(calibrated.memberIndexes.length, 1_000);
  assert.equal(calibrated.metrics.pairCount, 499_500);
});

test('matches the Bossman artifact-key canonical identity', () => {
  const producer = {
    name: '@moveroo/fleet-content-quality', version: '1.0.0', extractorVersion: 'rendered-main-text.v1',
    detectorVersion: 'fleet-duplicate-signals.v1', configurationDigest: sha256(configuration),
  };
  const source = {
    repositoryUrl: 'git@github.com:iamjasonhill/example.git', commitSha: 'a'.repeat(40), ref: 'refs/heads/main',
    lockfileSha256: sha256('lock'), runId: 'github:1:1',
  };
  const scope = {
    kind: 'full_build', completion: 'complete', expectedPages: 1, discoveredPages: 1, processedPages: 1,
    excludedPages: 0, failedPages: 0, extractionFailureCount: 0, tooShortCount: 0, capReached: false,
    inventoryDigest: sha256(['page']),
  };
  assert.match(artifactKey({ siteId: 1, source, producer, scope }), /^fcqe:1:repository_build:[a-f0-9]{64}$/);
});
