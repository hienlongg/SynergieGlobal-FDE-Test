declare const localDateBrand: unique symbol;
declare const localTimeBrand: unique symbol;

export type LocalDate = string & { readonly [localDateBrand]: true };
export type LocalTime = string & { readonly [localTimeBrand]: true };

export const LESSON_STATUSES = ['booked', 'cancelled', 'no_show'] as const;
export type LessonStatus = (typeof LESSON_STATUSES)[number];

export interface Tutor {
  readonly tutorId: string;
  readonly name: string;
  readonly subject: string;
  readonly phone: string;
}

export interface Lesson {
  readonly lessonId: string;
  readonly date: LocalDate;
  readonly startTime: LocalTime;
  readonly startMinutes: number;
  readonly endTime: LocalTime;
  readonly endMinutes: number;
  readonly durationMin: number;
  readonly student: string;
  readonly tutorId: string;
  readonly roomId: string;
  readonly status: LessonStatus;
  readonly cancelledAt: string | null;
  readonly note: string | null;
}

export interface SeedData {
  readonly lessons: readonly Lesson[];
  readonly tutors: ReadonlyMap<string, Tutor>;
}

export function parseLocalDate(value: string): LocalDate {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new Error('date must be YYYY-MM-DD');

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12) throw new Error('date must be a real Gregorian date');

  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysByMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;
  const maximumDay = daysByMonth[month - 1];
  if (maximumDay === undefined || day < 1 || day > maximumDay) {
    throw new Error('date must be a real Gregorian date');
  }

  return value as LocalDate;
}

export function parseLocalTime(value: string, label = 'time'): LocalTime {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) {
    throw new Error(`${label} must be a 24-hour HH:MM value`);
  }
  return value as LocalTime;
}

export function parseOffsetDateTime(value: string, label = 'timestamp'): string {
  const format = /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;
  if (!format.test(value)) {
    throw new Error(`${label} must be an ISO timestamp with an explicit offset`);
  }
  parseLocalDate(value.slice(0, 10));
  if (!Number.isFinite(Date.parse(value))) {
    throw new Error(`${label} must be a valid timestamp`);
  }
  return value;
}

export function localTimeToMinutes(value: LocalTime): number {
  const [hoursText, minutesText] = value.split(':');
  return Number(hoursText) * 60 + Number(minutesText);
}

export function minutesToLocalTime(minutes: number): LocalTime {
  if (!Number.isInteger(minutes) || minutes < 0 || minutes >= 24 * 60) {
    throw new Error('lesson must end before midnight');
  }
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return `${String(hours).padStart(2, '0')}:${String(remainder).padStart(2, '0')}` as LocalTime;
}
