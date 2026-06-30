import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { stableStringify } from './hash.js';

export interface JsonlRecord<T> {
  readonly line: number;
  readonly value: T;
}

export function appendJsonl(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${stableStringify(value)}\n`, 'utf8');
}

export function readJsonl<T>(path: string): readonly JsonlRecord<T>[] {
  if (!existsSync(path)) return [];

  const raw = readFileSync(path, 'utf8');
  if (raw.trim() === '') return [];

  const records: JsonlRecord<T>[] = [];
  const lines = raw.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === undefined || line.trim() === '') continue;
    records.push({ line: i + 1, value: JSON.parse(line) as T });
  }
  return records;
}
