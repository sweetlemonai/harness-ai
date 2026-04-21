// Config loader: layered merge of package defaults → repo overrides →
// local overrides, validated against config.schema.json via ajv. Repo and
// local overrides are optional (may not exist). Unknown or invalid fields
// are a fatal ConfigValidationError identifying the offending field —
// never a silent fallback to undefined.

import { existsSync, readFileSync } from 'node:fs';
import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormatsDefault from 'ajv-formats';
import {
  ConfigValidationError,
  type HarnessConfig,
  type HarnessPaths,
} from '../types.js';
import { resolveHarnessPaths } from './paths.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function loadConfig(paths: HarnessPaths): HarnessConfig {
  const packageDefault = readJsonFile(
    paths.packageConfigFile,
    'package defaults/config.json',
  );
  const repoOverrides = existsSync(paths.configFile)
    ? readJsonFile(paths.configFile, 'harness/config.json')
    : null;
  const localOverrides = existsSync(paths.configLocalFile)
    ? readJsonFile(paths.configLocalFile, 'harness/config.local.json')
    : null;

  let merged = packageDefault;
  if (repoOverrides) merged = deepMergeObjects(merged, repoOverrides);
  if (localOverrides) merged = deepMergeObjects(merged, localOverrides);

  const schema = readJsonFile(paths.configSchemaFile, 'config.schema.json');
  const validator = compileValidator(schema);

  if (!validator(merged)) {
    throw firstValidationError(validator.errors);
  }

  return merged as unknown as HarnessConfig;
}

// ---------------------------------------------------------------------------
// JSON loading
// ---------------------------------------------------------------------------

function readJsonFile(absPath: string, label: string): JsonObject {
  let raw: string;
  try {
    raw = readFileSync(absPath, 'utf8');
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new ConfigValidationError(label, `failed to read: ${reason}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new ConfigValidationError(label, `invalid JSON: ${reason}`);
  }
  if (!isJsonObject(parsed)) {
    throw new ConfigValidationError(label, 'top-level value must be an object');
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Deep merge — objects merge recursively, arrays and primitives replace.
// Only used for config.local.json overlay on config.json.
// ---------------------------------------------------------------------------

type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonObject
  | JsonValue[];

interface JsonObject {
  [key: string]: JsonValue;
}

function isJsonObject(value: unknown): value is JsonObject {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value)
  );
}

function deepMergeObjects(base: JsonObject, overlay: JsonObject): JsonObject {
  const out: JsonObject = { ...base };
  for (const [key, overlayValue] of Object.entries(overlay)) {
    // Underscore-prefixed keys are treated as comments — they stay in the
    // on-disk file for the human but are stripped before validation.
    if (key.startsWith('_')) continue;
    const baseValue = out[key];
    if (isJsonObject(baseValue) && isJsonObject(overlayValue)) {
      out[key] = deepMergeObjects(baseValue, overlayValue);
    } else {
      out[key] = overlayValue;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Ajv wiring
// ---------------------------------------------------------------------------

function compileValidator(schema: JsonObject): ValidateFunction {
  const ajv = new Ajv2020({
    allErrors: true,
    strict: true,
    strictSchema: true,
    strictTypes: true,
    useDefaults: false,
    $data: false,
  });
  const addFormats = addFormatsDefault as unknown as (
    instance: Ajv2020,
  ) => Ajv2020;
  addFormats(ajv);
  try {
    return ajv.compile(schema);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new ConfigValidationError(
      'config.schema.json',
      `schema failed to compile: ${reason}`,
    );
  }
}

function firstValidationError(
  errors: ErrorObject[] | null | undefined,
): ConfigValidationError {
  if (!errors || errors.length === 0) {
    return new ConfigValidationError('<unknown>', 'validation failed without details');
  }
  const err = errors[0]!;
  const field = fieldFromError(err);
  const message = messageFromError(err);
  return new ConfigValidationError(field, message);
}

function fieldFromError(err: ErrorObject): string {
  if (err.keyword === 'additionalProperties') {
    const parent = err.instancePath || '';
    const extra = (err.params as { additionalProperty?: string })
      .additionalProperty;
    const joined =
      parent && extra
        ? `${parent}/${extra}`
        : parent || (extra ? `/${extra}` : '<root>');
    return formatJsonPointer(joined);
  }
  if (err.keyword === 'required') {
    const parent = err.instancePath || '';
    const missing = (err.params as { missingProperty?: string }).missingProperty;
    const joined =
      parent && missing
        ? `${parent}/${missing}`
        : missing
          ? `/${missing}`
          : parent || '<root>';
    return formatJsonPointer(joined);
  }
  return formatJsonPointer(err.instancePath || '<root>');
}

function formatJsonPointer(pointer: string): string {
  if (!pointer || pointer === '<root>') return '<root>';
  if (pointer.startsWith('/')) {
    return pointer.slice(1).replace(/\//g, '.');
  }
  return pointer.replace(/\//g, '.');
}

function messageFromError(err: ErrorObject): string {
  if (err.keyword === 'additionalProperties') {
    const extra = (err.params as { additionalProperty?: string })
      .additionalProperty;
    return `unknown field '${extra ?? '?'}' — check for typos or stale config`;
  }
  if (err.keyword === 'required') {
    const missing = (err.params as { missingProperty?: string }).missingProperty;
    return `missing required field '${missing ?? '?'}'`;
  }
  if (err.keyword === 'enum') {
    const allowed = (err.params as { allowedValues?: readonly unknown[] })
      .allowedValues;
    return `value must be one of ${JSON.stringify(allowed)}`;
  }
  return err.message ?? 'failed validation';
}

// ---------------------------------------------------------------------------
// CLI entry point — `npx tsx src/lib/config.ts [--print]`
//
// Exits 0 on valid config, 1 on any validation error. On failure, the
// ConfigValidationError message is printed to stderr with the exact field
// name so the user can locate and fix the offending key.
// ---------------------------------------------------------------------------

function runCli(): void {
  try {
    const paths = resolveHarnessPaths();
    const cfg = loadConfig(paths);
    if (process.argv.includes('--print')) {
      process.stdout.write(`${JSON.stringify(cfg, null, 2)}\n`);
    } else {
      process.stdout.write('config OK\n');
    }
    process.exit(0);
  } catch (err) {
    if (err instanceof ConfigValidationError) {
      process.stderr.write(`${err.message}\n`);
      process.exit(1);
    }
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`config error: ${message}\n`);
    process.exit(2);
  }
}

if (import.meta.url.endsWith('/src/lib/config.ts')) {
  runCli();
}
