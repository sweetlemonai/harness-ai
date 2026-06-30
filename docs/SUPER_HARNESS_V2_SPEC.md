# Super Harness v2 Protocol Specification

Status: draft v0.5
Target repository: `/Users/veagent/harness-ai`
Compatibility targets: BCRX v1, VCRX legacy, local Mac agents, Spark agents, cloud agents, VERI AgentOps Glass Panel, RLL, RSI

## 1. Purpose

Super Harness v2 extends `harness-ai` from a single Claude-first phase runner into a distributed, multi-agent harness that can invoke real agents directly, route work across local and cloud models, preserve evidence, and make collaboration auditable. The harness is not only an executor: it is an evidence-producing, self-observing system whose activities feed RLL and whose next actions are shaped by bounded RSI decisions.

The immediate reason for v2 is that the old BCRX/VCRX layer does not provide reliable inter-agent communication. Codex may be listening without receiving Claude's messages, Claude may not receive Codex messages, and neither side can prove the difference between sent, delivered, read, accepted, completed, or challenged. v2 fixes this by defining a clean protocol with durable envelopes, inbox/outbox ledgers, receipts, evidence records, adversarial review, RLL/RSI feedback loops, AgentOps projections, and ZK SNARK proof receipts. Legacy BCRX/VCRX adapters can translate old packages into v2 objects, but they must not fabricate guarantees that the old layer did not provide.

## 2. Source Anchors

This spec is based on five inputs:

1. The LemonHarness paper: explicit runtime boundaries, structured tool execution, execution feedback as observations, reusable rule knowledge, and traceable validation records.
2. The current `harness-ai` repository: TypeScript CLI, phase runner, strict config schema, event logger, run state, phase outputs, and direct Claude CLI invocation.
3. Existing BCRX/ZK handoff design docs in the local OpenClaw state tree: signed completion records, recursive handoff chains, public inputs, private witnesses, artifact Merkle roots, and external SNARK prover hooks.
4. The operator requirement: v2 must support distributed real agents from day one across Mac B/C, Spark, cloud, local models, Codex, Claude, BCRX, and VCRX compatibility adapters.
5. The VERI AgentOps Glass Panel spec: event-sourced mission control, tenant-scoped replay, live graph, BCRX handoff ledger, dissent board, triage/rescue unit, benchmark cards, privacy swimlanes, proof viewer, and long-run epoch continuity.

## 2A. Spec Council and Evidence-Bounded Dissent

The specification process itself must use the harness epistemics. A spec created only by consensus is a groupthink risk. Major changes to this document require an advisory record with evidence-bounded support and evidence-bounded dissent.

Spec council roles:

- author: proposes or edits the spec.
- protocol reviewer: checks message semantics, lifecycle, and receipt boundaries.
- implementation reviewer: checks whether the design can land without destabilizing the current repo.
- proof/privacy reviewer: checks ZK SNARK, signature, privacy, and attestation claims.
- adversarial dissenter: is explicitly assigned to challenge the direction and find failure modes.
- operator: accepts, rejects, or asks for more review on high-impact changes.

Advisory and dissent records are not raw chain-of-thought. They are structured review artifacts.

```ts
export interface SpecAdvisoryOpinion {
  opinionId: string;
  specVersion: string;
  reviewer: AgentIdentity;
  role:
    | 'author'
    | 'protocol_reviewer'
    | 'implementation_reviewer'
    | 'proof_privacy_reviewer'
    | 'adversarial_dissenter'
    | 'operator';
  claim: string;
  recommendation: string;
  evidenceRefs: EvidenceRef[];
  confidence?: number;
  createdAt: string;
}

export interface SpecDissentRecord {
  dissentId: string;
  specVersion: string;
  raisedBy: AgentIdentity;
  challengedClaim: string;
  evidenceRefs: EvidenceRef[];
  severity: 'low' | 'medium' | 'high' | 'blocking';
  concreteRisk: string;
  disconfirmingTest: string;
  proposedRepair: string;
  status:
    | 'open'
    | 'accepted'
    | 'rejected_with_evidence'
    | 'overruled_with_reason'
    | 'superseded'
    | 'needs_operator';
  resolutionSummary?: string;
  resolutionReceiptId?: string;
}
```

Dissent rules:

- Every major spec change needs at least one dissent attempt or an explicit `no_material_dissent_found` receipt.
- Dissent must cite evidence: source lines, repo files, run artifacts, tests, existing protocol docs, or observed failures.
- Dissent must include a disconfirming test, not only a vibe.
- Unsupported dissent may be recorded, but it cannot block by itself.
- Blocking dissent remains open until accepted, repaired, operator-overruled with reasons, or superseded by a newer design.
- Advisory reviewers should be asked focused, non-overlapping questions where possible so the process gets independent views rather than repeated agreement.
- The final spec change summary must list material dissent and how it was handled.

Current draft dissent register:

| Dissent | Evidence anchor | Severity | Resolution in this draft |
| ------- | --------------- | -------- | ------------------------ |
| `harness-ai` should not accidentally own the whole VERI dashboard/API product | Attached Glass Panel spec says the product lives in the VERI dashboard; `harness-ai` is currently a TypeScript CLI package. | High | Accepted. `harness-ai` is the protocol producer and local projection/export surface; VERI dashboard owns the product UI and tenant-facing dashboard integration. |
| Alpha scope risks solving everything before proving real inter-agent receipts | Current repo has one direct Claude subprocess facade and a phase runner with delicate state semantics. | Critical | Accepted. Alpha is narrowed to adapter facade, fake adapter, local bus, receipt lifecycle, privacy-safe invocation, RLL append, and canary failures. |
| RLL/RSI active control could violate read-only-first observability | Attached Glass Panel spec requires read-only first and gated interventions after replay/provenance/privacy/audit are correct. | Critical | Accepted. RSI is recommend-only in alpha; applied decisions require replay, receipts, dry-run evidence, rollback, and operator gates. |
| ZK SNARKs could create false assurance before signed ledgers and circuits exist | SNARK backend, key identities, circuit policy, and private artifact retention are open questions. | High | Accepted. Alpha supports signed hashes and `proof_unavailable`; real SNARK verification follows circuit/key-policy specs. |
| Transport semantics are too thin for distributed Mac/Spark/cloud operation | The v2 goal assumes distributed Mac B/C, Spark, and cloud agents from day one. | High | Accepted. Transport profiles must specify ordering, leases, fencing, expiry, replay, fanout, and stale-reply rejection. |
| Privacy model must block indirect mission-gist leakage, not just raw secrets | Attached Glass Panel spec defines privacy lanes and preflight checks for mission gist, legal/IP strategy, identities, and abstraction. | Critical | Accepted. Privacy preflight is a route-blocking `PrivacyDecision` before hosted/off-stack routing. |
| Benchmark-driven routing can become numerology | Route scoring was additive without normalization, confidence, or missing-data behavior. | Medium | Accepted. Route scores require units, weights, confidence intervals, recency decay, missing-data behavior, and rejected-candidate explanations. |
| Legacy BCRX/VCRX import could normalize non-authoritative files | Existing BCRX/VCRX source directories and freshness signals are still an open question. | Medium | Accepted. Legacy adapters require a migration source manifest before import. |
| Long-run continuity can overpromise indefinite agency | Attached Glass Panel spec distinguishes context, storage, and quality-drift limits. | Medium | Accepted. The spec now frames continuity as epoch contracts with drift budgets, revalidation, and operator re-charter. |
| Owner/deployer self-verification can make a green/red verdict non-independent | Fleet dissent flagged a conflict-of-interest risk when the harness owner verifies its own restored harness or deployed change. | Critical | Accepted. High-risk verification verdicts require an independent verifier assignment; the actor that authored, deployed, or owns the lane may provide evidence but not the final green/red verdict. |
| Live forensics can become measurement theater without instrumentation proof | Fleet dissent flagged that reading an observer stream cannot prove a signature that the stream was never instrumented to emit. | Critical | Accepted. Any observer-based forensic verdict must first cite instrumentation or emit an `instrumentation_missing` receipt and stop at measure-first status. |
| Conflict logging can become high-fidelity false positive theater | Fleet review of Claude's conflict critique returned `SURVIVES: NO`: an `implementation_conflict` path alone lets the implementer record and close its own conflict. | Critical | Accepted. Latest unresolved or non-independently verified `implementation_conflict` records hard-block green status. Closure requires a verifier distinct from the implementer plus verification evidence. |
| Distinct verifier ids still allow verifier-shopping | Follow-up fleet review returned `SURVIVES: NO`: implementers can choose compliant or colluding verifiers unless verifier selection is policy-governed and identity-bound. | Critical | Accepted. Closure requires non-manual verifier selection provenance, a registry/consensus/operator policy ref, identity-binding refs, and verification evidence. Manual verifier selection remains blocked. |
| Adapter-failure blocking can deadlock production promotion | Fleet/Ornith dissent flagged that blocking every adapter failure without a recovery path creates an availability deadlock. | High | Accepted. `adapter_recovery` is now a first-class evidence kind and protocol command. Recovery clears a blocker only when it cites recovery refs, targets the failed adapter/subject, has independent verification, and production uses cryptographic verifier identity binding. |
| V1 inventory can split-brain across mirrors or witnesses | Fleet/Ornith dissent flagged that one V1 source can drift from another during long coding runs. | High | Accepted. V1 primary remains the roster authority, but `fleet doctor` can require consensus V1 witnesses. Disagreement or unavailable configured witnesses are red evidence states; witnesses never revive a model absent from primary V1. |
| Adapter recovery verification can race identity binding | Second fleet review converged on a TOCTOU risk: recovery verification and identity binding were distinct claims without an atomic commit artifact. | Critical | Accepted. Production-clearable `adapter_recovery` now requires a committed verify-bind transaction id, canonical binding payload hash, prepared/committed timestamps, adapter instance/version, target failure evidence id, and distinct recovery and identity verifiers. |
| Verifier trust anchors can become self-asserted strings | Fleet/Ornith noted that verifier ids are not enough without a root of trust or verifier attestation evidence. | Critical | Accepted. Production recovery and conflict closure require verifier trust-anchor refs and verifier attestation refs for both the recovery verifier and the identity verifier. |
| ZK proof latency failures had no deterministic state | Fleet dissent asked whether over-budget proof handling aborts, hangs, or silently degrades. | Critical | Accepted. External SNARK descriptors require a failure policy. Failed, unavailable, or over-budget proofs require a deterministic failure state and reason; production forbids alpha-only signature degradation. |
| RLL oscillation detection could false-red on normal correction | Fleet/Ornith noted that a single opposing signal pair can be healthy stabilization rather than structural oscillation. | High | Accepted. RLL doctor now uses configurable hysteresis: minimum alternations, window, and strength threshold. Single transient opposing corrections no longer trigger the oscillation error. |
| External signing provider lacked cascade policy | Fleet/Ornith noted that KMS/HSM/TEE outages, rotation, and partition behavior were not specified. | High | Accepted. External signing now supports ordered fallback signers and an explicit failure policy: halt, or degrade to an unavailable descriptor that production doctors reject rather than treating as signed. |

## 3. Terminology

- Agent: an addressable actor that can receive a v2 message and produce a v2 response. It may be Codex, Claude, a local model, a cloud model, a Spark-hosted service, a human, or a legacy adapter.
- Model adapter: code that invokes one concrete agent/runtime and returns a normalized result with evidence and receipts.
- Collaboration bus: append-only protocol storage for outbox, inbox, messages, receipts, leases, and replay cursors.
- Evidence ledger: append-only storage for observations, command outputs, artifacts, file references, endpoint probes, signatures, and content hashes.
- Claim: a typed epistemic statement. Claims are observations, inferences, speculations, unknowns, or decisions.
- ZK SNARK receipt: a signed receipt that binds a statement, public inputs, private witness commitments, verifier metadata, and proof bytes or proof references.
- Legacy adapter: a v2 adapter that maps old BCRX/VCRX packages to v2 envelopes while preserving their limitations.
- AgentOps: the normalized observability and control vocabulary consumed by the VERI AgentOps Glass Panel, API, replay tooling, and audit export. AgentOps is a read model over v2 ledgers, not the lifecycle source of truth.
- RLL: the first-class learning and control ledger for harness activity. It ingests envelopes, receipts, evidence, claims, benchmark deltas, route outcomes, privacy decisions, dissent, rescues, proof states, and operator gates. It emits replayable projections and learning signals.
- RSI: the bounded recursive/self-improvement decision layer that consumes RLL projections and proposes policy-allowed task evolution, routing, review, rescue, compression, and epoch decisions. In alpha it is recommend-only. Later applied decisions require dry-run evidence, rollback, receipts, and operator gates. RSI is not allowed to self-modify code, widen permissions, or mutate infrastructure without operator-gated receipts.
- Task graph: the evolving graph of atomic tasks, dependencies, verifications, handoffs, rescues, merges, cancellations, and epoch checkpoints.

The protocol term is ZK SNARK proof receipt, or more generally ZK proof receipt when a non-SNARK backend is explicitly configured.

## 4. Non-Negotiable Invariants

1. Real-agent invocation is allowed only through a `ModelAdapter`.
2. A process exit code is not a delivery receipt, read receipt, acceptance receipt, completion receipt, or adversarial clearance.
3. `events.jsonl` remains telemetry. It is not the collaboration inbox, outbox, receipt ledger, or source of message delivery truth.
4. Every v2 message has a stable identity, sender, recipient set, causality fields, idempotency key, content hash, and signature status.
5. Delivery, read, accepted, rejected, completed, failed, and challenged receipts are distinct objects. Per-recipient lifecycle receipts, especially `delivered`, must bind the recipient identity into the canonical receipt payload so fanout cannot collapse into duplicate receipt ids.
6. Observation and inference claims require evidence references. Speculation may be recorded, but it is non-actionable until promoted with evidence.
7. A model assertion is not evidence by itself. It is a claim that may cite evidence.
8. High-risk claims require an adversarial review by a different identity than the claim author.
9. Major claims must include a disconfirming condition: what observation would make the claim false or unsafe to rely on.
10. Legacy adapters must mark missing legacy state as `unknown`, `lossy`, or `unavailable`. They must not infer read or acceptance from old stdout, watcher files, or successful subprocess exit.
11. No static model list, endpoint list, timeout, retry policy, routing preference, or capability map is the long-term source of truth. Bootstrap defaults are allowed, but runtime inventory, routing state, and health evidence must be externalized and observable.
12. In VERI/OpenClaw deployments, the configured router or V3 authority remains the policy authority for model choice. Direct endpoint probes are health evidence, not routing authority.
13. Proof-unavailable is a valid state. It must not be reported as proof-verified.
14. Sensitive prompts, private chain-of-thought, credentials, and raw private witnesses must not be placed in public proof inputs.
15. Distributed execution must be safe under restart, partition, duplicate delivery, stale replies, and host reconnect.
16. RLL is a first-class driver and first-class beneficiary: every material harness activity must emit RLL records, and RLL-derived signals must be eligible to guide task growth, decomposition, routing, review intensity, rescue actions, and epoch planning under policy.
17. RSI decisions must be evidence-backed, bounded, reversible where possible, and represented as signed decisions or recommendations. High-risk RSI actions require operator approval or independent review.
18. AgentOps and the Glass Panel must distinguish observed facts, inferred diagnoses, recommended interventions, semantic claim status, attestation status, and proof status.
19. ZK SNARK receipts prove provenance, inclusion, ordering, integrity, lineage, policy compliance, and receipt-chain relations. They do not prove semantic truth.
20. No hidden chain-of-thought may enter RLL, AgentOps, public proof inputs, replay exports, or audit bundles. Use structured summaries, evidence refs, claims, rejected claims, blockers, next instructions, privacy tags, and artifact pointers.
21. An `implementation_conflict` is blocking until the latest record for that conflict id is resolved by verifier identities distinct from the implementer and cites verification evidence. Self-resolution, no verifier, or no verification evidence remains `blocked`.
22. Independent verifier closure also requires non-manual verifier selection provenance, a verifier policy or registry ref, identity-binding refs, verifier trust-anchor refs, verifier attestation refs, and a committed verify-bind transaction. Distinct verifier strings are not sufficient.
23. Evidence-bound verifier identity is alpha-only. Production green status requires cryptographically verified verifier identity against an approved registry, consensus root, or operator assignment root.
24. Production sidecar signatures must be cryptographically verified and identity-bound. `operator_bound` or `registry_verified` signatures require `keyId`, `issuedAt`, `expiresAt`, and `revocationListRef`; an expired or revoked configured key must fail before signing and fail production doctor if already recorded.
25. Local JSONL bus `sha256-local-integrity` signatures are tamper-evidence, not production identity proof. Production doctors may pass them with explicit warnings, while protocol/evidence sidecars need Ed25519 identity-bound signatures for production promotion.
26. Production promotion is a hard guard, not a report-only doctor. It runs alpha and production sidecar audits, bus validation, projection validation, and AgentOps operational blocker checks. It must block recorded `adapter_failure` evidence and unresolved `implementation_conflict` evidence even when those records are correctly signed.
27. `adapter_failure` and `implementation_conflict` blocking semantics are reject-with-evidence: the guard returns `allowed=false` with issue codes, not silent suppression or indefinite waiting. Recovery requires new evidence that removes or supersedes the blocker under policy.
28. `adapter_recovery` is the only adapter-failure recovery evidence kind. It must cite recovery evidence refs, verification evidence refs, verifier identity-binding refs, identify the adapter/provider/model target or superseded subject, and carry independent verification by a distinct verifier. Production recovery requires `identityBindingStatus=cryptographically_verified`.
29. Production promotion blocks any unresolved evidence whose subject or metadata marks it `blocking=true`, not only the first two blocker types. Later evidence may clear it only by valid resolution or supersession under policy.
30. Protocol doctors validate created/issued timestamps on core bus envelopes, core receipts, protocol messages, protocol receipts, and evidence receipts. Malformed timestamps are doctor-red because replay and ordering claims depend on parseable time evidence.
31. V1 consensus witnesses are veto evidence only. The primary V1 source determines active roster; configured secondary V1 sources can report split-brain or unavailability, but they cannot revive deprecated, removed, or absent primary models.
32. Production-clearable adapter recovery is replay-resistant. It must name the failed evidence id it resolves, the adapter instance id, adapter version, distinct recovery verifier and identity verifier, both verifier trust anchors, both verifier attestation ref sets, and a committed verify-bind transaction whose binding payload hash recomputes from those fields.
33. External ZK SNARK descriptors must declare failure semantics. Failed, unavailable, or over-budget proofs require a deterministic failure state and reason. A proof with `latencyMs > maxLatencyMs` is not production-proved even if it has proof hashes.
34. RLL feedback controls use hysteresis policy, not one-sample panic. The doctor flags opposing control action oscillation only after the configured minimum alternations occur inside the configured time window at or above the configured strength threshold.
35. External signer custody must have explicit cascade behavior. Fallback signers are tried in order; if all fail, policy must either halt or emit `status=unavailable`. Production promotion never treats unavailable signatures as signed.
36. A local bus `delivered` receipt means the recipient inbox was actually projected through the declared local JSONL inbox URI. Unknown, absent, or non-local recipient endpoints produce `undeliverable` receipts instead of fake delivery.
37. Production AgentOps advisory requires a live or file-backed V1 inventory source and passing V1 consensus when witnesses are configured. Static panel config is alpha overlay only and cannot become the production roster authority.
38. Dissent counted toward a production or configured dissent floor must be structured, evidence-bound, and receipt-backed. Keyword matches, generic concern language, empty dissent JSON, or unsupported model assertions are recorded as uncertain advice rather than dissent.
39. Privacy preflight is before hosted or off-stack adapter network I/O. A blocked privacy decision produces adapter-failure evidence and must not call the remote endpoint.

## 5. Current Repo Seams

The current repository should be extended rather than replaced.

- `src/lib/claude.ts` is the first adapter seam. It currently spawns `claude --dangerously-skip-permissions -p` directly. v2 keeps the exported `callAgent()` facade at first, but delegates execution to a model registry and adapter.
- `src/pipeline/runner.ts` is the phase engine. It should not be overloaded into a message bus. It can emit protocol events and consume protocol services, but phase completion is not message delivery.
- `src/lib/logger.ts` writes telemetry. v2 can add signed event-chain support there, but collaboration state lives in separate ledgers.
- `src/lib/state.ts` already has atomic JSON write patterns. v2 should reuse that discipline for protocol state.
- `defaults/config.schema.json` is strict. Any v2 config fields must be schema-backed.
- `src/commands/ship.ts` also invokes Claude-like task breaking and must eventually route through the same adapter layer.

## 6. Architecture

```text
                         +-----------------------------+
                         |        harness CLI          |
                         | run / ship / status / debug |
                         +--------------+--------------+
                                        |
                 +----------------------+----------------------+
                 |                                             |
        +--------v--------+                           +--------v--------+
        | phase runner    |                           | protocol v2     |
        | existing flow   |                           | bus and ledgers |
        +--------+--------+                           +--------+--------+
                 |                                             |
        +--------v--------+                           +--------v--------+
        | model registry  |<------------------------->| RLL ledger      |
        | route authority |                           | learning spine  |
        +--------+--------+                           +--------+--------+
                 |                                             |
  +--------------+---------------+               +-------------+-------------+
  |              |               |               |                           |
+-v-----+   +----v----+   +------v------+  +-----v------+            +-------v-------+
|Claude |   |Codex    |   |local/cloud  |  | RSI engine |            | AgentOps      |
|adapter|   |adapter  |   |adapters     |  | decisions  |            | projections   |
+-------+   +---------+   +------+------+  +-----+------+            +-------+-------+
                                |               |                           |
                                |        +------v------+             +------v------+
                                +------->| evidence    |<----------->| Glass Panel |
                                         | epistemics  |             | API/replay  |
                                         +------+-----+              +-------------+
                                                |
                                         +------v------+
                                         | proof engine|
                                         | ZK SNARKs   |
                                         | signatures  |
                                         +------+------+
                                                |
                                   +------------v-------------+
                                   | legacy BCRX/VCRX adapters|
                                   +--------------------------+
```

The phase runner remains useful for deterministic engineering workflows. The protocol layer is separate so agents can interact outside a single phase and so distributed recipients can prove what they saw.

## 6A. RLL and RSI Control Spine

RLL is the spine of Super Harness v2. It is both beneficiary and driver:

- Beneficiary: every material harness activity emits structured RLL records.
- Driver: RLL projections feed bounded RSI decisions that guide active tasks.

The harness should not wait until a run is over to learn. During execution, RLL receives task progress, route outcomes, claims, evidence coverage, benchmark deltas, handoff states, dissent, privacy decisions, proof status, failures, rescue outcomes, and operator gates. RSI reads those projections and may propose policy-allowed changes to the live task graph. In alpha, those proposals are recommendations only.

Examples of RSI-controlled task evolution:

- `grow_task`: add newly discovered subtasks or verification work.
- `split_task`: decompose a large or ambiguous task into atomic tasks.
- `merge_tasks`: combine redundant or converged subtasks.
- `reroute`: move work to a better agent or privacy lane.
- `add_verifier`: assign a complementary verifier for a weakness or risk.
- `request_dissent`: require a Tenth Man or adversarial challenge.
- `compress_context`: produce a BCRX/HN-JN package or epoch checkpoint.
- `rehydrate_context`: restore active state from artifacts and receipts.
- `quarantine_output`: block downstream use of risky or unsupported output.
- `revalidate_claim`: refresh stale evidence or benchmark assumptions.
- `escalate_operator`: require a human gate.

RSI actions are not prompt vibes. Each action is a typed decision or recommendation with evidence, policy, expected benefit, risk, cost effect, privacy effect, rollback plan, and receipt status.

```ts
export interface RLLEvent {
  eventId: string;
  schemaVersion: 'rll.event.v2';
  runId: string;
  tenantId?: string;
  nodeId: string;
  threadId?: string;
  timestamp: string;
  eventType: string;
  actor: AgentIdentity;
  subjectType:
    | 'run'
    | 'task'
    | 'agent'
    | 'adapter'
    | 'route'
    | 'handoff'
    | 'claim'
    | 'evidence'
    | 'dissent'
    | 'privacy'
    | 'proof'
    | 'operator_gate'
    | 'artifact';
  subjectId: string;
  payloadSummary: string;
  payloadRef?: EvidenceRef;
  privacyZone: PrivacyZone;
  scope: ScopeRef;
  receiptRefs: string[];
  claimRefs: string[];
  evidenceRefs: string[];
  prevHash?: string;
  hash: string;
  visibility: 'operator_visible' | 'internal' | 'secret_commitment_only';
}

export interface ScopeRef {
  scopeId: string;
  runId: string;
  workspaceId: string;
  tenantId?: string;
  tenantMode: boolean;
  privacyZone: PrivacyZone;
  visibility: 'operator_visible' | 'internal' | 'secret_commitment_only';
}

export interface TaskRequirements {
  taskId: string;
  scope: ScopeRef;
  requiredSkills: string[];
  qualityBar: 'low' | 'normal' | 'high' | 'critical';
  latencyClass: 'interactive' | 'batch' | 'long_running';
  contextClass: 'short' | 'medium' | 'long' | 'ultra_long';
  privacyZone: PrivacyZone;
  riskClass: 'low' | 'medium' | 'high' | 'critical';
  toolNeeds: string[];
  proofPolicy: ProofPolicy;
  adversarialReviewRequired: boolean;
}

export interface CapabilityProfile {
  profileId: string;
  agentId: string;
  modelId: string;
  hardwareTarget?: string;
  contextWindow?: number;
  privacyZone: PrivacyZone;
  measuredAt?: string;
  stale: boolean;
  scores: Record<string, CapabilityScore>;
  bestDomains: string[];
  weakDomains: string[];
  knownFailureModes: string[];
  recommendedComplements: string[];
  doNotRouteDomains: string[];
}

export interface CapabilityUpdate {
  updateId: string;
  profileId: string;
  routeDecisionId: string;
  outcomeRef: EvidenceRef;
  priorProfileHash: string;
  posteriorProfileHash: string;
  method: 'bayesian_update' | 'bounded_score_adjustment' | 'manual_review';
  confidenceDelta: number;
  recencyPolicyRef: EvidenceRef;
  receiptId: string;
}

export interface RouteOutcomeEvent {
  outcomeId: string;
  routeDecisionId: string;
  taskId: string;
  selectedAgentId: string;
  predictedScoreRef: EvidenceRef;
  observedQualityRef?: EvidenceRef;
  observedLatencyRef?: EvidenceRef;
  observedFailureRef?: EvidenceRef;
  privacyOutcomeRef?: EvidenceRef;
  capabilityUpdateRef?: string;
}

export interface RouteDecision {
  decisionId: string;
  taskId: string;
  selectedAgent: AgentIdentity;
  rejectedCandidates: Array<{ agentId: string; reason: string }>;
  requirementsRef: string;
  capabilityProfileRefs: string[];
  benchmarkRefs: string[];
  healthRefs: string[];
  privacyDecisionRef: string;
  weaknessCoverage: string[];
  routeScoreRef: EvidenceRef;
  policyHash: string;
  receiptId: string;
}

export interface TriageFinding {
  findingId: string;
  runId: string;
  taskId?: string;
  agentId?: string;
  kind:
    | 'healthy'
    | 'excellent_fit'
    | 'slow_but_progressing'
    | 'stuck_no_progress'
    | 'blocked_external_dependency'
    | 'misrouted_wrong_model'
    | 'context_saturated'
    | 'handoff_failed'
    | 'privacy_risk'
    | 'cost_runaway'
    | 'low_confidence'
    | 'unsupported_claims'
    | 'contradiction_detected'
    | 'test_failure'
    | 'benchmark_regression'
    | 'provider_degraded'
    | 'tool_failure'
    | 'proof_incomplete'
    | 'operator_attention_required';
  evidenceRefs: string[];
  severity: 'info' | 'warning' | 'high' | 'critical';
  createdAt: string;
}

export interface RescueRecommendation {
  recommendationId: string;
  findingId: string;
  action:
    | 'compress_context_with_bcrx'
    | 'rehydrate_from_artifact_graph'
    | 'reroute_to_specialist'
    | 'spawn_complementary_verifier'
    | 'split_task_into_atomic_subtasks'
    | 'reduce_context_to_claim_bundle'
    | 'strip_private_gist_for_hosted_subtask'
    | 'move_to_local_only_lane'
    | 'request_epistemic_review'
    | 'request_tenth_man_dissent'
    | 'run_tests_or_eval'
    | 'pause_agent'
    | 'quarantine_output'
    | 'ask_operator_for_gate';
  expectedBenefit: string;
  privacyEffect: string;
  costEffect: string;
  risk: string;
  rollback: string;
  evidenceRefs: string[];
  operatorGateRequired: boolean;
}

export interface RSIDecision {
  decisionId: string;
  runId: string;
  scope: ScopeRef;
  taskId?: string;
  decisionType:
    | 'grow_task'
    | 'split_task'
    | 'merge_tasks'
    | 'reroute'
    | 'add_verifier'
    | 'request_dissent'
    | 'compress_context'
    | 'rehydrate_context'
    | 'quarantine_output'
    | 'revalidate_claim'
    | 'escalate_operator';
  inputProjectionHash: string;
  policyHash: string;
  evidenceRefs: string[];
  recommendationRefs: string[];
  dryRunResultRef?: EvidenceRef;
  status: 'proposed' | 'dry_run' | 'applied' | 'rejected' | 'blocked';
  appliedReceiptId?: string;
  rollbackPlanRef?: EvidenceRef;
}

export interface RSITick {
  tickId: string;
  runId: string;
  scope: ScopeRef;
  trigger:
    | 'phase_boundary'
    | 'rll_event_threshold'
    | 'time_budget'
    | 'triage_finding'
    | 'operator_request'
    | 'drift_budget_breach';
  inputProjectionHash: string;
  decisionLatencyBudgetMs: number;
  emittedDecisionRefs: string[];
  noActionReason?: string;
  receiptId: string;
}

export interface TaskGraphNode {
  taskId: string;
  runId: string;
  scope: ScopeRef;
  parentTaskIds: string[];
  title: string;
  requirementsRef: string;
  status:
    | 'proposed'
    | 'ready'
    | 'assigned'
    | 'working'
    | 'blocked'
    | 'review'
    | 'completed'
    | 'cancelled'
    | 'superseded';
  routeDecisionRef?: string;
  causality: CausalLink[];
  receiptIds: string[];
}

export interface CausalLink {
  cause:
    | 'observation'
    | 'claim'
    | 'dissent'
    | 'route_failure'
    | 'benchmark_regression'
    | 'privacy_block'
    | 'proof_failure'
    | 'operator_request';
  subjectId: string;
  evidenceRef: EvidenceRef;
}

export interface TaskGraphMutation {
  mutationId: string;
  runId: string;
  scope: ScopeRef;
  decisionRef: string;
  op: 'grow' | 'split' | 'merge' | 'reroute' | 'reverse' | 'supersede' | 'cancel';
  beforeHash: string;
  afterHash: string;
  affectedTaskIds: string[];
  receiptId: string;
}

export interface RSIActionPolicy {
  actionClass:
    | 'prompt'
    | 'policy_param'
    | 'route'
    | 'task_plan'
    | 'evaluation'
    | 'decomposition'
    | 'source_code'
    | 'permissions'
    | 'infrastructure'
    | 'credentials'
    | 'privacy_policy'
    | 'signing_identity';
  autoApplyAllowed: boolean;
  operatorGateRequired: boolean;
  nonLlmCheckRequired: boolean;
}
```

RLL/RSI invariants:

- RLL is append-only and replayable. Projections may be rebuilt; they must not be invented.
- RSI consumes evidence-backed RLL signals only.
- RSI status `applied` is disabled in alpha.
- RSI ticks occur only at declared injection points: phase boundaries, event thresholds, time budgets, triage findings, operator requests, and drift-budget breaches.
- Live task evolution happens through append-only `TaskGraphMutation` records, not by silently rewriting phase state.
- RSI cannot directly modify source code, credentials, infrastructure, launchd jobs, cloud resources, or privacy policies.
- High-risk RSI actions require operator approval, independent review, or both.
- Safety- or privacy-affecting RSI decisions require a non-LLM gate such as a policy evaluator, static invariant verifier, test run, or deterministic privacy classifier.
- Task growth must preserve causality: new tasks point to the observation, claim, route decision, dissent, failure, or operator request that caused them.
- Benchmark-driven decisions must carry recency and confidence. Stale benchmarks degrade route confidence and may trigger revalidation.
- Route outcomes must feed capability updates; capability profiles do not change without observed outcome evidence.
- Rescue recommendations must name evidence, benefit, risk, privacy effect, cost effect, and rollback.
- Finalization is blocked by unresolved severe dissent unless resolved, operator-overruled with reasons, or explicitly escalated.
- High-risk green/red verdicts require an independent verifier. The author, deployer, or lane owner may submit evidence but cannot be the sole verdict authority.
- Observer-based forensic claims require instrumentation evidence before interpretation. If the structured observer does not emit the required signature, the harness records `instrumentation_missing` and routes the task as measure-first, not verified.
- Implementation-conflict closure requires `implementerAgentId`, `verifierAgentId`, `verifierSelectionMethod`, `verifierPolicyRef`, identity-binding refs, and verification evidence refs. `verifierAgentId === implementerAgentId`, missing verifier, manual implementer-selected verifier, missing policy, missing identity binding, or missing verification evidence keeps the AgentOps run verdict `blocked`.
- Closures with `identityBindingStatus=evidence_bound` can return only `pass_alpha`; production `pass` requires `identityBindingStatus=cryptographically_verified` plus a verifier signature or policy-root proof.
- Local-model response budgets are not economic token caps. For local and owned fleet models, the meaningful cost dimensions are electricity, thermal/headroom impact, queue occupancy, and elapsed time against the task's urgency/latency class. Output caps still exist as termination and latency guardrails, but they must be large enough for models such as Ornith to reason and emit a complete final answer when the task quality bar warrants it.
- V1 `/v1/models` is the non-hardcoded source of truth for active model existence, hot residency, and direct upstream location. Fleet config is an overlay only: names, request-model aliases, roles, exclusions, budgets, and adjudicator policy. It must not create active members that V1 does not advertise.
- Fleet panel configuration must be resolved against the live model inventory before material review. A member is active only if V1 advertises it, its upstream is reachable, a request-model alias is validated against the upstream's own `/v1/models`, and a final-content smoke can produce assistant `content` without relying on hidden reasoning fields. Deprecated or removed models must disappear by being absent from V1 instead of being reported as down.
- V1 unavailability and empty active-roster cases are critical evidence states. A last-known-good snapshot may be used only as an explicitly labeled fallback when the live V1 fetch fails; it must never silently override a reachable live V1 response, and a V1-derived doctor receipt with zero active upstream members is red.
- V1 split-brain is a first-class fleet doctor finding. `--consensus-v1-url`, `--consensus-v1-file`, config `source.consensus_urls`, and config `source.consensus_files` compare active primary V1 model ids against witness sources. Disagreement or unavailable configured witnesses fails the doctor, but only the primary V1 source contributes active members.
- Active advisory panels are first-class AgentOps work, not side-channel chat. `harness agentops advise` resolves members from V1 plus config overlay, sends a v2 bus review request, validates each upstream's own `/v1/models`, invokes direct OpenAI-compatible upstreams, then commits `read` and the first semantic acknowledgement in one bus transaction after processing. It records model outputs or adapter failures as evidence, writes protocol/RLL records, and blocks on missing configured dissent. In production assurance context, a V1 inventory source is mandatory, configured V1 consensus must pass, and no config-only panel fallback can satisfy the roster requirement.
- `harness agentops advise --max-tokens <n>` is an explicit quality/latency override for local owned models. It exists to prevent high-thinking models from spending the entire configured output budget on reasoning and returning no final assistant content. The override does not make local tokens a spend cap; it is an answer-completion and latency guardrail.
- Advisory dissent is parsed from the structured final answer. It counts toward the dissent floor only when the response explicitly declares a dissent stance and includes non-empty material weaknesses, recommended repairs, evidence needed, and residual risk. Unstructured concern text, hidden reasoning, keyword matches, or empty dissent shells are preserved as advice but counted as `uncertain`, not as evidence-bound dissent.
- A reasoning-only model response without assistant final `content` is an adapter failure. Hidden reasoning may inform the model's private computation, but the harness can only ingest the structured final answer and evidence refs; raw reasoning-only provider bodies must not be persisted as evidence stdout/stderr.
- `harness rll doctor --audit tip` is the cheap long-run monitor. It validates the RLL and AgentOps ledger tails plus sidecar object shape without walking the full run.
- `harness rll doctor --audit full` is the deterministic spine audit. It validates RLL/AgentOps/RSI sidecars through the protocol doctor, derives expected control signals from sidecar RLL events, reports unprojected AgentOps signals as warnings, validates RSI candidate ids, requires RSI evidence refs to exist, and returns red if any RSI candidate is marked `applied` during alpha.
- RLL feedback circuit breakers are deterministic doctor checks, not model vibes. If AgentOps contains opposing control actions for the same subject, such as `expand_scope` plus `narrow_scope` or `route_to_local` plus `route_to_frontier`, production `rll doctor --audit full` returns red with `rll_feedback.oscillation_detected`.
- `harness rsi recommend --run-dir <run>` is the alpha driver loop: it consumes evidence-backed AgentOps `RllControlSignal` records and deterministically upserts recommend-only RSI candidates. Signals with no evidence refs or missing evidence refs are skipped and recorded as RLL failures. The command emits `rsi_candidate` RLL events but never applies task graph mutations in alpha.
- RLL schema reconciliation is explicit: the doctor accepts both core `rll.event.v2` records and sidecar `superharness.rll.event.v2` records, but deterministic AgentOps control-signal projection is derived only from the sidecar schema that feeds `agentops.events.jsonl`.

## 6B. Code Intelligence Graph

Long coding missions need persistent codebase intelligence. Super Harness v2 should treat a code intelligence graph as a formal evidence source for task decomposition, impact analysis, routing, drift detection, handoffs, and replay. GitNexus is the initial adapter because it can index a repository, expose symbols, clusters, processes, dependencies, and impact queries, but the protocol should allow other graph providers.

The graph is not an oracle. It is evidence with freshness, scope, and confidence.

```ts
export interface CodeGraphProvider {
  providerId: string;
  kind: 'gitnexus' | 'language_server' | 'static_analysis' | 'custom';
  repoRoot: string;
  indexRef: EvidenceRef;
  freshness: 'fresh' | 'stale' | 'missing' | 'unknown';
  capabilities: Array<
    | 'symbol_lookup'
    | 'dependency_edges'
    | 'process_flows'
    | 'impact_analysis'
    | 'cluster_map'
    | 'ownership_hints'
    | 'test_mapping'
    | 'drift_detection'
  >;
}

export interface CodeGraphAdapter {
  adapterId: string;
  providerId: string;
  probe(scope: ScopeRef): Promise<CodeGraphProbeResult>;
  snapshot(scope: ScopeRef): Promise<CodeGraphSnapshot>;
  refresh(input: CodeGraphRefreshRequest): Promise<CodeGraphRefreshResult>;
  query(input: CodeGraphQueryRequest): Promise<CodeGraphQuery>;
  impact(input: CodeGraphImpactRequest): Promise<ImpactReceipt>;
  testCandidates(input: CodeGraphTestRequest): Promise<TestCandidateMap>;
  doctor(scope: ScopeRef): Promise<CodeGraphDoctorReport>;
  explainFailure(ref: EvidenceRef): Promise<string>;
}

export interface CodeGraphProbeResult {
  providerId: string;
  available: boolean;
  version?: string;
  healthRefs: EvidenceRef[];
  unavailableReason?: string;
}

export interface CodeGraphRefreshRequest {
  scope: ScopeRef;
  sidecarOnly: boolean;
  force?: boolean;
  generatedFilePolicyRef?: EvidenceRef;
}

export interface CodeGraphRefreshResult {
  snapshotId?: string;
  status: 'refreshed' | 'unchanged' | 'failed' | 'unavailable';
  receiptId: string;
  evidenceRefs: EvidenceRef[];
}

export interface CodeGraphQueryRequest {
  scope: ScopeRef;
  queryKind: CodeGraphQuery['queryKind'];
  subject: string;
  snapshotId?: string;
}

export interface CodeGraphImpactRequest {
  scope: ScopeRef;
  subject: string;
  depth: number;
  snapshotId?: string;
}

export interface CodeGraphTestRequest {
  scope: ScopeRef;
  subject: string;
  snapshotId?: string;
}

export interface CodeGraphDoctorReport {
  reportId: string;
  scope: ScopeRef;
  status: 'healthy' | 'stale' | 'degraded' | 'failed' | 'unavailable';
  findings: string[];
  evidenceRefs: EvidenceRef[];
  receiptId: string;
}

export interface CodeGraphSnapshot {
  snapshotId: string;
  providerId: string;
  repoRoot: string;
  providerVersion?: string;
  analyzerCommandRef?: EvidenceRef;
  commitHash?: string;
  indexedCommitHash?: string;
  worktreeHash?: string;
  worktreeStatusRef?: EvidenceRef;
  dirtyWorktreeState:
    | 'clean_indexed'
    | 'dirty_indexed_with_overlay'
    | 'dirty_unindexed'
    | 'dirty_conflicting'
    | 'unknown';
  dirtyWorktreePolicy?: 'index_clean_only' | 'index_with_overlay' | 'block_mutation' | 'operator_gate';
  generatedFilePolicyRef?: EvidenceRef;
  ignoredPathGlobsRef?: EvidenceRef;
  indexedAt: string;
  freshness: 'fresh' | 'stale' | 'partial' | 'failed';
  stalenessReason?: string;
  indexAgeMs?: number;
  lastRefreshAttemptRef?: EvidenceRef;
  graphHash: string;
  sourceRefs: EvidenceRef[];
  attestationRef?: EvidenceRef;
  proofReceiptIds: string[];
  receiptId: string;
}

export interface CodeGraphQuery {
  queryId: string;
  providerId: string;
  queryKind:
    | 'symbol_lookup'
    | 'callers'
    | 'callees'
    | 'impact'
    | 'process_trace'
    | 'cluster'
    | 'test_candidates'
    | 'ownership'
    | 'drift';
  subject: string;
  scope: ScopeRef;
  resultRef: EvidenceRef;
  snapshotId: string;
  confidence?: number;
  receiptId: string;
}

export interface CodeGraphAttestation {
  attestationId: string;
  providerId: string;
  snapshotId: string;
  statement:
    | 'snapshot_built_from_commit'
    | 'query_result_derived_from_snapshot'
    | 'impact_result_derived_from_snapshot'
    | 'test_mapping_derived_from_snapshot'
    | 'index_fresh_at_time'
    | 'index_stale_at_time'
    | 'fallback_source_read_used';
  publicInputsHash: string;
  graphRoot: string;
  queryHash?: string;
  resultHash?: string;
  sourceCommitHash?: string;
  worktreeStatusHash?: string;
  issuedAt: string;
  signature: SignatureStatus;
  zkReceiptId?: string;
}

export interface ImpactReceipt {
  receiptId: string;
  snapshotId: string;
  scope: ScopeRef;
  changedSymbols: string[];
  changedPathRefs: EvidenceRef[];
  affectedCallers: string[];
  affectedCallees: string[];
  affectedFiles: string[];
  depth: number;
  confidence?: number;
  ambiguousMatches: string[];
  unresolvedEdges: string[];
  generatedFileExclusions: string[];
  reviewerRequired: boolean;
  signature: SignatureStatus;
}

export interface TestCandidateMap {
  mapId: string;
  snapshotId: string;
  scope: ScopeRef;
  sourceRefs: EvidenceRef[];
  candidateTests: Array<{
    testRef: EvidenceRef;
    classification: 'focused' | 'broad' | 'smoke' | 'unknown';
    confidence?: number;
    rationaleRef?: EvidenceRef;
    historicalFailureRefs: string[];
  }>;
  verificationResultRefs: string[];
  receiptId: string;
}
```

Code graph rules:

- Long coding runs must have a current code graph snapshot or an explicit `code_graph_unavailable` receipt.
- Stale graph data may inform exploration, but it cannot be the only evidence for a high-risk code change.
- Every graph snapshot, query result, impact result, and test-mapping result must have a signed receipt or an explicit unavailable/fallback receipt.
- GitNexus-derived claims are evidence claims with freshness and confidence, not silent authority.
- Task decomposition should cite code graph evidence when splitting work by module, process, dependency, owner, or test surface.
- Impact analysis should run before broad refactors, shared-contract changes, cross-module edits, and route decisions that assign code work to agents.
- RLL records graph snapshots, query results, stale-index warnings, and impact-analysis receipts.
- AgentOps shows graph freshness, impacted modules, candidate tests, and unresolved dependency risks.
- BCRX handoffs for code work should include graph snapshot id, impacted symbols/modules, candidate tests, and stale-index status when available.
- If GitNexus or another graph provider fails, the harness records the failure as evidence and falls back to direct source reads, not guesses.
- Dirty or locked shared worktrees degrade graph confidence and block mutation unless there is lease evidence, operator approval, or a read-only/report-only lane.
- Stale graph data is orienting evidence only. It cannot provide final impact clearance for high-risk changes.
- Fallback source reads must cite file refs and explain which graph coverage is missing.
- Failed refresh must emit `code_graph_refresh_failed`; unavailable providers must emit `code_graph_unavailable`.
- Every code graph command persists its returned payload under `harness/codegraph/receipts.jsonl` with a receipt id and payload hash. `harness codegraph receipt <ref>` resolves this store and verifies the payload hash; lookup misses emit explicit unavailable receipts instead of claiming persistence is not wired.

GitNexus improvement requirements:

- Stable snapshot attestations: record repo root, commit hash, dirty-worktree hash, ignored/generated-file policy, index timestamp, graph hash, and tool version.
- Query derivation receipts: prove a query result came from a particular snapshot and query hash.
- Impact-analysis receipts: bind affected symbols, files, confidence, depth, and stale-index status to the graph snapshot.
- Test-mapping receipts: bind suggested tests to impacted symbols/files and explain confidence.
- Generated-file policy: avoid noisy generated `.claude/skills`, `AGENTS.md`, `CLAUDE.md`, or other context-file churn unless explicitly requested; support `skip generated context` as first-class metadata.
- Sidecar-only refresh: support a no-generated-output refresh mode that updates graph state without writing generated guidance files.
- Dirty-worktree mode: index and attest source state without overwriting user changes or generated context files.
- Long-run freshness policy: emit stale-index events when commits, merges, file churn, or elapsed time exceed configured bounds.
- Fallback receipts: when GitNexus is stale, missing, corrupt, or fails, emit a receipt and require direct source reads or another provider before high-risk decisions.
- Drift-aware reindex: record what changed since the prior graph and whether embeddings or semantic indexes were preserved, dropped, or unavailable.
- Provider abstraction: `gitnexus` is the first `CodeGraphProvider`, not a hard dependency. Other providers can satisfy the same receipts and query contracts.

SNARK-compatible graph proof hooks:

- `graph_snapshot_inclusion`: prove file/symbol/process records are included in a committed graph root.
- `query_result_derivation`: prove a query result hash was derived from a committed snapshot and query hash.
- `impact_derivation`: prove an impact result references only graph edges in the committed snapshot under a declared depth/policy.
- `freshness_attestation`: prove the snapshot commit/worktree hash matches the disclosed state at indexing time.
- `test_mapping_derivation`: prove suggested tests derive from impacted symbols/files and test-map edges.

As with all ZK receipts, these prove graph integrity, derivation, freshness, and policy compliance. They do not prove that the graph is semantically complete or that a proposed code change is correct.

Code graph CLI surface:

```text
harness codegraph status
harness codegraph refresh --sidecar-only
harness codegraph impact --path|--symbol
harness codegraph tests --path|--symbol
harness codegraph doctor
harness codegraph receipt <snapshot-or-query>
```

`protocol doctor` should include stale code graph, dirty overlay mismatch, graph refresh failure, ambiguous impact result, and missing test mapping checks.

## 6C. AgentOps Glass Panel as Read Model

VERI AgentOps Glass Panel is the primary visual/textual surface over Super Harness v2, but it is not the source of lifecycle truth. It consumes RLL, protocol ledgers, receipts, evidence refs, router decisions, proof receipts, benchmark cards, privacy decisions, and replay projections.

Ownership boundary:

- `harness-ai` owns protocol production: ledgers, receipts, local projections, replay/export artifacts, and CLI/API contracts needed by consumers.
- VERI dashboard owns the product UI, tenant-facing dashboard routes, builder widgets, and production dashboard/API deployment.
- Alpha must not add a frontend or dashboard server to `harness-ai`. It should prove the producer side and provide read-only exports that the dashboard can consume.

AgentOps must be read-only by default. State-changing interventions are dry-run first and operator-gated. The panel must make the multi-agent system legible without exposing hidden chain-of-thought.

Alpha AgentOps includes two local producer surfaces:

- `harness agentops panel --run-dir <run>` reads the ledgers and returns a glass-panel status projection: message counts, evidence counts, adapter failures, dissent, RLL events, RSI candidates, open conflicts, and alpha-only conflict closures.
- `harness agentops advise --run-dir <run> --prompt <text> --v1-url|--v1-file ...` actively asks the V1-derived fleet for evidence-bounded advice/dissent. It records the request through the v2 bus, validates each direct upstream against `/v1/models`, writes `read` plus the first semantic ack in a single committed bus transaction after processing, writes `model_output` or `adapter_failure` evidence, emits protocol messages and receipts, appends RLL events, and writes an AgentOps control signal. The command returns red if all members fail, any direct adapter fails, or the configured dissent floor is not met by structured evidence-bound dissent. `--assurance-context production` requires a V1 source, requires V1 consensus success when witnesses are configured, tags advisory subjects for production audits, and requires production-capable sidecar signing metadata. `--max-tokens` can raise local model output budgets when latency/urgency permits.
- `harness protocol adapter-recovery` records recovery as evidence, not as deletion. It emits `adapter_recovery` evidence, an `adapter_recovery` protocol message, an `adapter_recovery_recorded` receipt, and an RLL correction event. It is still blocked unless recovery refs, the resolved failure evidence id, adapter instance/version, independent verification, verifier-selection policy, cryptographic identity binding, verifier trust anchors, verifier attestation refs, and a committed verify-bind transaction meet the configured assurance bar.

Required surfaces:

- Live Mission Graph: agents, models, tasks, panels, artifacts, claims, privacy zones, proof receipts, and operator gates.
- Agent Inspector: identity, live work, history, future instruction stack, benchmark card, epistemic state, and rescue options.
- BCRX Handoff Ledger: source, target, payload class, compression class, cleansing/fortification/review status, acceptance status, elapsed time, receipt hash, and ZK SNARK attestation ref.
- Panel and Dissent Board: panel membership, majority/minority positions, dissents, evidence for/against, and required resolution.
- Triage and Rescue Unit: stuck agents, misroutes, privacy risk, context saturation, unsupported claims, contradiction, benchmark regression, provider degradation, tool failure, and proof incompleteness.
- Internal Benchmark Cards: latency, throughput, long-context reliability, tool-use reliability, domain scores, calibration, factuality, hallucination risk, weak domains, complements, and stale flags.
- Synergy Composition View: task decomposition into atomic skills, candidate ranking, weakness coverage, complementary agents, verifier assignment, dissent needs, and live performance feedback.
- Privacy Swimlanes: local-only, low-cost hosted/regional, ZDR/commercial frontier, and blind/off-stack subtasks.
- Epistemic Ledger: claims, evidence, counterevidence, confidence, contradiction, dissent, verifier outcomes, and source quality.
- Proof/Receipt Viewer: lineage, policy, privacy, execution, handoff, artifact, benchmark, review, and operator-gate receipts.
- Timeline Replay: deterministic reconstruction of mission state at a timestamp, with missing state marked missing.

AgentOps normalized event families:

```text
run.*
task.*
agent.*
adapter.*
router.*
handoff.*
artifact.*
claim.*
dissent.*
panel.*
triage.*
benchmark.*
privacy.*
proof.*
operator.*
tool.*
memory.*
context.*
rll.*
rsi.*
```

Canonical v2 event names are versioned separately from projection code:

```text
rll.event.appended
rll.segment.merged
rsi.tick.started
rsi.decision.proposed
rsi.decision.dry_run
rsi.decision.applied
rsi.decision.rejected
rsi.decision.blocked
rsi.taskgraph.mutated
route.decision.recorded
route.outcome.recorded
benchmark.card.updated
privacy.preflight.allowed
privacy.preflight.blocked
privacy.preflight.operator_gate
drift.budget.breached
epoch.checkpoint.created
proof.receipt.issued
proof.receipt.verified
proof.receipt.unavailable
bcrx.subject.observed
bcrx.handoff.mapped
```

AgentOps projection rules:

- The canonical wire schema is camelCase `agentops.event.v2`.
- RLL-to-AgentOps projections are versioned and replayable.
- Projection tables map source `RLLEvent.eventType` to AgentOps event names and read-model rows.
- Tenant id, privacy zone, visibility, subject id, event id, and source RLL hash are mandatory in every AgentOps projection.
- `payloadSummary` is not trusted free text. It must pass observability-plane privacy preflight before entering RLL, AgentOps, replay exports, or audit bundles.

Observability-plane preflight blocks or redacts:

- hidden chain-of-thought
- raw private prompts
- credentials, keys, tokens, and secrets-adjacent values
- raw private witnesses
- tenant identifiers in non-tenant-local surfaces
- mission gist in hosted/off-stack/public surfaces
- legal/IP strategy outside local-only or secret-commitment-only lanes
- raw KV/context snapshots

AgentOps API contract for the eventual dashboard/API product. This is a consumer contract, not a requirement that `harness-ai` host the tenant-facing API in alpha:

```text
GET  /api/agentops/runs
GET  /api/agentops/runs/:run_id
GET  /api/agentops/runs/:run_id/live
GET  /api/agentops/runs/:run_id/replay?at=timestamp
GET  /api/agentops/runs/:run_id/graph
GET  /api/agentops/agents/:agent_id
GET  /api/agentops/agents/:agent_id/history
GET  /api/agentops/agents/:agent_id/benchmark-card
GET  /api/agentops/handoffs?run_id=...
GET  /api/agentops/handoffs/:handoff_id
GET  /api/agentops/panels?run_id=...
GET  /api/agentops/dissents?run_id=...
GET  /api/agentops/triage?run_id=...
GET  /api/agentops/privacy-zones
GET  /api/agentops/receipts/:receipt_id
POST /api/agentops/interventions/dry-run
POST /api/agentops/interventions/apply
```

The `apply` endpoint remains disabled in the first implementation. When enabled, it must require an operator-gate receipt, policy hash, dry-run evidence, and rollback plan.

## 6D. Runner-Safe Integration Contract

The first implementation must keep the existing phase runner boring and stable.

- `state.json` remains phase progress state.
- `events.jsonl` remains telemetry.
- RLL, protocol, proof, AgentOps, and RSI files are sidecar ledgers under `RunPaths`.
- Runner progress is written only at existing phase boundaries.
- Adapter invocations may write RLL and evidence records during a phase, but must not mutate phase progress semantics.
- Adapter failures produce evidence-backed `unavailable`, `failed`, or `proof_unavailable` receipts without silently changing phase behavior.
- AgentOps consumes normalized projections, not raw phase state as authoritative lifecycle truth.
- `callAgent()` remains a compatibility facade while the adapter registry lands underneath it.
- Intervention commands remain read-only or dry-run until the protocol can prove receipts, policy, rollback, and operator gating.

## 7. Model Adapter Contract

Every direct agent invocation goes through this interface or a language-equivalent implementation.

```ts
export interface ModelAdapter {
  adapterId: string;
  kind: 'cli' | 'http' | 'grpc' | 'local' | 'legacy' | 'human';
  capabilities(): Promise<ModelCapabilities>;
  probe(input: ModelProbe): Promise<ModelProbeResult>;
  invoke(input: ModelInvocation): Promise<ModelInvocationResult>;
}

export interface ModelInvocation {
  invocationId: string;
  runId?: string;
  threadId?: string;
  phaseId?: string;
  scope: ScopeRef;
  caller: AgentIdentity;
  target: AgentIdentity;
  promptRef: EvidenceRef;
  inputEnvelope?: MessageEnvelopeV2;
  timeoutMs: number;
  privacyZone: PrivacyZone;
  requiredReceipts: ReceiptKind[];
  proofPolicy: ProofPolicy;
  abortSignal?: AbortSignal;
}

export interface ModelInvocationResult {
  invocationId: string;
  adapterId: string;
  modelId: string;
  status: 'completed' | 'failed' | 'timeout' | 'cancelled' | 'unavailable';
  stdoutRef?: EvidenceRef;
  stderrRef?: EvidenceRef;
  structuredOutputRef?: EvidenceRef;
  claims: ClaimV2[];
  receipts: ReceiptV2[];
  agentReceipt: AgentInvocationReceipt;
  proofReceipts: ZkSnarkReceipt[];
}
```

Adapter rules:

- CLI adapters must pass prompts through stdin or an argv-safe file reference, not shell-interpolated strings.
- Adapters must hash prompt, stdout, stderr, structured output, and exit metadata.
- Adapters must distinguish authentication failure, transport failure, model refusal, timeout, malformed output, and policy denial.
- Legacy or provider-native `public/workspace/sensitive/secret` privacy tiers must be mapped to canonical `PrivacyZone` before route selection or invocation.
- Adapters may sign "harness observed this invocation" even when the downstream model cannot sign for itself.
- Adapters must never write accepted/completed receipts unless the target agent actually produced the corresponding semantic acknowledgment.

Initial adapters:

- `claude-cli-v1`: compatibility wrapper around the existing Claude CLI invocation.
- `codex-cli-v1`: direct Codex CLI adapter when available.
- `fake-local-v1`: deterministic test adapter for protocol tests.
- `openai-http-v1`: cloud model adapter, gated by configured credentials and privacy policy.
- `local-openai-compatible-v1`: HTTP adapter for local OpenAI-compatible servers.
- `bcrx-v1-legacy`: reads/writes old BCRX packages as lossy v2 envelopes.
- `vcrx-legacy`: imports old VCRX messages and marks missing receipt semantics as unavailable.

## 8. Model Registry and Routing

The registry owns adapter discovery, inventory, policy constraints, route selection, health evidence, and adaptive routing metadata.

Bootstrap config can define initial adapters, but production state must be refreshable from runtime inventory. A route decision must include:

- requested capability
- selected identity
- rejected candidates with reasons
- inventory snapshot hash
- health/probe refs
- policy refs
- cost/latency constraints where available
- fallback decision if the selected adapter is unavailable

Health probes are evidence, not proof that a model is policy-eligible. A direct endpoint may be healthy while the central route authority intentionally excludes it.

Adaptive routing must be bounded:

- floors and caps for timeouts, retries, batch size, and concurrency
- explicit rollback state
- telemetry for changes
- no unreviewed model escalation for privacy-sensitive tasks
- no hardcoded "best model" list as the source of truth

## 8A. Privacy Swimlanes and Route Preflight

Privacy is a routing constraint, a proof input, an AgentOps display field, and an RLL learning signal. Every message, invocation, handoff, evidence ref, proof receipt, replay snapshot, export, UI field, and RSI decision carries a privacy zone.

```ts
export type PrivacyZone =
  | 'LOCAL_ONLY'
  | 'HOSTED_REGIONAL'
  | 'ZDR_FRONTIER'
  | 'BLIND_SUBTASK'
  | 'WORKSPACE'
  | 'SECRET_COMMITMENT_ONLY';

export interface PrivacyDecision {
  decisionId: string;
  subjectId: string;
  tenantId: string;
  zone: PrivacyZone;
  payloadClassification:
    | 'public'
    | 'workspace'
    | 'tenant_private'
    | 'legal_ip_strategy'
    | 'credentials_or_keys'
    | 'mission_gist'
    | 'blind_abstracted'
    | 'hash_or_commitment_only';
  preflightResult: 'allowed' | 'blocked' | 'requires_operator_gate';
  policyRef: EvidenceRef;
  evidenceRefs: string[];
  overrideReceiptId?: string;
}
```

Required lanes:

- Lane L, `LOCAL_ONLY`: raw tenant mission context, legal/IP strategy, private evidence, secrets-adjacent material, sensitive business strategy, and anything that reveals the real objective.
- Lane H, `HOSTED_REGIONAL`: low-sensitivity generic subtasks, translation, formatting, public-information summarization, and sanitized coding tasks.
- Lane Z, `ZDR_FRONTIER`: policy-permitted frontier reasoning for sanitized tasks, public-source research, and high-value work where the true gist is minimized.
- Lane B, `BLIND_SUBTASK`: hosted knowledge gathering or computation that does not reveal the tenant, real objective, private facts, or strategic gist.
- Lane S, `SECRET_COMMITMENT_ONLY`: public proofs, exports, or UI surfaces that may show commitments, hashes, and receipts only.

Privacy preflight asks:

```text
payload_contains_secret?
payload_contains_private_identity?
payload_contains_legal_strategy?
payload_contains_patent_strategy?
payload_contains_financial_private_data?
payload_reveals_mission_gist?
payload_contains_hidden_reasoning?
payload_contains_raw_private_witness?
payload_can_be_safely_abstracted?
payload_needs_local_only?
```

Route rules:

- Raw secrets, credentials, private prompts, hidden reasoning, raw private witnesses, and raw KV checkpoints stay local or secret-commitment-only.
- Hosted lanes receive redacted summaries, commitments, public facts, sanitized code, or blind subtasks.
- Privacy violations block routing unless a policy and operator-gate receipt explicitly allow the override.
- RLL records every privacy decision and outcome. RSI uses privacy failures as routing and rescue signals.
- AgentOps must show privacy zone, preflight result, policy ref, and override receipt where relevant.

## 8B. Synergy Composition and Task Growth

The harness composes a super-agent from complementary strengths rather than pretending one model is best for everything. RLL/RSI makes this composition dynamic while the task is running.

Required flow:

```text
prompt
  -> task decomposition
  -> atomic skill graph
  -> capability requirements
  -> model/agent candidate ranking
  -> weakness coverage analysis
  -> complementary agent pairing
  -> dissent/verifier assignment
  -> execution plan
  -> live performance feedback
  -> RLL update
  -> bounded RSI decision
```

For each atomic task, the route decision records:

- required skill
- required quality
- required speed
- required context
- required privacy
- candidate agents
- selected agent
- why selected
- known weakness
- complementary agent assigned
- verifier assigned
- dissent required
- confidence and benchmark recency

No model weakness may be silently accepted. The system must route around the weakness, pair the model with a complementary verifier, ask for dissent, or show the operator why the risk is tolerated.

Route scoring must be explicit and auditable:

```ts
export interface RouteScore {
  scoreId: string;
  taskId: string;
  candidateAgentId: string;
  total: number;
  confidenceInterval?: [number, number];
  stale: boolean;
  components: Array<{
    name:
      | 'quality_match'
      | 'specialty_match'
      | 'context_fit'
      | 'privacy_fit'
      | 'hardware_fit'
      | 'reliability'
      | 'complementarity_bonus'
      | 'cost_penalty'
      | 'latency_penalty'
      | 'known_weakness_penalty'
      | 'stale_benchmark_penalty'
      | 'privacy_risk_penalty';
    value: number;
    unit: string;
    weight: number;
    evidenceRefs: string[];
  }>;
  missingDataBehavior: 'degrade_confidence' | 'require_verifier' | 'require_operator' | 'block_route';
  recencyDecayPolicyRef: EvidenceRef;
}
```

Route-score rules:

- Weights come from config, policy, or calibrated benchmark metadata, not hidden literals.
- Missing, stale, contradictory, or low-confidence benchmark data degrades confidence and may require a verifier or operator review.
- Every rejected candidate gets a reason.
- Route scores are advisory evidence. They do not override privacy policy or unresolved severe dissent.

## 9. Protocol v2 Message Envelope

```ts
export interface MessageEnvelopeV2 {
  protocolVersion: '2.0';
  messageId: string;
  threadId: string;
  correlationId?: string;
  causationId?: string;
  runId?: string;
  scope: ScopeRef;
  tenantId?: string;
  taskRef?: string;
  createdAt: string;
  privacyZone: PrivacyZone;
  visibility: 'operator_visible' | 'internal' | 'secret_commitment_only';
  sender: AgentIdentity;
  recipients: AgentRecipient[];
  intent: MessageIntent;
  body: MessageBody;
  claims: ClaimV2[];
  evidenceRefs: EvidenceRef[];
  requiredReceipts: ReceiptKind[];
  deadline?: string;
  idempotencyKey: string;
  externalRefs: ExternalRef[];
  signature: SignatureStatus;
}
```

Message intents:

- `task.request`
- `question`
- `answer`
- `observation`
- `inference`
- `speculation`
- `artifact`
- `review.request`
- `review.finding`
- `challenge`
- `decision`
- `cancel`
- `heartbeat`
- `receipt.notice`

Message lifecycle:

```text
created
  -> signed
  -> persisted_outbox
  -> dispatched
  -> delivered | undeliverable
  -> read
  -> accepted | rejected
  -> working
  -> responded
  -> reviewed
  -> resolved
  -> archived
```

Failure states:

- `expired`
- `undeliverable`
- `duplicate_ignored`
- `adapter_failed`
- `challenged`
- `superseded`
- `poison`
- `retry_exhausted`
- `proof_failed`
- `proof_unavailable`

The state machine is append-only. Later states do not erase earlier states.

Scope rules:

- Every message, RLL event, receipt, AgentOps projection, and BCRX subject header carries `scope`.
- `scope.tenantId` is mandatory when `scope.tenantMode` is true.
- Local single-user development runs may set `tenantMode=false`, but must still carry `workspaceId`, `runId`, `privacyZone`, and visibility.
- Tenant-facing exports, replay, dashboards, and hosted/off-stack routing require tenant mode or an explicit operator-gated exception.

## 10. Receipt Semantics

```ts
export type ReceiptKind =
  | 'sent'
  | 'delivered'
  | 'undeliverable'
  | 'read'
  | 'accepted'
  | 'rejected'
  | 'completed'
  | 'failed'
  | 'challenged'
  | 'verified'
  | 'proof_unavailable';

export interface ReceiptV2 {
  receiptId: string;
  kind: ReceiptKind;
  subjectId: string;
  issuer: AgentIdentity;
  issuedAt: string;
  evidenceRefs: EvidenceRef[];
  previousReceiptId?: string;
  signature: SignatureStatus;
}
```

Receipt rules:

- `sent`: sender persisted the message to an outbox.
- `delivered`: transport placed the message in the recipient inbox or endpoint and recorded recipient-bound delivery evidence.
- `undeliverable`: transport could not prove placement in the recipient inbox or endpoint. This is an explicit negative lifecycle receipt, not a delivery receipt.
- `read`: recipient identity consumed the message from its inbox.
- `accepted`: recipient identity accepted responsibility for processing.
- `completed`: recipient returned a result satisfying the accepted work contract.
- `challenged`: adversarial reviewer or policy engine found an unresolved objection.
- `verified`: verifier checked required hashes, signatures, and proof policy.

No adapter may jump directly from `sent` to `accepted` without durable intermediate evidence unless the transport has a formally specified atomic semantics and records it. A missing, unsupported, or non-local inbox endpoint must remain pending or produce `undeliverable`; it must not be converted into `delivered` for operator convenience.

## 11. Evidence and Epistemics

```ts
export interface EvidenceRef {
  evidenceId: string;
  kind:
    | 'file'
    | 'command'
    | 'http'
    | 'model_output'
    | 'receipt'
    | 'signature'
    | 'proof'
    | 'human_observation'
    | 'external_record';
  uri: string;
  sha256?: string;
  contentType?: string;
  producedBy: AgentIdentity;
  observedAt: string;
  command?: string[];
  exitCode?: number;
  lineStart?: number;
  lineEnd?: number;
  retentionPolicy?: string;
}

export interface ClaimV2 {
  claimId: string;
  kind: 'observation' | 'inference' | 'speculation' | 'unknown' | 'decision';
  statement: string;
  confidence?: number;
  evidenceRefs: string[];
  disconfirmingCondition?: string;
  author: AgentIdentity;
  createdAt: string;
  status: 'draft' | 'supported' | 'challenged' | 'retracted' | 'accepted';
}
```

Validation rules:

- `observation` requires evidence from a direct source: command, file, endpoint, receipt, signature, or human observation.
- `inference` requires at least one observation and a disconfirming condition.
- `speculation` can be recorded without evidence only if marked non-actionable.
- `unknown` is preferred over filling gaps from model confidence.
- `decision` must reference the claims it accepts and the policy that allows the decision.
- Claims used for shipping, repair, routing, closure, or issue comments require adversarial clearance when risk is high.

## 12. Anti-Hallucination and Adversarial Review

v2 treats anti-hallucination as a protocol property.

Core checks:

1. Evidence gate: actionable claims without evidence fail validation.
2. Disconfirmation gate: major inferences without falsification criteria fail validation.
3. Contradiction gate: new claims are compared against accepted claims in the same thread, run, and configured memory sources.
4. Freshness gate: stale evidence is marked stale unless a current probe confirms it.
5. Provenance gate: model output cannot be promoted to observation without a non-model evidence ref.
6. Adversarial gate: high-risk results require a challenge pass from a different identity.
7. Privacy gate: secret or sensitive prompts cannot be placed in public evidence or proof inputs.

Adversarial review is a message flow:

```text
author result
  -> review.request
  -> adversarial observation/inference/challenge
  -> author response with evidence
  -> reviewer clears or keeps challenge
  -> policy engine resolves or blocks
```

The author cannot clear their own adversarial challenge. A harness may use multiple reviewers, including a local model for cheap contradiction checks and a stronger cloud model for high-risk claims, but routing must be policy-driven.

## 13. ZK SNARK Proof Receipts

ZK SNARK support is built into v2 as a receipt schema and attestation adapter target. It is not the first alpha proof of correctness. Alpha proves signed hash chains, receipt structure, and `proof_unavailable` honesty first. Real SNARK verification waits for circuit specs, key policy, public/private input policy, retention policy, and an independently reproducible verifier path.

Proof ladder:

1. Signed hashes and stable canonicalization.
2. Ed25519/self-signed alpha attestations for local integrity, explicitly marked as not registry identity-bound.
3. Merkle roots for messages, receipts, claims, evidence, and artifacts.
4. `mock_local` proof transcripts for verifier integration tests only. These use `mode=mock_transcript`, `status=unavailable`, and must never claim `proved`.
5. External ZK SNARK adapter with circuit id, verifying key hash, public input recomputation, and key policy.
6. `harness proof external` command adapter that invokes a configured external prover/verifier with canonical public inputs and records the returned external SNARK descriptor.

ZK descriptor modes are mandatory:

- `mode=not_requested`: no proof was requested.
- `mode=mock_transcript`: deterministic local transcript over public inputs; useful for hashing, plumbing, and replay tests, but not a SNARK proof.
- `mode=external_snark`: only mode allowed to carry `status=proved`; requires external backend, proof hash, public input hash, verifier ref, circuit/key policy, `provedAt`, `expiresAt`, `latencyMs`, and `maxLatencyMs`.
- Production doctors treat external SNARK freshness and proof latency as part of proof readiness. A stale proof, missing proof timestamp, missing expiry, missing latency budget, or `latencyMs > maxLatencyMs` is not production-proved even if hash fields are present.
- External SNARK descriptors must declare `failurePolicy`. Valid policies are `fail_closed`, `manual_hold`, and alpha-only `degrade_to_signature_only_alpha`.
- Failed, unavailable, or over-budget external SNARK descriptors must declare `failureState` and `reason`. Production forbids alpha-only signature degradation and treats over-budget proofs as not proved.
- External prover process failure, timeout, invalid JSON, or public-input mismatch becomes an explicit fail-closed descriptor rather than an implied proof.

Alpha verification commands may return green with warnings for `mock_transcript` and self-signed Ed25519 signatures because those warnings preserve the trust boundary: local integrity was checked, real SNARK verification and registry identity binding were not.

Production signing policy:

- Package defaults leave signing disabled. Production runs must enable signing through schema-validated config, not hidden environment assumptions.
- The implemented local production-capable provider is `local_operator_file_ed25519`. It reads an operator-provided PKCS8 Ed25519 private key file and emits inline SPKI public-key refs so the doctor can verify the signature bytes.
- The implemented external custody provider is `external`. It invokes a schema-declared command with a structured signing request on stdin and expects a `SignatureDescriptor` on stdout. This is the integration seam for KMS/HSM/TEE bridges; the production doctor still verifies the returned descriptor and fails invalid signatures.
- The external provider supports ordered `fallbackSigners`. If the primary signer fails, fallback signers are tried in order. If the cascade exhausts, `failurePolicy=halt` throws and stops signing; `failurePolicy=degrade_to_unavailable` emits an explicit unavailable descriptor that production doctors reject. The harness must not silently fall back to unsigned production evidence.
- `operator_bound` and `registry_verified` signing require `keyId`, `expiresAt`, and `revocationListRef` in config. A configured `revokedKeyIds` list prevents a revoked key from signing.
- Every signed sidecar descriptor includes `keyId`, `issuedAt`, `expiresAt`, and `revocationListRef`. The production doctor rejects missing lifecycle metadata, expired signatures, unsupported algorithms, unverifiable public key refs, failed signature checks, non-operator/non-registry trust levels, and locally checkable revoked keys. `file://` revocation lists are dereferenced by the doctor and may declare revoked keys as an array or as `revokedKeyIds`, `revoked_key_ids`, or `revoked`.
- HSM/KMS/external signer deployment policy remains a production hardening target. The operator-file provider is useful for local production-shaped verification and controlled deployments, but fleet dissent correctly treats it as residual key-exfiltration risk until replaced or backed by hardware/managed key custody.

External ZK command contract:

- Request stdin schema: `superharness.external_zk_request.v2`.
- Request fields: statement, public inputs, `publicInputsHash`, circuit metadata, verifier ref, setup hash, max latency, and failure policy.
- Response stdout: a `ZkSnarkDescriptor`.
- The harness measures latency, fills missing latency/failure-policy defaults from config, rejects public-input hash mismatches, and converts prover failures into deterministic failure descriptors.

```ts
export interface ZkSnarkReceipt {
  receiptId: string;
  proofVersion: 'zk-snark-receipt-v2';
  subjectId: string;
  issuer: AgentIdentity;
  issuedAt: string;
  statementHash: string;
  publicInputs: ZkPublicInputs;
  publicInputsHash: string;
  privateWitnessCommitment: string;
  proofSystem:
    | 'groth16_bn254'
    | 'plonk_bn254'
    | 'halo2_kzg'
    | 'mock_local'
    | 'external';
  circuitId: string;
  circuitHash?: string;
  verifyingKeyHash?: string;
  proofBytesHash?: string;
  proofRef?: EvidenceRef;
  verifierRef?: EvidenceRef;
  verificationStatus:
    | 'not_requested'
    | 'proof_unavailable'
    | 'pending'
    | 'verified'
    | 'failed';
  signature: SignatureStatus;
}

export interface ZkPublicInputs {
  runId?: string;
  threadId?: string;
  messageId?: string;
  invocationId?: string;
  eventChainHead?: string;
  receiptMerkleRoot?: string;
  artifactMerkleRoot?: string;
  claimMerkleRoot?: string;
  evidenceMerkleRoot?: string;
  epistemicSummaryHash?: string;
  routeDecisionHash?: string;
  policyHash?: string;
}

export interface ProofPolicy {
  policyId: string;
  requiredLevel:
    | 'none'
    | 'signed_hash'
    | 'signed_receipt_chain'
    | 'merkle_commitment'
    | 'mock_local'
    | 'verified_snark';
  mandatorySubjects: Array<
    | 'operator_gate'
    | 'applied_rsi_decision'
    | 'privacy_override'
    | 'cross_tenant_export'
    | 'handoff'
    | 'agent_invocation'
    | 'phase_receipt'
    | 'run_receipt'
  >;
  proofUnavailableAllowed: boolean;
  publicInputPolicyRef: EvidenceRef;
  privateWitnessPolicyRef: EvidenceRef;
  retentionPolicyRef: EvidenceRef;
  verifierPolicyRef: EvidenceRef;
}
```

SNARK receipt rules:

- Public inputs contain commitments and hashes, not raw sensitive content.
- Private witnesses may include workspace trees, command outputs, private package contents, and model transcripts, but only as committed inputs.
- The harness signs receipt metadata even if the external SNARK prover signs separately.
- `proof_unavailable` is explicit and auditable.
- A verifier must be able to recompute public input hashes from disclosed artifacts and verify proof bytes or a proof reference.
- Retention may delete raw prompt/output artifacts, but their commitments remain in the receipt chain.
- If the proof backend is disabled, the receipt remains signed but cannot claim SNARK verification.
- SNARK verification status and semantic claim status are separate. A UI may show `attestation_status=verified` while also showing `claim_status=unsupported`, `partially_supported`, `contradicted`, or `stale`.
- Public proof inputs must be red-team checked for raw prompts, raw outputs, private witnesses, hidden reasoning, tenant identifiers, mission gist, and legal/IP strategy.

Candidate circuit/proof statements:

1. Message inclusion: a message existed in an outbox/inbox ledger with a specific hash.
2. Receipt chain: a delivery/read/acceptance/completion sequence exists and is ordered.
3. Agent invocation: prompt, output, structured contract, and exit metadata match the invocation receipt.
4. Phase completion: phase output hash, event-chain head, claim root, and evidence root match the phase receipt.
5. Recursive handoff: step `N` input digest equals step `N-1` output digest, and complete data record hashes chain correctly.
6. Epistemic clearance: actionable claim root contains evidence refs and adversarial clearance refs under the configured policy hash.

## 14. Signed Event and Run Receipt Bundles

The current analytics `sealRun()` concept must not be treated as cryptographic sealing. v2 introduces a cryptographic receipt bundle:

```ts
export interface SignedEventV2 {
  seq: number;
  eventHash: string;
  prevEventHash?: string;
  payload: unknown;
  canonicalizationVersion: string;
  signature: SignatureStatus;
}

export interface AgentInvocationReceipt {
  receiptId: string;
  invocationId: string;
  adapterId: string;
  modelId: string;
  promptHash: string;
  stdoutHash?: string;
  stderrHash?: string;
  structuredOutputHash?: string;
  exitCode?: number;
  signal?: string;
  startedAt: string;
  endedAt: string;
  tokenUsage?: unknown;
  signature: SignatureStatus;
}

export interface PhaseReceipt {
  receiptId: string;
  runId: string;
  phaseId: string;
  status: string;
  phaseOutputHash?: string;
  eventMerkleRoot: string;
  claimMerkleRoot?: string;
  evidenceMerkleRoot?: string;
  agentReceiptIds: string[];
  proofReceiptIds: string[];
  signature: SignatureStatus;
}

export interface RunReceiptBundle {
  receiptId: string;
  runId: string;
  runJsonHash: string;
  stateJsonHash: string;
  phaseReceiptIds: string[];
  finalEventChainHead: string;
  runMerkleRoot: string;
  keyManifestHash: string;
  transparencyRefs: EvidenceRef[];
  signature: SignatureStatus;
}
```

All signed JSON must use stable canonicalization. Plain `JSON.stringify` insertion order is not enough for verifier-grade receipts.

## 15. Legacy BCRX/VCRX Adapters

The legacy adapters exist to migrate and interoperate, not to preserve broken semantics.

Before any legacy import, the operator must provide or approve a migration source manifest:

```ts
export interface LegacyMigrationSource {
  sourceId: string;
  kind: 'bcrx_v1' | 'vcrx_legacy' | 'pending_watcher' | 'handoff_archive';
  pathOrEndpoint: string;
  owner: string;
  freshnessSignal: string;
  hashPolicy: string;
  trustLevel: 'authoritative' | 'best_effort' | 'forensic_only';
  knownLossyFields: string[];
  receiptPolicy: 'preserve_only' | 'map_when_proven' | 'never_infer';
}
```

Without a source manifest, legacy tools may scan and report, but they must not mint canonical v2 import records.

### BCRX v1 Adapter

Maps legacy package fields into v2:

- `package_id` -> `externalRefs[]` and `messageId` derivation input
- `source_model` -> `sender`
- `target_model` -> `recipients[]`
- `current_state` -> `body.context`
- `next_model_instruction` -> `body.instructions`
- `requested_output` -> `body.expectedOutput`
- existing signatures -> `evidenceRefs[]`
- existing ZK package metadata -> `proofReceipts[]` where verifiable, otherwise `proof_unavailable`

The adapter must preserve the original package hash and path. If old package fields are absent, the adapter writes `unknown`, not guesses.

BCRX v2 adds a daily-use subject header. It is not lifecycle authority; receipts remain authority for sent, delivered, read, accepted, completed, failed, and challenged. The subject header exists so humans, agents, inbox monitors, and `protocol inbox` can triage packages without opening the full body.

```ts
export interface BcrxSubjectHeader {
  packageId: string;
  createdAt: string;
  scope: ScopeRef;
  sourceModel: string;
  targetModel: string;
  subjectTitle: string;
  subjectKind:
    | 'handoff'
    | 'reply'
    | 'request'
    | 'status'
    | 'heartbeat'
    | 'receipt_notice'
    | 'challenge';
  packageState:
    | 'new'
    | 'pending_reply'
    | 'accepted'
    | 'working'
    | 'blocked'
    | 'completed'
    | 'challenged'
    | 'stale'
    | 'superseded'
    | 'no_reply_seen';
  lifecycleStatusRef?: string;
  actionableRequest: string;
  nextActor: string;
  recipientScope: 'direct' | 'cc' | 'broadcast' | 'watch_only';
  recipientInScope: boolean;
  requiresReply: boolean;
  lastMaterialChangeAt: string;
  materialChangeSummary?: string;
  deadline?: string;
  privacyZone: PrivacyZone;
  payloadClass:
    | 'public'
    | 'workspace'
    | 'tenant_private'
    | 'legal_ip_strategy'
    | 'credentials_or_keys'
    | 'mission_gist'
    | 'blind_abstracted'
    | 'hash_or_commitment_only';
  evidenceState:
    | 'none'
    | 'partial'
    | 'current'
    | 'stale'
    | 'verified'
    | 'proof_unavailable';
  sourcePackagePath?: string;
  sourcePackageHash: string;
  receiptCommitment?: string;
  priority?: 'low' | 'normal' | 'high' | 'urgent';
  artifactCount?: number;
  evidenceRefCount?: number;
  safeAffectedPathLabels: string[];
  supersedesPackageIds: string[];
  responseDueAt?: string;
  blockerSummary?: string;
  affectedPathRefs: string[];
  verificationRefs: string[];
  doNotRepeatRefs: string[];
  operatorAttentionReason?: string;
  implementerAgentId?: string;
  verifierAgentId?: string;
  verifierSelectionMethod?:
    | 'policy_registry'
    | 'fleet_consensus'
    | 'operator_assigned'
    | 'manual_by_implementer';
  verifierPolicyRef?: string;
  identityBindingStatus?:
    | 'unverified'
    | 'evidence_bound'
    | 'cryptographically_verified';
  verificationStatus?:
    | 'unverified'
    | 'self_verified'
    | 'independently_verified'
    | 'rejected';
  instrumentationRefs?: string[];
  semanticDriftIndex?: number;
  laneIntegrityScore?: number;
  blocking?: boolean;
}
```

Required for new v2 BCRX packages:

- `packageId`
- `createdAt`
- `scope`
- `sourceModel`
- `targetModel`
- `subjectTitle`
- `subjectKind`
- `packageState`
- `actionableRequest`
- `nextActor`
- `recipientScope`
- `requiresReply`
- `lastMaterialChangeAt`
- `privacyZone`
- `payloadClass`
- `evidenceState`
- `sourcePackageHash`
- `safeAffectedPathLabels`

Required for inbox views:

- `recipientInScope`, computed for the queried recipient.

Required for legacy imports:

- `sourcePackagePath`
- `sourcePackageHash`

Strongly recommended:

- `supersedesPackageIds`
- `materialChangeSummary`
- `responseDueAt`
- `blockerSummary`
- `receiptCommitment`
- `priority`
- `artifactCount`
- `evidenceRefCount`
- `affectedPathRefs`
- `verificationRefs`
- `doNotRepeatRefs`
- `operatorAttentionReason`

Subject-header privacy rules:

- `subjectTitle`, `actionableRequest`, `materialChangeSummary`, and `blockerSummary` must pass observability-plane preflight.
- These fields must summarize actions and state, not hidden reasoning.
- `payloadClass=mission_gist`, `legal_ip_strategy`, or `credentials_or_keys` forces local-only or secret-commitment-only visibility unless operator policy says otherwise.
- `packageState` may summarize triage state, but it must not imply lifecycle receipts that do not exist.
- Default inbox lists must not display full `current_state`, full `next_model_instruction`, mission gist, true objective, hidden reasoning, raw prompts, raw outputs, transcript excerpts, legal/IP/patent/financial strategy, private identities, tenant names outside policy-approved tenant views, raw file paths that leak private context, KV checkpoint details, benchmark internals, route-score internals, or full receipt chains.
- `safeAffectedPathLabels` are redacted path labels for triage. Full paths stay behind drill-down and policy checks when path names reveal private context.

### VCRX Legacy Adapter

VCRX legacy import must treat watcher or stdout state as low-trust transport evidence. It may produce:

- `sent` if the source package exists and is hashable
- `delivered` only if the recipient inbox/endpoint can be proven
- `read` only if the recipient identity emits a read receipt
- `accepted` only if the recipient emits semantic acceptance

If the old layer cannot prove a state, the adapter writes `receipt_unavailable` evidence and leaves the state open.

## 16. Distributed Runtime

v2 assumes distributed agents from day one.

Required node concepts:

- node id
- host id
- trust domain
- transport profile
- clock source and skew tolerance
- signing identity
- inbox path or endpoint
- outbox path or endpoint
- lease store
- health status
- supported adapters

Initial transports:

1. Local filesystem JSONL ledgers for single-host development.
2. SSH/Tailscale file or command transport for Mac B/C.
3. HTTP transport for local/cloud OpenAI-compatible endpoints.
4. Object-store or database-backed transport for Spark/cloud fanout.

Each transport must publish a transport profile:

```ts
export interface TransportProfile {
  transportId: string;
  kind: 'local_jsonl' | 'ssh_filesystem' | 'http' | 'object_store' | 'database';
  appendAtomicity: 'single_writer' | 'compare_and_swap' | 'transactional' | 'best_effort';
  ordering: 'per_recipient_fifo' | 'per_thread_fifo' | 'causal_only' | 'unordered';
  deliverySemantics: 'at_least_once' | 'effectively_once_with_idempotency' | 'exactly_once';
  leaseModel: 'none' | 'ttl_lease' | 'fenced_lease';
  clockSkewToleranceMs: number;
  supportsRecipientQuorum: boolean;
  supportsPoisonQueue: boolean;
  replayCursorOwner: 'sender' | 'recipient' | 'coordinator';
  staleReplyPolicy: 'reject' | 'quarantine' | 'operator_review';
}
```

Distributed RLL uses per-node segment chains plus merge receipts:

```ts
export interface RLLSegmentHeader {
  segmentId: string;
  runId: string;
  scope: ScopeRef;
  nodeId: string;
  transportId: string;
  firstSeq: number;
  lastSeq: number;
  segmentRoot: string;
  prevSegmentRoot?: string;
  receiptId: string;
}

export interface RLLMergeReceipt {
  mergeId: string;
  runId: string;
  scope: ScopeRef;
  coordinatorNodeId: string;
  segmentRoots: string[];
  mergedMerkleRoot: string;
  orderingPolicy: 'causal' | 'coordinator_seq' | 'transport_fifo';
  conflictRefs: EvidenceRef[];
  signature: SignatureStatus;
}
```

Distributed safety rules:

- All dispatch uses idempotency keys.
- Every recipient has a replay cursor.
- Leases expire safely and can be renewed; write-capable leases require fencing tokens.
- Partitioned nodes leave messages pending or expired; they do not mark messages failed unless policy says so.
- Reconnect replay must not duplicate accepted work.
- Conflicting writes require a lock or merge protocol with receipt-backed causality.
- Partial recipient fanout must be visible per recipient. A message delivered to one recipient and pending for another is not globally delivered.
- Poison messages move to a quarantine queue with evidence, not silent drops.
- Stale replies are rejected or quarantined when causation ids, epoch ids, route decisions, or lease tokens no longer match.
- Clock-skew handling must be explicit in transport profiles; ordering cannot rely on wall-clock time alone.
- Workspace-write attempts across agents require lease evidence, merge receipts, or operator arbitration.

## 16A. Long-Run Epoch Continuity

The harness must support missions that last far longer than one model context window. Long-run continuity comes from verified, compressed, replayable, provenance-bearing mission state, not from pretending one continuous mental context stays alive.

Epoch types:

- Micro-epoch: 15-60 minutes; agent handoff or checkpoint.
- Work epoch: 4-24 hours; subgoal completion.
- Review epoch: 1-7 days; epistemic review, tests, pruning, and benchmark refresh.
- Strategic epoch: 30-90 days; operator re-charter, archive compaction, policy review.
- Campaign: 3-24+ months; persistent pursuit of a large objective.

```ts
export interface EpochCheckpoint {
  checkpointId: string;
  runId: string;
  epochType: 'micro' | 'work' | 'review' | 'strategic' | 'campaign';
  startedAt: string;
  endedAt: string;
  goalSummary: string;
  currentStateSummary: string;
  completedWorkRefs: string[];
  evidenceRefs: string[];
  claimRefs: string[];
  rejectedClaimRefs: string[];
  blockerRefs: string[];
  nextInstructionRefs: string[];
  doNotRepeatRefs: string[];
  privacyTags: PrivacyZone[];
  artifactRefs: string[];
  codeGraphSnapshotRefs: string[];
  impactReceiptRefs: string[];
  testMapRefs: string[];
  dirtyWorktreeStateRef?: EvidenceRef;
  staleEvidenceRefreshPlanRef?: EvidenceRef;
  kvCheckpointRefs: string[];
  receiptIds: string[];
  proofReceiptIds: string[];
  compactionPolicyHash: string;
}
```

BCRX long-run handoff flow:

```text
agent completes epoch or hits threshold
  -> emits structured work product
  -> strips hidden reasoning
  -> captures goal, state, work done, evidence, claims, rejected claims, blockers
  -> adds next instructions, do-not-repeat paths, privacy tags, artifact pointers
  -> epistemic review
  -> privacy review
  -> fortification with tests and failure warnings
  -> BCRX/HN-JN compression package
  -> optional local-only KV sidecar
  -> hash and receipt
  -> ZK SNARK proof receipt when policy requests it
  -> router selects next agent by capability, privacy, health, and weakness coverage
  -> recipient accepts, rejects, or requests repackage
  -> RLL and AgentOps update the task graph and replay state
```

Retention modes:

- Lean long-run: BCRX packages, artifact graph, evidence spans, receipts, recursive digests, and replay snapshots.
- Sparse local KV: optional active local lane sidecars for high-value local-only work.
- Raw/high-frequency KV: disallowed by default because storage and privacy risk grow too fast.

Long-run claims must be phrased as continuity of verified mission state, not continuity of a single agent mind. Every long-run mission needs:

- drift budget
- revalidation schedule
- benchmark refresh schedule
- archive compaction policy
- artifact loss model
- stale evidence policy
- operator re-charter criteria
- epoch receipt bundle

```ts
export interface DriftBudget {
  budgetId: string;
  runId: string;
  maxUnsupportedClaimRatio: number;
  maxStaleEvidenceAgeMs: number;
  maxBenchmarkAgeMs: number;
  maxSummaryDriftScore: number;
  requiredReviewCadenceMs: number;
  operatorRecharterCadenceMs: number;
  breachAction: 'revalidate' | 'pause' | 'operator_gate' | 'quarantine';
}
```

## 17. Config Shape

New config sections must be schema-backed:

```json
{
  "models": {
    "adapters": [],
    "routes": [],
    "inventorySources": [],
    "probePolicy": {},
    "privacyPolicy": {}
  },
  "protocol": {
    "version": "2.0",
    "bus": {},
    "receipts": {},
    "legacyAdapters": {}
  },
  "epistemics": {
    "requireEvidenceFor": ["observation", "inference", "decision"],
    "requireDisconfirmingCondition": true,
    "adversarialReview": {}
  },
  "agentops": {
    "enabled": true,
    "mode": "read_only",
    "emitNormalizedEvents": true,
    "replay": {}
  },
  "rll": {
    "enabled": true,
    "store": "jsonl",
    "hashChain": true,
    "emitControlSignals": true
  },
  "rsi": {
    "enabled": true,
    "mode": "recommend_only",
    "rebuildOnRead": true,
    "allowedActions": [],
    "operatorGateRequiredForHighRisk": true
  },
  "privacy": {
    "defaultZone": "WORKSPACE",
    "lanes": {},
    "preflight": {}
  },
  "codegraph": {
    "enabled": true,
    "defaultProvider": "gitnexus",
    "sidecarOnlyRefresh": true,
    "stalePolicy": {},
    "generatedFilePolicy": {}
  },
  "interventions": {
    "enabled": false,
    "dryRunOnly": true
  },
  "proofs": {
    "signing": {},
    "zkSnarks": {
      "enabled": false,
      "defaultBackend": "mock_local",
      "backends": []
    }
  }
}
```

The default config should preserve current behavior by routing all existing agent calls to `claude-cli-v1`, while still writing passive v2 evidence and invocation receipts.

## 18. Alpha Vertical Slice: Smallest Hard Thing

The first build slice must prove the original failure mode: real and fake agents can exchange messages with distinct, evidence-backed lifecycle receipts. It must not attempt to build the full dashboard, full RSI control loop, real ZK SNARKs, or distributed transports first.

Alpha adds:

- `src/lib/models/types.ts`
- `src/lib/models/registry.ts`
- `src/lib/models/adapters/claudeCli.ts`
- `src/lib/models/adapters/fakeLocal.ts`
- `src/lib/collaboration/envelope.ts`
- `src/lib/collaboration/localJsonlBus.ts`
- `src/lib/collaboration/receipts.ts`
- `src/lib/evidence/ledger.ts`
- `src/lib/rll/ledger.ts`
- `src/lib/rsi/recommend.ts`
- `src/lib/privacy/preflight.ts`
- `src/lib/proof/local.ts`
- `src/lib/legacy/importer.ts`
- `src/lib/codegraph/types.ts`
- `src/lib/codegraph/adapter.ts`
- `src/lib/codegraph/gitnexusAdapter.ts`
- `src/lib/codegraph/fallbackSourceAdapter.ts`
- `src/lib/codegraph/receipts.ts`
- `src/lib/codegraph/store.ts`
- `src/commands/agentops.ts`
- `src/commands/codegraph.ts`
- `src/commands/fleet.ts`
- `src/commands/legacy.ts`
- `src/commands/proof.ts`
- `src/commands/protocol.ts`
- `src/commands/rll.ts`
- `src/commands/rsi.ts`

Alpha changes:

- Keep `src/lib/claude.ts` exported API, but delegate invocation to the model registry.
- Preserve the current `agent_call` telemetry shape.
- Extend `RunPaths` with sidecar protocol, RLL, evidence, and receipt files.
- Extend config defaults and schema only for `models`, `protocol`, `rll`, `privacy`, passive `codegraph`, and minimal `proofs.signing`.
- Write signed/hashable receipts for prompt path, stdout/stderr refs, exit metadata, sent, delivered, undeliverable, read, accepted, completed, failed, and unavailable states.
- Implement privacy preflight before any hosted/off-stack adapter invocation. Adapters with configured `privacyZone` run preflight before network I/O; a blocked result emits adapter-failure evidence and no remote call.
- Preserve passive code graph receipt schemas so future GitNexus evidence can land without reshaping RLL.
- Implement a local JSONL bus with idempotency keys, per-recipient cursors, and hash-chain verification.
- Implement `harness rll doctor --audit tip|full` and `harness protocol doctor <run>`.
- `harness protocol send|inbox|ack` implements local JSONL collaboration semantics. Send writes an envelope plus `sent` and per-recipient lifecycle receipts. Recipients whose declared inbox URI is the local JSONL inbox URI get `delivered` receipts and inbox projections; missing, unsupported, or non-local endpoints get `undeliverable` receipts and no fake inbox message. Inbox returns both local bus messages and addressed sidecar protocol messages/receipts, and it can append `read` receipts. Ack appends semantic `accepted`, `rejected`, `completed`, `failed`, or `challenged` receipts. Retries use idempotency keys and do not duplicate messages or receipts.
- The local bus transaction ledger `protocol/bus-transactions.jsonl` is the committed source of truth for bus doctor reads. Envelope, inbox, outbox, and lifecycle receipt files are projections for operator ergonomics and compatibility. Orphan projections without a transaction are ignored by committed bus reads but surfaced as projection-audit warnings; committed transactions embed the envelope and receipts so missing projections can be rebuilt rather than treated as corruption; projections that exist but diverge from committed transactions are doctor-red drift.
- `harness protocol doctor` supports `--audit tip` for cheap long-run monitoring and `--audit full` for full sidecar validation. Tip mode validates local tail integrity and object shape without cross-ledger existence checks. Full mode walks the protocol, receipt, evidence, RLL, AgentOps, and RSI sidecars, validates hash links, canonical ids, evidence-policy minimums, receipt public-input hashes, alpha signature/ZK status, and cross-ledger refs. It also checks bus envelopes against lifecycle receipts so delivery is not confused with read or acceptance.
- `harness protocol promote` is the production hard gate. It blocks invalid sidecars, bus drift, unresolved `blocking=true` evidence, recorded adapter failures without verified replay-resistant `adapter_recovery`, and implementation-conflict closures lacking independent cryptographic verifier binding, trust anchors, attestation refs, and committed verify-bind transaction evidence. Adapter recovery clears a blocker only when it cites the currently open failure evidence id it resolves; recovery for a different failure is recorded but cannot clear the live blocker.
- `harness rll doctor` reuses the protocol sidecar doctor, then adds RLL-specific checks: full-mode deterministic signal derivation, missing AgentOps projection warnings, RSI required-evidence existence checks, RSI canonical id checks, configurable feedback-oscillation hysteresis, and alpha blocking for `status=applied`.
- `harness rsi recommend --run-dir <run>` consumes AgentOps control signals and upserts bounded RSI candidates only when the signal cites existing evidence refs. Evidence-free or missing-evidence signals are skipped with RLL failure records. It is recommend-only and emits `rsi_candidate` RLL events; alpha does not apply mutations.
- `harness proof attest|verify|explain` creates and checks Ed25519 self-signed alpha attestations. `--mock-zk` emits a deterministic `mock_transcript` descriptor that verifies plumbing and public-input binding while explicitly warning that no real SNARK was verified. Protocol doctors also enforce external-SNARK freshness, latency budgets, and deterministic failure-state metadata when external proof descriptors are present.
- `harness legacy scan|import-bcrx|import-vcrx` supports manifest-gated legacy import. Without an approved source manifest it scans only. With a manifest it emits lossy v2 artifact envelopes and file evidence while leaving old delivery/read/acceptance semantics `unavailable`.
- `harness fleet doctor --v1-url|--v1-file [--config overlay]` treats V1 `/v1/models` as the active roster source of truth and records direct endpoint/smoke failures as evidence when `--run-dir` is supplied. Optional `--consensus-v1-url`, `--consensus-v1-file`, and `--min-agreeing-sources` add witness checks for split-brain without changing primary V1 roster authority.
- `harness agentops panel` renders the local glass-panel read model. `harness agentops advise` actively invokes the V1-derived fleet, writes bus receipts/evidence/protocol/RLL records, and fails closed on adapter failures or insufficient configured dissent. Production advisory requires V1 roster authority, consensus success when witnesses are present, production-capable signer lifecycle metadata, and structured evidence-bound dissent for any dissent-floor credit.
- `harness codegraph status|refresh|impact|tests|doctor` persists payload receipts, and `harness codegraph receipt <ref>` verifies the local receipt store or emits an explicit unavailable receipt.

Alpha explicitly defers:

- Dashboard/frontend implementation.
- Tenant-facing AgentOps API hosting inside `harness-ai`.
- Applied RSI decisions.
- Real ZK SNARK verification.
- Ungated BCRX/VCRX canonical import. Alpha import is manifest-gated and lossy only.
- Distributed Mac/Spark/cloud transports.
- Gated interventions.

Post-alpha modules:

- `src/lib/agentops/types.ts`
- `src/lib/agentops/mapper.ts`
- `src/lib/agentops/projection.ts`
- `src/lib/rll/index.ts`
- `src/lib/rsi/runIndex.ts`
- `src/lib/rsi/decisions.ts`
- `src/lib/epistemics/claims.ts`
- `src/lib/codegraph/types.ts`
- `src/lib/proofs/signatures.ts`
- `src/lib/proofs/zkSnarks.ts`
- `src/lib/legacy/bcrxAdapter.ts`
- `src/lib/legacy/vcrxAdapter.ts`
- `src/lib/specCouncil/dissent.ts`
- `src/commands/models.ts`
- `src/commands/proof.ts`
- `src/commands/agentops.ts`
- `src/commands/codegraph.ts`
- `src/commands/rsi.ts`

Do not change in alpha:

- The phase order.
- `PHASE_IDS`.
- Runner resume semantics.
- Gate behavior.
- PR assembly behavior.
- `state.json` phase-progress meaning.

## 19. CLI Surface

New commands:

```text
harness models list
harness models probe [model-or-route]
harness protocol send
harness protocol inbox
harness protocol ack
harness protocol replay
harness protocol doctor
harness protocol promote --run-dir <run>
harness protocol adapter-failure --run-dir <run> --adapter <id> --provider <id> --error <text>
harness protocol adapter-recovery --run-dir <run> --adapter <id> --provider <id> --verifier <agent> --evidence <ids> --resolves-evidence <ids> --adapter-instance <id> --adapter-version <version> --identity-verifier <agent> --verifier-trust-anchor <ref> --verifier-attestation <ids> --identity-verifier-trust-anchor <ref> --identity-verifier-attestation <ids> --identity-binding <ids> --identity-binding-status cryptographically_verified
harness protocol conflict --run-dir <run> --conflict-id <id> --title <text> --description <text>
harness proof attest --statement <text> --public-inputs <json> [--mock-zk]
harness proof external --statement <text> --public-inputs <json> --command <prover> --timeout-ms <n> --max-output-bytes <n> --max-latency-ms <n>
harness proof verify --file <attestation.json>
harness proof explain --file <attestation.json>
harness legacy scan <path> --kind bcrx_v1|vcrx_legacy [--manifest <manifest.json>]
harness legacy import-bcrx <path> --run-dir <run> --manifest <manifest.json>
harness legacy import-vcrx <path> --run-dir <run> --manifest <manifest.json>
harness agentops panel --run-dir <run>
harness agentops advise --run-dir <run> --prompt <text> --v1-url|--v1-file [--config overlay]
harness agentops replay [run]
harness agentops graph [run]
harness agentops export [run]
harness rll doctor --run-dir <run> [--audit tip|full]
harness rsi rebuild [run]
harness rsi recommend [run]
harness privacy preflight [payload-or-ref]
harness fleet doctor --v1-url|--v1-file [--config overlay]
harness codegraph status
harness codegraph refresh --sidecar-only
harness codegraph impact --path|--symbol
harness codegraph tests --path|--symbol
harness codegraph doctor
harness codegraph receipt <snapshot-or-query>
```

`protocol doctor` should detect:

- JSONL hash-chain tamper in protocol, receipt, evidence, RLL, and AgentOps sidecars
- malformed protocol messages, receipts, evidence receipts, RLL events, control signals, or RSI candidates
- canonical id mismatches for protocol messages, receipts, evidence, RLL events, AgentOps signals, and RSI candidates
- evidence-policy minimums not satisfied by a message
- receipt public-input hashes or receipt ids that no longer match canonical public fields
- cross-ledger evidence/message references in `--audit full`
- recipients without reachable inboxes
- sent messages without delivery receipts
- delivered messages without read receipts past deadline
- accepted messages without progress
- missing signatures
- stale inventory
- proof policies claiming verified without proof receipts
- legacy adapter lossy mappings
- stale code graph
- dirty overlay mismatch

`rll doctor --audit full` should additionally detect:

- deterministic RLL control signals that have not yet been projected to AgentOps
- RSI candidates whose canonical ids no longer match subject, hypothesis, and required evidence refs
- RSI candidates whose required evidence refs are absent from the evidence ledger
- RSI candidates marked `applied` while alpha is recommend-only
- schema drift between core RLL events and sidecar RLL events
- graph refresh failure
- ambiguous impact result
- missing test mapping

## 20. Acceptance Tests

Protocol tests:

1. A v2 envelope validates, signs, persists, reloads, and round-trips.
2. Outbox crash before dispatch replays exactly one dispatch.
3. Delivery, undeliverable, read, accepted, completed, failed, and challenged receipts are independent.
4. A fake Codex agent asks a fake Claude agent a question; Claude answers; a fake local reviewer challenges; Codex resolves with evidence. The thread preserves causality.
5. Missing recipient remains pending or undeliverable and is not marked delivered.
6. Duplicate delivery is ignored by idempotency key.

Adapter tests:

1. `claude-cli-v1` preserves current `callAgent()` prompt writing, timeout, stdout/stderr capture, JSON contract extraction, and `agent_call` telemetry shape.
2. `fake-local-v1` supports deterministic success, timeout, malformed JSON, and refusal cases.
3. Auth failure from a real CLI adapter returns `unavailable` plus an evidence ref, not a silent failure.
4. Subprocess exit 0 with no parseable harness contract records `adapter_failure` evidence; it is not treated as completion merely because the process exited cleanly.
5. Hosted or off-stack adapters with a configured `privacyZone` run privacy preflight before network I/O and record an adapter failure without calling the endpoint when the preflight blocks.
6. `ship.ts` task breaking eventually routes through the same registry.

Real-agent failure canary matrix:

1. Auth failure creates `unavailable` receipt and evidence.
2. CLI hang creates timeout receipt and preserved stderr/stdout refs where available.
3. Malformed JSON creates structured-output failure without discarding raw output refs.
4. Missing recipient remains pending or undeliverable, never delivered.
5. Duplicate delivery is ignored by idempotency key.
6. Recipient crash after read but before accept leaves `read` without `accepted`.
7. Stale reply after route/epoch change is quarantined or rejected.
8. Subprocess exit 0 with invalid contract is not completion.
9. Subprocess nonzero with valid diagnostic contract is recorded as failed/unavailable, not silently retried as success.

Evidence and epistemic tests:

1. Observation without evidence fails validation.
2. Inference without evidence or disconfirming condition fails validation.
3. Speculation is accepted only as non-actionable.
4. A model output claim cannot be promoted to observation without non-model evidence.
5. High-risk claim without independent adversarial review blocks resolution.

Proof tests:

1. Signed event chain verifies.
2. Editing, deleting, or reordering one event fails verification.
3. Agent invocation receipt verifies prompt/output/contract hashes.
4. Phase receipt recomputes output, claim, evidence, and event roots.
5. Run receipt bundle verifies `run.json`, `state.json`, phase receipts, and final event-chain head.
6. Disabled SNARK backend reports `proof_unavailable`, never `verified`.
7. Mock ZK SNARK receipt verifies when public inputs match after signed ledgers exist.
8. Tampered public inputs fail verification.

Legacy tests:

1. A BCRX package imports into a v2 envelope with original package hash, source, target, instructions, and external refs.
2. Missing old delivery/read/ack data remains `unknown` or `unavailable`.
3. Old stdout JSON becomes a lossy response envelope.
4. Malformed old package creates `adapter_failed`, not fake success.

Distributed tests:

1. Mac B/C transport offline leaves messages pending with deadline status.
2. Reconnect delivers pending messages once and only once.
3. Spark/cloud adapter timeout records failed/unavailable receipts and retry policy evidence.
4. Two agents attempting the same workspace write require lock/lease evidence or a merge protocol.

RLL/RSI and AgentOps tests:

1. RLL append/replay is idempotent after duplicate writes.
2. Tampering with a hash-chained RLL event fails verification.
3. AgentOps mapper converts existing `phase_start`, `phase_end`, `agent_call`, and gate events into normalized read-model events.
4. RSI rebuild from `run.json`, `state.json`, outputs, `events.jsonl`, and RLL is deterministic.
5. RSI recommendation cites input projection hash, policy hash, evidence refs, expected benefit, risk, privacy effect, cost effect, and rollback.
6. Task growth from RSI preserves causality to the source observation, dissent, route failure, benchmark regression, or operator request.
7. Severe unresolved dissent blocks finalization unless resolved, operator-overruled with reasons, or explicitly escalated.
8. Glass projection marks missing evidence as missing, never inferred.
9. `rll doctor --audit full` derives expected AgentOps signals from sidecar RLL events and warns when projection has not happened.
10. `rll doctor --audit full` blocks missing RSI evidence refs and any alpha `applied` RSI candidate.

Code graph tests:

1. Code graph snapshot receipt records provider version, command ref, commit/worktree hash, generated-file policy, graph hash, and freshness.
2. Stale graph can orient exploration but cannot provide final high-risk impact clearance.
3. Dirty worktree overlay downgrades graph confidence and blocks mutation without lease or operator evidence.
4. Sidecar-only refresh updates graph evidence without writing generated context files.
5. Failed GitNexus refresh emits `code_graph_refresh_failed` and fallback source-read requirements.
6. Impact receipt includes changed symbols, affected callers/callees/files, depth, confidence, ambiguous matches, unresolved edges, and generated-file exclusions.
7. Test candidate map records focused/broad candidates, confidence, historical failures, and verification refs.
8. Tampering with graph snapshot/query/impact public inputs invalidates the corresponding signed or SNARK-backed receipt.

Privacy and leakage tests:

1. Privacy preflight blocks raw tenant legal/IP strategy to hosted-low-cost lanes.
2. Blind/off-stack subtasks fail validation if they reveal mission gist.
3. Public proof inputs contain no raw prompt, raw output, private witness, hidden reasoning, tenant identifier, or legal/IP strategy.
4. Audit export contains summaries, refs, hashes, route decisions, claims, dissents, and receipts, not hidden reasoning.
5. UI/read model separates `attestation_status` from semantic `claim_status`.

Spec-council dissent tests:

1. A major spec change without advisory opinion or `no_material_dissent_found` receipt fails governance validation.
2. A blocking dissent without resolution blocks spec-final status.
3. Unsupported dissent is recorded but does not block unless paired with evidence.
4. Dissent resolution requires evidence, operator receipt, or superseding design reference.

## 21. Implementation Order

1. Land this spec and schema sketches.
2. Add model adapter types, `claude-cli-v1`, and `fake-local-v1` without behavior change.
3. Add local JSONL collaboration bus, receipt lifecycle, and idempotency.
4. Add passive RLL/evidence ledger and agent invocation receipts.
5. Add privacy preflight before hosted/off-stack invocation.
6. Add RLL/protocol verifier and real-agent failure canary matrix.
7. Enable one Codex/Claude/fake-agent intercommunication canary when auth allows; otherwise record auth failure as evidence-backed unavailable state.
8. Add AgentOps mapper and replay projection from existing run artifacts.
9. Add RSI read index in recommend-only mode.
10. Add passive code graph receipts and degraded-mode honesty.
11. Add route-decision objects and benchmark uncertainty handling.
12. Add claim validation and adversarial review gates.
13. Add signatures and signed event/RLL chains.
14. Add code graph adapter lifecycle with GitNexus as the first provider.
15. Add mock ZK SNARK receipt service and verifier.
16. Add BCRX/VCRX source manifests and legacy import adapters.
17. Add distributed transports.
18. Route additional existing Claude invocations through the registry.
19. Enable gated interventions only after dry-run, receipt, rollback, and operator-gate tests pass.

## 22. Open Questions

1. Which current BCRX/VCRX directories are the authoritative live migration sources?
2. Which signing keys should represent Codex, Claude, human operator, harness process, Mac B, Mac C, Spark, and cloud agents?
3. Which SNARK backend should be first beyond `mock_local`: Groth16, PLONK, Halo2, or a project-specific prover service?
4. What policy defines high risk for mandatory adversarial review?
5. What private artifacts may be retained only as hashes or commitments?
6. Which route authority should be active when this repo runs outside OpenClaw/VERI?
7. Should protocol ledgers use JSONL first, SQLite first, or both behind a common store interface?
8. Which code graph freshness policy should trigger mandatory refresh during long coding runs?
9. Which generated files may a code graph adapter write, and when must it run sidecar-only?

## 23. Done Definition for v2 Alpha

v2 alpha is real when:

- Codex, Claude, and one fake/local model can exchange v2 messages in one thread.
- The harness can prove sent, delivered, read, accepted, completed, and challenged as separate states.
- Real-agent failure canaries produce evidence-backed failure/unavailable receipts instead of silent or fake success.
- RLL records are emitted for adapter invocations, receipt transitions, privacy decisions, and failures.
- RSI is recommend-only and cannot apply actions.
- A claim without required evidence cannot be used as an actionable conclusion.
- An adversarial challenge blocks final resolution until answered or explicitly overridden by policy.
- A real-agent invocation failure, including auth failure, creates an evidence-backed unavailable receipt.
- A run produces signed/hashable event, RLL, agent, and receipt-chain artifacts.
- SNARK-disabled mode reports `proof_unavailable` honestly.
- Old BCRX/VCRX packages can be scanned or mapped only with source manifests and without pretending the old layer had reliable delivery semantics.
- Routing and inventory are externally visible and not hardcoded as the long-term source of truth.
