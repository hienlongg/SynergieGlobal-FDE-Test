import { strict as assert } from 'node:assert';
import type { AddressInfo } from 'node:net';
import { test, type TestContext } from 'node:test';
import {
  CancellationStore,
  type NotificationPayload,
  type NotificationSender
} from '../src/cancellations';
import { createServer } from '../src/server';
import { loadSeed } from '../src/seed';

class RecordingSender implements NotificationSender {
  readonly sent: NotificationPayload[] = [];
  async send(payload: NotificationPayload): Promise<void> {
    this.sent.push(payload);
  }
}

async function startTestServer(
  t: TestContext,
  sender?: NotificationSender
): Promise<{ baseUrl: string; sender?: NotificationSender }> {
  const store = new CancellationStore(':memory:', loadSeed());
  const server = createServer(store, sender);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => {
      store.close();
      error ? reject(error) : resolve();
    });
  }));

  const address = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${address.port}`, ...(sender ? { sender } : {}) };
}

async function requestJson(
  baseUrl: string,
  url: string,
  init?: RequestInit
): Promise<{ response: Response; body: any }> {
  const response = await fetch(`${baseUrl}${url}`, init);
  return { response, body: await response.json() };
}

test('POST cancellation applies policy, persists history, and sends tutor notification', async (t) => {
  const sender = new RecordingSender();
  const { baseUrl } = await startTestServer(t, sender);
  const { response, body } = await requestJson(baseUrl, '/lessons/L012/cancellation', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': 'api-cancel-L012'
    },
    body: JSON.stringify({
      cancelledAt: '2026-03-04T13:00:00+07:00',
      cancelledBy: 'family',
      reasonCode: 'family_request'
    })
  });

  assert.equal(response.status, 201);
  assert.equal(body.status, 'cancelled');
  assert.deepEqual(body.policy, {
    timing: 'late', leadMinutes: 180, familyCharge: 'full', tutorPay: 'full'
  });
  assert.equal(body.notification.status, 'sent');
  assert.equal(sender.sent.length, 1);
  assert.equal(sender.sent[0]?.tutorId, 'T2');

  const lesson = await requestJson(baseUrl, '/lessons/L012');
  assert.equal(lesson.response.status, 200);
  assert.equal(lesson.body.currentStatus, 'cancelled');
  assert.equal(lesson.body.revisions.length, 2);
});

test('same idempotency key replays without sending a duplicate notification', async (t) => {
  const sender = new RecordingSender();
  const { baseUrl } = await startTestServer(t, sender);
  const init: RequestInit = {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'api-cancel-L011' },
    body: JSON.stringify({
      cancelledAt: '2026-03-04T12:00:00+07:00',
      cancelledBy: 'family',
      reasonCode: 'student_illness'
    })
  };

  const first = await requestJson(baseUrl, '/lessons/L011/cancellation', init);
  const replay = await requestJson(baseUrl, '/lessons/L011/cancellation', init);
  assert.equal(first.response.status, 201);
  assert.equal(replay.response.status, 201);
  assert.equal(replay.body.replayed, true);
  assert.equal(replay.body.version, 2);
  assert.equal(sender.sent.length, 1);
});

test('API returns structured errors for unsafe cancellation commands', async (t) => {
  const { baseUrl } = await startTestServer(t);
  const cases: Array<[string, RequestInit, number, string]> = [
    ['/lessons/L999/cancellation', {
      method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'missing-L999' },
      body: JSON.stringify({ cancelledAt: '2026-03-04T10:00:00+07:00', cancelledBy: 'family', reasonCode: 'other' })
    }, 404, 'lesson_not_found'],
    ['/lessons/L011/cancellation', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}'
    }, 400, 'missing_idempotency_key'],
    ['/lessons/L011/cancellation', {
      method: 'POST', headers: { 'content-type': 'application/jsonp', 'idempotency-key': 'wrong-media-type' },
      body: '{}'
    }, 415, 'unsupported_media_type'],
    ['/lessons/L011/cancellation', {
      method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'invalid-actor' },
      body: JSON.stringify({ cancelledAt: '2026-03-04T10:00:00+07:00', cancelledBy: 'tutor', reasonCode: 'family_request' })
    }, 400, 'invalid_reason'],
    ['/lessons/L005/cancellation', {
      method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'already-cancelled' },
      body: JSON.stringify({ cancelledAt: '2026-03-03T08:00:00+07:00', cancelledBy: 'family', reasonCode: 'other' })
    }, 409, 'already_cancelled']
  ];

  for (const [url, init, status, code] of cases) {
    const result = await requestJson(baseUrl, url, init);
    assert.equal(result.response.status, status);
    assert.equal(result.body.error.code, code);
  }
});

test('GET unknown lesson and route return JSON 404 responses', async (t) => {
  const { baseUrl } = await startTestServer(t);
  const lesson = await requestJson(baseUrl, '/lessons/L999');
  assert.equal(lesson.response.status, 404);
  assert.equal(lesson.body.error.code, 'lesson_not_found');

  const route = await requestJson(baseUrl, '/unknown');
  assert.equal(route.response.status, 404);
  assert.equal(route.body.error.code, 'not_found');
});
