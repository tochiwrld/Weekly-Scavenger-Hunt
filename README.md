# Weekly Hunt

A private, mobile-first weekly scavenger hunt. Everything runs on Netlify:

- **Netlify Database** (Postgres) for users, challenges, submissions, points, audit log
- **Netlify Blobs** for the submitted photos (private, served only to the owner and the admin)
- **Netlify Functions** for the API, plus a scheduled function (every 15 min) for "new challenge" and "ending soon" alerts
- Plain HTML/CSS/JS front end, no build step

## Deploy

1. Put this folder in a GitHub repo and import it into Netlify (or run `npx netlify deploy --prod` from the CLI after `npx netlify init`).
2. On deploy, Netlify creates the database and applies `netlify/database/migrations/`. Nothing to run by hand for the hosted site.
3. In **Site settings > Environment variables**, add:

| Variable | Required | What it is |
|---|---|---|
| `SESSION_SECRET` | yes | Any long random string (32+ chars). Signs login cookies. |
| `ADMIN_EMAIL` | yes | The email that becomes the admin when it registers. |
| `RESEND_API_KEY` | optional | For email alerts (resend.com). Without it, alerts are in-app only. |
| `EMAIL_FROM` | optional | e.g. `Weekly Hunt <hunt@yourdomain.com>` (a domain verified in Resend). |
| `APP_URL` | optional | Your site URL, used for the button in emails. |

4. Redeploy, open the site, and **register with the `ADMIN_EMAIL` address first**, before sharing the link. That account becomes the admin. Everyone else who registers is a participant.

## Running locally

```
npm install
npx netlify login && npx netlify link
npx netlify database migrations apply   # local database only
npx netlify dev
```

## Running a week

1. **Admin > Hunts > New challenge**: name, description, rules, start and end (end defaults to start + 7 days).
2. Add items (name, instructions, difficulty, points, optional hint). Points are whatever you set; difficulty is just a label.
3. **Publish**. It goes live at the start time, participants get an alert, and the countdown starts.
4. **Admin > Review**: approve or reject (a reason is required to reject). Approving awards the points once, ever, per person per item.
5. At the end time submissions close automatically, the leaderboard freezes, and results move to Past hunts. You can still review pending submissions after the deadline, and the final results update.
6. Publish the next challenge. Only one challenge can run at a time (overlapping dates are refused). The leaderboard is per challenge, so it "resets" by design. There is no all-time board.

## How the rules are enforced (server side)

- **Points** are read from the item in the database at approval time, never from the browser.
- **One payment per item**: a unique database index allows only one approval per person per item, and only one pending-or-approved submission at a time. Rejected ones are kept as history.
- **Tie-break**: equal points are ranked by the submission time of the person's latest scoring submission (so slow admin review doesn't change who got there first). Manual adjustments use the time they were made.
- **Submissions** are immutable once sent; closed challenges refuse new ones.
- **Photos**: exactly 2 per submission, JPEG/PNG/WebP checked by file contents, 4 MB max each (the app also shrinks photos on the phone before upload).
- **Auth**: scrypt password hashing, signed HttpOnly cookies, origin check on writes, rate limits on register, login and submit.
- **Score adjustments** (People > Adjust score) are recorded in the audit log (Log tab) with previous score, new score, difference, reason, admin and time.

## Notes

- Dates in the admin form use the admin's phone/browser timezone. Set it to Lagos time and you're good.
- Email addresses are never sent to the browser for participants. Only the admin sees them (People tab).
- An approval can't be undone in the UI. If you approve by mistake, use Adjust score with a reason.
- Not built (by design, to keep the core loop tight): GPS checks, web push notifications, password reset email, all-time stats.
