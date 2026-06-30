# Local Production Bootstrap

`harness production init-local` creates a machine-local production profile without changing package defaults.

It writes ignored files under `harness/` by default:

- `harness/config.local.json`
- `harness/fleet/local-production-fleet.json`
- `harness/fleet/v1-witness.snapshot.json`
- `harness/proof/local-operator.ed25519.pkcs8.pem`
- `harness/proof/revocations.json`
- `harness/proof/local-external-zk-prover.mjs`

Example:

```bash
harness production init-local \
  --v1-url http://127.0.0.1:8850/v1/models \
  --operator operator.local \
  --command-group operator.backup \
  --required-approvals 2
```

Then run the local fleet as a mandatory production critic:

```bash
harness production council \
  --run-dir /tmp/harness-production-review \
  --prompt "Review this production promotion. Return evidence-bound dissent for every material weakness." \
  --max-tokens 4096
```

The production council runs in `assuranceContext=production`, so it requires production-capable signing and V1 witness consensus. Package defaults intentionally fail closed; only an explicit local or deployment overlay enables promotion gates.
