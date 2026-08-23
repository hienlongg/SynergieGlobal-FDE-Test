# Decisions

## 1. Read the situation

### Questions for the owner

| Question | Why it matters / how the answer changes the product |
| --- | --- |
| Are exam pairs valid group sessions or prohibited exceptions? | If valid, they need an explicit authorised exception type and capacity rule. Until then, `L009`/`L010` remains a structural tutor-and-room collision; free text does not grant authorization. |
| Can management override closure, resource conflicts, or the daily tutor cap? | An override needs a rule type, reason, actor, and audit record. The report must not invent exceptions. |
| Does the daily cap include no-shows, cancellations, or group sessions? | It determines the active-booking query for a future load guard. This feature marks that check as deferred. |
| Must student overlap be prevented too? | The export includes a simultaneous student booking, but the brief explicitly calls out tutor and room occupancy. Student overlap remains visible in report scope as deferred. |
| Does the financial cancellation rule apply to tutor-caused cancellations? | Tutor sickness should not automatically charge a family or pay that tutor. A cancellation feature needs actor/reason policy. |
| What is captured at the communication cut-off, and who can change it later? | Whole-day snapshots and per-booking communication events imply different audit models. Either requires immutable prior values. |
| Are all rooms stable named entities? | If yes, seed a room catalogue and foreign key; otherwise rooms must remain configurable. The supplied export only demonstrates `R1`–`R3`. |

### Contradictions and assumptions

- The brief describes one-to-one lessons and exclusive tutors/rooms, while `L009` and `L010` share both and say `exam pair - half price`. The note is retained as evidence, not interpreted as authorization.
- The centre is described as closed on one day on which `L032` was moved. The row is preserved; operating-day compliance is explicitly deferred.
- The supplied rows demonstrate a tutor load above the stated cap. This report does not imply that load is allowed.
- A cancellation releases resources; a no-show retains scheduled occupancy.
- Intervals use half-open `[start, end)` bounds: 09:00–10:00 and 10:00–11:00 are adjacent, not overlapping.
- Lesson dates and times are local schedule values. This report needs no current clock or timezone conversion.
- Valid Gregorian dates are accepted even outside the imported week. No-record dates return an empty, scoped report.

## 2. Choose one feature

Candidate features considered: explainable tutor/room conflict report; atomic booking guard; daily schedule board; communicated-schedule change ledger; cancellation desk; tutor daily-cap guard; move-booking workflow; exception register; valid-slot finder; tutor notification outbox.

**Built feature: explainable tutor and room conflict detection.**

It earns its place because double booking is named as unacceptable, the supplied data proves it occurs, and a report can be demonstrated honestly from the snapshot. A change ledger is important but the export has no authentic revisions or communication events; inventing those would weaken the evidence.

What remains broken: new-booking prevention, student overlap checks, tutor-cap enforcement, operating-day policy, cancellation charges/pay, authorised exceptions, post-cut-off audit, notifications, authentication, and concurrent writes. The API lists the schedule checks it applied and deferred rather than implying broader compliance.

## 3. Implemented design

### Strict TypeScript boundary

The loader, detector, server, and tests share readonly types in `src/domain.ts`. `ConflictResource` is a discriminated union: tutor resources require a tutor name while room resources cannot receive tutor-shaped data.

`LocalDate` and `LocalTime` are branded only after runtime validation. `LocalDate` checks Gregorian month lengths and leap years; it is not merely a string alias or a regular-expression match. Compilation uses strict Node-aware settings, including `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, and `noEmitOnError`, while `"type": "commonjs"` produces CommonJS output.

Arrows are used for exported typed function values and callbacks. Named functions are retained for the CSV state machine and multi-stage parsing/report helpers where readable stack traces are more useful than syntax uniformity.

### Snapshot import model

The CSV snapshot becomes:

- `Tutor(tutorId, name, subject, phone)`
- `Lesson(lessonId, date, startTime, durationMin, endTime, student, tutorId, roomId, status, cancelledAt, note)`

The importer validates exact headers, row widths, CSV quoting, identifiers, tutor references, status, date, time, positive duration, same-day end time, and duplicate IDs. Historical scheduling rule violations are deliberately not rejected because revealing them is the feature.

Phone numbers remain in the in-memory import shape but never enter conflict resources or lesson summaries. Student names and notes do enter the report, so this unauthenticated demonstration must not be exposed publicly.

For a future write model, keep booking identity stable and append immutable revisions:

```text
Booking(id, student_id, current_revision_id)
BookingRevision(id, booking_id, scheduled_start, duration_min, tutor_id,
                room_id, status, changed_at, changed_by, reason,
                communicated_at, replaces_revision_id)
```

A cancellation is a revision, never deletion. A move after communication points to the prior revision so previously communicated values remain reconstructable. The current CSV has no such history, so this report is only a current-status snapshot.

### Rule boundaries

The code applies only these semantics:

1. filter to the requested date and statuses that occupy resources;
2. compare intervals with half-open bounds;
3. detect shared tutors and rooms;
4. generate a canonical lesson pair independent of input order;
5. group all colliding resources for that pair into one incident.

For a future PostgreSQL write path, IDs, foreign keys, allowed status, positive duration, and resource interval non-overlap belong in database constraints. GiST exclusion constraints over half-open ranges fit tutor and room occupancy. Policies depending on actor, reason, or authorization—caps, group exceptions, closure, pricing, and communication cut-off—belong in a transaction-aware service layer.

### Conflict Report v2

Implemented:

```http
GET /conflicts?date=2026-03-04
```

The response is:

```ts
interface ConflictIncident {
  readonly lessonIds: readonly [string, string];
  readonly date: LocalDate;
  readonly overlap: { readonly start: LocalTime; readonly end: LocalTime };
  readonly resources: readonly ConflictResource[];
  readonly lessons: readonly LessonSummary[];
}
```

At the top level it returns `checksApplied`, `checksDeferred`, `incidentCount`, and `incidents`. Consequently, `L009`/`L010` is one incident with tutor and room resources rather than two disconnected findings.

Rejected:

```http
POST /bookings/check
```

A preflight result can become stale before a separate write. A future booking feature should use one atomic `POST /bookings` command that either persists or returns `409 Conflict`.

## 4. Verification and reflection

Tests compile before execution and cover real-date validation, no-record dates, exact/partial/contained overlap, adjacency, lifecycle occupancy, grouped resources, canonical deterministic pairs, CSV quoting and malformed imports, exact whole-seed incidents, and in-process HTTP `200`/`400`/`404` plus content type. HTTP servers use port `0` and close in test cleanup.

With another week, build the atomic booking/move command on persisted revisions, then add explicit authorised exceptions, the daily-cap and operating-day policies, a finalised-tomorrow snapshot, and delivery/acknowledgement tracking.

AI assistance was used to inspect the supplied materials, propose the TypeScript structure, implement the conversion and v2 grouping, and identify edge cases. Before submission, the submitter should personally review the final code and only claim understanding or verification they can substantiate.

The deliberately rejected first feature was a change ledger. It addresses long-term receptionist knowledge risk, but the seed has no authentic history; building it first would require fabricated events while leaving demonstrated scheduling collisions unresolved.
