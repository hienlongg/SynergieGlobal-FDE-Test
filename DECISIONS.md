# Decisions

## 1. Read the situation

### Questions for the owner

| Question | How the answer changes the build |
| --- | --- |
| Does the four-hour charge/pay rule apply only when a family cancels? | If tutor- or centre-caused cancellations use different pay rules, policy must branch on a structured actor rather than infer intent from notes. |
| What cancellation reasons may staff record, and who may see the note? | This determines the reason catalogue, validation, retention, and whether notes may enter tutor notifications. |
| Is WhatsApp the required delivery channel, and is delivery or acknowledgement the success measure? | It determines the notification adapter and whether a delivered/acknowledged state must block follow-up work. |
| At exactly four hours before the lesson, is cancellation free? | I read “up to 4 hours” as inclusive: exactly four hours is free. A different answer changes one policy boundary and its tests. |
| May Mai enter the original WhatsApp time later, and what evidence is required? | If yes, policy uses the reported `cancelledAt` while the server separately records `recordedAt`; retrospective entry then needs staff authorisation and audit review. |
| Who may correct a mistaken cancellation? | A correction should append a revision and a new notification; it must not edit or delete the cancellation history. The submitted API deliberately omits this command. |
| Are exam pairs authorised group lessons and must students also be protected from overlap? | The answer shapes the next booking/conflict feature, but does not change whether an existing lesson may be cancelled. |

### Contradictions and assumptions

- Cancellations are described as family actions, but `L017` is cancelled because the tutor is sick. I therefore require `cancelledBy` and apply the financial rule only to family cancellations.
- A family cancellation under four hours means full family charge and full tutor pay. An on-time family cancellation means neither. A tutor cancellation means neither; this needs owner confirmation.
- A cancellation at or after lesson start is rejected; a student who does not arrive must be recorded as a no-show instead.
- The 16:00 cut-off and four-hour rule are separate. A cancellation may be financially on time but still be a visible post-cut-off schedule change. I treat exactly 16:00 as post-cut-off because the schedule is final then; this needs owner confirmation.
- Schedule values use Da Nang time (`+07:00`, no daylight-saving change). The command requires an offset timestamp and tests use dates inside the seed week rather than the real clock.
- Free-text notes are optional and are retained in history, but notification text uses the structured reason only.
- Existing cancelled CSV rows are imported as one historical revision. Their actor, policy outcome, and delivery state are not invented from free text.
- The brief says one-to-one while `L009`/`L010` are an intentional exam pair, and it says Monday is closed while `L032` is on Monday. Those booking-policy contradictions are preserved and deferred.

## 2. Choose exactly one feature

| Candidate feature | Pain removed | Evidence and rule certainty | Timebox fit | Decision |
| --- | --- | --- | --- | --- |
| Cancellation desk | Stops cancellation edits and tutor messages becoming inconsistent. | Repeated by receptionist and tutors; four-hour and cut-off rules are mostly explicit. | Medium | **Build** as one end-to-end command. |
| Atomic booking/move guard | Prevents the highest-severity student, tutor, and room collisions. | Strong pain, but student overlap and intentional exam-pair exceptions are unresolved. | Low | Wait for policy answers and write commands. |
| Conflict report | Makes existing collisions visible without interpreting them as authorised. | The export demonstrates collisions clearly. | High | Detection alone still lets the system create them. |
| Daily schedule board | Gives the owner a current day without scrolling. | Explicit request and easy to seed. | High | Visibility does not fix stale tutor communication. |
| Post-cut-off change ledger | Shows every correction after a tutor was told. | Strong pain, but the export has no authentic communication events. | Medium | Reuse the revision model after cancellation. |
| Tutor load guard | Prevents more than six active bookings per tutor per day. | Rule and seed violation are explicit. | High | Narrower and less frequently painful. |
| Exception register | Replaces notes with authorised exam-pair and override records. | The contradiction is clear; the intended approval rules are not. | Medium | Needs an owner-defined exception policy. |
| Open-slot follow-up | Helps refill capacity released by cancellations. | Mentioned as a manual task, but no waiting-list data is supplied. | Low | Depends on family preferences and contact policy. |

**Decision: build the cancellation desk with tutor notification.**

Cancellation is the strongest repeated daily pain: Mai calls it the worst part, tutors receive conflicting corrections, and two tutors travelled for lessons cancelled the night before. The export contains both a family cancellation and tutor sickness, so the ambiguity is real. This slice replaces a fragile edit-and-remember workflow with one command that records the decision and produces a trackable notification.

Conflict prevention is higher-severity when it occurs, but a safe guard belongs inside booking and move commands that this narrow tool does not yet have. Building those commands within the timebox would also require resolving student overlap and authorised exam-pair policy. Cancellation can deliver a complete vertical workflow over the existing schedule now.

What remains broken: bookings and moves can still conflict; the daily cap and Monday closure are not enforced; exam-pair exceptions are unstructured; open slots are not offered to families; notification acknowledgement is absent; access control is absent; and failed webhook delivery is retried only when the service restarts.

## 3. Design and implementation

### Data model

SQLite stores the operational state:

```text
Tutor(tutor_id, name, phone)
Lesson(lesson_id, student, current_revision_id)
LessonRevision(revision_id, lesson_id, version, date, start_time, duration_min,
               tutor_id, room_id, status, changed_at, recorded_at, changed_by,
               reason_code, note, after_cutoff, timing, lead_minutes, family_charge,
               tutor_pay, replaces_revision_id)
NotificationOutbox(notification_id, lesson_id, revision_id, tutor_id,
                   recipient_phone, message, status, attempts, created_at,
                   sent_at, last_error)
IdempotencyKey(key, request_hash, revision_id, notification_id)
```

A cancellation appends a `cancelled` revision and advances `Lesson.current_revision_id`; it never deletes the booked revision. The revision copies the scheduled values, so the exact cancelled slot remains reconstructable. `changed_at` is the reported cancellation time used for policy; server-generated `recorded_at` reveals when the command entered the system.

A future move uses the same shape: append a `booked` revision with changed schedule fields, point it to the replaced revision, then create a notification for that new revision. A notification references the precise revision the tutor was told about, including recipient, attempts, outcome, and error. Imported cancellations get no fabricated outbox row.

### Database and code boundaries

The database enforces foreign keys, allowed status/delivery values, positive duration, one version per lesson, one notification per revision, and one result per idempotency key. Cancellation revision, current pointer, outbox event, and idempotency record are written in one transaction. SQLite WAL mode and synchronous transactions serialize writes in this single-service deployment.

Code validates actor/reason combinations and offset timestamps, calculates the four-hour and prior-day 16:00 boundaries, rejects cancellation after lesson start, and creates privacy-limited notification text. These are business policies that need named tests and will change when the owner answers the open questions.

### API

Implemented command:

```http
POST /lessons/L012/cancellation
Content-Type: application/json
Idempotency-Key: cancel-L012-20260304-1300

{
  "cancelledAt": "2026-03-04T13:00:00+07:00",
  "cancelledBy": "family",
  "reasonCode": "family_request",
  "note": "optional internal detail"
}
```

It returns the immutable revision version, reported cancellation time, server-recorded time, late/on-time policy outcome, post-cut-off flag, and notification status. Repeating the same key and body returns the same revision and outbox event; a failed or interrupted delivery may retry that same `notificationId`, which the webhook must de-duplicate. Reusing the key with different content returns `409`.

`GET /lessons/:lessonId` is supporting audit visibility: it returns current state, all revisions, and aggregate notification delivery state. The service posts tutor ID, name, phone, and message to `TUTOR_NOTIFICATION_WEBHOOK_URL`. Cancellation remains committed if delivery fails, while the outbox records `failed`; unsent events are retried at startup. Without a configured webhook they remain `pending` rather than being falsely marked sent.

Rejected endpoint:

```http
DELETE /lessons/:lessonId
```

Deletion would erase the slot the tutor was told about, make charge/pay decisions unauditable, and make retries unsafe.

## 4. Reflection

With another week I would add authenticated staff identities, webhook retry with backoff and dead-letter visibility, tutor acknowledgement, then an atomic booking/move command with student/tutor/room conflict protection and explicit exam-pair exceptions.

The weakest part is notification transport: a generic webhook proves the durable hand-off but is not yet a production WhatsApp integration, and a failed send is not retried until restart. SQLite also assumes one service instance; a multi-instance deployment needs a database that supports safe outbox claiming.

AI assistance helped compare feature priorities, design the revision/outbox transaction, implement TypeScript and SQLite code, and identify idempotency and boundary tests. I reviewed the resulting command, schema, and tests and can explain the submitted paths.

I rejected “edit the CSV and send WhatsApp directly.” It looked smaller, but a crash between those actions would leave schedule and communication inconsistent, repeated requests could notify twice, and overwriting the row would destroy what the tutor had previously been told.
