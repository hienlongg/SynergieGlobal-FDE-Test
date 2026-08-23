# Bright Path conflict report

A deliberately small internal-tool slice for the Bright Path Learning Centre assessment: an **explainable tutor and room conflict report** over the supplied spreadsheet export.

It does not repair or reject invalid legacy rows. The export is evidence of what the centre actually operated, so the report keeps each original lesson and note visible.

## Run

Requires Node.js 20 or later. There are no runtime dependencies.

```bash
npm test
npm start
```

With the server running, request a seeded date:

```bash
curl "http://localhost:3000/conflicts?date=2026-03-04"
curl "http://localhost:3000/conflicts?date=2026-03-10"
```

`GET /health` is available for a simple health check. `GET /conflicts` requires a `date` in `YYYY-MM-DD` form; unknown dates return an empty report.

## What it finds

A conflict is emitted for every overlapping pair that shares a tutor or room. Lessons are half-open intervals (`[start, end)`), so back-to-back lessons are valid. Cancelled lessons release their resources; no-shows keep theirs occupied.

The seeded results include:

- **2026-03-04:** `L009` and `L010` overlap for tutor `T1` / Ngoc Anh and room `R1`. They produce one tutor finding and one room finding. The `exam pair - half price` notes are retained rather than silently treated as an exception.
- **2026-03-10:** `L033` and `L034` double-book tutor `T1` / Ngoc Anh in different rooms.

## Deliberate boundary

This is a read-only conflict-detection feature, not a booking system. It does not enforce the six-booking daily cap, student conflicts, cancellations/payment policy, authorised exceptions, schedule finalisation/history, notifications, authentication, or concurrent booking writes.

Those decisions, the proposed future revision model, database/code boundaries, and the rejected unsafe preflight API are documented in [`DECISIONS.md`](DECISIONS.md).

## Project layout

- `lessons_export.csv`, `tutors.csv` — supplied seed export
- `src/seed.js` — CSV import and domain normalisation
- `src/conflicts.js` — occupancy and overlap rules
- `src/server.js` — JSON HTTP endpoint
- `test/conflicts.test.js` — interval, lifecycle, and seed-regression tests
