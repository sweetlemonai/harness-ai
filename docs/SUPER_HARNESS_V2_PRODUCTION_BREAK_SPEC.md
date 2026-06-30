# Super Harness v2 Production Break Specification

Status: accepted-for-implementation, production-promotion-blocked
Created: 2026-06-30
Parent spec: `docs/SUPER_HARNESS_V2_SPEC.md`
Scope: take Super Harness v2 from alpha protocol producer to production promotion readiness.

## 1. Meaning of Production Break

Production break is the controlled break point between alpha evidence production and production authority. It is not a permission to cause an outage, skip evidence, or silently weaken policy. It is the promotion program that proves the harness can run production-sensitive, distributed, tenant-aware, multi-agent work with hard gates, rollback, and audit.

This spec covers two paths:

1. Normal production promotion: a staged path from alpha sidecars to production-side promotion.
2. Break-glass production repair: a constrained emergency path for restoring service when waiting for the full promotion path would cause greater harm.

Break-glass is not a bypass. It is a smaller, separately signed decision with stricter blast-radius limits, shorter expiry, mandatory post-hoc proof completion, and automatic rollback or quarantine if delayed gates fail.

## 2. Current Evidence Snapshot

The local V1 inventory source used for this spec council was:

```text
http://127.0.0.1:8850/v1/models
```

Fleet doctor result from 2026-06-30:

| Metric | Value |
| --- | ---: |
| V1 model records | 35 |
| Active local members with upstreams | 5 |
| Hosted or no-direct-upstream records skipped | 30 |
| Unreachable active members | 0 |
| Missing configured models | 0 |
| Smoke failures | 0 |
| V1 consensus witnesses configured | 0 |

Active local members observed by the harness:

| Member | Model | Endpoint | Context | p95 latency | p50 tok/s | Primary role |
| --- | --- | --- | ---: | ---: | ---: | --- |
| `mlx-100-121-76-126-8001` | `renderbox2-gemma4-26b-a4b-awq` / `google/gemma-4-26B-A4B-it` | `http://100.121.76.126:8001` | 76,800 | 4.669s | 62.56 | Fast draft / realtime |
| `mlx-192-168-6-1-8000` | `Step-3.7-Flash` | `http://192.168.6.1:8000` | 204,800 | 27.419s | 16.07 | Long-context deep knowledge |
| `mlx-192-168-6-0-8000` | `ornith-1.0-35b` | `http://192.168.6.0:8000` | unknown in summary | 19.004s | 75.07 | Review / reasoning |
| `mlx-192-168-5-246-8000` | `deepseek-v4-flash` | `http://192.168.5.246:8000` | 17,820 | 55.598s | 24.87 | Deep reasoning |
| `mlx-192-168-5-255-8000` | `diffusiongemma_26b_a4b_it_nvfp4_tp1` | `http://192.168.5.255:8000` | 26,214 | unknown in summary | unknown in summary | Experimental language |

These numbers are seed evidence only. Production gates must re-read the live V1 inventory and recent telemetry at decision time. Static numbers in this file cannot become routing authority.

## 3. Mandatory Fleet Council

Every production-break spec change requires a fleet council record before the spec can move from draft to accepted.

### 3.1 Participation Rule

All live active local members returned by the V1 inventory must be invited and must receive a durable v2 request. A member is live active when:

- it is advertised by the primary V1 source,
- it has a direct upstream endpoint,
- its upstream `/v1/models` advertises the selected request model,
- it is not disabled by policy overlay,
- it is not already quarantined by evidence.

No member may be silently skipped. If a live active member does not respond before the bounded council deadline, the result is `blocked_member_timeout` unless an operator signs an availability exception with a repair ticket and blast-radius limit.

### 3.2 Dissent Rule

At least two evidence-bound dissents are required before the spec can be accepted. The purpose is not theatre. The spec must survive material objections.

A dissent counts only when the response is machine-parseable JSON with:

```json
{
  "stance": "dissent",
  "strongest_weaknesses": ["..."],
  "recommended_repairs": ["..."],
  "evidence_needed": ["..."],
  "residual_risk": "...",
  "confidence": 0.85
}
```

`residual_risk` is a string, not an array. Markdown-fenced JSON is allowed only if the parser extracts it cleanly. Unstructured concern text is preserved as advice but counts as `uncertain`, not dissent.

### 3.3 Council Deadline Controller

The first council round observed response durations of about 3.647s, 8.310s, 9.526s, 53.025s, and 96.907s. The production controller starts with:

- seed council timeout: 120s,
- floor: 30s,
- cap: 180s,
- recovery: lower by at most 15s after three consecutive councils where p95 response time is below half the current timeout,
- pressure behavior: raise by at most 30s when a live member times out but its endpoint remains healthy,
- disable switch: operator may pin the timeout for a single council, with reason and expiry.

The controller must log configured timeout, effective timeout, member durations, timeout reason, pressure signals, and final council verdict.

## 4. First Council Result

Command:

```text
harness agentops advise --run-dir tmp/production-break-spec-council --v1-url http://127.0.0.1:8850 --min-dissenters 2 --timeout-ms 120000 --max-tokens 1600 --json
```

Observed result:

| Field | Value |
| --- | --- |
| Verdict | `blocked_insufficient_dissent` |
| Active members | 5 |
| Successes | 5 |
| Failures | 0 |
| Counted evidence-bound dissent | 1 of 2 |
| Material dissent present | yes |
| Control signal | `request_dissent` |

This result blocked acceptance of the first draft. Material dissents were accepted below and repaired in this document.

## 4A. Repaired Council Results

Round two reviewed the repaired spec and produced two counted evidence-bound dissents, but the verdict was `blocked_adapter_failure` because `ornith-1.0-35b` returned reasoning without assistant content. That failure is preserved as evidence that production councils need strict content-contract retries and adapter-failure handling.

Round three used a stricter assistant-content-only prompt and cleared the council mechanics:

| Field | Value |
| --- | --- |
| Run directory | `tmp/production-break-spec-council-round3` |
| Verdict | `survives` |
| Active members | 5 |
| Successes | 5 |
| Failures | 0 |
| Counted evidence-bound dissent | 5 of 2 |
| Skipped no-upstream records | 30 |
| Control signal | `gather_more_evidence` |

This does not mean production is ready. It means the spec process survived mandatory local-fleet participation and dissent. All five round-three members dissented that production promotion must remain blocked until the open blockers in Section 11 are closed with evidence.

## 5. Dissent Register and Repairs

| ID | Dissent | Status | Repair in this spec |
| --- | --- | --- | --- |
| D-001 | Requiring all live members to participate can create liveness deadlock. | Accepted | All members must be invited and receipted, but production decisions use explicit modes: normal promotion requires all required roles or signed exception; emergency break-glass uses quorum plus blast-radius limits and post-hoc completion. |
| D-002 | Gates are named but lack definitions of done. | Accepted | Section 8 defines hard gates with measurable evidence. |
| D-003 | Mandatory dissent can become a checkbox. | Accepted | Section 3.2 defines a strict schema, two counted dissents, and resolution requirements. |
| D-004 | V1 inventory consensus is undefined. | Accepted | Section 7 defines primary V1 authority plus witness vetoes, conflict handling, and no config-only authority. |
| D-005 | Production-break semantics are missing. | Accepted | Section 6 defines stages, emergency path, rollback, and promotion semantics. |
| D-006 | RLL/RSI gate terms need concrete criteria. | Accepted | Section 8.6 defines RLL/RSI pass/fail criteria and alpha-to-production transition limits. |
| D-007 | Proof readiness is vague. | Accepted | Section 8.5 defines proof modes, freshness, latency, and fail-closed behavior. |
| D-008 | Identity provider or PKI failure can deadlock distributed delivery. | Accepted | Section 8.1 and Section 11 define identity recovery and degraded states. |
| D-009 | Heavy gates can raise MTTR during emergencies. | Accepted | Section 6.4 defines break-glass limits, expiry, and automatic quarantine. |
| D-010 | Unstructured or malformed model output can hide dissent. | Accepted | Section 3.2 and Section 10 require strict parser feedback and rerun on contract failures. |

No dissent is rejected in this draft. Any later rejection must cite evidence and an operator resolution receipt.

## 6. Promotion Stages

### 6.1 P0: Production-Shaped Alpha

Goal: prove local sidecars, replay, evidence, RLL, RSI recommendations, and AgentOps exports without production authority.

Required:

- `npm run typecheck`, `npm test`, and `npm run build` pass.
- `harness protocol doctor --profile alpha` is green.
- `harness rll doctor --audit full` is green.
- `harness agentops export` produces replayable JSON.
- No RSI candidate has status `applied`.
- Proof records may be `not_requested`, `proof_unavailable`, or `mock_transcript`, but must not claim real proof.

Exit: eligible for shadow production recording only.

### 6.2 P1: Shadow Production

Goal: record production-like evidence without controlling production behavior.

Required:

- sidecar signing configured in production-capable shape,
- V1 primary inventory source present,
- at least one V1 witness or an operator-signed witness-deferral receipt,
- all production gates run report-only,
- production blockers are recorded but do not mutate live behavior.

Exit: eligible for canary only after two consecutive shadow runs produce identical projection roots for the same replay input.

### 6.3 P2: Canary Production

Goal: allow limited production authority for low-risk, reversible actions.

Required:

- production doctor green,
- cryptographic identity verified,
- V1 witness checks pass,
- rollback rehearsal completed inside the last 7 days,
- privacy preflight blocks hosted/off-stack leaks before network I/O,
- AgentOps council has at least two counted dissents resolved or operator-overruled with reasons.

Initial canary seed:

- eligible traffic: local-only or sanitized workspace tasks,
- ceiling: one production task at a time,
- max duration: 30 minutes,
- automatic rollback on any production doctor red issue, privacy block, unresolved adapter failure, or missing receipt.

The canary ceiling may rise only by bounded controller:

- floor: one task,
- seed: one task,
- cap before full acceptance: five tasks,
- step up: plus one after a green replay/rollback cycle,
- step down: to floor on any red issue or missing telemetry,
- disable switch: operator freezes canary level.

### 6.4 P3: Production Default

Goal: make v2 the default production assurance path for supported harness missions.

Required:

- P2 has at least three green canary cycles with replay, rollback rehearsal, and dissent closure,
- production signing is verified and not expired,
- proof backend is external or an operator explicitly accepts proof-unavailable for non-proof-required subjects,
- V1 primary and witnesses agree or unavailable witnesses are resolved,
- runbooks are executed in rehearsal, not merely written.

### 6.5 P4: Break-Glass Repair

Break-glass is allowed only when production harm from waiting exceeds risk of a scoped repair.

Required before break-glass:

- operator signs incident id, urgency class, blast radius, rollback command, expiry, and post-hoc gates,
- privacy preflight still runs before any hosted/off-stack call,
- production doctor runs and records all red issues,
- at least quorum council participates unless the incident is fleet unavailability itself,
- no secret, raw tenant prompt, raw private witness, or hidden reasoning is exported.

Break-glass constraints:

- max expiry: 4 hours,
- max scope: one incident and one rollback target,
- no infrastructure or credential widening unless a separate security operator signs,
- automatic quarantine if post-hoc gates do not complete by expiry,
- post-hoc fleet council must include all recovered live members.

## 7. Fleet Inventory and Consensus

V1 `/v1/models` is the roster authority. Config is only a policy overlay.

Production inventory decision:

1. Fetch primary V1 inventory.
2. Fetch every configured witness V1 inventory.
3. Normalize active local records by model id, node id, upstream, advertised model candidates, privacy tier, capability tags, and telemetry freshness.
4. Primary determines active membership.
5. Witnesses are veto evidence. They cannot add a member absent from primary.
6. Any configured witness disagreement or unavailability is red unless covered by an operator-signed witness-deferral receipt.

Minimum production witness policy:

- seed: one primary plus one witness,
- target: one primary plus two witnesses,
- floor for normal promotion: one primary plus one agreeing witness,
- break-glass floor: primary only with signed witness-deferral receipt and post-hoc witness recovery.

No production roster can be sourced from static config alone.

## 8. Production Hard Gates

### 8.1 Cryptographic Identity Gate

Pass requires:

- every production sidecar signature is Ed25519-verifiable or backed by an approved external signer descriptor,
- signer trust level is `operator_bound` or `registry_verified`,
- each signature has `keyId`, `issuedAt`, `expiresAt`, and `revocationListRef`,
- revoked or expired keys fail before signing and fail doctor after recording,
- verifier identity is cryptographically verified against registry, consensus root, or operator assignment root,
- adapter recovery and conflict closure use distinct recovery and identity verifiers.

Fail states:

- unavailable signer with `degrade_to_unavailable`,
- alpha-only local hash treated as production proof,
- missing revocation metadata,
- verifier selected manually by the implementer,
- identity provider unavailable without an identity-recovery receipt.

### 8.2 Distributed Delivery Gate

Pass requires:

- every message has durable outbox entry, recipient-specific delivery or undeliverable receipt, read/accepted/completed lifecycle where applicable, idempotency key, and content hash,
- local bus delivery proves projection into a recipient inbox URI,
- non-local transports define ordering, leases, fencing, expiry, replay cursor, fanout, and stale-reply rejection,
- duplicate delivery is idempotent under restart,
- partition tests prove no fake delivered receipt is emitted.

### 8.3 Privacy Gate

Pass requires:

- privacy preflight runs before hosted or off-stack adapter network I/O,
- blocked privacy decision emits adapter-failure evidence and does not call the remote endpoint,
- hidden reasoning, raw private prompts, tenant identifiers, legal/IP strategy, secrets, and raw private witnesses are blocked from public proof inputs, AgentOps exports, and replay bundles,
- every message, evidence ref, proof receipt, export row, and RSI decision carries a privacy zone.

### 8.4 Evidence and Replay Gate

Pass requires:

- protocol, evidence, RLL, RSI, and AgentOps ledgers are append-only and replayable,
- replay rebuilds the same projection roots from the same inputs,
- timestamps are parseable and monotonic where a sequence claim depends on order,
- evidence refs exist for actionable claims,
- high-risk green/red verdicts are signed by a verifier distinct from the author, deployer, or lane owner.

### 8.5 Proof Gate

Pass requires:

- subjects with `proofRequired=true` have `mode=external_snark` and `status=proved`,
- proof descriptor includes circuit id, verifying key hash, public input hash, proof hash, verifier ref, `provedAt`, `expiresAt`, `latencyMs`, and `maxLatencyMs`,
- proof is fresh and within latency budget,
- failed, unavailable, or over-budget proofs declare failure state and reason,
- production forbids `degrade_to_signature_only_alpha`.

For subjects without proof requirement, proof-unavailable may be honest but must be visible as residual risk.

### 8.6 RLL/RSI Gate

Pass requires:

- RLL append and doctor are green,
- AgentOps control signals are derived from evidence-backed RLL events,
- RSI recommendations cite existing evidence refs,
- no RSI action mutates source code, credentials, infrastructure, cloud resources, privacy policy, or launchd jobs without operator gate,
- any applied production RSI action has dry-run evidence, rollback plan, policy hash, operator receipt, and independent review,
- oscillation detection uses hysteresis and reports configured/effective values.

Alpha rule remains: `applied` RSI status is red until the production apply path exists.

### 8.7 Rollback Gate

Pass requires:

- rollback command or procedure exists before canary,
- rollback was rehearsed against staging or an isolated production-equivalent run in the last 7 days,
- rollback has owner, max expected duration, data-loss expectation, and verification command,
- rollback result writes evidence and RLL events,
- canary and break-glass have automatic rollback triggers.

### 8.8 Observability and Runbook Gate

Pass requires:

- SLI/SLO definitions exist for adapter success, receipt latency, proof latency, privacy blocks, replay determinism, council response time, and rollback time,
- dashboards or CLI projections expose current and recent values,
- runbooks have been executed in rehearsal,
- alert thresholds are bounded controllers or config values with rationale, floors, caps, and disable switches,
- every production blocker has a runbook section with owner and escalation path.

## 9. Required Implementation Work

### 9.1 CLI and Protocol

- Add a production-break command group:
  - `harness production init-local --v1-url <url> --operator <id>`
  - `harness production doctor --run-dir <run>`
  - `harness production promote --run-dir <run>`
  - `harness production canary --run-dir <run>`
  - `harness production break-glass --run-dir <run> --incident <id>`
  - `harness production council --run-dir <run> --v1-url|--v1-file`
- Production commands must call existing alpha doctors, production profile doctors, fleet doctor, RLL doctor, AgentOps panel/export, proof verification, and rollback checkers.
- Promotion returns a signed decision object with `allowed=false` by default until every hard gate passes.
- `production.fleet` config may provide reusable fleet authority defaults:
  - fleet config path,
  - primary V1 URL or file,
  - V1 witness URLs or files,
  - minimum agreeing source count,
  - hosted inclusion policy.
- CLI fleet flags override `production.fleet`; absence of CLI flags must not downgrade configured witness policy.

### 9.2 Sidecar Signing

- Implement or configure production-capable sidecar signer.
- Add signer lifecycle tests for revoked, expired, unavailable, fallback, invalid public key, and bad signature.
- Reject production mode when signer is disabled.

### 9.3 V1 Witnesses

- Configure at least one V1 witness source.
- Add fleet consensus fixtures:
  - agreeing witness,
  - missing model,
  - extra model,
  - stale witness,
  - unavailable witness,
  - primary empty roster.

### 9.4 External Proof

- Add external SNARK command adapter or a production policy that marks proof-required subjects unsupported.
- Add tests for proof success, stale proof, over-budget proof, invalid JSON, public input mismatch, timeout, and fail-closed descriptor.

### 9.5 Transport Profiles

- Define transport profiles for local JSONL, local HTTP, remote HTTP, Spark, and cloud worker.
- Each profile must state ordering, lease, fencing, expiry, retry, fanout, inbox URI, and stale-reply policy.

### 9.6 Council Parser Feedback

- When a model outputs malformed or non-counting dissent, the harness must write parser feedback and optionally rerun that member once with the exact schema error.
- A rerun is bounded:
  - seed retries: 1,
  - floor: 0,
  - cap: 2,
  - no retry if privacy block or policy denial occurs.

## 10. Acceptance Tests

Minimum tests before P1:

- production doctor blocks default unsigned config,
- production doctor passes a fixture with operator-bound Ed25519 signatures,
- expired or revoked signing key blocks promotion,
- adapter failure blocks promotion until valid adapter recovery exists,
- implementation conflict blocks promotion until valid independent closure exists,
- local JSONL missing inbox emits undeliverable, not delivered,
- privacy block prevents hosted/off-stack network call,
- RSI `applied` blocks alpha and unaudited production,
- V1 primary plus agreeing witness passes,
- V1 split-brain fails,
- council with only one counted dissent fails,
- council with two counted dissents and repaired issues passes,
- break-glass requires incident id, expiry, rollback, operator receipt, and post-hoc gate list.

Minimum production rehearsal:

- one full shadow run,
- one canary run,
- one rollback rehearsal,
- one simulated V1 witness disagreement,
- one simulated signer outage,
- one simulated proof timeout,
- one simulated member timeout,
- one simulated privacy leak attempt.

## 11. Open Production Blockers

This spec is accepted as an implementation roadmap. The initial command/schema support now exists. Package defaults remain intentionally blocked, while `harness production init-local` can generate a machine-local opt-in profile with operator signing, a local external-proof shim, V1 witness snapshot, fleet config, and command-group policy.

Open blockers for a true hosted or hardware-backed production deployment:

1. Package defaults deliberately leave production signing disabled.
2. `init-local` uses an operator-file Ed25519 key and a local external-proof shim; HSM/KMS custody and a real SNARK backend remain deployment hardening work.
3. Local V1 witness snapshots are useful split-brain guards, but independent live witness infrastructure is still stronger.
4. Production command-group membership is configured only by explicit local overlay, not by package defaults.
5. The round-two reasoning-without-assistant-content failure still needs adapter repair or quarantine policy before councils can be trusted without retry pressure.
6. Production-mode council review must be run against the configured local or deployment fleet before promotion.

Implemented roadmap surface:

- `harness production init-local --v1-url <url> --operator <id>`
- `harness production doctor --run-dir <run>`
- `harness production promote --run-dir <run>`
- `harness production canary --run-dir <run>`
- `harness production break-glass --run-dir <run> --incident <id> ...`
- `harness production council --run-dir <run> --prompt <text>`
- production config policy for fleet defaults, command-group approvals, council timeout controller, canary bounds, and break-glass expiry/rollback requirements
- machine-parseable `superharness.production_break_glass_receipt.v1` receipts recorded as evidence

## 12. Future Council Prompt

Future councils must keep the stricter JSON contract that cleared round three:

```text
Review docs/SUPER_HARNESS_V2_PRODUCTION_BREAK_SPEC.md.
Return JSON only. No markdown. Required keys:
stance, strongest_weaknesses, recommended_repairs, evidence_needed,
residual_risk, confidence.
Use stance=dissent if any remaining issue should block acceptance.
residual_risk must be one string.
At least two evidence-bound dissents are mandatory before acceptance.
```

If a future council blocks, the spec stays accepted-for-implementation but the target promotion stage cannot advance until the dissent register is extended and repaired.
