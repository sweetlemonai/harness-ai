import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolveFleetMembers,
  resolveFleetMembersFromV1CatalogForTest,
} from '../src/commands/fleet.ts';

describe('fleet V1 inventory resolution', () => {
  it('uses V1 records as the active roster and treats config as overlay', () => {
    const catalog = {
      object: 'list',
      data: [
        {
          id: 'renderbox2-gemma4-26b-a4b-awq',
          provider_model_id: 'renderbox2-gemma4-26b-a4b-awq',
          hf_model_id: 'google/gemma-4-26B-A4B-it',
          node_id: 'mlx-100-121-76-126-8001',
          upstream: 'http://100.121.76.126:8001',
          source: 'live_vllm_probe',
          hot_memory: true,
        },
        {
          id: 'ornith-1.0-35b',
          provider_model_id: 'ornith-1.0-35b',
          node_id: 'mlx-192-168-6-0-8000',
          upstream: 'http://192.168.6.0:8000',
          source: 'live_inventory',
          hot_memory: true,
        },
      ],
    };
    const resolution = resolveFleetMembersFromV1CatalogForTest(catalog, {
      overrides: {
        'renderbox2-gemma4-26b-a4b-awq': {
          name: 'gemma4-rtx5090',
          model: 'google/gemma-4-26B-A4B-it',
        },
        'qwen36-coder-spark3': {
          name: 'qwen36-coder-spark3',
          model: 'qwen36-coder-spark3',
        },
      },
    });

    assert.deepEqual(
      resolution.members.map((member) => member.name).sort(),
      ['gemma4-rtx5090', 'mlx-192-168-6-0-8000'],
    );
    assert.equal(
      resolution.members.find((member) => member.name === 'gemma4-rtx5090')?.model,
      'google/gemma-4-26B-A4B-it',
    );
    assert.deepEqual(
      resolution.configuredAbsentFromV1.map((entry) => entry.key),
      ['qwen36-coder-spark3'],
    );
  });

  it('reports V1 split-brain without reviving models from secondary sources', async () => {
    const primary = writeCatalog([
      {
        id: 'ornith-1.0-35b',
        upstream: 'http://ornith.test',
        hot_memory: true,
      },
    ]);
    const secondary = writeCatalog([
      {
        id: 'ornith-1.0-35b',
        upstream: 'http://ornith.test',
        hot_memory: true,
      },
      {
        id: 'qwen36-coder-spark3',
        upstream: 'http://removed.test',
        hot_memory: true,
      },
    ]);

    const resolution = await resolveFleetMembers({
      config: {},
      v1CatalogFile: primary,
      consensusV1CatalogFiles: [secondary],
      timeoutMs: 1000,
    });

    assert.equal(resolution.v1Consensus.ok, false);
    assert.equal(resolution.v1Consensus.disagreements.length, 1);
    assert.equal(resolution.v1Consensus.disagreements[0]?.modelId, 'qwen36-coder-spark3');
    assert.deepEqual(
      resolution.members.map((member) => member.v1ModelId),
      ['ornith-1.0-35b'],
    );
  });

  it('rejects config-panel fallback when V1 inventory is required', async () => {
    await assert.rejects(() => resolveFleetMembers({
      config: {
        panel: [{
          name: 'legacy-config-only',
          endpoint: 'http://legacy.test',
          model: 'legacy-model',
        }],
      },
      requireV1Inventory: true,
      timeoutMs: 1000,
    }), /requires a V1 model inventory source/);
  });
});

function writeCatalog(data: readonly Record<string, unknown>[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'harness-fleet-v1-'));
  const file = join(dir, 'models.json');
  writeFileSync(file, JSON.stringify({
    object: 'list',
    data,
  }), 'utf8');
  return file;
}
