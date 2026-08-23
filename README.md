# Bright Path conflict report

A deliberately small internal-tool slice for the Bright Path Learning Centre assessment: an **explainable tutor and room conflict report** over the supplied spreadsheet export.

The report is a read-only **current-status snapshot** of the export. It is not a historical reconstruction and does not repair, reject, or silently authorise scheduling collisions found in legacy rows.

## Run

Requires Node.js 20 or later. There are no runtime dependencies; TypeScript and Node type definitions are development dependencies pinned in `package-lock.json`.

```bash
npm ci
npm run typecheck
npm test
npm start
```

`npm start` builds the project and listens on port `3000` by default. Set `PORT` to override it.

```bash
curl "http://localhost:3000/conflicts?date=2026-03-04"
curl "http://localhost:3000/conflicts?date=2026-03-10"
```

`GET /health` is available for a simple health check.

## HTTP contract

`GET /conflicts?date=YYYY-MM-DD` validates an actual Gregorian date. For example, `2026-02-30` returns `400`; a valid date outside the seed range returns `200` with an empty report.

A report has explicit scope metadata so an empty incident list cannot be mistaken for full schedule compliance:

```json
{
  "date": "2026-03-04",
  "checksApplied": ["tutor-overlap", "room-overlap"],
  "checksDeferred": ["student-overlap", "daily-cap", "operating-day"],
  "incidentCount": 1,
  "incidents": [
    {
      "lessonIds": ["L009", "L010"],
      "date": "2026-03-04",
      "overlap": { "start": "11:00", "end": "12:30" },
      "resources": [
        { "type": "tutor", "id": "T1", "name": "Ngoc Anh" },
        { "type": "room", "id": "R1" }
      ],
      "lessons": [
        {
          "lessonId": "L009",
          "student": "Tran Bao Long",
          "tutorId": "T1",
          "roomId": "R1",
          "status": "booked",
          "interval": "11:00-12:30",
          "note": "exam pair - half price"
        },
        {
          "lessonId": "L010",
          "student": "Nguyen Thi Ha",
          "tutorId": "T1",
          "roomId": "R1",
          "status": "booked",
          "interval": "11:00-12:30",
          "note": "exam pair - half price"
        }
      ]
    }
  ]
}
```

One incident represents one canonical lesson pair. If that pair collides on both tutor and room, both discriminated resources appear in the same incident.

All responses are JSON. Missing, malformed, and impossible dates return `400`; unknown routes return `404`.

## Detection rules

- Lessons use half-open intervals (`[start, end)`), so back-to-back lessons are valid.
- Cancelled lessons release their tutor and room.
- No-shows retain their scheduled occupancy.
- A shared tutor and a shared room are checked separately, then grouped by lesson pair.
- Input order does not affect incident or lesson-pair ordering.
- Free-text such as `exam pair - half price` is evidence, not authorization. The collision remains visible for owner review.

The whole seed produces exactly two incidents:

- **2026-03-04:** `L009` / `L010`, sharing tutor `T1` and room `R1`.
- **2026-03-10:** `L033` / `L034`, sharing tutor `T1` in different rooms.

## Data and security boundary

This demonstration endpoint has no authentication or authorization. Its lesson summaries expose synthetic student names and free-text notes, so it must not be deployed as a public service without access control and data-minimisation review.

Tutor phone numbers are loaded from `tutors.csv` because they are part of the supplied export shape, but they are never returned by the API. The report is a snapshot of current row status; because the export has no revision history, it cannot show what a tutor was told previously or reconstruct conflicts as of an earlier time.

## Deliberate boundary

This is conflict detection, not a booking system. It does not enforce student overlap, the daily tutor cap, operating days, cancellation/payment policy, authorised exceptions, schedule finalisation/history, notifications, authentication, or concurrent booking writes.

The questions, model boundary, future revision design, and rejected unsafe preflight API are documented in [`DECISIONS.md`](DECISIONS.md).

## Project layout

- `lessons_export.csv`, `tutors.csv` — supplied seed export
- `src/domain.ts` — shared readonly domain types and validated `LocalDate` / `LocalTime` parsers
- `src/seed.ts` — CSV state machine, export validation, and domain normalisation
- `src/conflicts.ts` — occupancy, overlap, canonical grouping, and report creation
- `src/server.ts` — JSON HTTP endpoint
- `test/*.test.ts` — domain, CSV, seed-regression, determinism, and in-process HTTP tests
- `dist/` — generated CommonJS output (not committed)
