import { strict as assert } from 'node:assert';
import type { AddressInfo } from 'node:net';
import { test, type TestContext } from 'node:test';
import { createServer } from '../src/server';

async function startTestServer(t: TestContext): Promise<string> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));

  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

async function getJson(baseUrl: string, path: string): Promise<{ response: Response; body: unknown }> {
  const response = await fetch(`${baseUrl}${path}`);
  return { response, body: await response.json() as unknown };
}

test('HTTP contract returns grouped incidents and scope metadata', async (t) => {
  const baseUrl = await startTestServer(t);
  const { response, body } = await getJson(baseUrl, '/conflicts?date=2026-03-04');

  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /^application\/json; charset=utf-8$/);
  assert.deepEqual(body, {
    date: '2026-03-04',
    checksApplied: ['tutor-overlap', 'room-overlap'],
    checksDeferred: ['student-overlap', 'daily-cap', 'operating-day'],
    incidentCount: 1,
    incidents: [{
      lessonIds: ['L009', 'L010'],
      date: '2026-03-04',
      overlap: { start: '11:00', end: '12:30' },
      resources: [
        { type: 'tutor', id: 'T1', name: 'Ngoc Anh' },
        { type: 'room', id: 'R1' }
      ],
      lessons: [
        {
          lessonId: 'L009', student: 'Tran Bao Long', tutorId: 'T1', roomId: 'R1',
          status: 'booked', interval: '11:00-12:30', note: 'exam pair - half price'
        },
        {
          lessonId: 'L010', student: 'Nguyen Thi Ha', tutorId: 'T1', roomId: 'R1',
          status: 'booked', interval: '11:00-12:30', note: 'exam pair - half price'
        }
      ]
    }]
  });
});

test('HTTP contract returns an empty scoped report for a valid date with no rows', async (t) => {
  const baseUrl = await startTestServer(t);
  const { response, body } = await getJson(baseUrl, '/conflicts?date=2035-01-01');

  assert.equal(response.status, 200);
  assert.deepEqual(body, {
    date: '2035-01-01',
    checksApplied: ['tutor-overlap', 'room-overlap'],
    checksDeferred: ['student-overlap', 'daily-cap', 'operating-day'],
    incidentCount: 0,
    incidents: []
  });
});

test('HTTP contract returns 400 for missing, malformed, and impossible dates', async (t) => {
  const baseUrl = await startTestServer(t);
  for (const path of ['/conflicts', '/conflicts?date=2026-3-04', '/conflicts?date=2026-02-30']) {
    const { response, body } = await getJson(baseUrl, path);
    assert.equal(response.status, 400);
    assert.match(response.headers.get('content-type') ?? '', /^application\/json/);
    assert.equal(typeof (body as { error?: unknown }).error, 'string');
  }
});

test('HTTP contract returns JSON 404 for unknown routes', async (t) => {
  const baseUrl = await startTestServer(t);
  const { response, body } = await getJson(baseUrl, '/unknown');

  assert.equal(response.status, 404);
  assert.match(response.headers.get('content-type') ?? '', /^application\/json/);
  assert.deepEqual(body, { error: 'Not found. Use GET /conflicts?date=YYYY-MM-DD.' });
});
