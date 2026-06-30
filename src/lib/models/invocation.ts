import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { AgentTimeoutError, type RunContext } from '../../types.js';
import {
  appendEvidenceReceipt,
  createAdapterFailureEvidence,
} from '../evidence/ledger.js';
import { promptFileFor } from '../paths.js';
import {
  appendProtocolMessage,
  appendProtocolReceipt,
  createProtocolMessage,
  createProtocolReceipt,
} from '../protocol/messages.js';
import type { BcrxSubjectFields } from '../protocol/types.js';
import {
  appendRllEvent,
  createRllEvent,
} from '../rll/ledger.js';
import {
  createSidecarSigner,
  signEvidenceReceipt,
  signProtocolMessage,
  signProtocolReceipt,
} from '../proof/signing.js';
import { estimateTokens } from '../tokens.js';
import {
  extractCompletionTokenCount,
  extractLastFencedJson,
  extractPromptTokenCount,
} from './contracts.js';
import { modelRegistryForRun } from './registry.js';
import type {
  ModelInvocationArgs,
  ModelInvocationResult,
  RawModelInvocationResult,
} from './types.js';

export async function invokeRegisteredModel(
  args: ModelInvocationArgs,
): Promise<ModelInvocationResult> {
  const promptPath = promptFileFor(args.ctx.runPaths, String(args.phase), args.attempt);
  mkdirSync(dirname(promptPath), { recursive: true });
  writeFileSync(promptPath, args.prompt, 'utf8');

  const estimatedTokens = estimateTokens(args.prompt);
  args.ctx.logger.info(
    `agent ${args.agent}: invoking (attempt ${args.attempt}, ~${estimatedTokens} tokens in)`,
  );

  const adapter = modelRegistryForRun(args.ctx).defaultAdapter();
  let raw: RawModelInvocationResult;
  try {
    raw = await adapter.invoke({
      ctx: args.ctx,
      agent: args.agent,
      phase: args.phase,
      attempt: args.attempt,
      prompt: args.prompt,
      timeoutMs: args.timeoutMs,
      promptPath,
      estimatedTokens,
    });
  } catch (err) {
    recordAdapterFailure(args.ctx, {
      agent: args.agent,
      phase: String(args.phase),
      attempt: args.attempt,
      adapterId: adapter.id,
      providerId: adapter.kind,
      error: err instanceof Error ? err.message : String(err),
      promptPath,
    });
    throw err;
  }

  let contract: unknown | null = null;
  try {
    contract = extractLastFencedJson(raw.stdout);
  } catch {
    contract = null;
  }
  const reportedTokens = extractPromptTokenCount(contract);
  const completionTokens = extractCompletionTokenCount(contract);

  args.ctx.logger.event('agent_call', {
    agent: args.agent,
    phase: String(args.phase),
    attempt: args.attempt,
    promptTokensEstimated: estimatedTokens,
    promptTokensActual: reportedTokens,
    completionTokens,
    durationMs: raw.durationMs,
    exitCode: raw.exitCode,
    signal: raw.signal,
    contractFound: contract !== null,
    stdoutBytes: raw.stdout.length,
    stderrBytes: raw.stderr.length,
  });

  if (raw.timedOut === true) {
    recordAdapterFailure(args.ctx, {
      agent: args.agent,
      phase: String(args.phase),
      attempt: args.attempt,
      adapterId: adapter.id,
      providerId: adapter.kind,
      error: `adapter timed out after ${args.timeoutMs}ms`,
      promptPath,
      exitCode: raw.exitCode,
      stderr: raw.stderr,
      stdout: raw.stdout,
      durationMs: raw.durationMs,
      timedOut: true,
    });
    throw new AgentTimeoutError(args.agent, args.timeoutMs, args.attempt);
  }

  if (raw.exitCode !== 0) {
    recordAdapterFailure(args.ctx, {
      agent: args.agent,
      phase: String(args.phase),
      attempt: args.attempt,
      adapterId: adapter.id,
      providerId: adapter.kind,
      error: `adapter exited ${raw.exitCode}`,
      promptPath,
      exitCode: raw.exitCode,
      stderr: raw.stderr,
      stdout: raw.stdout,
      durationMs: raw.durationMs,
    });
  }

  if (raw.exitCode === 0 && contract === null) {
    recordAdapterFailure(args.ctx, {
      agent: args.agent,
      phase: String(args.phase),
      attempt: args.attempt,
      adapterId: adapter.id,
      providerId: adapter.kind,
      error: 'adapter exited 0 without a parseable harness contract',
      promptPath,
      exitCode: raw.exitCode,
      stderr: raw.stderr,
      stdout: raw.stdout,
      durationMs: raw.durationMs,
    });
  }

  return {
    stdout: raw.stdout,
    stderr: raw.stderr,
    exitCode: raw.exitCode ?? -1,
    signal: raw.signal,
    durationMs: raw.durationMs,
    estimatedTokens,
    reportedTokens,
    contract,
    promptPath,
  };
}

function recordAdapterFailure(
  ctx: RunContext,
  args: {
    readonly agent: string;
    readonly phase: string;
    readonly attempt: number;
    readonly adapterId: string;
    readonly providerId: string;
    readonly error: string;
    readonly promptPath: string;
    readonly exitCode?: number | null | undefined;
    readonly stderr?: string | undefined;
    readonly stdout?: string | undefined;
    readonly durationMs?: number | undefined;
    readonly timedOut?: boolean | undefined;
  },
): void {
  try {
    const signer = sidecarSignerForRun(ctx);
    const subject = adapterFailureSubject(ctx, args);
    const evidence = appendEvidenceReceipt(ctx, signEvidenceReceipt(createAdapterFailureEvidence({
      subject,
      observedBy: 'harness.model.invocation',
      failure: {
        adapterId: args.adapterId,
        providerId: args.providerId,
        command: args.adapterId,
        ...(args.exitCode !== undefined ? { exitCode: args.exitCode } : {}),
        ...(args.stderr !== undefined ? { stderr: args.stderr } : {}),
        ...(args.stdout !== undefined ? { stdout: args.stdout } : {}),
        error: args.error,
        ...(args.durationMs !== undefined ? { durationMs: args.durationMs } : {}),
        ...(args.timedOut !== undefined ? { timedOut: args.timedOut } : {}),
      },
    }), signer));
    const message = appendProtocolMessage(ctx, signProtocolMessage(createProtocolMessage({
      kind: 'adapter_failure',
      from: 'harness.model.invocation',
      to: ['superharness.control', args.agent],
      subject,
      body: {
        adapterId: args.adapterId,
        providerId: args.providerId,
        phase: args.phase,
        attempt: args.attempt,
        promptPath: args.promptPath,
        exitCode: args.exitCode ?? null,
        timedOut: args.timedOut ?? false,
        error: args.error,
      },
      epistemics: {
        status: 'observed',
        confidence: 1,
      },
      evidenceRefs: [evidence.evidenceId],
    }), signer));
    const receipt = appendProtocolReceipt(ctx, signProtocolReceipt(createProtocolReceipt({
      receiptType: 'adapter_failure_recorded',
      subject,
      status: 'degraded',
      messageId: message.messageId,
      payload: {
        messageId: message.messageId,
        evidenceId: evidence.evidenceId,
        adapterId: args.adapterId,
        error: args.error,
      },
      evidenceRefs: [evidence.evidenceId],
    }), signer));
    appendRllEvent(ctx, createRllEvent({
      kind: 'failure',
      subject,
      source: 'harness.model.invocation',
      summary: `${args.adapterId} adapter failed in ${args.phase}: ${args.error}`,
      inputRefs: [args.promptPath],
      outputRefs: [evidence.evidenceId, receipt.receiptId],
      metrics: {
        adapterFailure: 1,
        timedOut: args.timedOut === true ? 1 : 0,
      },
      confidence: 1,
    }));
  } catch (err) {
    ctx.logger.warn('model adapter failure receipt could not be recorded', {
      adapterId: args.adapterId,
      reason: err instanceof Error ? err.message : String(err),
    });
  }
}

function sidecarSignerForRun(ctx: RunContext): ReturnType<typeof createSidecarSigner> {
  try {
    return createSidecarSigner(ctx.config.proofs.signing);
  } catch (err) {
    ctx.logger.warn('configured signing provider unavailable; recording unsigned adapter failure evidence', {
      reason: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

function adapterFailureSubject(
  ctx: RunContext,
  args: {
    readonly agent: string;
    readonly phase: string;
    readonly attempt: number;
    readonly adapterId: string;
  },
): BcrxSubjectFields {
  return {
    subjectId: `adapter:${args.adapterId}:${ctx.runPaths.runId}:${args.phase}:${args.attempt}`,
    subjectType: 'adapter',
    title: `${args.adapterId} failure for ${args.agent}`,
    assuranceContext: 'alpha',
    ownerAgentId: args.agent,
    privacyZone: ctx.config.privacy.defaultZone,
    materiality: 'high',
    evidencePolicy: {
      required: true,
      minRefs: 1,
      acceptedKinds: ['adapter_failure', 'command_output'],
    },
    dissentPolicy: {
      required: true,
      minDissenters: 1,
      scope: 'material_claims',
    },
    correlationId: ctx.runPaths.runId,
  };
}
