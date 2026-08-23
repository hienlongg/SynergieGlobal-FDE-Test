# Bright Path cancellation desk

A deliberately small internal-tool slice for the Bright Path assessment: **cancel one existing lesson, calculate its policy impact, retain an immutable audit trail, and notify the assigned tutor**.

## Run

Requires Node.js 20, 22, 23, or 24. The SQLite native package and TypeScript compiler are pinned in `package-lock.json`.

```bash
npm ci
npm run typecheck
npm test
npm start
```

`npm start` listens on port `3000` and creates `data/bright-path.sqlite`. Set `PORT` or `DATA_DIR` to override those defaults. Delete that database to reset the demonstration from the supplied CSV export. For the assessment, server-recorded timestamps are pinned to `2026-03-10T12:00:00+07:00`; reported cancellation times come from commands inside the seed week.

Without `TUTOR_NOTIFICATION_WEBHOOK_URL`, cancellations still commit safely but their notifications remain `pending`. When configured, the service sends this JSON shape to the webhook and marks a `2xx` response as `sent`:

```json
{
  "notificationId": 1,
  "lessonId": "L012",
  "tutor": {
    "tutorId": "T2",
    "name": "Pham Duc",
    "phone": "090xxx3344"
  },
  "message": "CANCELLED: 2026-03-04 16:00, Vu Ha My, room R2. Reason: family request. Tutor pay remains full. Change made after the 16:00 schedule cut-off."
}
```

The webhook is an adapter boundary for the centre's eventual WhatsApp provider; the application never claims delivery when no adapter or a failing adapter is present. The receiver should de-duplicate retries by `notificationId`.

## Cancel a lesson

The example uses a pinned time inside the seed week. `L012` starts at 16:00, so a family cancellation at 13:00 is late.

Bash, Git Bash, or WSL:

```bash
curl -i -X POST "http://localhost:3000/lessons/L012/cancellation" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: cancel-L012-20260304-1300" \
  -d '{
    "cancelledAt": "2026-03-04T13:00:00+07:00",
    "cancelledBy": "family",
    "reasonCode": "family_request"
  }'
```

PowerShell:

```powershell
$body = @{
  cancelledAt = "2026-03-04T13:00:00+07:00"
  cancelledBy = "family"
  reasonCode = "family_request"
} | ConvertTo-Json

Invoke-RestMethod `
  -Method Post `
  -Uri "http://localhost:3000/lessons/L012/cancellation" `
  -ContentType "application/json" `
  -Headers @{ "Idempotency-Key" = "cancel-L012-20260304-1300" } `
  -Body $body
```

Key response fields:

```json
{
  "lessonId": "L012",
  "status": "cancelled",
  "version": 2,
  "cancelledAt": "2026-03-04T13:00:00+07:00",
  "recordedAt": "2026-03-10T12:00:00+07:00",
  "cancelledBy": "family",
  "reasonCode": "family_request",
  "afterCommunicationCutoff": true,
  "policy": {
    "timing": "late",
    "leadMinutes": 180,
    "familyCharge": "full",
    "tutorPay": "full"
  },
  "notification": {
    "notificationId": 1,
    "tutorId": "T2",
    "tutorName": "Pham Duc",
    "status": "pending",
    "attempts": 0
  },
  "replayed": false
}
```

The actual response also includes the notification message and any delivery error. With a successful webhook, status is `sent` and attempts is `1`.

`Idempotency-Key` is required. Repeating the same key and command returns the same revision and outbox notification. A failed or interrupted attempt can retry that same `notificationId`, so the webhook receiver must de-duplicate it. Reusing a key for different command content returns `409`.

## Inspect the audit trail

```bash
curl "http://localhost:3000/lessons/L012"
```

This returns the current state, all immutable revisions, and each notification's delivery state and attempt count. Supporting `GET /health` returns service health.

## Implemented policy

- Exactly four hours before start is free; less than four hours is late.
- A late family cancellation charges the family in full and pays the tutor in full.
- An on-time family cancellation has no family charge or tutor pay.
- A tutor cancellation has no family charge and no tutor pay; this documented assumption needs owner confirmation.
- Cancellation at or after start is rejected; the operator should record a no-show where appropriate.
- A change at or after 16:00 on the prior day is visibly marked post-cut-off; treating exactly 16:00 as inclusive is a documented assumption.
- A cancellation frees the room and tutor by advancing the lesson to a cancelled current revision.
- Notes remain internal; the structured reason, not free text, enters the tutor message.

The imported `L005` and `L017` cancellations remain honest snapshot revisions. The system does not infer actors, financial policy, or notification delivery from their notes.

## Failure behavior

The current lesson pointer, cancellation revision, notification outbox event, and idempotency record commit in one SQLite transaction. The reported `cancelledAt` drives policy, while separate server-generated `recordedAt` shows when the command entered the system. Notification delivery happens afterward. A failed webhook cannot undo or hide the cancellation; it records `failed`, the attempt count, and an error. Pending and failed events are attempted again when the service starts with a webhook configured.

This demonstration has no authentication. It contains synthetic student names and tutor phone numbers and must not be exposed publicly. Production also needs authorisation, encrypted transport, secret management, retention policy, and webhook authentication.

## Deliberate boundary

This is one cancellation workflow, not a complete scheduling product. It does not create or move bookings, detect conflicts, enforce the daily tutor cap or Monday closure, authorise exam pairs, contact families about released slots, or record tutor acknowledgement.

Open questions, prioritisation, schema decisions, database/code boundaries, and the rejected delete endpoint are in [`DECISIONS.md`](DECISIONS.md).

## Project layout

- `lessons_export.csv`, `tutors.csv` — supplied seed export
- `src/domain.ts` — validated schedule value types
- `src/seed.ts` — strict CSV import and normalisation
- `src/cancellations.ts` — SQLite schema, transaction, policy, idempotency, and notification outbox
- `src/server.ts` — HTTP command, audit endpoint, and webhook adapter wiring
- `test/*.test.ts` — policy boundaries, persistence, idempotency, delivery failure, import, and HTTP tests
- `data/` — generated SQLite database, not committed
