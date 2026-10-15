# Manifest Esports — Static Website Demo

A responsive esports tournament website inspired by a modern business-management dashboard. Includes a public tournament listing and registration form plus a local demo admin dashboard.

## Features
- Responsive public landing page, tournament listings, search and filters
- Registration form for teams/captains
- Local admin dashboard with event metrics
- Create, edit, close/reopen, and delete tournaments
- Review registrations: approve, reject, reset status, or delete
- Demo leaderboard
- Brand/contact settings
- Export/import local JSON backup
- Data stored in browser `localStorage`

## Run locally
Open `index.html` in a browser, or run a static server from this folder:

```bash
python -m http.server 8080
```

Then open `http://localhost:8080`.

## Deploy to GitHub Pages
1. Create a GitHub repository, e.g. `manifest-esports`.
2. Upload `index.html`, `styles.css`, `app.js`, and this README to the repository root.
3. Go to **Settings → Pages**.
4. Under **Build and deployment**, choose **Deploy from a branch**, select `main` and `/ (root)`, then Save.
5. Wait for the published URL shown on the Pages settings screen.

## Demo admin login
- Username: `admin`
- Password: `manifest123`

This is a demonstration login only. The credentials are visible in the client-side JavaScript and are **not secure**.

## Important limitations
This is a static GitHub Pages demo. `localStorage` is browser-specific: data is not shared with other players, moderators, browsers, or devices. Public registrations are only saved in the browser that submits them, so the admin dashboard will not receive registrations made by other people. Do not use this for real tournaments, sensitive personal data, payments, or access control without a backend.

For a production system, replace the demo login and local storage with server-side authentication, a shared database, validation, rate limiting, backups, and secure file storage. Verify UPI payments against the receiving account/provider records rather than trusting uploaded screenshots.

## Registration and payment demo updates

- A team cannot register twice for the same tournament using the same team name or captain email while its earlier registration is not rejected. A transaction ID already used in this browser is also blocked.
- The supplied QR image is included as `upi-qr.png` and shown on the registration page. Players can scan it with their phone's UPI app/camera. Tapping the QR area or **Pay with UPI** attempts to open a UPI intent link.
- To enable one-tap UPI intent with the correct dynamically selected tournament fee, edit `app.js` and replace `YOUR_UPI_ID_HERE` with the UPI ID linked to your payment account. The intent amount is set from the tournament's configured entry fee. The supplied static QR image itself cannot have its encoded amount changed by the website; if it is a fixed-amount QR, generate a dynamic QR from the UPI ID to encode the amount. If it is a generic QR, the payer may need to enter the amount manually.
- Registration requires a transaction/UTR ID and a payment screenshot. Admins can view the submitted screenshot and review the transaction ID. Screenshot files are stored as data URLs in that browser's localStorage, with a 1.2 MB per-image limit for this demo.
- Use **Admin → Registrations → Export CSV statement** to download a CSV with timestamp, captain name, email, team name, tournament, entry fee, transaction ID, status and screenshot filename. CSV export is a manual download; a GitHub Pages site cannot silently write a CSV file to the repository or to a central server.

## Important limitations

This remains a static browser-local prototype. Browser-local registrations do not sync between players or devices, so duplicate checks and CSV records only cover the browser that holds the data. The demo login is not secure. Before real tournament/payment use, connect a backend database, real admin authentication and secure screenshot storage. Verify UPI payments against your actual bank/UPI statement; screenshots and transaction IDs alone do not confirm payment.

## Tournament operations upgrade

- Tournament cards display **Registered** after an approved registration exists for that tournament in the same browser's demo data. This prototype has no player account identity, so a live multi-user site needs server-side user/team identity to show the correct status per player.
- Tournament listings include a public Event Standings table.
- Admin → **Live ops** provides group-count and qualification settings, auto-allocation of approved teams, match-result entry (placement/kills/bonus), standings CSV export, and wildcard paid-entry requests. Entering results recalculates points and group qualification for teams that have already been allocated to groups. Admins can also run qualification manually.
- Wildcard entries are added as **Pending** and must be payment-verified and approved before they count as an approved team. The wildcard workflow records a transaction ID but this static demo does not independently confirm the transfer.
- Standings and allocations use browser-local storage. They are a functional prototype, not a live shared competition database.

## Requirements before public production

1. Add a backend API and shared database (e.g. PostgreSQL) so teams, transactions, matches, groups and scores sync across all visitors and devices.
2. Use a payment provider account with a server-side order/create-payment flow, signed webhook verification, and payment-status reconciliation. A normal UPI intent/QR cannot send transaction data directly back to this static website.
3. Protect admin and moderator routes with real authentication and role-based permissions; remove the demo `admin` / `manifest123` login before deployment.
4. Store payment screenshots privately in backend object storage, never in public static files or client localStorage.
5. Configure the game's actual scoring rules and tiebreakers before using auto-qualification for a live event. The demo currently sums placement + kills + bonus and breaks ties by kills then team name.


## Mid-tournament wildcard entry update

- Set an event status to **Live** in Admin → Tournament manager before creating wildcard entries. Regular public registration stays available only while the event is **Open**.
- Wildcard requests are now restricted to Live tournaments and still require an available slot and an unexpired wildcard deadline. The demo accepts a typed UTR only as a pending manual-review request; it never treats a UTR or screenshot as verified payment.
- With the Razorpay backend configured, a wildcard is approved only after a captured payment is verified. If the tournament is no longer Live, the deadline passes, or all slots are taken while checkout is in progress, the payment is recorded as **Verified - Review Required** / **Pending Review** for admin reconciliation or refund instead of silently granting a slot.
- Once approved, a wildcard entrant is assigned to the least-populated existing group when group allocation is already active. Unplayed wildcard teams are excluded from automatic qualification/elimination until they have a match result, so they are not immediately eliminated simply for joining late. In a knockout-only event they are labelled as a wildcard/late entry and require bracket placement by the organizer.
- To run the payment API, install dependencies inside `backend/`, copy `.env.example` to `.env`, set real Razorpay credentials, set a long random `ADMIN_API_TOKEN`, configure `ALLOWED_ORIGINS`, deploy the API to HTTPS, and configure the Razorpay webhook URL `/api/webhooks/razorpay` with the same webhook secret. Keep all secrets on the server, never in `app.js` or GitHub Pages.
- The website's current tournament manager and group/match data still run in browser `localStorage`. The backend is a payment/registration API starter and is not yet connected to every frontend operation; for multi-device live standings and secure admin control, the next production step is to move tournament status, group allocation, match results, wildcard slots and qualification into the backend database and call those APIs from the UI.


## Backend setup (UPI-only starting point)

This repository now includes a Node/Express API starter under `backend/`, a Render Blueprint (`render.yaml`), and `config.js` for the public site's API URL. The API supports a manual UPI registration submission endpoint, admin-only registration review endpoints, transaction CSV export, and optional Razorpay order/webhook routes for when a payment provider account is added.

### Important payment limitation

A UPI ID, UPI QR image, or `upi://pay` intent does not give a static website a trusted payment callback or direct access to the payer's bank transaction data. With your current UPI-only setup, submissions must remain **Pending bank verification** until an authorized moderator checks the UTR against the receiving bank/UPI statement. The backend deliberately does not auto-approve typed UTRs or screenshots. Automatic acceptance requires a supported payment provider with server-side verification/webhooks, or a bank/aggregator API that you are authorized to use.

### Deploying the API

1. Upload the existing `manifest-esports-website` folder to a GitHub repository. Keep `.env` files and database files out of GitHub.
2. Create a Render account and choose **New → Blueprint**, then select that GitHub repository. Render reads `render.yaml` and configures the Node API.
3. The Blueprint config uses a persistent disk at `/var/data` for SQLite. Confirm the selected Render plan supports persistent disks; if not, use a managed PostgreSQL database and migrate the API before real launch. Do not use an ephemeral filesystem for tournament/payment records.
4. In the API service's Environment settings, set `ALLOWED_ORIGINS` to the exact public website origin, for example `https://YOUR-USERNAME.github.io` (no trailing slash; add the repository path only if your configured origin requires it). Save and redeploy. `ADMIN_API_TOKEN` is generated by Render. Keep it private.
5. After deployment, open `https://YOUR-API.onrender.com/api/health`. A JSON response with `ok: true` confirms the API process is responding; `providerConfigured: false` is expected while no payment provider is configured.
6. Edit `config.js` and replace `http://localhost:4242` with your API's HTTPS base URL. Commit and push the change to your website host. Do not put API secrets in `config.js`.

### Current integration boundary

The API endpoints are prepared, but the existing public/admin UI is still a browser-local demo for tournament editing, groups, results, and standings. `window.MANIFEST_BACKEND_ENABLED` remains `false` on purpose; deploying the API alone does **not** connect those UI modules to shared data. Before public launch, the frontend registration form and admin dashboard must be migrated to these authenticated API endpoints, and tournament/group/match/qualification records must also move to the shared database. The current demo admin login (`admin` / `manifest123`) is not secure and must not be used as real authentication.

### Manual UPI API (for integration/testing)

`POST /api/registrations/upi` accepts JSON fields `tournamentId`, `teamName`, `captainName`, `email`, `utr`, and optional `wildcard: true`. It enforces tournament state, deadline, slot limits, and duplicate team/email/UTR checks, and saves the request as pending. `GET /api/admin/registrations`, `PATCH /api/admin/registrations/:id`, and `GET /api/admin/transactions.csv` require `Authorization: Bearer YOUR_ADMIN_API_TOKEN`. Approving a paid UPI entry requires a moderator to first reconcile the UTR and explicitly send `paymentStatus: "Verified"`; never mark it verified based only on a screenshot or user-provided text.
