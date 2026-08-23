import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  CancellationStore,
  ServiceError,
  parseCancellationCommand,
  type NotificationPayload,
  type NotificationSender
} from '../src/cancellations';
import { loadSeed } from '../src/seed';

class RecordingSender implements NotificationSender {
  readonly sent: NotificationPayload[] = [];

  async send(payload: NotificationPayload): Promise<void> {
    this.sent.push(payload);
  }
}

const command = (
  cancelledAt: string,
  cancelledBy: 'family' | 'tutor' = 'family',
  reasonCode: 'family_request' | 'tutor_illness' = 'family_request'
) => ({ cancelledAt, cancelledBy, reasonCode, note: null });

test('cancellation timestamps require a real date, time, and explicit offset', () => {
  for (const cancelledAt of [
    '2026-02-30T12:00:00+07:00',
    '2026-03-04T24:00:00+07:00',
    '2026-03-04T12:00:60+07:00',
    '2026-03-04T12:00:00'
  ]) {
    assert.throws(
      () => parseCancellationCommand({
        cancelledAt,
        cancelledBy: 'family',
        reasonCode: 'family_request'
      }),
      (error: unknown) => error instanceof ServiceError && error.code === 'invalid_cancelled_at'
    );
  }
});

test('late family cancellation charges the family, pays the tutor, and queues one notification', () => {
  const store = new CancellationStore(':memory:', loadSeed());
  try {
    const result = store.cancel(
      'L012',
      command('2026-03-04T13:00:00+07:00'),
      'cancel-L012-late'
    );

    assert.equal(result.status, 'cancelled');
    assert.equal(result.version, 2);
    assert.equal(result.recordedAt, '2026-03-10T12:00:00+07:00');
    assert.equal(result.afterCommunicationCutoff, true);
    assert.deepEqual(result.policy, {
      timing: 'late',
      leadMinutes: 180,
      familyCharge: 'full',
      tutorPay: 'full'
    });
    assert.equal(result.notification.status, 'pending');
    assert.match(result.notification.message, /Tutor pay remains full/);
    assert.match(result.notification.message, /after the 16:00 schedule cut-off/);
  } finally {
    store.close();
  }
});

test('exactly four hours is on time and a tutor cancellation never charges the family', () => {
  const familyStore = new CancellationStore(':memory:', loadSeed());
  const tutorStore = new CancellationStore(':memory:', loadSeed());
  try {
    const onTime = familyStore.cancel(
      'L012',
      command('2026-03-04T12:00:00+07:00'),
      'cancel-L012-four-hours'
    );
    assert.deepEqual(onTime.policy, {
      timing: 'on_time',
      leadMinutes: 240,
      familyCharge: 'none',
      tutorPay: 'none'
    });

    const tutorCancellation = tutorStore.cancel(
      'L016',
      command('2026-03-05T13:00:00+07:00', 'tutor', 'tutor_illness'),
      'cancel-L016-tutor'
    );
    assert.equal(tutorCancellation.policy.timing, 'late');
    assert.equal(tutorCancellation.policy.familyCharge, 'none');
    assert.equal(tutorCancellation.policy.tutorPay, 'none');
  } finally {
    familyStore.close();
    tutorStore.close();
  }
});

test('the schedule cut-off begins exactly at 16:00 on the prior day', () => {
  const beforeStore = new CancellationStore(':memory:', loadSeed());
  const atStore = new CancellationStore(':memory:', loadSeed());
  try {
    const before = beforeStore.cancel(
      'L030', command('2026-03-06T15:59:59+07:00'), 'cancel-L030-before-cutoff'
    );
    const at = atStore.cancel(
      'L030', command('2026-03-06T16:00:00+07:00'), 'cancel-L030-at-cutoff'
    );
    assert.equal(before.afterCommunicationCutoff, false);
    assert.equal(at.afterCommunicationCutoff, true);
  } finally {
    beforeStore.close();
    atStore.close();
  }
});

test('idempotency replays one revision and rejects key reuse with another command', () => {
  const store = new CancellationStore(':memory:', loadSeed());
  try {
    const first = store.cancel('L011', command('2026-03-04T12:00:00+07:00'), 'cancel-L011-key');
    const replay = store.cancel('L011', command('2026-03-04T12:00:00+07:00'), 'cancel-L011-key');
    assert.equal(first.version, 2);
    assert.equal(replay.version, 2);
    assert.equal(replay.replayed, true);
    assert.equal(replay.notification.notificationId, first.notification.notificationId);

    assert.throws(
      () => store.cancel('L011', command('2026-03-04T12:30:00+07:00'), 'cancel-L011-key'),
      (error: unknown) => error instanceof ServiceError && error.code === 'idempotency_conflict'
    );
    assert.throws(
      () => store.cancel('L012', command('2026-03-04T12:00:00+07:00'), 'cancel-L011-key'),
      (error: unknown) => error instanceof ServiceError && error.code === 'idempotency_conflict'
    );
  } finally {
    store.close();
  }
});

test('notification delivery is recorded without rolling back a valid cancellation', async () => {
  const successStore = new CancellationStore(':memory:', loadSeed());
  const failureStore = new CancellationStore(':memory:', loadSeed());
  const sender = new RecordingSender();
  try {
    const success = successStore.cancel('L011', command('2026-03-04T12:00:00+07:00'), 'cancel-L011-send');
    await Promise.all([
      successStore.deliver(success.notification.notificationId, sender),
      successStore.deliver(success.notification.notificationId, sender)
    ]);
    const delivered = successStore.refresh(success);
    assert.equal(delivered.notification.status, 'sent');
    assert.equal(delivered.notification.attempts, 1);
    assert.equal(sender.sent.length, 1);
    assert.equal(sender.sent[0]?.recipientPhone, '090xxx5566');

    const failed = failureStore.cancel('L011', command('2026-03-04T12:00:00+07:00'), 'cancel-L011-fail');
    await failureStore.deliver(failed.notification.notificationId, {
      send: async () => { throw new Error('WhatsApp unavailable'); }
    });
    const retained = failureStore.refresh(failed);
    assert.equal(retained.status, 'cancelled');
    assert.equal(retained.notification.status, 'failed');
    assert.equal(retained.notification.attempts, 1);
    assert.equal(retained.notification.lastError, 'WhatsApp unavailable');
  } finally {
    successStore.close();
    failureStore.close();
  }
});

test('rejects cancellation after lesson start and preserves imported history honestly', () => {
  const store = new CancellationStore(':memory:', loadSeed());
  try {
    assert.throws(
      () => store.cancel('L011', command('2026-03-04T14:00:00+07:00'), 'cancel-L011-started'),
      (error: unknown) => error instanceof ServiceError && error.code === 'lesson_started'
    );

    const imported = store.getLesson('L005') as { currentStatus: string; revisions: unknown[] };
    assert.equal(imported.currentStatus, 'cancelled');
    assert.equal(imported.revisions.length, 1);
  } finally {
    store.close();
  }
});

test('transaction failure rolls back the revision, current pointer, and idempotency result', () => {
  const store = new CancellationStore(':memory:', loadSeed());
  try {
    store.database.exec(`
      CREATE TRIGGER fail_outbox BEFORE INSERT ON notification_outbox
      BEGIN SELECT RAISE(ABORT, 'simulated outbox failure'); END;
    `);
    assert.throws(
      () => store.cancel('L011', command('2026-03-04T12:00:00+07:00'), 'cancel-L011-rollback'),
      /simulated outbox failure/
    );
    const lesson = store.getLesson('L011') as { currentStatus: string; currentVersion: number; revisions: unknown[] };
    assert.equal(lesson.currentStatus, 'booked');
    assert.equal(lesson.currentVersion, 1);
    assert.equal(lesson.revisions.length, 1);
    assert.equal(store.database.prepare('SELECT count(*) FROM idempotency_keys').pluck().get(), 0);
  } finally {
    store.close();
  }
});

test('database rejects attempts to rewrite revision history', () => {
  const store = new CancellationStore(':memory:', loadSeed());
  try {
    assert.throws(
      () => store.database.prepare("UPDATE lesson_revisions SET room_id = 'R9' WHERE lesson_id = 'L001'").run(),
      /lesson revisions are immutable/
    );
    assert.throws(
      () => store.database.prepare("DELETE FROM lesson_revisions WHERE lesson_id = 'L001'").run(),
      /lesson revisions are immutable/
    );
  } finally {
    store.close();
  }
});

test('cancellation state and immutable revisions survive reopening the database', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'cancellation-store-'));
  const filename = path.join(root, 'bright-path.sqlite');
  try {
    const first = new CancellationStore(filename, loadSeed());
    first.cancel('L030', command('2026-03-06T15:00:00+07:00'), 'cancel-L030-persist');
    first.close();

    const reopened = new CancellationStore(filename, loadSeed());
    const lesson = reopened.getLesson('L030') as {
      currentStatus: string;
      currentVersion: number;
      revisions: Array<{ replacesRevisionId: number | null }>;
    };
    assert.equal(lesson.currentStatus, 'cancelled');
    assert.equal(lesson.currentVersion, 2);
    assert.equal(lesson.revisions.length, 2);
    assert.equal(typeof lesson.revisions[1]?.replacesRevisionId, 'number');
    reopened.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
