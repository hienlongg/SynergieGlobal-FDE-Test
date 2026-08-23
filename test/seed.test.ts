import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { parseLocalDate } from '../src/domain';
import { loadSeed, parseCsv } from '../src/seed';

const TUTORS = 'tutor_id,tutor_name,subject,phone\nT1,Ngoc Anh,Maths,090xxx1122\n';
const LESSON_HEADER = 'lesson_id,date,start_time,duration_min,student,tutor_id,room,status,cancelled_at,note';
const VALID_LESSON = 'L001,2026-03-03,09:00,60,Le Minh Chau,T1,R1,booked,,';

function withFixture(tutorsCsv: string, lessonsCsv: string, run: (root: string) => void): void {
  const root = mkdtempSync(path.join(tmpdir(), 'conflict-report-'));
  try {
    writeFileSync(path.join(root, 'tutors.csv'), tutorsCsv);
    writeFileSync(path.join(root, 'lessons_export.csv'), lessonsCsv);
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('LocalDate parser validates real Gregorian dates without bounding the seed range', () => {
  assert.equal(parseLocalDate('2024-02-29'), '2024-02-29');
  assert.equal(parseLocalDate('2035-12-31'), '2035-12-31');

  for (const invalid of ['2026-02-30', '2025-02-29', '2026-04-31', '2026-00-10', '2026-13-01', '2026-3-04', '0000-01-01']) {
    assert.throws(() => parseLocalDate(invalid));
  }
});

test('CSV state machine handles quoted commas, escaped quotes, quoted newlines, and CRLF', () => {
  const document = parseCsv('id,note\r\n1,"comma, here"\r\n2,"said ""hello"""\r\n3,"line one\r\nline two"\r\n');
  assert.deepEqual(document, {
    headers: ['id', 'note'],
    records: [
      { id: '1', note: 'comma, here' },
      { id: '2', note: 'said "hello"' },
      { id: '3', note: 'line one\r\nline two' }
    ]
  });
});

test('seed loader accepts the expected export', () => {
  withFixture(TUTORS, `${LESSON_HEADER}\n${VALID_LESSON}\n`, (root) => {
    const seed = loadSeed(root);
    assert.equal(seed.tutors.size, 1);
    assert.equal(seed.lessons.length, 1);
    assert.equal(seed.tutors.get('T1')?.phone, '090xxx1122');
  });
});

test('seed loader rejects missing or wrong headers', async (t) => {
  await t.test('missing lesson header', () => {
    withFixture(TUTORS, '', (root) => {
      assert.throws(() => loadSeed(root), /lessons_export\.csv headers/);
    });
  });
  await t.test('wrong tutor header', () => {
    withFixture('id,name\nT1,Ngoc Anh\n', `${LESSON_HEADER}\n${VALID_LESSON}\n`, (root) => {
      assert.throws(() => loadSeed(root), /tutors\.csv headers/);
    });
  });
});

test('seed loader rejects malformed rows and domain values', async (t) => {
  await t.test('wrong column count', () => {
    withFixture(TUTORS, `${LESSON_HEADER}\nL001,2026-03-03\n`, (root) => {
      assert.throws(() => loadSeed(root), /has 2 fields; expected 10/);
    });
  });
  await t.test('unknown tutor', () => {
    const row = VALID_LESSON.replace(',T1,R1,', ',T9,R1,');
    withFixture(TUTORS, `${LESSON_HEADER}\n${row}\n`, (root) => {
      assert.throws(() => loadSeed(root), /Unknown tutor T9/);
    });
  });
  await t.test('invalid status', () => {
    const row = VALID_LESSON.replace(',booked,,', ',pending,,');
    withFixture(TUTORS, `${LESSON_HEADER}\n${row}\n`, (root) => {
      assert.throws(() => loadSeed(root), /Invalid status/);
    });
  });
  await t.test('invalid time', () => {
    const row = VALID_LESSON.replace(',09:00,', ',25:00,');
    withFixture(TUTORS, `${LESSON_HEADER}\n${row}\n`, (root) => {
      assert.throws(() => loadSeed(root), /24-hour HH:MM/);
    });
  });
  await t.test('impossible lesson date', () => {
    const row = VALID_LESSON.replace(',2026-03-03,', ',2026-02-30,');
    withFixture(TUTORS, `${LESSON_HEADER}\n${row}\n`, (root) => {
      assert.throws(() => loadSeed(root), /real Gregorian date/);
    });
  });
});
