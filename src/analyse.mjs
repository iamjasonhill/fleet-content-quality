import { readFile, readdir } from 'node:fs/promises';
import { relative, sep } from 'node:path';
import { pageKey, normalizeUrl, sha256 } from './contract.mjs';

const REMOVED_BLOCKS = ['script', 'style', 'noscript', 'template', 'svg', 'nav', 'footer', 'form'];

export async function analyseRenderedSite({ dist, canonicalUrl, configuration }) {
  const files = (await collectHtmlFiles(dist)).sort();
  const pages = [];
  for (const file of files) {
    const bytes = await readFile(file);
    const html = bytes.toString('utf8');
    const url = routeUrl(canonicalUrl, relative(dist, file));
    pages.push(analysePage({ html, bytes, url, configuration }));
  }
  if (pages.length === 0) throw new Error('Rendered inventory is empty; complete evidence cannot be produced.');
  const homepage = pageKey(normalizeUrl(new URL('/', canonicalUrl).toString()));
  if (!pages.some((page) => page.pageKey === homepage)) throw new Error('Rendered inventory does not contain the canonical homepage.');
  const { clusterSpecs, comparisonCount, candidateCapReached } = detectFindings(pages, configuration);
  return { pages, clusterSpecs, comparisonCount, candidateCapReached, files };
}

async function collectHtmlFiles(directory) {
  const results = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = `${directory}${sep}${entry.name}`;
    if (entry.isDirectory()) results.push(...await collectHtmlFiles(path));
    else if (entry.isFile() && entry.name.endsWith('.html')) results.push(path);
  }
  return results;
}

export function routeUrl(canonicalUrl, relativePath) {
  const normalized = relativePath.split(sep).join('/');
  let route = normalized === 'index.html'
    ? '/'
    : normalized.endsWith('/index.html')
      ? `/${normalized.slice(0, -'index.html'.length)}`
      : `/${normalized}`;
  return normalizeUrl(new URL(route, canonicalUrl).toString());
}

export function analysePage({ html, bytes = Buffer.from(html), url, configuration }) {
  const title = decodeEntities(firstMatch(html, /<title\b[^>]*>([\s\S]*?)<\/title>/i));
  const description = decodeEntities(attributeFromTag(html, 'meta', 'name', 'description', 'content'));
  const robots = attributeFromTag(html, 'meta', 'name', 'robots', 'content').toLowerCase();
  const refresh = attributeFromTag(html, 'meta', 'http-equiv', 'refresh', 'content');
  const canonicalRaw = attributeFromLink(html, 'canonical', 'href');
  let canonical = { state: 'missing' };
  if (canonicalRaw) {
    try {
      const canonicalUrl = normalizeUrl(new URL(canonicalRaw, url).toString());
      canonical = { state: canonicalUrl === normalizeUrl(url) ? 'self' : 'other', pageKey: pageKey(canonicalUrl), url: canonicalUrl };
    } catch {
      canonical = { state: 'invalid' };
    }
  }
  const mainMatch = html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i);
  const extractionMode = mainMatch ? 'main' : 'body_fallback';
  const source = mainMatch?.[1] ?? firstMatch(html, /<body\b[^>]*>([\s\S]*?)<\/body>/i);
  const normalizedMain = normalizeText(stripRemovedBlocks(source));
  const words = normalizedMain ? normalizedMain.split(' ') : [];
  const wordCount = words.length;
  const status = normalizedMain === '' ? 'failed' : wordCount < configuration.minimumWords ? 'too_short' : 'success';
  const reliability = status === 'success' ? 'eligible' : status === 'too_short' ? 'unreliable' : 'unavailable';
  const h1 = decodeEntities(firstMatch(source, /<h1\b[^>]*>([\s\S]*?)<\/h1>/i));
  const shingles = status === 'failed' ? new Uint32Array() : shingleHashes(words, configuration.shingleWords);
  const signature = minHash(shingles, configuration.minHashSeeds);
  const hashes = {
    fullDocumentSha256: sha256(bytes),
    normalizedMainContentSha256: normalizedMain ? sha256(normalizedMain) : null,
    pageChangeSha256: sha256(`${normalizeText(title)}\n${normalizeText(description)}\n${normalizeText(h1)}\n${normalizedMain}`),
    titleSha256: title ? sha256(normalizeText(title)) : null,
    descriptionSha256: description ? sha256(normalizeText(description)) : null,
    h1Sha256: h1 ? sha256(normalizeText(h1)) : null,
  };
  return {
    pageKey: pageKey(url),
    url,
    family: { key: pageFamily(url), source: 'producer', classifier: 'first-path-segment.v1' },
    indexability: {
      state: refresh ? 'redirect' : /(?:^|,)\s*noindex\b/i.test(robots) ? 'noindex' : 'indexable',
      basis: refresh ? 'rendered_meta_refresh' : 'rendered_meta_robots',
    },
    canonical,
    extraction: {
      status,
      mode: status === 'failed' ? 'none' : extractionMode,
      reliability,
      wordCount: status === 'failed' ? null : wordCount,
      ...(status === 'success' ? {} : { nullReason: status === 'failed' ? 'empty_rendered_main_text' : 'below_minimum_words' }),
    },
    hashes,
    sketch: {
      algorithm: 'minhash-32.v1',
      shingleCount: shingles.length,
      signature: `base64:${Buffer.from(signature.buffer).toString('base64')}`,
      parameters: { shingleWords: configuration.shingleWords, seeds: configuration.minHashSeeds, bands: configuration.lshBands },
    },
    _analysis: { normalizedTitle: normalizeText(title), normalizedDescription: normalizeText(description), shingles, signature },
  };
}

export function detectFindings(pages, configuration) {
  const clusterSpecs = [];
  addGroupedClusters(clusterSpecs, pages, 'exact_full_document_duplicate', 'exact-full-document.v1', (page) => page.hashes.fullDocumentSha256);
  addGroupedClusters(clusterSpecs, pages, 'exact_normalized_main_duplicate', 'exact-normalized-main.v1', (page) => page.hashes.normalizedMainContentSha256);
  addGroupedClusters(clusterSpecs, pages, 'duplicate_title', 'duplicate-title.v1', (page) => page.hashes.titleSha256);
  addGroupedClusters(clusterSpecs, pages, 'duplicate_description', 'duplicate-description.v1', (page) => page.hashes.descriptionSha256);
  addGroupedClusters(clusterSpecs, pages, 'duplicate_h1', 'duplicate-h1.v1', (page) => page.hashes.h1Sha256);

  let comparisonCount = 0;
  const similaritySignals = new Map();
  const compareCandidate = (leftIndex, rightIndex) => {
    comparisonCount++;
    const left = pages[leftIndex];
    const right = pages[rightIndex];
    if (left.extraction.reliability !== 'eligible' || right.extraction.reliability !== 'eligible') return;
    const { resemblance, containment } = compareSortedSets(left._analysis.shingles, right._analysis.shingles);
    const differentOwners = left.canonical.pageKey && right.canonical.pageKey && left.canonical.pageKey !== right.canonical.pageKey;
    const calibrated = resemblance >= configuration.calibratedResemblance
      && left._analysis.normalizedTitle !== ''
      && left._analysis.normalizedTitle === right._analysis.normalizedTitle
      && left._analysis.normalizedDescription !== ''
      && left._analysis.normalizedDescription === right._analysis.normalizedDescription
      && differentOwners;
    const kinds = [];
    if (calibrated) kinds.push('calibrated_duplicate_owner_candidate');
    if (resemblance >= configuration.highResemblance) kinds.push('high_resemblance_candidate');
    if (containment >= configuration.containment) kinds.push('asymmetric_containment_candidate');
    if (resemblance >= configuration.templateResemblance && resemblance < configuration.highResemblance) kinds.push('template_similarity_risk');
    for (const kind of kinds) {
      if (!similaritySignals.has(kind)) similaritySignals.set(kind, new SignalComponents(pages.length));
      similaritySignals.get(kind).add(leftIndex, rightIndex, resemblance, containment);
    }
  };
  const { capReached: candidateCapReached } = forEachLshCandidate(pages, configuration, compareCandidate);
  for (const [kind, components] of similaritySignals) {
    for (const component of components.results()) {
      clusterSpecs.push({
        kind,
        ruleId: `${kind}.v1`,
        memberIndexes: component.members,
        metrics: {
          pairCount: component.pairCount,
          minimumResemblance: component.minimumResemblance,
          maximumResemblance: component.maximumResemblance,
          maximumContainment: component.maximumContainment,
        },
      });
    }
  }
  for (let index = 0; index < pages.length; index++) {
    const page = pages[index];
    if (page.extraction.status === 'failed') clusterSpecs.push({ kind: 'extraction_failure', ruleId: 'rendered-extraction.v1', memberIndexes: [index], metrics: {} });
    if (page.extraction.status === 'too_short') clusterSpecs.push({ kind: 'short_page_unreliable', ruleId: 'minimum-main-words.v1', memberIndexes: [index], metrics: { wordCount: page.extraction.wordCount } });
  }
  return { clusterSpecs, comparisonCount, candidateCapReached };
}

export function materializeFindings(pages, clusterSpecs, manifestIdentity) {
  const clusters = [];
  const findings = [];
  for (const spec of clusterSpecs) {
    const members = [...new Set(spec.memberIndexes.map((index) => pages[index].pageKey))].sort();
    const clusterId = `fcqc:${manifestIdentity.siteId}:${sha256({
      artifactKey: manifestIdentity.artifactKey,
      configurationDigest: manifestIdentity.configurationDigest,
      kind: spec.kind,
      memberPageKeys: members,
    }).slice(7)}`;
    clusters.push({
      clusterId,
      kind: spec.kind,
      representativePageKey: members[0],
      memberPageKeys: members,
      configurationDigest: manifestIdentity.configurationDigest,
      metrics: spec.metrics,
    });
    findings.push({
      findingKey: `fcqf:${sha256({
        artifactKey: manifestIdentity.artifactKey,
        clusterKey: clusterId,
        kind: spec.kind,
        ruleId: spec.ruleId,
        subjectPageKeys: members,
      }).slice(7)}`,
      kind: spec.kind,
      clusterId,
      ruleId: spec.ruleId,
      confidence: findingConfidence(spec.kind),
      subjectPageKeys: members,
      metrics: spec.metrics,
      reason: findingReason(spec.kind),
    });
  }
  return { clusters, findings };
}

function addGroupedClusters(output, pages, kind, ruleId, keyForPage) {
  const groups = new Map();
  for (let index = 0; index < pages.length; index++) {
    const key = keyForPage(pages[index]);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(index);
  }
  for (const members of groups.values()) {
    if (members.length > 1) output.push({ kind, ruleId, memberIndexes: members, metrics: { memberCount: members.length } });
  }
}

function forEachLshCandidate(pages, configuration, callback) {
  const buckets = new Map();
  const rowsPerBand = configuration.minHashSeeds / configuration.lshBands;
  for (let index = 0; index < pages.length; index++) {
    const page = pages[index];
    if (page.extraction.reliability !== 'eligible') continue;
    for (let band = 0; band < configuration.lshBands; band++) {
      const start = band * rowsPerBand;
      const key = `${band}:${[...page._analysis.signature.slice(start, start + rowsPerBand)].join(':')}`;
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(index);
    }
  }
  const possiblePairs = pages.length * (pages.length - 1) / 2;
  const seen = new Uint8Array(Math.ceil(possiblePairs / 8));
  let comparisonCount = 0;
  let capReached = false;
  const addPair = (left, right) => {
    if (left === right || capReached) return;
    const smaller = Math.min(left, right);
    const larger = Math.max(left, right);
    const pairIndex = smaller * pages.length - smaller * (smaller + 1) / 2 + (larger - smaller - 1);
    const byteIndex = Math.floor(pairIndex / 8);
    const mask = 1 << (pairIndex % 8);
    if ((seen[byteIndex] & mask) !== 0) return;
    if (comparisonCount >= configuration.maximumCandidateComparisons) {
      capReached = true;
      return;
    }
    seen[byteIndex] |= mask;
    callback(smaller, larger);
    comparisonCount++;
  };
  for (const members of buckets.values()) {
    if (capReached) break;
    const sorted = [...new Set(members)].sort((a, b) => a - b);
    for (let left = 0; left < sorted.length && !capReached; left++) {
      for (let right = left + 1; right < sorted.length && !capReached; right++) addPair(sorted[left], sorted[right]);
    }
  }
  return { capReached, comparisonCount };
}

class SignalComponents {
  constructor(size) {
    this.parent = new Int32Array(size).fill(-1);
    this.rank = new Uint8Array(size);
    this.pairCount = new Float64Array(size);
    this.minimumResemblance = new Float64Array(size).fill(Number.POSITIVE_INFINITY);
    this.maximumResemblance = new Float64Array(size);
    this.maximumContainment = new Float64Array(size);
  }

  add(left, right, resemblance, containment) {
    this.initialize(left);
    this.initialize(right);
    let leftRoot = this.find(left);
    let rightRoot = this.find(right);
    if (leftRoot !== rightRoot) {
      if (this.rank[leftRoot] < this.rank[rightRoot]) [leftRoot, rightRoot] = [rightRoot, leftRoot];
      this.parent[rightRoot] = leftRoot;
      if (this.rank[leftRoot] === this.rank[rightRoot]) this.rank[leftRoot]++;
      this.pairCount[leftRoot] += this.pairCount[rightRoot];
      this.minimumResemblance[leftRoot] = Math.min(this.minimumResemblance[leftRoot], this.minimumResemblance[rightRoot]);
      this.maximumResemblance[leftRoot] = Math.max(this.maximumResemblance[leftRoot], this.maximumResemblance[rightRoot]);
      this.maximumContainment[leftRoot] = Math.max(this.maximumContainment[leftRoot], this.maximumContainment[rightRoot]);
    }
    this.pairCount[leftRoot]++;
    this.minimumResemblance[leftRoot] = Math.min(this.minimumResemblance[leftRoot], resemblance);
    this.maximumResemblance[leftRoot] = Math.max(this.maximumResemblance[leftRoot], resemblance);
    this.maximumContainment[leftRoot] = Math.max(this.maximumContainment[leftRoot], containment);
  }

  results() {
    const members = new Map();
    for (let index = 0; index < this.parent.length; index++) {
      if (this.parent[index] === -1) continue;
      const root = this.find(index);
      if (!members.has(root)) members.set(root, []);
      members.get(root).push(index);
    }
    return [...members.entries()].map(([root, indexes]) => ({
      members: indexes,
      pairCount: this.pairCount[root],
      minimumResemblance: this.minimumResemblance[root],
      maximumResemblance: this.maximumResemblance[root],
      maximumContainment: this.maximumContainment[root],
    }));
  }

  initialize(index) {
    if (this.parent[index] === -1) this.parent[index] = index;
  }

  find(index) {
    let root = index;
    while (this.parent[root] !== root) root = this.parent[root];
    while (this.parent[index] !== index) {
      const next = this.parent[index];
      this.parent[index] = root;
      index = next;
    }
    return root;
  }
}

function compareSortedSets(left, right) {
  let leftIndex = 0;
  let rightIndex = 0;
  let intersection = 0;
  while (leftIndex < left.length && rightIndex < right.length) {
    if (left[leftIndex] === right[rightIndex]) { intersection++; leftIndex++; rightIndex++; }
    else if (left[leftIndex] < right[rightIndex]) leftIndex++;
    else rightIndex++;
  }
  const union = left.length + right.length - intersection;
  return {
    resemblance: union === 0 ? 0 : round(intersection / union),
    containment: Math.min(left.length, right.length) === 0 ? 0 : round(intersection / Math.min(left.length, right.length)),
  };
}

function shingleHashes(words, width) {
  if (words.length < width) return new Uint32Array();
  const values = new Set();
  for (let index = 0; index <= words.length - width; index++) values.add(hash32(words.slice(index, index + width).join(' '), 0));
  return Uint32Array.from([...values].sort((a, b) => a - b));
}

function minHash(shingles, count) {
  const signature = new Uint32Array(count).fill(0xffffffff);
  for (const shingle of shingles) {
    for (let seed = 0; seed < count; seed++) signature[seed] = Math.min(signature[seed], mix32(shingle, seed + 1));
  }
  return signature;
}

function hash32(value, seed) {
  let hash = (2166136261 ^ seed) >>> 0;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash;
}

function mix32(value, seed) {
  let hash = (value ^ Math.imul(seed, 0x9e3779b1)) >>> 0;
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b) >>> 0;
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2ae35) >>> 0;
  return (hash ^ (hash >>> 16)) >>> 0;
}

function stripRemovedBlocks(value) {
  let output = value;
  for (const tag of REMOVED_BLOCKS) output = output.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi'), ' ');
  return output;
}

function normalizeText(value) {
  return decodeEntities(value.replace(/<[^>]+>/g, ' ')).normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

function decodeEntities(value) {
  return value
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([a-f0-9]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/\s+/g, ' ')
    .trim();
}

function firstMatch(value, pattern) {
  return value.match(pattern)?.[1] ?? '';
}

function attributeFromTag(html, tag, selectorName, selectorValue, targetName) {
  const tags = html.match(new RegExp(`<${tag}\\b[^>]*>`, 'gi')) ?? [];
  for (const candidate of tags) {
    const attributes = parseAttributes(candidate);
    if ((attributes[selectorName] ?? '').toLowerCase() === selectorValue.toLowerCase()) return attributes[targetName] ?? '';
  }
  return '';
}

function attributeFromLink(html, rel, targetName) {
  const tags = html.match(/<link\b[^>]*>/gi) ?? [];
  for (const candidate of tags) {
    const attributes = parseAttributes(candidate);
    if ((attributes.rel ?? '').toLowerCase().split(/\s+/).includes(rel)) return attributes[targetName] ?? '';
  }
  return '';
}

function parseAttributes(tag) {
  const attributes = {};
  for (const match of tag.matchAll(/([:\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) attributes[match[1].toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? '';
  return attributes;
}

function pageFamily(url) {
  return new URL(url).pathname.split('/').filter(Boolean)[0] ?? 'home';
}

function findingConfidence(kind) {
  if (kind.startsWith('exact_') || kind.startsWith('duplicate_')) return 'exact';
  if (kind === 'calibrated_duplicate_owner_candidate') return 'calibrated_candidate';
  if (kind === 'short_page_unreliable' || kind === 'extraction_failure') return 'unreliable';
  return kind === 'high_resemblance_candidate' ? 'high' : 'medium';
}

function findingReason(kind) {
  const reasons = {
    exact_full_document_duplicate: 'Distinct rendered URLs have identical full-document hashes.',
    exact_normalized_main_duplicate: 'Distinct rendered URLs have identical normalized main-content hashes.',
    duplicate_title: 'Distinct rendered URLs share one non-empty title hash.',
    duplicate_description: 'Distinct rendered URLs share one non-empty description hash.',
    duplicate_h1: 'Distinct rendered URLs share one non-empty H1 hash.',
    calibrated_duplicate_owner_candidate: 'Pages meet the calibrated resemblance, metadata, word-count and distinct-canonical-owner conjunction.',
    high_resemblance_candidate: 'Pages have high rendered main-content resemblance but do not meet the calibrated owner-conflict rule.',
    asymmetric_containment_candidate: 'One rendered main-content shingle set is substantially contained by another.',
    template_similarity_risk: 'Rendered pages share substantial template or repeated-content evidence.',
    extraction_failure: 'No usable rendered main text could be extracted.',
    short_page_unreliable: 'Rendered main text is below the minimum word count for similarity decisions.',
  };
  return reasons[kind];
}

function round(value) {
  return Math.round(value * 1_000_000) / 1_000_000;
}
