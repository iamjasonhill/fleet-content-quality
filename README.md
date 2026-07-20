# Fleet Content Quality

`@moveroo/fleet-content-quality` is the evidence-only Node 22 runner and reusable
GitHub Actions workflow for the reviewed Moveroo fleet pilot.

It runs after a site repository has completed its own immutable lockfile install,
contract check, Astro check, and production build. It scans rendered `dist/` HTML
and emits `fleet-content-quality-evidence.v1` without retaining HTML, page bodies,
normalised text, excerpts, or cleanup instructions.

The runner reports separate exact-document, exact-main, metadata, calibrated
duplicate-owner, high-resemblance, containment, template-risk, extraction, and
short-page evidence. Findings are evidence, not severity or remediation decisions.

## Site configuration

Each explicitly approved pilot repository owns `.fleet-content-quality.json`:

```json
{
  "site": {
    "coreSiteId": 4,
    "canonicalDomain": "movingcars.com.au",
    "canonicalUrl": "https://movingcars.com.au"
  },
  "repository": {
    "url": "https://github.com/iamjasonhill/astrosites2026"
  },
  "approvalReference": "github:issue:762#pilot",
  "optionalChecks": {
    "language": "unsupported",
    "seo": "declared_by_repository"
  }
}
```

This configuration identifies evidence production for an already reviewed pilot.
V1 fails closed unless the Site/domain/repository tuple is one of the three
issue-#762 pilots and, in Actions, matches the checked-out repository. It does
not infer or activate Standards applicability.

## Authority boundary

The package and workflow never deploy, publish, submit IndexNow, merge, rewrite,
select canonical owners, mutate providers, activate Standards, or approve cleanup.
Transport artifacts expire after 14 days; Bossman's typed Route Quality Evidence
records are the durable evidence owner.
