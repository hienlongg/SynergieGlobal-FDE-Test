function overlaps(first, second) {
  // Half-open intervals: a lesson ending at 10:00 does not overlap one starting at 10:00.
  return first.startMinutes < second.endMinutes && second.startMinutes < first.endMinutes;
}

function isOccupying(lesson) {
  // A cancellation releases its tutor and room. A no-show did occupy the scheduled slot.
  return lesson.status !== 'cancelled';
}

function lessonSummary(lesson) {
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

function conflict(resourceType, resourceId, first, second, tutors) {
  const startMinutes = Math.max(first.startMinutes, second.startMinutes);
  const endMinutes = Math.min(first.endMinutes, second.endMinutes);
  const result = {
    type: resourceType,
    resource: resourceType === 'tutor'
      ? { id: resourceId, name: tutors.get(resourceId)?.name ?? null }
      : { id: resourceId },
    interval: `${first.date}T${String(Math.floor(startMinutes / 60)).padStart(2, '0')}:${String(startMinutes % 60).padStart(2, '0')}-${String(Math.floor(endMinutes / 60)).padStart(2, '0')}:${String(endMinutes % 60).padStart(2, '0')}`,
    lessonIds: [first.lessonId, second.lessonId],
    lessons: [lessonSummary(first), lessonSummary(second)]
  };
  return result;
}

function findConflicts(lessons, tutors, date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('date must be YYYY-MM-DD');

  const scheduled = lessons
    .filter((lesson) => lesson.date === date && isOccupying(lesson))
    .sort((first, second) => first.startMinutes - second.startMinutes || first.lessonId.localeCompare(second.lessonId));
  const conflicts = [];

  for (let firstIndex = 0; firstIndex < scheduled.length; firstIndex += 1) {
    for (let secondIndex = firstIndex + 1; secondIndex < scheduled.length; secondIndex += 1) {
      const first = scheduled[firstIndex];
      const second = scheduled[secondIndex];
      if (second.startMinutes >= first.endMinutes) break;
      if (!overlaps(first, second)) continue;
      if (first.tutorId === second.tutorId) conflicts.push(conflict('tutor', first.tutorId, first, second, tutors));
      if (first.roomId === second.roomId) conflicts.push(conflict('room', first.roomId, first, second, tutors));
    }
  }

  return conflicts;
}

module.exports = { findConflicts, isOccupying, overlaps };
