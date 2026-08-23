import {
  type ConflictIncident,
  type ConflictReport,
  type ConflictResource,
  type Lesson,
  type LessonSummary,
  type LocalDate,
  type TimeRange,
  type Tutor,
  minutesToLocalTime
} from './domain';

const CHECKS_APPLIED: ConflictReport['checksApplied'] = ['tutor-overlap', 'room-overlap'];
const CHECKS_DEFERRED: ConflictReport['checksDeferred'] = ['student-overlap', 'daily-cap', 'operating-day'];

export const overlaps = (first: TimeRange, second: TimeRange): boolean =>
  first.startMinutes < second.endMinutes && second.startMinutes < first.endMinutes;

export const isOccupying = (lesson: Lesson): boolean => lesson.status !== 'cancelled';

function summarizeLesson(lesson: Lesson): LessonSummary {
  return {
    lessonId: lesson.lessonId,
    student: lesson.student,
    tutorId: lesson.tutorId,
    roomId: lesson.roomId,
    status: lesson.status,
    interval: `${lesson.startTime}-${lesson.endTime}`,
    note: lesson.note
  };
}

function canonicalLessons(first: Lesson, second: Lesson): readonly [Lesson, Lesson] {
  return first.lessonId.localeCompare(second.lessonId) <= 0 ? [first, second] : [second, first];
}

function sharedResources(
  first: Lesson,
  second: Lesson,
  tutors: ReadonlyMap<string, Tutor>
): readonly ConflictResource[] {
  const resources: ConflictResource[] = [];

  if (first.tutorId === second.tutorId) {
    const tutor = tutors.get(first.tutorId);
    if (!tutor) throw new Error(`Unknown tutor ${first.tutorId}`);
    resources.push({ type: 'tutor', id: tutor.tutorId, name: tutor.name });
  }
  if (first.roomId === second.roomId) {
    resources.push({ type: 'room', id: first.roomId });
  }

  return resources;
}

function incidentForPair(
  first: Lesson,
  second: Lesson,
  tutors: ReadonlyMap<string, Tutor>,
  date: LocalDate
): ConflictIncident | null {
  if (!overlaps(first, second)) return null;

  const resources = sharedResources(first, second, tutors);
  if (resources.length === 0) return null;

  const [canonicalFirst, canonicalSecond] = canonicalLessons(first, second);
  return {
    lessonIds: [canonicalFirst.lessonId, canonicalSecond.lessonId],
    date,
    overlap: {
      start: minutesToLocalTime(Math.max(first.startMinutes, second.startMinutes)),
      end: minutesToLocalTime(Math.min(first.endMinutes, second.endMinutes))
    },
    resources,
    lessons: [summarizeLesson(canonicalFirst), summarizeLesson(canonicalSecond)]
  };
}

export const findConflictIncidents = (
  lessons: readonly Lesson[],
  tutors: ReadonlyMap<string, Tutor>,
  date: LocalDate
): readonly ConflictIncident[] => {
  const scheduled = lessons
    .filter((lesson) => lesson.date === date && isOccupying(lesson))
    .sort((first, second) =>
      first.startMinutes - second.startMinutes || first.lessonId.localeCompare(second.lessonId)
    );
  const incidents: ConflictIncident[] = [];

  for (let firstIndex = 0; firstIndex < scheduled.length; firstIndex += 1) {
    const first = scheduled[firstIndex];
    if (!first) continue;

    for (let secondIndex = firstIndex + 1; secondIndex < scheduled.length; secondIndex += 1) {
      const second = scheduled[secondIndex];
      if (!second) continue;
      if (second.startMinutes >= first.endMinutes) break;

      const incident = incidentForPair(first, second, tutors, date);
      if (incident) incidents.push(incident);
    }
  }

  return incidents.sort((first, second) =>
    first.lessonIds[0].localeCompare(second.lessonIds[0]) ||
    first.lessonIds[1].localeCompare(second.lessonIds[1]) ||
    first.overlap.start.localeCompare(second.overlap.start)
  );
};

export const createConflictReport = (
  lessons: readonly Lesson[],
  tutors: ReadonlyMap<string, Tutor>,
  date: LocalDate
): ConflictReport => {
  const incidents = findConflictIncidents(lessons, tutors, date);
  return {
    date,
    checksApplied: CHECKS_APPLIED,
    checksDeferred: CHECKS_DEFERRED,
    incidentCount: incidents.length,
    incidents
  };
};
