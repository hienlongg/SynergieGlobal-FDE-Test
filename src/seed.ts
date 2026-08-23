import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  LESSON_STATUSES,
  type Lesson,
  type LessonStatus,
  type LocalTime,
  type SeedData,
  type Tutor,
  localTimeToMinutes,
  minutesToLocalTime,
  parseLocalDate,
  parseLocalTime,
  parseOffsetDateTime
} from './domain';

const LESSON_HEADERS = [
  'lesson_id', 'date', 'start_time', 'duration_min', 'student', 'tutor_id',
  'room', 'status', 'cancelled_at', 'note'
] as const;
const TUTOR_HEADERS = ['tutor_id', 'tutor_name', 'subject', 'phone'] as const;
const VALID_STATUSES = new Set<string>(LESSON_STATUSES);

type CsvRecord = Readonly<Record<string, string>>;

export interface CsvDocument {
  readonly headers: readonly string[];
  readonly records: readonly CsvRecord[];
}

export function parseCsv(text: string): CsvDocument {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let state: 'unquoted' | 'quoted' | 'after-quote' = 'unquoted';

  function finishField(): void {
    row.push(field);
    field = '';
    state = 'unquoted';
  }

  function finishRow(): void {
    finishField();
    rows.push(row);
    row = [];
  }

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];

    if (state === 'quoted') {
      if (character === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        state = 'after-quote';
      } else {
        field += character;
      }
      continue;
    }

    if (state === 'after-quote') {
      if (character === ',') {
        finishField();
      } else if (character === '\n') {
        finishRow();
      } else if (character === '\r') {
        if (text[index + 1] === '\n') index += 1;
        finishRow();
      } else {
        throw new Error('CSV contains characters after a closing quote');
      }
      continue;
    }

    if (character === '"') {
      if (field.length > 0) throw new Error('CSV contains a quote inside an unquoted field');
      state = 'quoted';
    } else if (character === ',') {
      finishField();
    } else if (character === '\n') {
      finishRow();
    } else if (character === '\r') {
      if (text[index + 1] === '\n') index += 1;
      finishRow();
    } else {
      field += character;
    }
  }

  if (state === 'quoted') throw new Error('CSV contains an unterminated quoted field');
  if (field.length > 0 || row.length > 0 || state === 'after-quote') finishRow();

  const headers = rows[0] ?? [];
  const records = rows.slice(1)
    .filter((fields) => !(fields.length === 1 && fields[0] === ''))
    .map((fields, rowIndex) => {
      if (fields.length !== headers.length) {
        throw new Error(`CSV row ${rowIndex + 2} has ${fields.length} fields; expected ${headers.length}`);
      }
      return Object.fromEntries(headers.map((header, index) => [header, fields[index] ?? '']));
    });

  return { headers, records };
}

function assertHeaders(actual: readonly string[], expected: readonly string[], source: string): void {
  if (actual.length !== expected.length || actual.some((header, index) => header !== expected[index])) {
    throw new Error(`${source} headers do not match the expected export format`);
  }
}

function required(row: CsvRecord, key: string, source: string): string {
  const value = row[key];
  if (value === undefined || value.length === 0) throw new Error(`Missing ${key} on ${source}`);
  return value;
}

export const timeToMinutes = (time: string, label: string): number =>
  localTimeToMinutes(parseLocalTime(time, label));

export const minutesToTime = (minutes: number): LocalTime => minutesToLocalTime(minutes);

function parseTutor(row: CsvRecord): Tutor {
  const tutorId = required(row, 'tutor_id', 'tutor row');
  return {
    tutorId,
    name: required(row, 'tutor_name', tutorId),
    subject: required(row, 'subject', tutorId),
    phone: required(row, 'phone', tutorId)
  };
}

function parseLesson(row: CsvRecord, tutorIds: ReadonlySet<string>): Lesson {
  const lessonId = required(row, 'lesson_id', 'lesson row');
  const tutorId = required(row, 'tutor_id', lessonId);
  const statusText = required(row, 'status', lessonId);

  if (!/^L\d+$/.test(lessonId)) throw new Error(`Invalid lesson id: ${lessonId}`);
  if (!tutorIds.has(tutorId)) throw new Error(`Unknown tutor ${tutorId} on ${lessonId}`);
  if (!VALID_STATUSES.has(statusText)) throw new Error(`Invalid status on ${lessonId}`);

  const date = parseLocalDate(required(row, 'date', lessonId));
  const startTime = parseLocalTime(required(row, 'start_time', lessonId), `Start time on ${lessonId}`);
  const startMinutes = localTimeToMinutes(startTime);
  const durationText = required(row, 'duration_min', lessonId);
  if (!/^\d+$/.test(durationText)) throw new Error(`Invalid duration on ${lessonId}`);
  const durationMin = Number(durationText);
  if (!Number.isSafeInteger(durationMin) || durationMin <= 0) throw new Error(`Invalid duration on ${lessonId}`);

  const cancelledAt = row.cancelled_at || null;
  if (statusText === 'cancelled' && !cancelledAt) {
    throw new Error(`Missing cancelled_at on ${lessonId}`);
  }
  if (statusText !== 'cancelled' && cancelledAt) {
    throw new Error(`Unexpected cancelled_at on ${lessonId}`);
  }
  if (cancelledAt) {
    try {
      parseOffsetDateTime(cancelledAt, 'cancelled_at');
    } catch {
      throw new Error(`Invalid cancelled_at on ${lessonId}`);
    }
  }

  const endMinutes = startMinutes + durationMin;
  const endTime = minutesToLocalTime(endMinutes);
  return {
    lessonId,
    date,
    startTime,
    startMinutes,
    endMinutes,
    endTime,
    durationMin,
    student: required(row, 'student', lessonId),
    tutorId,
    roomId: required(row, 'room', lessonId),
    status: statusText as LessonStatus,
    cancelledAt,
    note: row.note || null
  };
}

function uniqueMap<T>(items: readonly T[], key: (item: T) => string, label: string): Map<string, T> {
  const result = new Map<string, T>();
  for (const item of items) {
    const id = key(item);
    if (result.has(id)) throw new Error(`Duplicate ${label}: ${id}`);
    result.set(id, item);
  }
  return result;
}

export const loadSeed = (rootDir = path.resolve(__dirname, '..', '..')): SeedData => {
  const tutorDocument = parseCsv(readFileSync(path.join(rootDir, 'tutors.csv'), 'utf8'));
  const lessonDocument = parseCsv(readFileSync(path.join(rootDir, 'lessons_export.csv'), 'utf8'));
  assertHeaders(tutorDocument.headers, TUTOR_HEADERS, 'tutors.csv');
  assertHeaders(lessonDocument.headers, LESSON_HEADERS, 'lessons_export.csv');

  const tutors = uniqueMap(tutorDocument.records.map(parseTutor), (tutor) => tutor.tutorId, 'tutor id');
  const tutorIds = new Set(tutors.keys());
  const lessons = lessonDocument.records.map((row) => parseLesson(row, tutorIds));
  uniqueMap(lessons, (lesson) => lesson.lessonId, 'lesson id');

  return { lessons, tutors };
};
