import type { EvidenceReceipt } from '../evidence/types.js';
import type {
  ProtocolMessage,
  ProtocolReceipt,
} from './types.js';

export function protocolMessageSigningPayload(message: ProtocolMessage): unknown {
  const {
    signature: _signature,
    previousLineHash: _previousLineHash,
    ...payload
  } = message as ProtocolMessage & { readonly previousLineHash?: string | null };
  return payload;
}

export function protocolReceiptSigningPayload(receipt: ProtocolReceipt): unknown {
  const {
    signature: _signature,
    previousLineHash: _previousLineHash,
    ...payload
  } = receipt as ProtocolReceipt & { readonly previousLineHash?: string | null };
  return payload;
}

export function evidenceReceiptSigningPayload(evidence: EvidenceReceipt): unknown {
  const {
    signature: _signature,
    previousLineHash: _previousLineHash,
    ...payload
  } = evidence as EvidenceReceipt & { readonly previousLineHash?: string | null };
  return payload;
}
