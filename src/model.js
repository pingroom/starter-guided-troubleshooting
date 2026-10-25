import { createHash } from 'node:crypto';
import { validateObservation } from './question.js';

export const TTL = 900;
export const CLOCK_SKEW_MS = 60000;
export const ROOM = /^[A-Z0-9]{12}$/;
export const isId = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const keys = (value, expected) => record(value) && Object.keys(value).sort().join(',') === [...expected].sort().join(',');
const word = value => typeof value === 'string' && /^[a-z][a-z0-9_-]{0,39}$/.test(value);
const line = (value, max) => typeof value === 'string' && value.length <= max && /^[\x20-\x7e]+$/.test(value) && value.trim() === value;
const canonical = value => Array.isArray(value) ? value.map(canonical) : record(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
export const hash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

export function iso(raw) {
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)$/.test(raw)) throw new Error('Expected a UTC timestamp.');
  const time = Date.parse(raw);
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 19) !== raw.slice(0, 19)) throw new Error('Invalid UTC timestamp.');
  return new Date(time).toISOString();
}

export function validateInput(input) {
  if (!keys(input, ['caseId', 'title', 'summary', 'runbookVersion', 'entry', 'nodes']) || !word(input.caseId)
    || !line(input.title, 60) || !line(input.summary, 120) || !word(input.runbookVersion) || !word(input.entry)
    || !Array.isArray(input.nodes) || input.nodes.length < 2 || input.nodes.length > 24) throw new Error('Use a bounded case with 2–24 runbook nodes and an explicit entry.');
  const nodes = new Map();
  for (const node of input.nodes) {
    if (!word(node?.id) || nodes.has(node.id)) throw new Error('Node IDs must be unique.');
    if (node.kind === 'observation') {
      if (!keys(node, ['id', 'kind', 'prompt', 'options']) || !line(node.prompt, 200)
        || !Array.isArray(node.options) || node.options.length < 1 || node.options.length > 3) throw new Error('An observation needs 1–3 concrete options and a bounded prompt.');
      const values = new Set(), labels = new Set();
      for (const option of node.options) {
        if (!keys(option, ['value', 'label', 'next']) || !word(option.value) || option.value === 'unknown' || values.has(option.value)
          || !line(option.label, 40) || option.label === 'Unknown / not applicable' || labels.has(option.label) || !word(option.next)) throw new Error('Each branch needs a unique value and label, and a next node.');
        values.add(option.value); labels.add(option.label);
      }
    } else if (node.kind === 'recommendation') {
      if (!keys(node, ['id', 'kind', 'text']) || !line(node.text, 400)) throw new Error('Recommendation leaves contain only bounded plain text.');
    } else throw new Error('Unsupported runbook node kind.');
    nodes.set(node.id, node);
  }
  if (nodes.get(input.entry)?.kind !== 'observation') throw new Error('Entry must name an observation.');
  for (const node of nodes.values()) for (const option of node.options ?? []) if (!nodes.has(option.next)) throw new Error('A branch points to a missing node.');
  const visiting = new Set(), visited = new Set(); let leaves = 0;
  const walk = id => {
    if (visiting.has(id)) throw new Error('Runbook must be acyclic.');
    if (visited.has(id)) return;
    visiting.add(id);
    const node = nodes.get(id);
    if (node.kind === 'recommendation') leaves++;
    else for (const option of node.options) walk(option.next);
    visiting.delete(id); visited.add(id);
  };
  walk(input.entry);
  if (visited.size !== nodes.size || leaves === 0) throw new Error('Every node must be reachable from entry and lead to a recommendation.');
  return structuredClone(input);
}

export function validateConfig(config) {
  if (!keys(config, ['participant']) || !keys(config.participant, ['id', 'label']) || !isId(config.participant.id)
    || !line(config.participant.label, 60)) throw new Error('Config requires an exact observer UUID and label.');
  return structuredClone(config);
}

export function requestFor(input, config, nodeId, attemptId) {
  const node = input.nodes.find(item => item.id === nodeId);
  if (node?.kind !== 'observation' || !isId(attemptId)) throw new Error('Invalid observation node or attempt.');
  const key = `troubleshoot-${attemptId}`;
  const prompt = `${input.title}\nCase: ${input.summary}\nObserve only: ${node.prompt}`;
  if (prompt.length > 500) throw new Error('Observation prompt exceeds 500 characters.');
  return { prompt, context: `Case ${hash(input).slice(0, 20)}`,
    options: [...node.options.map(({ value, label }) => ({ value, label, style: 'default' })), { value: 'unknown', label: 'Unknown / not applicable', style: 'default' }],
    responder_scope: 'direct', target_user_id: config.participant.id, ttl: TTL, correlation_id: key,
    data: { input_hash: hash(input), node_id: nodeId, attempt_id: attemptId }, idempotencyKey: key };
}

// The path is reconstructed from accepted observations, never from a mutable current-node pointer.
export function validateState(state, input) {
  validateInput(input);
  if (!keys(state, ['version', 'inputHash', 'config', 'room', 'credentialHash', 'startedAt', 'attempts']) || state.version !== 1
    || state.inputHash !== hash(input) || typeof state.room !== 'string' || !ROOM.test(state.room)
    || typeof state.credentialHash !== 'string' || !/^[0-9a-f]{64}$/.test(state.credentialHash)
    || !Array.isArray(state.attempts) || state.attempts.length > input.nodes.length || iso(state.startedAt) !== state.startedAt) throw new Error('Invalid state or changed case/runbook. Restore the original files.');
  validateConfig(state.config);
  let next = input.entry, previous = state.startedAt, askerId;
  const ids = new Set(), questionIds = new Set();
  for (const [index, attempt] of state.attempts.entries()) {
    const node = input.nodes.find(item => item.id === next);
    if (node?.kind !== 'observation' || !keys(attempt, ['id', 'node', 'createdAt', 'request', 'questionId', 'status', 'observation'])
      || !isId(attempt.id) || ids.has(attempt.id) || attempt.node !== next || iso(attempt.createdAt) !== attempt.createdAt
      || attempt.createdAt < previous || hash(attempt.request) !== hash(requestFor(input, state.config, next, attempt.id))
      || !['creating', 'pending', 'answered', 'expired', 'cancelled', 'invalid_answer'].includes(attempt.status)) throw new Error('Saved observation breaks the runbook path or request.');
    ids.add(attempt.id); previous = attempt.createdAt;
    if (attempt.status === 'creating') {
      if (attempt.questionId !== null || attempt.observation !== null) throw new Error('Invalid uncertain creation state.');
    } else {
      if (!isId(attempt.questionId) || questionIds.has(attempt.questionId)) throw new Error('Invalid or repeated Question ID.');
      questionIds.add(attempt.questionId); validateObservation(attempt.observation, attempt.status, attempt.request);
      if (Date.parse(attempt.observation.createdAt) < Date.parse(attempt.createdAt) - CLOCK_SKEW_MS
        || attempt.observation.checkedAt < attempt.createdAt) throw new Error('Question predates its creation intent.');
      if (askerId !== undefined && attempt.observation.askerId !== askerId) throw new Error('Questions belong to different asking registrations.');
      askerId = attempt.observation.askerId; previous = attempt.observation.checkedAt;
    }
    if (attempt.status === 'answered' && attempt.observation.answer.value !== 'unknown') next = node.options.find(option => option.value === attempt.observation.answer.value).next;
    else {
      if (index !== state.attempts.length - 1) throw new Error('No observation may follow an unresolved or inconclusive result.');
      if (!['creating', 'pending'].includes(attempt.status)) next = null;
    }
  }
  return state;
}

export function report(state, input) {
  validateState(state, input);
  let next = input.entry, reason = null;
  const path = state.attempts.map(attempt => {
    const answer = attempt.observation?.answer;
    if (attempt.status === 'answered' && answer.value !== 'unknown') next = input.nodes.find(item => item.id === attempt.node).options.find(option => option.value === answer.value).next;
    else if (!['creating', 'pending'].includes(attempt.status)) { next = null; reason = attempt.status === 'answered' ? 'unknown_observation' : attempt.status; }
    return { node: attempt.node, status: attempt.status === 'creating' ? 'create_unknown' : attempt.status,
      choice: answer?.value ?? null, label: answer?.label ?? null, questionId: attempt.questionId, attemptId: attempt.id,
      responderId: answer?.responderId ?? null, answeredAt: answer?.answeredAt ?? null, askerId: attempt.observation?.askerId ?? null,
      observedAt: attempt.observation?.checkedAt ?? null };
  });
  const active = path.find(item => ['create_unknown', 'pending'].includes(item.status));
  const node = input.nodes.find(item => item.id === next);
  const status = active?.status ?? (reason ? 'inconclusive' : node.kind === 'recommendation' ? 'complete' : 'ready');
  return { caseId: input.caseId, title: input.title, runbookVersion: input.runbookVersion, inputHash: state.inputHash,
    status, reason, participant: state.config.participant, path, nextObservation: status === 'ready' ? next : null,
    recommendation: status === 'complete' ? { node: node.id, text: node.text } : null };
}
