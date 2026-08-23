import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { createConflictReport, findConflictIncidents, overlaps } from '../src/conflicts';
import {
  type Lesson,
  type LessonStatus,
  type Tutor,
  minutesToLocalTime,
  parseLocalDate
} from '../src/domain';
import { loadSeed } from '../src/seed';

const tutors: ReadonlyMap<string, Tutor> = new Map([
  ['T1', { tutorId: 'T1', name: 'Ngoc Anh', subject: 'Maths', phone: 'private-1' }],
  ['T2', { tutorId: 'T2', name: 'Pham Duc', subject: 'English', phone: 'private-2' }]
]);

interface LessonOptions {
  readonly lessonId: string;
  readonly startMinutes: number;
  readonly durationMin?: number;
  readonly tutorId?: string;
  readonly roomId?: string;
  readonly status?: LessonStatus;
  readonly note?: string | null;
}

function lesson({
  lessonId,
  startMinutes,
  durationMin = 60,
  tutorId = 'T1',
  roomId = 'R1',
  status = 'booked',
  note = null
}: LessonOptions): Lesson {
  const endMinutes = startMinutes + durationMin;
  return {
    lessonId,
    date: parseLocalDate('2026-03-04'),
    startMinutes,
    endMinutes,
    startTime: minutesToLocalTime(startMinutes),
    endTime: minutesToLocalTime(endMinutes),
    durationMin,
    student: `Student ${lessonId}`,
    tutorId,
    roomId,
    status,
    cancelledAt: status === 'cancelled' ? '2026-03-04T08:00:00+07:00' : null,
    note
  };
}

const reportFor = (lessons: readonly Lesson[]) =>
  createConflictReport(lessons, tutors, parseLocalDate('2026-03-04'));

test('detects exact, partial, and contained overlaps but permits adjacency', () => {
  const base = lesson({ lessonId: 'A', startMinutes: 540, durationMin: 120 });
  const exact = lesson({ lessonId: 'B', startMinutes: 540, durationMin: 120, roomId: 'R2' });
  const partial = lesson({ lessonId: 'C', startMinutes: 600, durationMin: 120, roomId: 'R3' });
  const contained = lesson({ lessonId: 'D', startMinutes: 570, durationMin: 30, roomId: 'R4' });
  const adjacent = lesson({ lessonId: 'E', startMinutes: 660, durationMin: 30, roomId: 'R5' });

  assert.equal(overlaps(base, exact), true);
  assert.equal(overlaps(base, partial), true);
  assert.equal(overlaps(base, contained), true);
  assert.equal(overlaps(base, adjacent), false);
  assert.deepEqual(
    reportFor([base, adjacent]).incidents,
    []
  );
});

test('groups tutor and room collisions into one incident', () => {
  const first = lesson({ lessonId: 'A', startMinutes: 540, durationMin: 120 });
  const second = lesson({ lessonId: 'B', startMinutes: 600, durationMin: 30 });
  const report = reportFor([first, second]);

  assert.equal(report.incidentCount, 1);
  assert.deepEqual(report.incidents[0]?.resources, [
    { type: 'tutor', id: 'T1', name: 'Ngoc Anh' },
    { type: 'room', id: 'R1' }
  ]);
  assert.deepEqual(report.incidents[0]?.overlap, { start: '10:00', end: '10:30' });
});

test('reports tutor-only and room-only incidents independently', () => {
  const first = lesson({ lessonId: 'A', startMinutes: 540, durationMin: 120, tutorId: 'T1', roomId: 'R1' });
  const sameTutor = lesson({ lessonId: 'B', startMinutes: 600, durationMin: 30, tutorId: 'T1', roomId: 'R2' });
  const sameRoom = lesson({ lessonId: 'C', startMinutes: 630, durationMin: 90, tutorId: 'T2', roomId: 'R1' });
  const report = reportFor([first, sameTutor, sameRoom]);

  assert.deepEqual(report.incidents.map((incident) => [incident.lessonIds, incident.resources]), [
    [['A', 'B'], [{ type: 'tutor', id: 'T1', name: 'Ngoc Anh' }]],
    [['A', 'C'], [{ type: 'room', id: 'R1' }]]
  ]);
});

test('cancelled lessons release capacity while no-shows retain it', () => {
  const occupied = lesson({ lessonId: 'A', startMinutes: 540 });
  const cancelled = lesson({ lessonId: 'B', startMinutes: 540, status: 'cancelled' });
  const noShow = lesson({ lessonId: 'C', startMinutes: 540, status: 'no_show' });

  assert.equal(reportFor([occupied, cancelled]).incidentCount, 0);
  assert.equal(reportFor([occupied, noShow]).incidentCount, 1);
});

test('canonical pair generation is deterministic for shuffled input', () => {
  const first = lesson({ lessonId: 'Z', startMinutes: 540 });
  const second = lesson({ lessonId: 'A', startMinutes: 540 });
  const third = lesson({ lessonId: 'M', startMinutes: 570 });
  const date = parseLocalDate('2026-03-04');

  const forward = findConflictIncidents([first, second, third], tutors, date);
  const shuffled = findConflictIncidents([third, first, second], tutors, date);
  assert.deepEqual(shuffled, forward);
  assert.deepEqual(forward.map((incident) => incident.lessonIds), [
    ['A', 'M'],
    ['A', 'Z'],
    ['M', 'Z']
  ]);
});

test('whole-seed regression has exactly the known grouped incidents', () => {
  const seed = loadSeed();
  const allDates = [...new Set(seed.lessons.map((item) => item.date))].sort();
  const actual = allDates.flatMap((date) =>
    findConflictIncidents(seed.lessons, seed.tutors, date).map((incident) => ({
      date: incident.date,
      lessonIds: incident.lessonIds,
      resources: incident.resources.map((resource) => [resource.type, resource.id]),
      notes: incident.lessons.map((item) => item.note)
    }))
  );

  assert.deepEqual(actual, [
    {
      date: '2026-03-04',
      lessonIds: ['L009', 'L010'],
      resources: [['tutor', 'T1'], ['room', 'R1']],
      notes: ['exam pair - half price', 'exam pair - half price']
    },
    {
      date: '2026-03-10',
      lessonIds: ['L033', 'L034'],
      resources: [['tutor', 'T1']],
      notes: [null, null]
    }
  ]);
});
