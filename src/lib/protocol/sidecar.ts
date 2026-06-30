import { resolve } from 'node:path';

export interface ProtocolSidecarPaths {
  readonly runDir: string;
  readonly protocolMessagesFile: string;
  readonly protocolReceiptsFile: string;
  readonly protocolEnvelopesFile: string;
  readonly protocolLifecycleReceiptsFile: string;
  readonly protocolBusTransactionsFile: string;
  readonly protocolInboxDir: string;
  readonly protocolOutboxDir: string;
  readonly evidenceFile: string;
  readonly rllFile: string;
  readonly rsiIndexFile: string;
  readonly agentopsEventsFile: string;
}

export function sidecarPathsForRunDir(runDir: string): ProtocolSidecarPaths {
  const root = resolve(runDir);
  return {
    runDir: root,
    protocolMessagesFile: resolve(root, 'protocol', 'messages.jsonl'),
    protocolReceiptsFile: resolve(root, 'protocol', 'receipts.jsonl'),
    protocolEnvelopesFile: resolve(root, 'protocol', 'envelopes.jsonl'),
    protocolLifecycleReceiptsFile: resolve(root, 'protocol', 'lifecycle-receipts.jsonl'),
    protocolBusTransactionsFile: resolve(root, 'protocol', 'bus-transactions.jsonl'),
    protocolInboxDir: resolve(root, 'protocol', 'inbox'),
    protocolOutboxDir: resolve(root, 'protocol', 'outbox'),
    evidenceFile: resolve(root, 'evidence', 'evidence.jsonl'),
    rllFile: resolve(root, 'rll', 'events.jsonl'),
    rsiIndexFile: resolve(root, 'rsi.index.json'),
    agentopsEventsFile: resolve(root, 'agentops.events.jsonl'),
  };
}
