const test = require('node:test');
const assert = require('node:assert/strict');
const { findConflicts, overlaps } = require('../src/conflicts');
const { loadSeed } = require('../src/seed');

const tutors = new Map([['T1', { name: 'Ngoc Anh' }], ['T2', { name: 'Pham Duc' }]]);

function lesson({
  lessonId, startMinutes, durationMin = 60, tutorId = 'T1', roomId = 'R1', status = 'booked', note = null
}) {
  const hour = String(Math.floor(startMinutes / 60)).padStart(2, '0');
  const minute = String(startMinutes % 60).padStart(2, '0');
  const end = startMinutes + durationMin;
  return {
    lessonId,
    date: '2026-03-04',
    startMinutes,
    endMinutes: end,
    startTime: `${hour}:${minute}`,
    endTime: `${String(Math.floor(end / 60)).padStart(2, '0')}:${String(end % 60).padStart(2, '0')}`,
    durationMin,
    student: `Student ${lessonId}`,
    tutorId,
    roomId,
    status,
    note
  };
}

test('half-open intervals allow back-to-back lessons', () => {
  const first = lesson({ lessonId: 'A', startMinutes: 540 });
  const second = lesson({ lessonId: 'B', startMinutes: 600 });
  assert.equal(overlaps(first, second), false);
  assert.deepEqual(findConflicts([first, second], tutors, '2026-03-04'), []);
});

test('detects partial and contained overlaps independently for tutors and rooms', () => {
  const first = lesson({ lessonId: 'A', startMinutes: 540, durationMin: 120, tutorId: 'T1', roomId: 'R1' });
  const sameTutor = lesson({ lessonId: 'B', startMinutes: 600, durationMin: 30, tutorId: 'T1', roomId: 'R2' });
  const sameRoom = lesson({ lessonId: 'C', startMinutes: 630, durationMin: 90, tutorId: 'T2', roomId: 'R1' });
  const conflicts = findConflicts([first, sameTutor, sameRoom], tutors, '2026-03-04');

  assert.deepEqual(conflicts.map(({ type, resource, lessonIds }) => ({ type, resource: resource.id, lessonIds })), [
    { type: 'tutor', resource: 'T1', lessonIds: ['A', 'B'] },
    { type: 'room', resource: 'R1', lessonIds: ['A', 'C'] }
  ]);
});

test('cancelled lessons release capacity while no-shows retain it', () => {
  const occupied = lesson({ lessonId: 'A', startMinutes: 540 });
  const cancelled = lesson({ lessonId: 'B', startMinutes: 540, status: 'cancelled' });
  const noShow = lesson({ lessonId: 'C', startMinutes: 540, status: 'no_show' });

  assert.equal(findConflicts([occupied, cancelled], tutors, '2026-03-04').length, 0);
  assert.equal(findConflicts([occupied, noShow], tutors, '2026-03-04').length, 2);
});

test('seed regression: the exam pair remains visible as tutor and room conflicts', () => {
  const { lessons, tutors: seededTutors } = loadSeed();
  const conflicts = findConflicts(lessons, seededTutors, '2026-03-04');

  assert.deepEqual(conflicts.map((item) => [item.type, item.resource.id, item.lessonIds]), [
    ['tutor', 'T1', ['L009', 'L010']],
    ['room', 'R1', ['L009', 'L010']]
  ]);
  assert.match(conflicts[0].lessons[0].note, /exam pair/i);
});

test('seed regression: L033 and L034 are a tutor collision', () => {
  const { lessons, tutors: seededTutors } = loadSeed();
  const conflicts = findConflicts(lessons, seededTutors, '2026-03-10');

  assert.deepEqual(conflicts.map((item) => [item.type, item.resource.id, item.lessonIds]), [
    ['tutor', 'T1', ['L033', 'L034']]
  ]);
});
