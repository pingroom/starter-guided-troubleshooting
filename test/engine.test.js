import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { step, localReport } from '../src/engine.js';
import { readJson, atomicJson, acquireLock } from '../src/storage.js';
import { validateInput, validateState, hash, iso, requestFor } from '../src/model.js';
import { loadConnection, loadEnvironment } from '../src/config.js';
import { makeClient } from '../src/client.js';
import { mockApi, CONFIG, ROOM_CODE, OTHER, ASKER, id } from '../src/mock.js';

const example = await readJson(new URL('../examples/case.json', import.meta.url), 16384);
async function setup(t, input = structuredClone(example)) {
  const directory = await mkdtemp(join(tmpdir(), 'pingroom-troubleshooting-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const clock = { value: '2026-01-01T09:00:00.000Z' }, now = () => clock.value;
  const api = mockApi(now);
  const options = { client: api.client, directory, input, config: structuredClone(CONFIG), token: 'offline-fixture-token', room: ROOM_CODE, now };
  return { directory, clock, api, options, run: (extra = {}) => step({ ...options, ...extra }), saved: () => readJson(join(directory, 'state.json')) };
}
const sends = api => api.calls.filter(call => call.method === 'POST').length;
async function decide(s, choices) {
  let result;
  for (const choice of choices) {
    result = await s.run();
    s.api.answer(result.path.at(-1).questionId, choice);
    result = await s.run();
  }
  return result;
}

test('lost response blocks later branches; exact-ID recovery reads the original request without resend', async (t) => {
  const s = await setup(t, example); s.api.controls.loseNext = true;
  assert.equal((await s.run()).status, 'create_unknown'); assert.equal((await s.run()).status, 'create_unknown');
  assert.deepEqual((await s.run({ command: 'find' })).candidates, [{ id: id(1), state: 'pending' }]);
  s.api.answer(id(1), 'lit'); assert.equal((await s.run({ command: 'recover', attachId: id(1) })).status, 'ready');
  assert.equal(sends(s.api), 1);
});

test('malformed create response and empty search never authorize a new POST', async (t) => {
  const s = await setup(t); s.api.controls.malformedNext = true; await assert.rejects(s.run());
  assert.equal((await s.saved()).attempts[0].status, 'creating'); s.api.questions.clear();
  assert.deepEqual((await s.run({ command: 'find' })).candidates, []);
  assert.equal((await s.run()).status, 'create_unknown'); assert.equal(sends(s.api), 1);
});

test('recovery validates exact target, room, request, options, data and non-handoff provenance', async (t) => {
  for (const mutate of [
    (q) => { q.target_user_id = OTHER; }, (q) => { q.room.code = 'WRONG1234567'; }, (q) => { q.prompt = 'Other prompt'; },
    (q) => { q.options[0].primary = true; }, (q) => { q.options[0].destructive = true; }, (q) => { q.options.reverse(); },
    (q) => { q.data.node_id = 'other'; }, (q) => { q.data.input_hash = 'changed'; }, (q) => { delete q.is_handoff; },
    (q) => { q.is_handoff = true; }, (q) => { q.asker.type = 'user'; }, (q) => { q.resolution_policy = 'all'; },
  ]) {
    const s = await setup(t); s.api.controls.loseNext = true; await s.run(); mutate(s.api.questions.get(id(1)));
    await assert.rejects(s.run({ command: 'recover', attachId: id(1) })); assert.equal((await s.saved()).attempts[0].status, 'creating');
    assert.equal(sends(s.api), 1);
  }
});

test('wrong, missing, typed or unknown answers never produce a recommendation', async (t) => {
  for (const mutate of [
    (q) => { q.answer.responder.id = OTHER; }, (q) => { q.answer.responder = null; },
    (q) => { q.answer.text = 'lit'; }, (q) => { q.answer.value = 'unknown'; }, (q) => { q.answer.label = 'Wrong'; },
  ]) {
    const s = await setup(t); await s.run(); s.api.answer(id(1), 'lit'); mutate(s.api.questions.get(id(1)));
    const result = await s.run(); assert.equal(result.observedStatus, 'invalid_answer'); assert.equal(result.recommendation, null);
    await s.run(); assert.equal(sends(s.api), 1);
  }
});

test('original asker, lifetime and intent remain bound across reads and across nodes', async (t) => {
  for (const mutate of [
    (q) => { q.asker.id = OTHER; },
    (q) => { q.created_at = '2026-01-01T09:00:01.000Z'; q.expires_at = '2026-01-01T09:15:01.000Z'; },
  ]) {
    const s = await setup(t); await s.run(); mutate(s.api.questions.get(id(1))); await assert.rejects(s.run(), /identity or lifetime/);
  }
  const s = await setup(t, example); await s.run(); s.api.answer(id(1), 'lit'); await s.run();
  s.api.controls.loseNext = true; await s.run(); s.api.questions.get(id(2)).asker.id = OTHER;
  await assert.rejects(s.run({ command: 'recover', attachId: id(2) }), /different asking registrations/);
  const other = await setup(t); other.api.controls.loseNext = true; await other.run();
  const q = other.api.questions.get(id(1)); q.created_at = '2026-01-01T08:58:59.000Z'; q.expires_at = '2026-01-01T09:13:59.000Z';
  await assert.rejects(other.run({ command: 'recover', attachId: id(1) }), /predates/);
});

test('expiry accepts delayed processing but rejects premature and implausibly future resolution on replay', async (t) => {
  const s = await setup(t); await s.run(); s.clock.value = '2026-01-01T09:16:00.000Z';
  s.api.terminal(id(1), 'expired'); s.api.questions.get(id(1)).resolved_at = '2026-01-01T09:15:30.000Z';
  assert.equal((await s.run()).status, 'inconclusive'); assert.equal((await localReport(s.directory, s.options.input)).recommendation, null);
  const original = await s.saved();
  for (const timestamp of ['2026-01-01T09:14:59.999Z', '2026-01-01T09:17:00.001Z']) {
    const saved = structuredClone(original); saved.attempts[0].observation.resolvedAt = timestamp;
    await atomicJson(s.directory, 'state.json', saved); const calls = s.api.calls.length;
    await assert.rejects(s.run(), /resolution time/); assert.equal(s.api.calls.length, calls);
    const live = await setup(t); await live.run(); live.clock.value = s.clock.value; live.api.terminal(id(1), 'expired');
    live.api.questions.get(id(1)).resolved_at = timestamp; await assert.rejects(live.run(), /resolution time/);
  }
});

test('answer and resolution times must agree and answer/cancellation cannot occur after expiry', async (t) => {
  const s = await setup(t); await s.run(); s.api.answer(id(1), 'lit');
  s.api.questions.get(id(1)).answer.answered_at = '2026-01-01T09:00:01.000Z';
  assert.equal((await s.run()).observedStatus, 'invalid_answer');
  for (const terminal of ['answered', 'cancelled']) {
    const other = await setup(t); await other.run(); other.clock.value = '2026-01-01T09:16:00.000Z';
    if (terminal === 'answered') other.api.answer(id(1), 'lit'); else other.api.terminal(id(1), terminal);
    await assert.rejects(other.run(), /resolution time/);
  }
});

test('checked time follows response; future creation, wrong TTL and answer on pending fail', async (t) => {
  const s = await setup(t); await s.run(); const get = s.api.client.questions.get.bind(s.api.client.questions);
  s.api.client.questions.get = async (...args) => { s.clock.value = '2026-01-01T09:02:00.000Z'; s.api.answer(id(1), 'lit'); return get(...args); };
  await s.run(); assert.equal((await s.saved()).attempts[0].observation.checkedAt, s.clock.value);
  for (const mutate of [
    (q) => { q.created_at = '2027-01-01T09:00:00.000Z'; q.expires_at = '2027-01-01T09:15:00.000Z'; },
    (q) => { q.expires_at = '2026-01-01T10:00:00.000Z'; }, (q) => { q.answer = {}; },
  ]) { const other = await setup(t); await other.run(); mutate(other.api.questions.get(id(1))); await assert.rejects(other.run()); }
  assert.equal(iso('2026-01-01T09:00:00+00:00'), '2026-01-01T09:00:00.000Z'); assert.throws(() => iso('2026-02-30T09:00:00Z'));
});

test('room preflight refuses public/unsupported rooms and missing observer before a POST', async (t) => {
  for (const mutate of [(rooms) => { rooms[0].is_public = true; }, (rooms) => { rooms[0].type = 'dm'; }, (rooms) => { rooms[0].members = [{ user_id: OTHER }]; }]) {
    const s = await setup(t); mutate(s.api.rooms); await assert.rejects(s.run()); assert.equal(sends(s.api), 0);
  }
});

test('reservation write failure sends nothing; answer save failure resumes the original question', async (t) => {
  const s = await setup(t); let writes = 0;
  await assert.rejects(s.run({ write: async (...args) => { if (++writes === 2) throw new Error('disk full'); await atomicJson(...args); } }), /disk full/);
  assert.equal(sends(s.api), 0); await s.run(); s.api.answer(id(1), 'lit');
  await assert.rejects(s.run({ write: async () => { throw new Error('disk full'); } }), /disk full/);
  assert.equal((await s.saved()).attempts[0].status, 'pending'); assert.equal((await s.run()).status, 'ready'); assert.equal(sends(s.api), 1);
});

test('post-create save failure leaves uncertain intent for verified recovery without another POST', async (t) => {
  const s = await setup(t); let writes = 0;
  await assert.rejects(s.run({ write: async (...args) => { if (++writes === 3) throw new Error('disk full'); await atomicJson(...args); } }), /disk full/);
  assert.equal((await s.run()).status, 'create_unknown');
  assert.equal((await s.run({ command: 'recover', attachId: id(1) })).status, 'pending'); assert.equal(sends(s.api), 1);
});

test('failed reads preserve evidence and corrupted request/provenance fail before network', async (t) => {
  const s = await setup(t); await s.run(); const before = await readFile(join(s.directory, 'state.json'), 'utf8');
  s.api.controls.readError = true; await assert.rejects(s.run()); assert.equal(await readFile(join(s.directory, 'state.json'), 'utf8'), before);
  s.api.controls.readError = false; s.api.answer(id(1), 'lit'); await s.run(); const original = await s.saved();
  for (const mutate of [
    (saved) => { saved.attempts[0].request.ttl = 60; }, (saved) => { saved.attempts.push(saved.attempts[0]); },
    (saved) => { saved.attempts[0].node = 'queue'; }, (saved) => { saved.attempts[0].observation.answer.responderId = OTHER; },
  ]) {
    const saved = structuredClone(original); mutate(saved); assert.throws(() => validateState(saved, s.options.input));
    await atomicJson(s.directory, 'state.json', saved); const calls = s.api.calls.length;
    await assert.rejects(s.run()); assert.equal(s.api.calls.length, calls);
  }
});

test('bounded file reads reject malformed, oversized, invalid UTF-8 and symlink data without revealing contents', async (t) => {
  const s = await setup(t), path = join(s.directory, 'bad.json');
  await writeFile(path, '{"secret":"PRIVATE_TOKEN",bad');
  await assert.rejects(readJson(path), (error) => !error.message.includes('PRIVATE_TOKEN') && error.message.includes('malformed'));
  await writeFile(path, Buffer.from([0xff])); await assert.rejects(readJson(path), /UTF-8/);
  await writeFile(path, 'x'.repeat(100)); await assert.rejects(readJson(path, 50), /size limit/);
  await symlink(path, join(s.directory, 'linked')); await assert.rejects(readJson(join(s.directory, 'linked')));
});

test('private lock excludes other commands; report is offline and private', async (t) => {
  const s = await setup(t); await s.run(); const release = await acquireLock(s.directory);
  await assert.rejects(s.run(), /lock exists/); await assert.rejects(localReport(s.directory, s.options.input), /lock exists/);
  await release(); const before = s.api.calls.length;
  assert.equal((await localReport(s.directory, s.options.input, { save: true })).recommendation, null); assert.equal(s.api.calls.length, before);
  assert.equal((await stat(join(s.directory, 'report.json'))).mode & 0o777, 0o600);
});

test('partial or blank environment overrides never combine with saved credentials', async (t) => {
  const s = await setup(t); await atomicJson(s.directory, 'credentials.json', { token: 'saved', room: ROOM_CODE });
  await assert.rejects(loadConnection(s.directory, { PINGROOM_TOKEN: '' })); await assert.rejects(loadConnection(s.directory, { PINGROOM_ROOM: ROOM_CODE }));
  assert.equal((await loadConnection(s.directory, { PINGROOM_TOKEN: 'explicit', PINGROOM_ROOM: ROOM_CODE.toLowerCase() })).token, 'explicit');
});

test('transport rejects unrelated writes, redirects and oversized responses', async () => {
  let count = 0; const client = makeClient({ token: 'fixture', fetchImpl: async () => { count++; return new Response(null, { status: 302 }); } });
  await assert.rejects(client.questions.get(id(1))); assert.equal(count, 1); await assert.rejects(client.questions.cancel(id(1))); assert.equal(count, 1);
  const large = makeClient({ token: 'fixture', fetchImpl: async () => new Response('x'.repeat(512 * 1024 + 1)) }); await assert.rejects(large.questions.get(id(1)));
});

test('transport deadlines bound stalled fetch/body and allow abort through infinite ready empty chunks', async () => {
  const stalled = makeClient({ token: 'fixture', deadlineMs: 20, fetchImpl: () => new Promise(() => {}) }); await assert.rejects(stalled.questions.get(id(1)));
  const body = makeClient({ token: 'fixture', deadlineMs: 20, fetchImpl: async () => new Response(new ReadableStream({ pull: () => new Promise(() => {}) })) }); await assert.rejects(body.questions.get(id(1)));
  const controller = new AbortController();
  const empty = makeClient({ token: 'fixture', signal: controller.signal, fetchImpl: async () => new Response(new ReadableStream({ pull: (out) => out.enqueue(new Uint8Array()) })) });
  const timer = setTimeout(() => controller.abort(), 20); try { await assert.rejects(empty.questions.get(id(1))); } finally { clearTimeout(timer); }
});

test('abort before reservation sends nothing; after reservation it preserves unresolved intent', async (t) => {
  const s = await setup(t), stopped = new AbortController(); stopped.abort(); await assert.rejects(s.run({ signal: stopped.signal })); assert.equal(sends(s.api), 0);
  const controller = new AbortController(); let writes = 0;
  await assert.rejects(s.run({ signal: controller.signal, write: async (...args) => { await atomicJson(...args); if (++writes === 2) controller.abort(); } }));
  assert.equal(sends(s.api), 0); assert.equal((await s.run()).status, 'create_unknown');
});


test('partial external credentials cannot borrow the room from dotenv', async (t) => {
  const s = await setup(t), path = join(s.directory, '.env');
  await writeFile(path, 'PINGROOM_TOKEN=file-token\nPINGROOM_ROOM=DEMO12345678\n');
  const partial = { PINGROOM_TOKEN: 'shell-token' }; await loadEnvironment(partial, path);
  assert.equal(partial.PINGROOM_ROOM, undefined); await assert.rejects(loadConnection(s.directory, partial));
  const env = {}; await loadEnvironment(env, path); assert.deepEqual(await loadConnection(s.directory, env), { token: 'file-token', room: ROOM_CODE });
});

test('adaptive traversal asks only the chosen branch and retains exact human observations', async t => {
  const s = await setup(t), before = structuredClone(s.options.input);
  let result = await decide(s, ['lit']);
  assert.equal(result.status, 'ready'); assert.equal(result.nextObservation, 'queue');
  assert.equal(result.recommendation, null); assert.equal(sends(s.api), 1);
  result = await decide(s, ['present']);
  assert.equal(result.status, 'complete'); assert.equal(result.recommendation.node, 'queue-support');
  assert.deepEqual(result.path.map(item => item.node), ['display', 'queue']);
  assert.deepEqual(result.path.map(item => item.choice), ['lit', 'present']);
  assert.equal(result.path[0].askerId, ASKER); assert.equal(result.path[0].responderId, CONFIG.participant.id);
  assert.deepEqual(s.options.input, before);
  const calls = s.api.calls.length; await s.run(); assert.equal(s.api.calls.length, calls);
});

test('a short branch skips irrelevant observations and a distinct branch selects its own leaf', async t => {
  const short = await setup(t), first = await decide(short, ['dark']);
  assert.equal(first.recommendation.node, 'power-support'); assert.equal(sends(short.api), 1);
  const other = await setup(t), result = await decide(other, ['lit', 'absent']);
  assert.equal(result.recommendation.node, 'application-support'); assert.equal(sends(other.api), 2);
});

test('Unknown terminates at either observation without a recommendation or further question', async t => {
  for (const choices of [['unknown'], ['lit', 'unknown']]) {
    const s = await setup(t), result = await decide(s, choices);
    assert.equal(result.status, 'inconclusive'); assert.equal(result.reason, 'unknown_observation');
    assert.equal(result.recommendation, null); assert.equal(result.nextObservation, null);
    const calls = s.api.calls.length; await s.run(); assert.equal(s.api.calls.length, calls);
  }
});

test('expiry, cancellation and invalid answers stop the path permanently', async t => {
  for (const terminal of ['expired', 'cancelled', 'invalid_answer']) {
    const s = await setup(t); await s.run();
    if (terminal === 'expired') { s.clock.value = '2026-01-01T09:16:00.000Z'; s.api.terminal(id(1), terminal); }
    else if (terminal === 'cancelled') s.api.terminal(id(1), terminal);
    else s.api.answer(id(1), 'unsupported');
    const result = await s.run(); assert.equal(result.status, 'inconclusive'); assert.equal(result.reason, terminal);
    assert.equal(result.recommendation, null); const calls = s.api.calls.length; await s.run(); assert.equal(s.api.calls.length, calls);
  }
});

test('invalid graph shapes fail before any network request or saved state', async t => {
  for (const mutate of [
    p => { p.entry = 'missing'; }, p => { p.entry = 'power-support'; }, p => { p.nodes[0].options[0].next = 'display'; },
    p => { p.nodes[1].options[0].next = 'display'; }, p => { p.nodes[1].options[0].next = 'missing'; },
    p => { p.nodes[0].options = []; }, p => { p.nodes[0].options.push(...p.nodes[0].options); },
    p => { p.nodes[0].options[1].value = 'lit'; }, p => { p.nodes[0].options[1].label = 'Display is lit'; },
    p => { p.nodes[0].options[0].value = 'unknown'; }, p => { p.nodes[0].options[0].label = 'Unknown / not applicable'; },
    p => { p.nodes[1].id = 'display'; }, p => { p.nodes[0].kind = 'command'; }, p => { p.nodes[0].exec = 'anything'; },
    p => { p.nodes.push({ id: 'unused', kind: 'recommendation', text: 'Unreachable' }); },
    p => { p.nodes[0].prompt = 'x'.repeat(201); }, p => { p.nodes[0].prompt = 'newline\ntext'; },
    p => { p.nodes[2].text = ''; }, p => { p.nodes[2].text = 'x'.repeat(401); },
    p => { p.nodes = []; }, p => { p.nodes = Array(25).fill(p.nodes[0]); }, p => { p.summary = 'x'.repeat(121); },
  ]) {
    const input = structuredClone(example); mutate(input); const s = await setup(t, input);
    await assert.rejects(s.run()); assert.equal(s.api.calls.length, 0); assert.equal(await s.saved(), null);
  }
});

test('changed case, runbook, connection or observer cannot reuse saved evidence', async t => {
  const s = await setup(t); await s.run(); const calls = s.api.calls.length;
  for (const mutate of [p => { p.caseId = 'different'; }, p => { p.summary = 'Different case'; },
    p => { p.runbookVersion = 'v2'; }, p => { p.nodes[0].prompt = 'Changed meaning'; }, p => { p.nodes[0].options.reverse(); }]) {
    const input = structuredClone(example); mutate(input); await assert.rejects(s.run({ input }), /changed case/);
  }
  await assert.rejects(s.run({ token: 'other' }), /another connection/);
  await assert.rejects(s.run({ config: { participant: { id: OTHER, label: 'Other' } } }), /another connection/);
  assert.equal(s.api.calls.length, calls);
});

test('saved path cannot skip, reorder or append observations after a terminal branch', async t => {
  const s = await setup(t); await decide(s, ['lit', 'present']); const original = await s.saved();
  for (const mutate of [
    state => { state.attempts.reverse(); }, state => { state.attempts.shift(); },
    state => { state.attempts.push(structuredClone(state.attempts[0])); },
    state => { state.attempts[0].observation.answer = { ...state.attempts[0].observation.answer, value: 'dark', label: 'Display is dark' }; },
    state => { state.attempts[0].observation.answer = { ...state.attempts[0].observation.answer, value: 'unknown', label: 'Unknown / not applicable' }; },
    state => { state.attempts[1].createdAt = '2026-01-01T08:59:59.000Z'; },
    state => { state.attempts[1].questionId = state.attempts[0].questionId; },
  ]) {
    const state = structuredClone(original); mutate(state); await atomicJson(s.directory, 'state.json', state);
    const calls = s.api.calls.length; await assert.rejects(s.run()); assert.equal(s.api.calls.length, calls);
  }
});

test('a saved observation appended after expiry is rejected before reading the API', async t => {
  const s = await setup(t); await s.run(); s.clock.value = '2026-01-01T09:16:00.000Z';
  s.api.terminal(id(1), 'expired'); await s.run();
  const state = await s.saved(), forged = structuredClone(state.attempts[0]);
  forged.id = id(90); forged.node = 'queue'; forged.createdAt = s.clock.value;
  forged.request = requestFor(s.options.input, CONFIG, 'queue', forged.id);
  forged.questionId = null; forged.status = 'creating'; forged.observation = null;
  state.attempts.push(forged); await atomicJson(s.directory, 'state.json', state);
  const calls = s.api.calls.length; await assert.rejects(s.run(), /No observation may follow/);
  assert.equal(s.api.calls.length, calls);
});

test('converging acyclic branches are permitted without demanding a single parent', () => {
  const input = structuredClone(example); input.nodes[1].options[1].next = 'queue-support';
  input.nodes = input.nodes.filter(node => node.id !== 'application-support');
  assert.equal(validateInput(input).nodes.length, 4);
});

test('maximum 24-node path fits prompt, state and report limits and stops at its leaf', async t => {
  const input = { caseId: 'bounded', title: 't'.repeat(60), summary: 's'.repeat(120), runbookVersion: 'v1', entry: 'n0',
    nodes: Array.from({ length: 23 }, (_, i) => ({ id: `n${i}`, kind: 'observation', prompt: 'p'.repeat(200),
      options: [{ value: 'seen', label: 's'.repeat(40), next: `n${i + 1}` }] })) };
  input.nodes.push({ id: 'n23', kind: 'recommendation', text: 'r'.repeat(400) });
  const s = await setup(t, input), result = await decide(s, Array(23).fill('seen'));
  assert.equal(result.status, 'complete'); assert.equal(sends(s.api), 23);
  for (const q of s.api.questions.values()) assert.ok(q.prompt.length <= 500);
  assert.ok(Buffer.byteLength(JSON.stringify(await s.saved(), null, 2)) + 4096 < 1024 * 1024);
  await localReport(s.directory, input, { save: true }); assert.ok((await stat(join(s.directory, 'report.json'))).size < 1024 * 1024);
});
