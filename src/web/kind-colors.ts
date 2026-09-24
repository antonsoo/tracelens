import type { AgentSpanKind } from '../core/index.js';

export const KIND_LABEL: Record<AgentSpanKind, string> = {
  agent: 'Agent',
  llm: 'LLM',
  tool: 'Tool',
  chain: 'Chain',
  retriever: 'Retriever',
  embedding: 'Embedding',
  reranker: 'Reranker',
  guardrail: 'Guardrail',
  evaluator: 'Evaluator',
  other: 'Other',
};

export const LEGEND_KINDS: AgentSpanKind[] = ['agent', 'llm', 'tool', 'chain', 'retriever'];

export function kindClass(kind: AgentSpanKind): string {
  return `kind-${kind}`;
}
