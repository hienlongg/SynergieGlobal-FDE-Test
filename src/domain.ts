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

export interface TimeRange {
  readonly startMinutes: number;
  readonly endMinutes: number;
}

export interface LessonSummary {
  readonly lessonId: string;
  readonly student: string;
  readonly tutorId: string;
  readonly roomId: string;
  readonly status: LessonStatus;
  readonly interval: string;
  readonly note: string | null;
}

export interface TutorConflictResource {
  readonly type: 'tutor';
  readonly id: string;
  readonly name: string;
}

export interface RoomConflictResource {
  readonly type: 'room';
  readonly id: string;
}

export type ConflictResource = TutorConflictResource | RoomConflictResource;

export interface ConflictIncident {
  readonly lessonIds: readonly [string, string];
  readonly date: LocalDate;
  readonly overlap: {
    readonly start: LocalTime;
    readonly end: LocalTime;
  };
  readonly resources: readonly ConflictResource[];
  readonly lessons: readonly [LessonSummary, LessonSummary];
}

export interface ConflictReport {
  readonly date: LocalDate;
  readonly checksApplied: readonly ['tutor-overlap', 'room-overlap'];
  readonly checksDeferred: readonly ['student-overlap', 'daily-cap', 'operating-day'];
  readonly incidentCount: number;
  readonly incidents: readonly ConflictIncident[];
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

export function localTimeToMinutes(value: LocalTime): number {
  const [hoursText, minutesText] = value.split(':');
  const hours = Number(hoursText);
  const minutes = Number(minutesText);
  return hours * 60 + minutes;
}

export function minutesToLocalTime(minutes: number): LocalTime {
  if (!Number.isInteger(minutes) || minutes < 0 || minutes >= 24 * 60) {
    throw new Error('lesson must end before midnight');
  }
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return `${String(hours).padStart(2, '0')}:${String(remainder).padStart(2, '0')}` as LocalTime;
}
