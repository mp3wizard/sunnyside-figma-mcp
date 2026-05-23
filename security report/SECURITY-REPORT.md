# Security Report — sunnyside-figma-mcp

**Target:** `@mp3wizard/sunnyside-figma-mcp` (fork of `tercumantanumut/sunnysideFigma-Context-MCP`)
**Base commit scanned:** `ba6da85`
**Scan date:** 2026-05-23
**Standard:** OWASP APTS-aligned (Scope Enforcement · Auditability · Manipulation Resistance · Reporting)
**Toolchain:** Gitleaks, Semgrep (OWASP/TS/secrets), Trivy, TruffleHog, OSV-Scanner, mcps-audit, plus manual source review

---

## 1. Executive Summary

A full static security scan was run against the codebase, followed by manual review of the
flagged source files. **Three genuine code-level security issues were identified and fixed**, and
the dependency tree was hardened (68 → 26 advisories, with **zero remaining in the production
runtime path**).

| Area | Before | After |
|------|--------|-------|
| Code security issues (High/Med) | 3 open | **0 open** |
| Dependency advisories (total) | 68 | 26 (all dev-only) |
| Dependency advisories (runtime path) | 13+ | **0** |
| Server network exposure | all interfaces | **loopback only** |
| HTTP endpoint auth | none | Host validation + optional bearer token |

Remaining items are either out-of-scope (pre-existing repo bugs, dev-only transitive vulns) or
require a decision by the maintainer (secrets baked into upstream git history).

---

## 2. Scan Coverage

| Tool | Result |
|------|--------|
| **Gitleaks** | 6 findings — Figma file keys in git history |
| **Semgrep** (OWASP Top 10 / TypeScript / secrets) | 0 findings |
| **TruffleHog** | 0 verified (live) secrets |
| **Trivy** (pnpm-lock.yaml) | 58 dependency advisories (0 critical) |
| **OSV-Scanner** | 69 advisories across 33 packages (0 critical) |
| **mcps-audit** (OWASP MCP Top 10) | 57 findings (incl. false positives — see §5) |
| **Manual source review** | 3 genuine issues (CORS, command injection, missing auth) |
| CodeQL | Skipped — no GitHub Actions CodeQL workflow in repo |

---

## 3. Findings & Remediation (FIXED)

### 3.1 [HIGH] CORS wildcard — all origins allowed

**File:** `src/plugin-integration.ts`

The CORS `origin` callback built an `allowedOrigins` list but ended with an unconditional
`return callback(null, true)`, so the allowlist was dead code and **every origin was accepted**.
Combined with `credentials: true`, any website open in the user's browser could issue
credentialed cross-origin requests to the local MCP server and read Figma design data.

**Fix:** the final branch now rejects unlisted origins:

```ts
if (allowedOrigins.includes(origin)) {
  return callback(null, true);
}
return callback(new Error(`CORS: origin '${origin}' not allowed`));
```

### 3.2 [MEDIUM] Command injection in curl fallback

**File:** `src/utils/fetch-with-retry.ts`

The `fetch` fallback shelled out via `exec` with the URL interpolated into a command string:

```ts
const curlCommand = `curl -s -L ${curlHeaders.join(" ")} "${url}"`;
await execAsync(curlCommand);
```

A URL containing shell metacharacters (`"`, `$(...)`, backticks) could break out of the quotes
and execute arbitrary commands.

**Fix:** switched to `execFile` with an argv array (no shell), and the URL is passed after a `--`
separator so it can never be parsed as a flag or shell token:

```ts
const { stdout, stderr } = await execFileAsync("curl", curlArgs); // ["-s","-L",...,"--",url]
```

### 3.3 [MEDIUM] No authentication on HTTP endpoints

**Files:** `src/server.ts`, `src/utils/http-security.ts` (new), `src/config.ts`, `src/cli.ts`

In HTTP mode the server bound to all network interfaces and exposed `/mcp`, `/sse`, `/messages`
and all `/plugin/*` routes with no authentication. Any host on the network — and (via the CORS
hole and DNS rebinding) any website — could reach them.

**Fix — defense in depth, three layers:**

1. **Loopback bind by default.** `app.listen(port, bindHost)` with `bindHost` defaulting to
   `127.0.0.1` (configurable via `BIND_HOST` env or `--bind-host`). The server is no longer
   reachable from the network. Verified: socket listens on `127.0.0.1` only.
2. **Host-header validation (anti-DNS-rebinding).** First middleware rejects any request whose
   `Host` header is not loopback (`localhost` / `127.0.0.1` / `[::1]`, optional port). A strict
   regex blocks bypasses like `localhost.attacker.com`. `trust proxy` is set to `false` so
   `X-Forwarded-Host` cannot spoof it.
3. **Optional bearer token.** When `MCP_AUTH_TOKEN` is set, `/mcp`, `/sse` and `/messages`
   require `Authorization: Bearer <token>`, compared with `crypto.timingSafeEqual`. Plugin
   endpoints rely on the loopback bind + Host check (the Figma plugin cannot carry a secret).

---

## 4. Dependency Hardening (FIXED)

Audit reduced **68 → 26** advisories. Steps taken:

| Action | Effect |
|--------|--------|
| Removed `vercel` (declared dependency, never imported) | −16 advisories, zero risk |
| Updated `js-yaml` 4.1.0 → 4.1.1 (within `^4.1.0`) | −1 advisory |
| Added scoped `pnpm.overrides` | patched remaining runtime-path transitives |

Scoped overrides applied (each pinned to the parent's range so it cannot break siblings):

```jsonc
"pnpm": { "overrides": {
  "path-to-regexp@0.1": "0.1.13",   // express 4
  "path-to-regexp@^8": "8.4.0",     // @modelcontextprotocol/sdk
  "qs@^6.13": "6.15.2",             // express
  "hono": ">=4.12.18",              // @modelcontextprotocol/sdk
  "fast-uri": ">=3.1.2",
  "ip-address": ">=10.1.1"
}}
```

Resolved versions verified: hono 4.12.22, fast-uri 3.1.2, ip-address 10.2.0,
path-to-regexp 0.1.13 + 8.4.0, qs 6.15.2.

---

## 5. Remaining Issues (NOT fixed — by decision or out of scope)

### 5.1 Secrets in git history (6) — requires maintainer decision
Figma **file keys** (not access tokens) are committed in `test-simple.mjs`,
`test-pagination.mjs`, and `docs/asset-management/README.md` in upstream history.
TruffleHog confirmed **none are live-verified secrets**; a file key alone grants no API access.
They cannot be removed without rewriting git history (`git filter-repo`). **Risk: low.**
Recommendation: if adopting this fork long-term, rotate the keys and rewrite history.

### 5.2 Dev-only dependency vulnerabilities (26) — intentionally deferred
All 26 remaining advisories come through dev tooling — eslint (9), @typescript-eslint (5),
tsup/esbuild (4), changesets (3), ts-jest (3), jest (1), tsx (1) — and **none ship in the
production runtime**. Forcing overrides on `esbuild`/`rollup` risks breaking the bundler
contract. Recommendation: address by bumping the dev tools' major versions when convenient.

### 5.3 `npm run lint` is broken — pre-existing
The `lint` script uses the removed `--ext .ts` flag and there is no `eslint.config.js`
(ESLint 9 flat-config). Pre-existing; unrelated to security. Fix by migrating to flat config.

### 5.4 Dead route `/plugin/assets/:nodeId` — pre-existing functional bug
The Figma plugin POSTs to this endpoint (`figma-dev-plugin/code.js:1124`) but the server has
**no handler** for it, so asset uploads silently fail. Functional bug, not a security issue.

### 5.5 mcps-audit "CRITICAL" in plugin code — false positives
`figma-dev-plugin/code.js:1058` (`assets.map(...)`) and `:1166` were flagged as
"dangerous execution / injection". Manual review confirmed these are ordinary JavaScript array
transforms. **No action required.**

---

## 6. Verification Evidence

- `npm run type-check` — clean (0 errors, TypeScript 5.7.3)
- `npm run build` — success (tsup ESM + DTS)
- `pnpm install` — no range conflicts after overrides
- `pnpm audit` — 26 advisories, all dev-only (runtime-path = 0)
- **Runtime security matrix (8/8 passing):**

  | Test | Expected | Result |
  |------|----------|--------|
  | `/plugin/health` loopback, no token | 200 | ✅ |
  | `Host: evil.com` | 403 | ✅ |
  | `Host: localhost.attacker.com` (bypass) | 403 | ✅ |
  | `/mcp` no token (when MCP_AUTH_TOKEN set) | 401 | ✅ |
  | `/mcp` wrong token | 401 | ✅ |
  | `/mcp` correct token | 400 (passes auth, app-level) | ✅ |
  | `/sse` no token | 401 | ✅ |
  | plugin POST `figma-dev-data` | 200 | ✅ |

- Loopback bind confirmed via `lsof`: `TCP 127.0.0.1:<port> (LISTEN)`.

---

## 7. Changed Files

| File | Change |
|------|--------|
| `src/plugin-integration.ts` | CORS allowlist now enforced |
| `src/utils/fetch-with-retry.ts` | `execFile` + argv (no shell) |
| `src/utils/http-security.ts` | **new** — Host validation + bearer-token middleware |
| `src/server.ts` | loopback bind, Host middleware, auth on MCP/SSE routes, startup warning |
| `src/config.ts` | `bindHost` config (`BIND_HOST` env / `--bind-host`) |
| `src/cli.ts` | pass `bindHost` to server |
| `package.json` | removed `vercel`, js-yaml bump, `pnpm.overrides` |
| `pnpm-lock.yaml` | regenerated |
