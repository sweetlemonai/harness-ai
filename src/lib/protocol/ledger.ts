import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { sha256Hex, stableStringify } from './hash.js';

export interface LedgerAppendResult<T> {
  readonly entry: T;
  readonly lineHash: string;
  readonly previousLineHash: string | null;
}

export function appendLedgerEntry<T extends Record<string, unknown>>(
  file: string,
  entry: T,
): LedgerAppendResult<T> {
  mkdirSync(dirname(file), { recursive: true });
  const previousLineHash = lastLedgerLineHash(file);
  const line = stableStringify({
    ...entry,
    previousLineHash,
  });
  appendFileSync(file, `${line}\n`, 'utf8');
  return {
    entry: JSON.parse(line) as T,
    lineHash: sha256Hex(line),
    previousLineHash,
  };
}

export function readLedgerEntries<T>(file: string): T[] {
  if (!existsSync(file)) return [];
  const raw = readFileSync(file, 'utf8').trim();
  if (raw.length === 0) return [];
  return raw
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as T);
}

export function lastLedgerLineHash(file: string): string | null {
  if (!existsSync(file)) return null;
  const raw = readFileSync(file, 'utf8').trimEnd();
  if (raw.length === 0) return null;
  const lines = raw.split(/\r?\n/);
  const last = lines[lines.length - 1];
  return last === undefined ? null : sha256Hex(last);
}

export function ledgerStats(file: string): {
  readonly entries: number;
  readonly tipHash: string | null;
} {
  if (!existsSync(file)) return { entries: 0, tipHash: null };
  const raw = readFileSync(file, 'utf8').trimEnd();
  if (raw.length === 0) return { entries: 0, tipHash: null };
  const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const last = lines[lines.length - 1];
  return {
    entries: lines.length,
    tipHash: last === undefined ? null : sha256Hex(last),
  };
}
