import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { appendLedgerEntry, readLedgerEntries } from '../protocol/ledger.js';
import { sha256Hex, stableStringify } from './receipts.js';
import type { ScopeRef } from './types.js';

export interface CodeGraphStoredRecord {
  readonly schemaVersion: 'codegraph.receipt_store.v1';
  readonly receiptId: string;
  readonly command: string;
  readonly scope: ScopeRef;
  readonly storedAt: string;
  readonly payloadHash: string;
  readonly payload: unknown;
  readonly previousLineHash?: string | null;
}

export function codeGraphReceiptStoreFile(scope: ScopeRef): string {
  return resolve(scope.repoRoot, 'harness', 'codegraph', 'receipts.jsonl');
}

export function storeCodeGraphPayload(args: {
  readonly scope: ScopeRef;
  readonly command: string;
  readonly payload: unknown;
  readonly receiptId?: string | undefined;
  readonly storedAt?: string;
}): CodeGraphStoredRecord | null {
  const receiptId = args.receiptId ?? extractReceiptId(args.payload);
  if (receiptId === null) return null;
  const record: Omit<CodeGraphStoredRecord, 'previousLineHash'> = {
    schemaVersion: 'codegraph.receipt_store.v1',
    receiptId,
    command: args.command,
    scope: args.scope,
    storedAt: args.storedAt ?? new Date().toISOString(),
    payloadHash: sha256Hex(stableStringify(args.payload)),
    payload: args.payload,
  };
  const file = codeGraphReceiptStoreFile(args.scope);
  mkdirSync(dirname(file), { recursive: true });
  return appendLedgerEntry(file, record as unknown as Record<string, unknown>).entry as unknown as CodeGraphStoredRecord;
}

export function readCodeGraphStoredRecords(scope: ScopeRef): CodeGraphStoredRecord[] {
  const file = codeGraphReceiptStoreFile(scope);
  if (!existsSync(file)) return [];
  return readLedgerEntries<CodeGraphStoredRecord>(file);
}

export function findCodeGraphStoredRecord(
  scope: ScopeRef,
  ref: string,
): CodeGraphStoredRecord | null {
  return readCodeGraphStoredRecords(scope)
    .find((record) => record.receiptId === ref || record.payloadHash === ref)
    ?? null;
}

export function verifyCodeGraphStoredRecord(record: CodeGraphStoredRecord): boolean {
  return record.payloadHash === sha256Hex(stableStringify(record.payload));
}

function extractReceiptId(payload: unknown): string | null {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const value = (payload as { readonly receiptId?: unknown }).receiptId;
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}
