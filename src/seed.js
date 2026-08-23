const fs = require('node:fs');
const path = require('node:path');

const LESSON_HEADERS = [
  'lesson_id', 'date', 'start_time', 'duration_min', 'student', 'tutor_id',
  'room', 'status', 'cancelled_at', 'note'
];
const TUTOR_HEADERS = ['tutor_id', 'tutor_name', 'subject', 'phone'];
const VALID_STATUSES = new Set(['booked', 'cancelled', 'no_show']);

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        field += character;
      }
    } else if (character === '"') {
      quoted = true;
    } else if (character === ',') {
      row.push(field);
      field = '';
    } else if (character === '\n') {
      row.push(field.replace(/\r$/, ''));
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += character;
    }
  }

  if (quoted) throw new Error('CSV contains an unterminated quoted field');
  if (field.length > 0 || row.length > 0) {
    row.push(field.replace(/\r$/, ''));
    rows.push(row);
  }

  const [headers, ...values] = rows;
  return values.filter((fields) => fields.some(Boolean)).map((fields, lineIndex) => {
    if (fields.length !== headers.length) {
      throw new Error(`CSV row ${lineIndex + 2} has ${fields.length} fields; expected ${headers.length}`);
    }
    return Object.fromEntries(headers.map((header, index) => [header, fields[index]]));
  });
}

function assertHeaders(records, expected, source) {
  const headers = records.length ? Object.keys(records[0]) : [];
  if (headers.join(',') !== expected.join(',')) {
    throw new Error(`${source} headers do not match the expected export format`);
  }
}

function timeToMinutes(time, label) {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) {
    throw new Error(`${label} must be a 24-hour HH:MM value`);
  }
  const [hours, minutes] = time.split(':').map(Number);
  return hours * 60 + minutes;
}

function minutesToTime(minutes) {
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return `${String(hours).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`;
}

function parseLesson(row, tutorIds) {
  if (!/^L\d+$/.test(row.lesson_id)) throw new Error(`Invalid lesson id: ${row.lesson_id}`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(row.date)) throw new Error(`Invalid lesson date for ${row.lesson_id}`);
  if (!tutorIds.has(row.tutor_id)) throw new Error(`Unknown tutor ${row.tutor_id} on ${row.lesson_id}`);
  if (!VALID_STATUSES.has(row.status)) throw new Error(`Invalid status on ${row.lesson_id}`);

  const startMinutes = timeToMinutes(row.start_time, `Start time on ${row.lesson_id}`);
  const durationMin = Number(row.duration_min);
  if (!Number.isInteger(durationMin) || durationMin <= 0) throw new Error(`Invalid duration on ${row.lesson_id}`);

  return {
    lessonId: row.lesson_id,
    date: row.date,
    startTime: row.start_time,
    startMinutes,
    endMinutes: startMinutes + durationMin,
    endTime: minutesToTime(startMinutes + durationMin),
    durationMin,
    student: row.student,
    tutorId: row.tutor_id,
    roomId: row.room,
    status: row.status,
    cancelledAt: row.cancelled_at || null,
    note: row.note || null
  };
}

function loadSeed(rootDir = path.resolve(__dirname, '..')) {
  const tutorRows = parseCsv(fs.readFileSync(path.join(rootDir, 'tutors.csv'), 'utf8'));
  const lessonRows = parseCsv(fs.readFileSync(path.join(rootDir, 'lessons_export.csv'), 'utf8'));
  assertHeaders(tutorRows, TUTOR_HEADERS, 'tutors.csv');
  assertHeaders(lessonRows, LESSON_HEADERS, 'lessons_export.csv');

  const tutors = new Map(tutorRows.map((row) => [row.tutor_id, {
    tutorId: row.tutor_id,
    name: row.tutor_name,
    subject: row.subject,
    phone: row.phone
  }]));
  const lessons = lessonRows.map((row) => parseLesson(row, new Set(tutors.keys())));

  return { lessons, tutors };
}

module.exports = { loadSeed, minutesToTime, parseCsv, timeToMinutes };
