import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { startReadinessServer } from '../src/readiness.js';

test('readiness stays on loopback and reports current state', async (context) => {
  let ready = false;
  const server = startReadinessServer({ port: 0, isReady: () => ready });
  context.after(() => server.close());
  await once(server, 'listening');
  const { port } = server.address();

  let response = await fetch(`http://127.0.0.1:${port}/ready`);
  assert.equal(response.status, 503);
  assert.equal(await response.text(), 'not ready\n');

  ready = true;
  response = await fetch(`http://127.0.0.1:${port}/ready`);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'ready\n');
  assert.equal(server.address().address, '127.0.0.1');
});
