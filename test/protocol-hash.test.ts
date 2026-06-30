import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { stableHash, stableStringify } from '../src/lib/protocol/hash.ts';

describe('stable JSON canonicalization', () => {
  it('sorts object keys recursively before hashing', () => {
    const left = { z: 1, a: { y: true, b: ['x', { n: 2 }] } };
    const right = { a: { b: ['x', { n: 2 }], y: true }, z: 1 };

    assert.equal(stableStringify(left), stableStringify(right));
    assert.equal(stableHash(left), stableHash(right));
  });

  it('rejects values that JSON receipts cannot represent safely', () => {
    assert.throws(() => stableStringify({ value: Number.NaN }), /non-finite/);
    assert.throws(() => stableStringify({ value: undefined }), /undefined/);
  });
});
