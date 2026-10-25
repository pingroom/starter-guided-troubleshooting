import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readJson } from './storage.js';
import { step, localReport } from './engine.js';
import { mockApi, CONFIG, ROOM_CODE } from './mock.js';

const input = await readJson(new URL('../examples/case.json', import.meta.url), 16384);
for (const [name, choices] of [['queue observation', ['lit', 'present']], ['short branch', ['dark']], ['unknown observation', ['unknown']]]) {
  const directory = await mkdtemp(join(tmpdir(), 'pingroom-troubleshooting-demo-'));
  const now = () => '2026-01-01T09:00:00.000Z', api = mockApi(now);
  const options = { client: api.client, directory, input, config: CONFIG, token: 'offline-fixture-token', room: ROOM_CODE, now };
  try {
    for (const choice of choices) {
      const pending = await step(options);
      api.answer(pending.path.at(-1).questionId, choice);
      await step(options);
    }
    const result = await localReport(directory, input, { save: true });
    assert.equal(result.status, name === 'unknown observation' ? 'inconclusive' : 'complete');
    const calls = api.calls.length; await step(options); assert.equal(api.calls.length, calls);
    console.log(JSON.stringify({ demo: name, transport: 'real SDK with local mock only', ...result }, null, 2));
  } finally { await rm(directory, { recursive: true, force: true }); }
}
