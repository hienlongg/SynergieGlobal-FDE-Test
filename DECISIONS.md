# Decisions

## 1. Read the situation

### Questions for the owner

| Question | Why it matters / how the answer changes the product |
| --- | --- |
| Are exam pairs valid group sessions or prohibited exceptions? | If valid, they need an authorised exception type and a different capacity rule. Until then, this report deliberately shows `L009`/`L010` as conflicts rather than hiding them. |
| Can management override Monday closure, resource conflicts, or the daily tutor cap? | An override needs a reason, actor, and audit record. Without that policy, a validator must reject rather than invent an exception. |
| Does the six-booking cap include no-shows, cancellations, or group sessions? | It determines the active-booking query for a future load guard. This feature does not enforce the cap. |
| Must student overlap be prevented too? | The export includes a simultaneous student booking, but the brief only explicitly prohibits room and tutor overlap. It remains a reported business question, not an implemented rule. |
| Does the four-hour financial rule apply to tutor-caused cancellations? | A tutor-sickness cancellation should not automatically charge a family or pay that tutor. A cancellation feature needs an actor/reason policy. |
| What is captured at 16:00 and who can change it later? | A whole-day snapshot versus per-booking communicated revisions changes the audit model; a post-cut-off change may need an actor and a mandatory reason. |
| Are all six rooms stable named entities? | If yes, seed a room catalogue; if no, rooms should remain configurable. The supplied export only uses `R1`–`R3`. |

### Contradictions and assumptions

- The brief says one-to-one lessons and one lesson per tutor/room, while `L009` and `L010` deliberately share both resources and say `exam pair - half price`. It is treated as a hard-rule finding pending an owner decision.
- The centre is closed Monday, but `L032` is moved to Monday. The imported record is preserved as history, not normalised away.
- The six-booking maximum is exceeded by `T1` on 2026-03-06. This feature reports only interval conflicts, so it does not imply that seven is allowed.
- Cancellation releases a resource; a no-show retains its scheduled occupancy. This is the only cancellation semantic needed for conflict reporting.
- Intervals use half-open `[start, end)` bounds: a 09:00–10:00 lesson can sit immediately before a 10:00–11:00 lesson.
- Seed lesson times are local to Da Nang. `Asia/Ho_Chi_Minh` is the assumed timezone for later cut-off/cancellation work; this read-only report does not need a current clock.

## 2. Choose what to build

Candidate features considered: explainable tutor/room conflict report; atomic booking guard; daily schedule board; tomorrow-final change ledger; cancellation desk; tutor daily-cap guard; move-booking workflow; exception register; valid-slot finder; tutor notification outbox.

**Built feature: Explainable tutor and room conflict detection.**

It earns its place first because the owner names double booking as unacceptable, the supplied data proves the problem (`L009`/`L010` and `L033`/`L034`), and it can be demonstrated honestly from the export. A finalisation/change ledger is valuable for replacing receptionist knowledge, but the export contains no real prior revisions or communication events; inventing them would weaken the evidence.

What remains broken by this choice: new-booking prevention, tutor daily-cap enforcement, student overlap checks, cancellation charges/pay, exceptions/authorisation, the post-cut-off audit UI, notifications, and authentication.

## 3. Design and build

### Scope and model

The implemented report loads the CSV snapshot into these in-memory domain values:

- `Tutor(tutorId, name, subject, phone)`
- `Lesson(lessonId, date, startTime, durationMin, endTime, student, tutorId, roomId, status, cancelledAt, note)`

`lesson_id` and `tutor_id` are identifiers from the export. Student names are display data, not stable IDs. The import validates the stated CSV shape and tutor references but **does not reject historical rule violations**: those violations are what the feature must reveal.

For a future write model, keep `Booking` as the stable identity and append immutable `BookingRevision` rows:

```text
Booking(id, student_id, current_revision_id)
BookingRevision(id, booking_id, scheduled_start, duration_min, tutor_id,
                room_id, status, changed_at, changed_by, reason,
                communicated_at, replaces_revision_id)
```

A cancellation is a revision with a changed status, never a deletion. A move after a tutor has been told creates a revision that points at the prior communicated revision; the tutor’s previously communicated values remain reconstructable.

### Rule boundaries

This is deliberately a read-only import/report, so it detects rather than blocks legacy conflicts. Its code applies these scheduling semantics: compare tutor and room separately, use `[)` intervals, exclude `cancelled`, and retain `no_show` as occupying capacity.

For a future PostgreSQL write path, put IDs, foreign keys, allowed status, positive duration, and resource interval non-overlap constraints in the database. PostgreSQL GiST exclusion constraints over half-open time ranges are appropriate for tutor and room occupancy. Put policies that depend on actor/reason/authorisation (daily cap overrides, exam pairs, closure exceptions, pricing and communication cut-off) in a transaction-aware service layer. SQLite would need a transactional overlap query and an explicit concurrency limitation.

### API

Implemented:

```http
GET /conflicts?date=2026-03-04
```

It returns each resource conflict independently, including resource identity, the overlapping interval, both lesson IDs, students, statuses, and original notes. `L009`/`L010` consequently produce both a tutor and room finding and keep the exam-pair note visible.

Rejected:

```http
POST /bookings/check
```

A preflight check can become stale before a separate write. A future booking feature should use one atomic `POST /bookings` command that persists or returns `409 Conflict`; it is intentionally outside this feature.

## 4. Reflect

With another week, build the atomic booking/move command on top of persisted revisions, then add clear authorised exceptions, daily-cap policy, a finalised-tomorrow snapshot, and delivery/acknowledgement tracking. The present implementation is intentionally weak on persistence and concurrent writes because it reads a historical CSV snapshot only.

An AI assistant helped inspect the supplied assessment, identify the seed cases, draft this small Node implementation and its tests, and review edge cases. I reviewed the generated code, ran the test suite, and can explain the import and interval logic.

I rejected a change ledger as the one idea not to build now. It addresses the long-term knowledge risk, but the seed offers no authentic change history; implementing it first would require fabricated events and leave the demonstrated scheduling conflicts unresolved.
