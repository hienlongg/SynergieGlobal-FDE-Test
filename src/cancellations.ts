import { createHash } from 'node:crypto';
import Database = require('better-sqlite3');
import { parseOffsetDateTime, type SeedData } from './domain';

export const CANCELLATION_ACTORS = ['family', 'tutor'] as const;
export type CancellationActor = (typeof CANCELLATION_ACTORS)[number];

export const CANCELLATION_REASONS = [
  'family_request',
  'student_illness',
  'tutor_illness',
  'emergency',
  'other'
] as const;
export type CancellationReason = (typeof CANCELLATION_REASONS)[number];
export type NotificationStatus = 'pending' | 'sending' | 'sent' | 'failed';

export interface CancellationCommand {
  readonly cancelledAt: string;
  readonly cancelledBy: CancellationActor;
  readonly reasonCode: CancellationReason;
  readonly note: string | null;
}

export interface NotificationPayload {
  readonly notificationId: number;
  readonly lessonId: string;
  readonly revisionId: number;
  readonly tutorId: string;
  readonly tutorName: string;
  readonly recipientPhone: string;
  readonly message: string;
}

export interface NotificationSender {
  send(payload: NotificationPayload): Promise<void>;
}

export interface CancellationResult {
  readonly lessonId: string;
  readonly status: 'cancelled';
  readonly version: number;
  readonly cancelledAt: string;
  readonly recordedAt: string;
  readonly cancelledBy: CancellationActor;
  readonly reasonCode: CancellationReason;
  readonly afterCommunicationCutoff: boolean;
  readonly policy: {
    readonly timing: 'on_time' | 'late';
    readonly leadMinutes: number;
    readonly familyCharge: 'none' | 'full';
    readonly tutorPay: 'none' | 'full';
  };
  readonly notification: {
    readonly notificationId: number;
    readonly tutorId: string;
    readonly tutorName: string;
    readonly status: NotificationStatus;
    readonly attempts: number;
    readonly message: string;
    readonly lastError: string | null;
  };
  readonly replayed: boolean;
}

interface CurrentLessonRow {
  readonly lesson_id: string;
  readonly student: string;
  readonly tutor_id: string;
  readonly tutor_name: string;
  readonly phone: string;
  readonly date: string;
  readonly start_time: string;
  readonly duration_min: number;
  readonly room_id: string;
  readonly status: string;
  readonly version: number;
}

interface IdempotencyRow {
  readonly request_hash: string;
  readonly revision_id: number;
  readonly notification_id: number;
}

interface ResultRow {
  readonly lesson_id: string;
  readonly version: number;
  readonly cancelled_at: string;
  readonly recorded_at: string;
  readonly cancelled_by: CancellationActor;
  readonly reason_code: CancellationReason;
  readonly after_cutoff: number;
  readonly timing: 'on_time' | 'late';
  readonly lead_minutes: number;
  readonly family_charge: 'none' | 'full';
  readonly tutor_pay: 'none' | 'full';
  readonly notification_id: number;
  readonly tutor_id: string;
  readonly tutor_name: string;
  readonly notification_status: NotificationStatus;
  readonly attempts: number;
  readonly message: string;
  readonly last_error: string | null;
}

interface NotificationRow {
  readonly notification_id: number;
  readonly lesson_id: string;
  readonly revision_id: number;
  readonly tutor_id: string;
  readonly tutor_name: string;
  readonly recipient_phone: string;
  readonly message: string;
  readonly status: NotificationStatus;
  readonly attempts: number;
  readonly last_error: string | null;
}

export class ServiceError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

const familyReasons = new Set<CancellationReason>(['family_request', 'student_illness', 'emergency', 'other']);
const tutorReasons = new Set<CancellationReason>(['tutor_illness', 'emergency', 'other']);

export function parseCancellationCommand(value: unknown): CancellationCommand {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ServiceError(400, 'invalid_body', 'Request body must be a JSON object.');
  }

  const body = value as Record<string, unknown>;
  const allowed = new Set(['cancelledAt', 'cancelledBy', 'reasonCode', 'note']);
  const unexpected = Object.keys(body).filter((key) => !allowed.has(key));
  if (unexpected.length > 0) {
    throw new ServiceError(400, 'invalid_body', `Unexpected field: ${unexpected[0]}.`);
  }

  if (typeof body.cancelledAt !== 'string') {
    throw new ServiceError(400, 'invalid_cancelled_at', 'cancelledAt must be an ISO timestamp with an explicit offset.');
  }
  try {
    parseOffsetDateTime(body.cancelledAt, 'cancelledAt');
  } catch {
    throw new ServiceError(400, 'invalid_cancelled_at', 'cancelledAt must contain a real date, time, and explicit offset.');
  }

  if (body.cancelledBy !== 'family' && body.cancelledBy !== 'tutor') {
    throw new ServiceError(400, 'invalid_actor', 'cancelledBy must be family or tutor.');
  }
  if (typeof body.reasonCode !== 'string' ||
      !CANCELLATION_REASONS.includes(body.reasonCode as CancellationReason)) {
    throw new ServiceError(400, 'invalid_reason', 'reasonCode is not recognised.');
  }

  const reasonCode = body.reasonCode as CancellationReason;
  const validForActor = body.cancelledBy === 'family'
    ? familyReasons.has(reasonCode)
    : tutorReasons.has(reasonCode);
  if (!validForActor) {
    throw new ServiceError(400, 'invalid_reason', `reasonCode is not valid for a ${body.cancelledBy} cancellation.`);
  }

  if (body.note !== undefined && body.note !== null &&
      (typeof body.note !== 'string' || body.note.trim().length === 0 || body.note.length > 500)) {
    throw new ServiceError(400, 'invalid_note', 'note must be omitted or contain 1 to 500 characters.');
  }

  return {
    cancelledAt: body.cancelledAt,
    cancelledBy: body.cancelledBy,
    reasonCode,
    note: typeof body.note === 'string' ? body.note.trim() : null
  };
}

function requestHash(lessonId: string, command: CancellationCommand): string {
  return createHash('sha256').update(JSON.stringify({ lessonId, ...command })).digest('hex');
}

function previousDate(date: string): string {
  const [yearText, monthText, dayText] = date.split('-');
  const instant = Date.UTC(Number(yearText), Number(monthText) - 1, Number(dayText) - 1);
  return new Date(instant).toISOString().slice(0, 10);
}

function policyFor(lesson: CurrentLessonRow, command: CancellationCommand) {
  const lessonStart = Date.parse(`${lesson.date}T${lesson.start_time}:00+07:00`);
  const cancelledAt = Date.parse(command.cancelledAt);
  if (cancelledAt >= lessonStart) {
    throw new ServiceError(
      422,
      'lesson_started',
      'A lesson cannot be cancelled at or after its start time; record a no-show where appropriate.'
    );
  }

  const leadMinutes = Math.floor((lessonStart - cancelledAt) / 60_000);
  const timing = leadMinutes < 240 ? 'late' as const : 'on_time' as const;
  const familyCharge = command.cancelledBy === 'family' && timing === 'late' ? 'full' as const : 'none' as const;
  const tutorPay = command.cancelledBy === 'family' && timing === 'late' ? 'full' as const : 'none' as const;
  const cutoff = Date.parse(`${previousDate(lesson.date)}T16:00:00+07:00`);

  return {
    timing,
    leadMinutes,
    familyCharge,
    tutorPay,
    afterCommunicationCutoff: cancelledAt >= cutoff
  };
}

function messageFor(
  lesson: CurrentLessonRow,
  command: CancellationCommand,
  policy: ReturnType<typeof policyFor>
): string {
  const cutoffText = policy.afterCommunicationCutoff ? ' Change made after the 16:00 schedule cut-off.' : '';
  const payText = policy.tutorPay === 'full' ? ' Tutor pay remains full.' : '';
  return `CANCELLED: ${lesson.date} ${lesson.start_time}, ${lesson.student}, room ${lesson.room_id}. ` +
    `Reason: ${command.reasonCode.replaceAll('_', ' ')}.${payText}${cutoffText}`;
}

export class CancellationStore {
  readonly database: Database.Database;

  constructor(
    filename: string,
    seed: SeedData,
    private readonly now: () => string = () => '2026-03-10T12:00:00+07:00'
  ) {
    this.database = new Database(filename);
    this.database.pragma('foreign_keys = ON');
    if (filename !== ':memory:') this.database.pragma('journal_mode = WAL');
    this.createSchema();
    this.migrateSchema();
    this.recoverInterruptedDeliveries();
    this.seed(seed);
  }

  private createSchema(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS tutors (
        tutor_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        phone TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS lessons (
        lesson_id TEXT PRIMARY KEY,
        student TEXT NOT NULL,
        current_revision_id INTEGER REFERENCES lesson_revisions(revision_id)
      );
      CREATE TABLE IF NOT EXISTS lesson_revisions (
        revision_id INTEGER PRIMARY KEY,
        lesson_id TEXT NOT NULL REFERENCES lessons(lesson_id),
        version INTEGER NOT NULL,
        date TEXT NOT NULL,
        start_time TEXT NOT NULL,
        duration_min INTEGER NOT NULL CHECK (duration_min > 0),
        tutor_id TEXT NOT NULL REFERENCES tutors(tutor_id),
        room_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('booked', 'cancelled', 'no_show')),
        changed_at TEXT,
        recorded_at TEXT,
        changed_by TEXT CHECK (changed_by IS NULL OR changed_by IN ('family', 'tutor', 'import')),
        reason_code TEXT,
        note TEXT,
        after_cutoff INTEGER CHECK (after_cutoff IS NULL OR after_cutoff IN (0, 1)),
        timing TEXT CHECK (timing IS NULL OR timing IN ('on_time', 'late')),
        lead_minutes INTEGER,
        family_charge TEXT CHECK (family_charge IS NULL OR family_charge IN ('none', 'full')),
        tutor_pay TEXT CHECK (tutor_pay IS NULL OR tutor_pay IN ('none', 'full')),
        replaces_revision_id INTEGER REFERENCES lesson_revisions(revision_id),
        UNIQUE (lesson_id, version)
      );
      CREATE TABLE IF NOT EXISTS notification_outbox (
        notification_id INTEGER PRIMARY KEY,
        lesson_id TEXT NOT NULL REFERENCES lessons(lesson_id),
        revision_id INTEGER NOT NULL UNIQUE REFERENCES lesson_revisions(revision_id),
        tutor_id TEXT NOT NULL REFERENCES tutors(tutor_id),
        recipient_phone TEXT NOT NULL,
        message TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'sending', 'sent', 'failed')),
        attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        created_at TEXT NOT NULL,
        sent_at TEXT,
        last_error TEXT
      );
      CREATE TABLE IF NOT EXISTS idempotency_keys (
        idempotency_key TEXT PRIMARY KEY,
        request_hash TEXT NOT NULL,
        revision_id INTEGER NOT NULL REFERENCES lesson_revisions(revision_id),
        notification_id INTEGER NOT NULL REFERENCES notification_outbox(notification_id)
      );
      CREATE TRIGGER IF NOT EXISTS lesson_revisions_require_cancelled_at
      BEFORE INSERT ON lesson_revisions
      WHEN NEW.status = 'cancelled' AND NEW.changed_at IS NULL
      BEGIN
        SELECT RAISE(ABORT, 'cancelled revision requires changed_at');
      END;
      CREATE TRIGGER IF NOT EXISTS lesson_revisions_no_update
      BEFORE UPDATE ON lesson_revisions
      BEGIN
        SELECT RAISE(ABORT, 'lesson revisions are immutable');
      END;
      CREATE TRIGGER IF NOT EXISTS lesson_revisions_no_delete
      BEFORE DELETE ON lesson_revisions
      BEGIN
        SELECT RAISE(ABORT, 'lesson revisions are immutable');
      END;
    `);
  }

  private migrateSchema(): void {
    const revisionColumns = this.database.pragma('table_info(lesson_revisions)') as Array<{ name: string }>;
    if (!revisionColumns.some((column) => column.name === 'recorded_at')) {
      this.database.exec('ALTER TABLE lesson_revisions ADD COLUMN recorded_at TEXT');
    }

    const notificationColumns = this.database.pragma('table_info(notification_outbox)') as Array<{ name: string }>;
    if (!notificationColumns.some((column) => column.name === 'recipient_phone')) {
      this.database.exec('ALTER TABLE notification_outbox ADD COLUMN recipient_phone TEXT');
      this.database.exec(`
        UPDATE notification_outbox
        SET recipient_phone = (SELECT phone FROM tutors WHERE tutors.tutor_id = notification_outbox.tutor_id)
      `);
    }
  }

  private recoverInterruptedDeliveries(): void {
    this.database.prepare(`
      UPDATE notification_outbox
      SET status = 'failed', last_error = 'Delivery interrupted before an outcome was recorded'
      WHERE status = 'sending'
    `).run();
  }

  private seed(seed: SeedData): void {
    const insertTutor = this.database.prepare(
      'INSERT OR IGNORE INTO tutors (tutor_id, name, phone) VALUES (?, ?, ?)'
    );
    const insertLesson = this.database.prepare(
      'INSERT OR IGNORE INTO lessons (lesson_id, student) VALUES (?, ?)'
    );
    const insertRevision = this.database.prepare(`
      INSERT INTO lesson_revisions (
        lesson_id, version, date, start_time, duration_min, tutor_id, room_id,
        status, changed_at, changed_by, reason_code, note
      ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, 'import', NULL, ?)
    `);
    const currentRevision = this.database.prepare(
      'UPDATE lessons SET current_revision_id = ? WHERE lesson_id = ?'
    );
    const hasRevision = this.database.prepare(
      'SELECT 1 FROM lesson_revisions WHERE lesson_id = ? LIMIT 1'
    );

    this.database.transaction(() => {
      for (const tutor of seed.tutors.values()) insertTutor.run(tutor.tutorId, tutor.name, tutor.phone);
      for (const lesson of seed.lessons) {
        insertLesson.run(lesson.lessonId, lesson.student);
        if (hasRevision.get(lesson.lessonId)) continue;
        const result = insertRevision.run(
          lesson.lessonId,
          lesson.date,
          lesson.startTime,
          lesson.durationMin,
          lesson.tutorId,
          lesson.roomId,
          lesson.status,
          lesson.cancelledAt,
          lesson.note
        );
        currentRevision.run(Number(result.lastInsertRowid), lesson.lessonId);
      }
    })();
  }

  cancel(lessonId: string, command: CancellationCommand, idempotencyKey: string): CancellationResult {
    if (!/^[A-Za-z0-9._:-]{8,100}$/.test(idempotencyKey)) {
      throw new ServiceError(400, 'invalid_idempotency_key', 'Idempotency-Key must contain 8 to 100 safe characters.');
    }
    const hash = requestHash(lessonId, command);

    const execute = this.database.transaction((): { revisionId: number; notificationId: number; replayed: boolean } => {
      const prior = this.database.prepare(
        'SELECT request_hash, revision_id, notification_id FROM idempotency_keys WHERE idempotency_key = ?'
      ).get(idempotencyKey) as IdempotencyRow | undefined;
      if (prior) {
        if (prior.request_hash !== hash) {
          throw new ServiceError(409, 'idempotency_conflict', 'Idempotency-Key was already used for a different command.');
        }
        return { revisionId: prior.revision_id, notificationId: prior.notification_id, replayed: true };
      }

      const lesson = this.currentLesson(lessonId);
      if (!lesson) throw new ServiceError(404, 'lesson_not_found', `Lesson ${lessonId} was not found.`);
      if (lesson.status === 'cancelled') {
        throw new ServiceError(409, 'already_cancelled', `Lesson ${lessonId} is already cancelled.`);
      }
      if (lesson.status === 'no_show') {
        throw new ServiceError(409, 'no_show_recorded', `Lesson ${lessonId} is already recorded as a no-show.`);
      }

      const policy = policyFor(lesson, command);
      const recordedAt = this.now();
      const previousRevision = this.database.prepare(
        'SELECT current_revision_id FROM lessons WHERE lesson_id = ?'
      ).pluck().get(lessonId) as number;
      const revision = this.database.prepare(`
        INSERT INTO lesson_revisions (
          lesson_id, version, date, start_time, duration_min, tutor_id, room_id, status,
          changed_at, recorded_at, changed_by, reason_code, note, after_cutoff, timing, lead_minutes,
          family_charge, tutor_pay, replaces_revision_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'cancelled', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        lessonId,
        lesson.version + 1,
        lesson.date,
        lesson.start_time,
        lesson.duration_min,
        lesson.tutor_id,
        lesson.room_id,
        command.cancelledAt,
        recordedAt,
        command.cancelledBy,
        command.reasonCode,
        command.note,
        policy.afterCommunicationCutoff ? 1 : 0,
        policy.timing,
        policy.leadMinutes,
        policy.familyCharge,
        policy.tutorPay,
        previousRevision
      );
      const revisionId = Number(revision.lastInsertRowid);
      this.database.prepare('UPDATE lessons SET current_revision_id = ? WHERE lesson_id = ?')
        .run(revisionId, lessonId);

      const notification = this.database.prepare(`
        INSERT INTO notification_outbox (
          lesson_id, revision_id, tutor_id, recipient_phone, message, status, created_at
        ) VALUES (?, ?, ?, ?, ?, 'pending', ?)
      `).run(
        lessonId,
        revisionId,
        lesson.tutor_id,
        lesson.phone,
        messageFor(lesson, command, policy),
        recordedAt
      );
      const notificationId = Number(notification.lastInsertRowid);
      this.database.prepare(`
        INSERT INTO idempotency_keys (idempotency_key, request_hash, revision_id, notification_id)
        VALUES (?, ?, ?, ?)
      `).run(idempotencyKey, hash, revisionId, notificationId);

      return { revisionId, notificationId, replayed: false };
    });

    const ids = execute();
    return this.result(ids.revisionId, ids.notificationId, ids.replayed);
  }

  private currentLesson(lessonId: string): CurrentLessonRow | undefined {
    return this.database.prepare(`
      SELECT l.lesson_id, l.student, r.tutor_id, t.name AS tutor_name, t.phone,
             r.date, r.start_time, r.duration_min, r.room_id, r.status, r.version
      FROM lessons l
      JOIN lesson_revisions r ON r.revision_id = l.current_revision_id
      JOIN tutors t ON t.tutor_id = r.tutor_id
      WHERE l.lesson_id = ?
    `).get(lessonId) as CurrentLessonRow | undefined;
  }

  private result(revisionId: number, notificationId: number, replayed: boolean): CancellationResult {
    const row = this.database.prepare(`
      SELECT r.lesson_id, r.version, r.changed_at AS cancelled_at, r.recorded_at,
             r.changed_by AS cancelled_by, r.reason_code, r.after_cutoff, r.timing, r.lead_minutes, r.family_charge, r.tutor_pay,
             n.notification_id, n.tutor_id, t.name AS tutor_name,
             n.status AS notification_status, n.attempts, n.message, n.last_error
      FROM lesson_revisions r
      JOIN notification_outbox n ON n.notification_id = ? AND n.revision_id = r.revision_id
      JOIN tutors t ON t.tutor_id = n.tutor_id
      WHERE r.revision_id = ?
    `).get(notificationId, revisionId) as ResultRow | undefined;
    if (!row) throw new Error('Cancellation result is missing');

    return {
      lessonId: row.lesson_id,
      status: 'cancelled',
      version: row.version,
      cancelledAt: row.cancelled_at,
      recordedAt: row.recorded_at,
      cancelledBy: row.cancelled_by,
      reasonCode: row.reason_code,
      afterCommunicationCutoff: row.after_cutoff === 1,
      policy: {
        timing: row.timing,
        leadMinutes: row.lead_minutes,
        familyCharge: row.family_charge,
        tutorPay: row.tutor_pay
      },
      notification: {
        notificationId: row.notification_id,
        tutorId: row.tutor_id,
        tutorName: row.tutor_name,
        status: row.notification_status,
        attempts: row.attempts,
        message: row.message,
        lastError: row.last_error
      },
      replayed
    };
  }

  notification(notificationId: number): NotificationPayload | undefined {
    const row = this.database.prepare(`
      SELECT n.notification_id, n.lesson_id, n.revision_id, n.tutor_id,
             t.name AS tutor_name, n.recipient_phone, n.message,
             n.status, n.attempts, n.last_error
      FROM notification_outbox n JOIN tutors t ON t.tutor_id = n.tutor_id
      WHERE n.notification_id = ?
    `).get(notificationId) as NotificationRow | undefined;
    if (!row) return undefined;
    return {
      notificationId: row.notification_id,
      lessonId: row.lesson_id,
      revisionId: row.revision_id,
      tutorId: row.tutor_id,
      tutorName: row.tutor_name,
      recipientPhone: row.recipient_phone,
      message: row.message
    };
  }

  async deliver(notificationId: number, sender?: NotificationSender): Promise<void> {
    if (!sender) return;
    const payload = this.notification(notificationId);
    if (!payload) throw new Error('Notification is missing');
    const claim = this.database.prepare(`
      UPDATE notification_outbox
      SET status = 'sending', attempts = attempts + 1, last_error = NULL
      WHERE notification_id = ? AND status IN ('pending', 'failed')
    `).run(notificationId);
    if (claim.changes === 0) return;

    try {
      await sender.send(payload);
      this.database.prepare(`
        UPDATE notification_outbox SET status = 'sent', sent_at = ?, last_error = NULL
        WHERE notification_id = ? AND status = 'sending'
      `).run(this.now(), notificationId);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Notification delivery failed';
      this.database.prepare(`
        UPDATE notification_outbox SET status = 'failed', last_error = ?
        WHERE notification_id = ? AND status = 'sending'
      `).run(message.slice(0, 500), notificationId);
    }
  }

  refresh(result: CancellationResult): CancellationResult {
    const revisionId = this.database.prepare(
      'SELECT revision_id FROM notification_outbox WHERE notification_id = ?'
    ).pluck().get(result.notification.notificationId) as number;
    return this.result(revisionId, result.notification.notificationId, result.replayed);
  }

  getLesson(lessonId: string): unknown | undefined {
    const lesson = this.currentLesson(lessonId);
    if (!lesson) return undefined;
    const revisions = this.database.prepare(`
      SELECT revision_id AS revisionId, version, date, start_time AS startTime,
             duration_min AS durationMin, tutor_id AS tutorId, room_id AS roomId,
             status, changed_at AS changedAt, recorded_at AS recordedAt,
             changed_by AS changedBy, reason_code AS reasonCode, note, after_cutoff AS afterCommunicationCutoff,
             timing, lead_minutes AS leadMinutes, family_charge AS familyCharge,
             tutor_pay AS tutorPay, replaces_revision_id AS replacesRevisionId
      FROM lesson_revisions WHERE lesson_id = ? ORDER BY version
    `).all(lessonId);
    const notifications = this.database.prepare(`
      SELECT notification_id AS notificationId, revision_id AS revisionId,
             tutor_id AS tutorId, message, status, attempts, created_at AS createdAt,
             sent_at AS sentAt, last_error AS lastError
      FROM notification_outbox WHERE lesson_id = ? ORDER BY notification_id
    `).all(lessonId);
    return {
      lessonId: lesson.lesson_id,
      student: lesson.student,
      currentStatus: lesson.status,
      currentVersion: lesson.version,
      revisions,
      notifications
    };
  }

  async deliverOutstanding(sender: NotificationSender): Promise<void> {
    const ids = this.database.prepare(`
      SELECT notification_id FROM notification_outbox
      WHERE status IN ('pending', 'failed') ORDER BY notification_id
    `).pluck().all() as number[];
    for (const id of ids) await this.deliver(id, sender);
  }

  close(): void {
    this.database.close();
  }
}

export class WebhookNotificationSender implements NotificationSender {
  constructor(private readonly url: string) {}

  async send(payload: NotificationPayload): Promise<void> {
    const response = await fetch(this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        notificationId: payload.notificationId,
        lessonId: payload.lessonId,
        tutor: {
          tutorId: payload.tutorId,
          name: payload.tutorName,
          phone: payload.recipientPhone
        },
        message: payload.message
      }),
      signal: AbortSignal.timeout(5_000)
    });
    if (!response.ok) throw new Error(`Notification webhook returned ${response.status}`);
  }
}
