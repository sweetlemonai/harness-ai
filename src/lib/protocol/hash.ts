import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export type JsonInput =
  | null
  | boolean
  | number
  | string
  | readonly JsonInput[]
  | { readonly [key: string]: JsonInput };

const DEFAULT_ID_BYTES = 24;

export function stableStringify(value: unknown): string {
  return stringifyCanonical(value, '$', new WeakSet<object>());
}

export function stableHash(value: unknown): string {
  return sha256Hex(stableStringify(value));
}

export function stableId(prefix: string, value: unknown, hashBytes = DEFAULT_ID_BYTES): string {
  return `${prefix}_${stableHash(value).slice(0, hashBytes)}`;
}

export function sha256Hex(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

export function hashFile(path: string): string {
  return sha256Hex(readFileSync(path));
}

function stringifyCanonical(value: unknown, path: string, seen: WeakSet<object>): string {
  if (value === null) return 'null';

  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) {
        throw new TypeError(`Cannot canonicalize non-finite number at ${path}`);
      }
      return JSON.stringify(value);
    case 'undefined':
    case 'function':
    case 'symbol':
    case 'bigint':
      throw new TypeError(`Cannot canonicalize ${typeof value} at ${path}`);
    case 'object':
      return stringifyObjectLike(value, path, seen);
  }
  throw new TypeError(`Cannot canonicalize value at ${path}`);
}

function stringifyObjectLike(value: object, path: string, seen: WeakSet<object>): string {
  const withToJson = value as { readonly toJSON?: () => unknown };
  if (typeof withToJson.toJSON === 'function' && !Array.isArray(value)) {
    return stringifyCanonical(withToJson.toJSON(), path, seen);
  }

  if (seen.has(value)) {
    throw new TypeError(`Cannot canonicalize circular reference at ${path}`);
  }
  seen.add(value);

  try {
    if (Array.isArray(value)) {
      return `[${value
        .map((entry, index) => stringifyCanonical(entry, `${path}[${index}]`, seen))
        .join(',')}]`;
    }

    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      throw new TypeError(`Cannot canonicalize non-plain object at ${path}`);
    }

    const input = value as Record<string, unknown>;
    const fields = Object.keys(input)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stringifyCanonical(input[key], `${path}.${key}`, seen)}`);
    return `{${fields.join(',')}}`;
  } finally {
    seen.delete(value);
  }
}
