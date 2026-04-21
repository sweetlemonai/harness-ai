// Dependency graph loader + cycle detection + ready-task resolver.
//
// Graphs are YAML under harness/tasks/<project>/dependency-graph.yml.
// Two shapes are accepted — whichever the producer wrote:
//
//   Shape A — harness-native, keyed by task id:
//     dependencies:
//       2-styles: [1-types]
//       3-store:  [1-types]
//       5-layout: [2-styles, 3-store]
//
//   Shape B — task-breaker agent output, list of task records:
//     project: <slug>
//     tasks:
//       - slug: <project>/2-styles
//         depends-on: [<project>/1-types]
//         hash: ""
//         exports: [...]
//
// Shape B slugs are normalised to the short `<id>` form (everything
// after the first `/`) before being stored. Cycle detection and the
// ready-task resolver are shape-agnostic once the load normalises.
//
// Cycle detection is recursive DFS with a "visiting" set. On cycle the
// exact cycle path is returned in CyclicDependencyError.cycle, not the
// string "cycle detected" — an actionable error beats a vague one.
//
// getReadyTasks returns tasks whose every dependency is in `completed`.
// Parked tasks (escalated) are NOT in `completed`; their dependents stay
// blocked until the human resolves them and re-runs.

import { existsSync, readFileSync } from 'node:fs';
import * as yaml from 'js-yaml';
import { CyclicDependencyError } from '../types.js';

// ---------------------------------------------------------------------------
// Graph loading
// ---------------------------------------------------------------------------

export interface DependencyGraph {
  /** Task → list of task ids it depends on. A task with no entry is a root. */
  readonly dependencies: ReadonlyMap<string, readonly string[]>;
  /** Every task mentioned anywhere, in sorted order. */
  readonly allTasks: readonly string[];
}

export function loadDependencyGraph(path: string): DependencyGraph {
  if (!existsSync(path)) {
    return { dependencies: new Map(), allTasks: [] };
  }
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    throw new Error(
      `failed to read dependency-graph.yml at ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = yaml.load(raw);
  } catch (err) {
    throw new Error(
      `invalid YAML in ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (parsed === null || parsed === undefined) {
    return { dependencies: new Map(), allTasks: [] };
  }
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${path}: top-level must be a mapping`);
  }
  const record = parsed as Record<string, unknown>;
  if (record.dependencies !== undefined) {
    return parseDependenciesShape(path, record.dependencies);
  }
  if (record.tasks !== undefined) {
    return parseTasksShape(path, record.tasks);
  }
  return { dependencies: new Map(), allTasks: [] };
}

function parseDependenciesShape(path: string, depsRaw: unknown): DependencyGraph {
  if (depsRaw === null || typeof depsRaw !== 'object' || Array.isArray(depsRaw)) {
    throw new Error(`${path}: 'dependencies' must be a mapping`);
  }
  const map = new Map<string, string[]>();
  const allTasks = new Set<string>();
  for (const [key, value] of Object.entries(depsRaw as Record<string, unknown>)) {
    if (typeof key !== 'string' || key.length === 0) {
      throw new Error(`${path}: dependency key must be a non-empty string`);
    }
    if (!Array.isArray(value)) {
      throw new Error(`${path}: dependencies.${key} must be an array of task ids`);
    }
    const deps: string[] = [];
    for (const dep of value) {
      if (typeof dep !== 'string' || dep.length === 0) {
        throw new Error(
          `${path}: dependencies.${key}[] entries must be non-empty strings`,
        );
      }
      deps.push(dep);
      allTasks.add(dep);
    }
    map.set(key, deps);
    allTasks.add(key);
  }
  return { dependencies: map, allTasks: [...allTasks].sort() };
}

// Task-breaker agent shape:
//   tasks:
//     - slug: <project>/<id>
//       depends-on: [<project>/<id>, ...]
// Slugs are normalised to short `<id>` form — the runner keys state on
// `<id>` everywhere, so carrying the project prefix here would bifurcate
// the namespace.
function parseTasksShape(path: string, tasksRaw: unknown): DependencyGraph {
  if (!Array.isArray(tasksRaw)) {
    throw new Error(`${path}: 'tasks' must be a list`);
  }
  const map = new Map<string, string[]>();
  const allTasks = new Set<string>();
  for (let i = 0; i < tasksRaw.length; i += 1) {
    const entry = tasksRaw[i];
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`${path}: tasks[${i}] must be a mapping`);
    }
    const record = entry as Record<string, unknown>;
    const slug = record.slug;
    if (typeof slug !== 'string' || slug.length === 0) {
      throw new Error(`${path}: tasks[${i}].slug must be a non-empty string`);
    }
    const shortId = stripProjectPrefix(slug);
    if (shortId.length === 0) {
      throw new Error(`${path}: tasks[${i}].slug '${slug}' yielded empty id`);
    }

    const rawDeps = record['depends-on'] ?? record.dependsOn;
    const deps: string[] = [];
    if (rawDeps !== undefined && rawDeps !== null) {
      if (!Array.isArray(rawDeps)) {
        throw new Error(
          `${path}: tasks[${i}].depends-on must be a list`,
        );
      }
      for (const dep of rawDeps) {
        if (typeof dep !== 'string' || dep.length === 0) continue;
        const depId = stripProjectPrefix(dep);
        if (depId.length === 0) continue;
        deps.push(depId);
        allTasks.add(depId);
      }
    }
    map.set(shortId, deps);
    allTasks.add(shortId);
  }
  return { dependencies: map, allTasks: [...allTasks].sort() };
}

function stripProjectPrefix(slug: string): string {
  const idx = slug.indexOf('/');
  return idx === -1 ? slug : slug.slice(idx + 1);
}

// ---------------------------------------------------------------------------
// Cycle detection (DFS)
// ---------------------------------------------------------------------------

/**
 * Throws CyclicDependencyError(cycle = [a, b, ..., a]) on the first cycle
 * encountered. The cycle array lists the exact path so the error message
 * is actionable.
 */
export function assertAcyclic(graph: DependencyGraph): void {
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const stack: string[] = [];

  const visit = (node: string): void => {
    if (visited.has(node)) return;
    if (visiting.has(node)) {
      const startIndex = stack.indexOf(node);
      const cyclePath =
        startIndex === -1
          ? [node, node]
          : [...stack.slice(startIndex), node];
      throw new CyclicDependencyError(cyclePath);
    }
    visiting.add(node);
    stack.push(node);
    for (const next of graph.dependencies.get(node) ?? []) {
      visit(next);
    }
    stack.pop();
    visiting.delete(node);
    visited.add(node);
  };

  for (const node of graph.allTasks) {
    visit(node);
  }
}

// ---------------------------------------------------------------------------
// Ready-task resolver
// ---------------------------------------------------------------------------

export interface ReadyTaskArgs {
  readonly graph: DependencyGraph;
  readonly completed: ReadonlySet<string>;
  readonly parked: ReadonlySet<string>;
}

/**
 * Tasks whose every dependency is in `completed`, minus anything already in
 * `completed` or `parked`. Result sorted for deterministic runner order.
 *
 * Parked tasks (escalated) are NOT considered completed — their dependents
 * stay blocked until a human resolves the escalation and re-runs.
 */
export function getReadyTasks({
  graph,
  completed,
  parked,
}: ReadyTaskArgs): string[] {
  const ready: string[] = [];
  for (const task of graph.allTasks) {
    if (completed.has(task)) continue;
    if (parked.has(task)) continue;
    const deps = graph.dependencies.get(task) ?? [];
    if (deps.every((d) => completed.has(d))) {
      ready.push(task);
    }
  }
  return ready.sort();
}

/**
 * Tasks that are blocked by an ancestor in `parked`. Useful for status
 * reporting ("blocked on <task>"). For a task `t`, it's blocked if any
 * dep (direct or transitive) is parked OR is not yet completed.
 */
export function getBlockers(
  graph: DependencyGraph,
  task: string,
  completed: ReadonlySet<string>,
  parked: ReadonlySet<string>,
): string[] {
  const out = new Set<string>();
  const walk = (node: string, depth: number): void => {
    if (depth > 50) return; // defensive — cycle should already have thrown
    for (const dep of graph.dependencies.get(node) ?? []) {
      if (parked.has(dep)) {
        out.add(dep);
      } else if (!completed.has(dep)) {
        out.add(dep);
        walk(dep, depth + 1);
      }
    }
  };
  walk(task, 0);
  return [...out].sort();
}
