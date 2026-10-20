# Tour Board Backend

A small Node.js + TypeScript API for the [Tour Board](https://github.com/xX0ZAK0Xx/Tour-Board)
app. It does the few jobs a phone can't do safely on its own:

- **Notifications**: verifies that a reported event really happened in
  Firestore, then writes inbox items and sends FCM push notifications to the
  right members, honouring their preferences. Each event is delivered once.
- **Retention**: a daily job deletes expired join codes, notifications older
  than 30 days, finished join requests older than 7 days, stale device tokens,
  and whole tours **30 days after their end date** (members get an inbox item
  and push a week before).
- **Place search**: proxies Google Places API (New) and Geocoding so the
  server key never ships in the app, with caching, per-user rate limits and
  monthly caps below Google's free tier.
- **Tour deletion**: lets a host delete an archived tour recursively.

Served on Render: `https://tour-board-backend.onrender.com`.

## API

All `/v1` routes need `Authorization: Bearer <Firebase ID token>`.

| Method & path | Purpose |
|---|---|
| `GET /health` | Liveness check (no auth) |
| `POST /v1/events` | `{tourId, type, refId?, subjectUid?}`. Types: `joinRequest`, `joinApproved`, `joinRejected`, `settlementSubmitted`, `settlementConfirmed`, `settlementDisputed`, `tourClosed`, `tourReopened`, `roleChanged`, `expenseAdded`, `expenseEdited`, `expenseDeleted`, `planAdded`, `planEdited` |
| `GET /v1/places/autocomplete?q=&lang=&session=&lat=&lng=` | Place suggestions |
| `GET /v1/places/details/:placeId?lang=&session=` | Address + coordinates (Essentials fields only) |
| `GET /v1/places/reverse?lat=&lng=&lang=` | Name/address for a dropped pin |
| `DELETE /v1/tours/:tourId` | Host deletes an archived tour |
| `POST /internal/jobs/cleanup` | Retention job; header `X-Cron-Secret` |

Errors are JSON `{ "error": "<code>" }`: `unauthenticated` (401),
`permission-denied` (403), `not-found` (404), `invalid-argument` (400),
`rate-limited` / `quota-exceeded` (429), `places-unavailable` (503).

Rate limits per user: events 60/min; place search 30/min and 300/day.
Google usage caps per calendar month (stored in `serverMeta/mapsUsage-YYYY-MM`):
9,000 each for autocomplete, place details and geocoding — below the free
10,000/month of each SKU (verified 2026-10-20). Place details request only
Essentials fields (`displayName` would bill as Pro).

## Data written by the server

| Path | Notes |
|---|---|
| `users/{uid}/inbox/{id}` | Inbox items (clients can no longer create them) |
| `serverEvents/{hash}` | Dedup records, expire after 30 days |
| `serverMeta/mapsUsage-YYYY-MM` | Monthly Google API counters |
| `tours/{id}.deletionWarningSentAt` | Set when the deletion warning was sent |

The app writes `users/{uid}/devices/{deviceId}` (`token`, `platform`,
`updatedAt`) and `users/{uid}.notificationPrefs` (`important`, `expenses`,
`plans`). Firestore rules and indexes live in the app repository.

## Setup on Render

1. **Firebase service account**: Firebase Console → Project settings →
   Service accounts → *Generate new private key*. Keep the JSON private.
2. **Google Maps server key**: Google Cloud Console → Credentials → *Create
   API key*, restricted to **Places API (New)** and **Geocoding API** only.
3. **Cron secret**: `openssl rand -hex 32`.
4. Render → *New → Blueprint* (uses `render.yaml`) or *New → Web Service*
   from this repo with build `npm ci --include=dev && npm run build` and start
   `npm start`. In *Environment* set:
   - `FIREBASE_SERVICE_ACCOUNT`: paste the JSON (or base64 of it)
   - `GOOGLE_MAPS_SERVER_KEY`
   - `CRON_SECRET`
5. GitHub → this repo → Settings → Secrets → Actions: add `CRON_SECRET`
   (same value). Optionally set the variable `BACKEND_URL` if the URL differs.
   The *Daily cleanup* workflow runs at 21:30 UTC (03:30 Dhaka) and can be
   run manually from the Actions tab.

Free-tier notes: Render's free instance sleeps after ~15 minutes idle, so the
first request after a pause takes up to a minute. The app sends events in
the background, so users never wait on it; push notifications may arrive
late after idle periods.

## Development

```bash
npm ci
cp .env.example .env      # fill in values
npm run dev               # http://localhost:8080
npm run typecheck && npm test
npm run test:emulator     # needs Java 17+ and firebase-tools
```
