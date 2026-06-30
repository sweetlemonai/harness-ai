import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createScopeRef } from '../src/lib/codegraph/receipts.ts';
import {
  findCodeGraphStoredRecord,
  readCodeGraphStoredRecords,
  storeCodeGraphPayload,
  verifyCodeGraphStoredRecord,
} from '../src/lib/codegraph/store.ts';

describe('codegraph receipt store', () => {
  it('stores and looks up command payloads by receipt id', () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'harness-codegraph-store-'));
    const scope = createScopeRef({ repoRoot });
    const payload = {
      receiptId: 'codegraph_receipt_test',
      status: 'fresh',
      snapshotId: 'snapshot_test',
    };

    const stored = storeCodeGraphPayload({
      scope,
      command: 'status',
      payload,
    });

    assert.ok(stored);
    assert.equal(stored.receiptId, 'codegraph_receipt_test');
    assert.equal(readCodeGraphStoredRecords(scope).length, 1);
    assert.equal(findCodeGraphStoredRecord(scope, 'codegraph_receipt_test')?.receiptId, 'codegraph_receipt_test');
    assert.equal(verifyCodeGraphStoredRecord(stored), true);
  });
});
