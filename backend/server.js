import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import Razorpay from 'razorpay';
import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const port = Number(process.env.PORT || 4242);
const adminToken = process.env.ADMIN_API_TOKEN || '';
const keyId = process.env.RAZORPAY_KEY_ID || '';
const keySecret = process.env.RAZORPAY_KEY_SECRET || '';
const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET || '';
const razorpayReady = keyId.startsWith('rzp_') && Boolean(keySecret);
const razorpay = razorpayReady ? new Razorpay({ key_id: keyId, key_secret: keySecret }) : null;
const db = new Database(process.env.DATABASE_FILE || path.join(__dirname, 'manifest-esports.sqlite'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
CREATE TABLE IF NOT EXISTS tournaments (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, game TEXT NOT NULL, fee INTEGER NOT NULL DEFAULT 0,
 wildcard_fee INTEGER NOT NULL DEFAULT 0, slots INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'Coming Soon',
 structure TEXT NOT NULL DEFAULT 'groups', group_count INTEGER NOT NULL DEFAULT 4, qualify_per_group INTEGER NOT NULL DEFAULT 2,
 wildcard_deadline TEXT
);
CREATE TABLE IF NOT EXISTS registrations (
 id TEXT PRIMARY KEY, tournament_id TEXT NOT NULL REFERENCES tournaments(id), team_name TEXT NOT NULL,
 captain_name TEXT NOT NULL, email TEXT NOT NULL, is_wildcard INTEGER NOT NULL DEFAULT 0,
 amount_paise INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'Pending', payment_status TEXT NOT NULL DEFAULT 'Pending',
 payment_id TEXT UNIQUE, order_id TEXT UNIQUE, utr TEXT UNIQUE, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS payment_events (
 id INTEGER PRIMARY KEY AUTOINCREMENT, provider_event_id TEXT UNIQUE, event_type TEXT NOT NULL,
 payment_id TEXT, order_id TEXT, received_at TEXT NOT NULL
);
`);
// Backward-compatible migration for databases created by earlier project versions.
const registrationColumns = new Set(db.prepare('PRAGMA table_info(registrations)').all().map(column => column.name));
if (!registrationColumns.has('utr')) db.exec('ALTER TABLE registrations ADD COLUMN utr TEXT');
const tournamentCount = db.prepare('SELECT COUNT(*) AS n FROM tournaments').get().n;
if (!tournamentCount) {
  const seed = JSON.parse(fs.readFileSync(path.join(__dirname, 'seed-tournaments.json'), 'utf8'));
  const insert = db.prepare(`INSERT INTO tournaments (id,name,game,fee,wildcard_fee,slots,status,structure,group_count,qualify_per_group,wildcard_deadline)
    VALUES (@id,@name,@game,@fee,@wildcardFee,@slots,@status,@structure,@groupCount,@qualifyPerGroup,@wildcardDeadline)`);
  const tx = db.transaction(rows => rows.forEach(row => insert.run(row)));
  tx(seed);
}

const allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(cors({ origin(origin, callback) {
  if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
  return callback(new Error('Origin is not allowed by CORS'));
} }));
app.use('/api/', rateLimit({ windowMs: 60_000, limit: 90, standardHeaders: true, legacyHeaders: false }));
// Razorpay webhook signature must be computed from the exact raw request body.
app.post('/api/webhooks/razorpay', express.raw({ type: 'application/json', limit: '1mb' }), (req, res) => {
  if (!webhookSecret) return res.status(503).send('Webhook secret not configured');
  const signature = req.get('x-razorpay-signature') || '';
  const expected = crypto.createHmac('sha256', webhookSecret).update(req.body).digest('hex');
  if (!safeEqual(signature, expected)) return res.status(400).send('Invalid webhook signature');
  const event = JSON.parse(req.body.toString('utf8'));
  const eventId = req.get('x-razorpay-event-id') || `${event.event}:${event.payload?.payment?.entity?.id || ''}`;
  const pay = event.payload?.payment?.entity;
  const orderId = pay?.order_id;
  const paymentId = pay?.id;
  try {
    const tx = db.transaction(() => {
      const inserted = db.prepare('INSERT OR IGNORE INTO payment_events(provider_event_id,event_type,payment_id,order_id,received_at) VALUES (?,?,?,?,?)')
        .run(eventId, event.event || 'unknown', paymentId || null, orderId || null, new Date().toISOString());
      if (!inserted.changes) return;
      if (event.event === 'payment.captured' && pay?.status === 'captured') {
        const outcome = markPaid(orderId, paymentId, Number(pay.amount));
        if (!outcome.accepted) console.warn(`Captured payment requires admin review: ${outcome.reason}`);
      }
      if (event.event === 'payment.failed' && orderId) db.prepare("UPDATE registrations SET payment_status='Failed' WHERE order_id=? AND payment_status!='Verified'").run(orderId);
    });
    tx();
    return res.json({ received: true });
  } catch (error) {
    console.error('Webhook processing failed:', error.message);
    return res.status(500).send('Webhook processing failed');
  }
});
app.use(express.json({ limit: '100kb' }));

function safeEqual(a, b) {
  const aa = Buffer.from(String(a)); const bb = Buffer.from(String(b));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}
function adminOnly(req, res, next) {
  if (!adminToken || !safeEqual(req.get('authorization') || '', `Bearer ${adminToken}`)) return res.status(401).json({ error: 'Unauthorized' });
  next();
}
function markPaid(orderId, paymentId, amountPaise) {
  if (!orderId || !paymentId) return { accepted: false, reason: 'Missing order or payment ID.' };
  const reg = db.prepare(`SELECT r.*, t.status AS tournament_status, t.slots, t.wildcard_deadline
    FROM registrations r JOIN tournaments t ON t.id=r.tournament_id WHERE r.order_id=?`).get(orderId);
  if (!reg) return { accepted: false, reason: 'No registration was found for this order.' };
  if (Number(reg.amount_paise) !== Number(amountPaise)) throw new Error('Captured amount does not match registration amount');
  // Payment is genuine, but an event rule may have changed while checkout was open.
  // Keep the paid record for admin reconciliation/refund instead of silently granting a slot.
  let blockedReason = '';
  if (reg.is_wildcard && reg.tournament_status !== 'Live') blockedReason = 'Tournament is no longer Live; review/refund required.';
  if (reg.is_wildcard && reg.wildcard_deadline && new Date(`${reg.wildcard_deadline}T23:59:59`) < new Date()) blockedReason = 'Wildcard deadline passed before payment confirmation; review/refund required.';
  const activeOthers = db.prepare("SELECT COUNT(*) AS n FROM registrations WHERE tournament_id=? AND id!=? AND status!='Rejected'").get(reg.tournament_id, reg.id).n;
  if (activeOthers >= Number(reg.slots)) blockedReason = 'No slots remain after payment confirmation; review/refund required.';
  if (blockedReason) {
    db.prepare("UPDATE registrations SET payment_id=?,payment_status='Verified - Review Required',status='Pending Review' WHERE order_id=?").run(paymentId, orderId);
    return { accepted: false, reason: blockedReason, status: 'Pending Review' };
  }
  db.prepare("UPDATE registrations SET payment_id=?,payment_status='Verified',status='Approved' WHERE order_id=?").run(paymentId, orderId);
  return { accepted: true, status: 'Approved' };
}
function publicTournament(row) {
  return { id: row.id, name: row.name, game: row.game, fee: row.fee, wildcardFee: row.wildcard_fee, slots: row.slots, status: row.status, structure: row.structure, groupCount: row.group_count, qualifyPerGroup: row.qualify_per_group, wildcardDeadline: row.wildcard_deadline };
}
app.get('/api/health', (_req, res) => res.json({ ok: true, providerConfigured: Boolean(razorpay && webhookSecret) }));
app.get('/api/tournaments', (_req, res) => res.json(db.prepare('SELECT * FROM tournaments ORDER BY rowid').all().map(publicTournament)));
app.get('/api/registrations/:tournamentId', (req, res) => {
  // Public response deliberately excludes email and payment identifiers.
  const rows = db.prepare('SELECT id,team_name AS teamName,is_wildcard AS wildcard,status,payment_status AS paymentStatus,created_at AS createdAt FROM registrations WHERE tournament_id=? AND status="Approved" ORDER BY created_at').all(req.params.tournamentId);
  res.json(rows);
});
// UPI QR / intent registrations are recorded as pending. A typed UTR or screenshot is
// not proof of payment; a moderator must reconcile it with the receiving bank/UPI account.
app.post('/api/registrations/upi', (req, res) => {
  const { tournamentId, teamName, captainName, email, utr, wildcard = false } = req.body || {};
  if (![tournamentId, teamName, captainName, email, utr].every(v => typeof v === 'string' && v.trim())) {
    return res.status(400).json({ error: 'Tournament, team, captain, email and UTR are required.' });
  }
  const tournament = db.prepare('SELECT * FROM tournaments WHERE id=?').get(tournamentId);
  const allowedStatus = wildcard ? tournament?.status === 'Live' : tournament?.status === 'Open';
  if (!tournament || !allowedStatus) return res.status(400).json({ error: wildcard ? 'Wildcard entries are only accepted while the tournament is Live.' : 'Registration is not open.' });
  if (wildcard && tournament.wildcard_deadline && new Date(`${tournament.wildcard_deadline}T23:59:59`) < new Date()) return res.status(400).json({ error: 'Wildcard deadline has passed.' });
  const amountRupees = Number(wildcard ? tournament.wildcard_fee : tournament.fee);
  if (!Number.isFinite(amountRupees) || amountRupees <= 0) return res.status(400).json({ error: 'This entry does not have a payable fee.' });
  const activeCount = db.prepare("SELECT COUNT(*) AS n FROM registrations WHERE tournament_id=? AND status NOT IN ('Rejected')").get(tournamentId).n;
  if (activeCount >= Number(tournament.slots)) return res.status(409).json({ error: 'No entry slots remain.' });
  const duplicate = db.prepare("SELECT id FROM registrations WHERE tournament_id=? AND status!='Rejected' AND (lower(team_name)=lower(?) OR lower(email)=lower(?))").get(tournamentId, teamName.trim(), email.trim());
  if (duplicate) return res.status(409).json({ error: 'Team or captain email is already registered for this tournament.' });
  const duplicateUtr = db.prepare('SELECT id FROM registrations WHERE lower(utr)=lower(?)').get(utr.trim());
  if (duplicateUtr) return res.status(409).json({ error: 'This UTR has already been submitted.' });
  const id = crypto.randomUUID();
  try {
    db.prepare(`INSERT INTO registrations(id,tournament_id,team_name,captain_name,email,is_wildcard,amount_paise,status,payment_status,utr,created_at)
      VALUES(?,?,?,?,?,?,?,'Pending','Pending bank verification',?,?)`).run(id,tournamentId,teamName.trim(),captainName.trim(),email.trim().toLowerCase(),wildcard?1:0,Math.round(amountRupees*100),utr.trim(),new Date().toISOString());
    return res.status(201).json({ registrationId:id, status:'Pending', paymentStatus:'Pending bank verification', message:'Submission saved. Entry is not approved until payment is verified.' });
  } catch (error) {
    if (String(error.message).includes('UNIQUE')) return res.status(409).json({ error:'This UTR has already been submitted.' });
    console.error('UPI registration failed:',error.message);
    return res.status(500).json({ error:'Could not save registration.' });
  }
});
app.get('/api/admin/registrations', adminOnly, (_req, res) => {
  const rows = db.prepare(`SELECT r.id,r.tournament_id AS tournamentId,t.name AS tournament,r.team_name AS teamName,r.captain_name AS captainName,r.email,r.is_wildcard AS wildcard,r.amount_paise/100.0 AS amountINR,r.utr,r.payment_id AS paymentId,r.order_id AS orderId,r.payment_status AS paymentStatus,r.status,r.created_at AS createdAt FROM registrations r JOIN tournaments t ON t.id=r.tournament_id ORDER BY r.created_at DESC`).all();
  res.json(rows);
});
app.patch('/api/admin/registrations/:id', adminOnly, (req, res) => {
  const { status, paymentStatus } = req.body || {};
  if (!['Approved','Rejected','Pending Review'].includes(status)) return res.status(400).json({ error:'Status must be Approved, Rejected, or Pending Review.' });
  const registration = db.prepare('SELECT * FROM registrations WHERE id=?').get(req.params.id);
  if (!registration) return res.status(404).json({ error:'Registration not found.' });
  if (status === 'Approved' && registration.amount_paise > 0 && !['Verified','Verified - Review Required'].includes(registration.payment_status) && paymentStatus !== 'Verified') {
    return res.status(409).json({ error:'Paid registrations cannot be approved until payment is verified. Reconcile the UTR against the bank/UPI account first, then submit paymentStatus=Verified.' });
  }
  db.prepare('UPDATE registrations SET status=?,payment_status=COALESCE(?,payment_status) WHERE id=?').run(status,typeof paymentStatus==='string'?paymentStatus:null,req.params.id);
  res.json({ updated:true, id:req.params.id, status });
});
app.post('/api/payments/create-order', async (req, res) => {
  if (!razorpay) return res.status(503).json({ error: 'Payment provider is not configured on the server.' });
  const { tournamentId, teamName, captainName, email, wildcard = false } = req.body || {};
  if (![tournamentId, teamName, captainName, email].every(v => typeof v === 'string' && v.trim())) return res.status(400).json({ error: 'Tournament and captain/team details are required.' });
  const tournament = db.prepare('SELECT * FROM tournaments WHERE id=?').get(tournamentId);
  const allowedStatus = wildcard ? tournament?.status === 'Live' : tournament?.status === 'Open';
  if (!tournament || !allowedStatus) return res.status(400).json({ error: wildcard ? 'Wildcard entries are accepted only while the tournament is Live.' : 'Standard registration is only available while registration is Open.' });
  const amountRupees = wildcard ? Number(tournament.wildcard_fee) : Number(tournament.fee);
  if (!Number.isFinite(amountRupees) || amountRupees <= 0) return res.status(400).json({ error: 'This entry does not have a payable fee.' });
  if (wildcard && tournament.wildcard_deadline && new Date(`${tournament.wildcard_deadline}T23:59:59`) < new Date()) return res.status(400).json({ error: 'Wildcard deadline has passed.' });
  const activeCount = db.prepare("SELECT COUNT(*) AS n FROM registrations WHERE tournament_id=? AND status!='Rejected'").get(tournamentId).n;
  if (activeCount >= tournament.slots) return res.status(409).json({ error: 'No entry slots remain.' });
  const duplicate = db.prepare("SELECT id FROM registrations WHERE tournament_id=? AND status!='Rejected' AND (lower(team_name)=lower(?) OR lower(email)=lower(?))").get(tournamentId, teamName.trim(), email.trim());
  if (duplicate) return res.status(409).json({ error: 'Team or captain email is already registered for this tournament.' });
  const amountPaise = Math.round(amountRupees * 100);
  try {
    const order = await razorpay.orders.create({ amount: amountPaise, currency: 'INR', receipt: `me_${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`, notes: { tournamentId, teamName: teamName.trim(), captainName: captainName.trim(), email: email.trim().toLowerCase(), wildcard: wildcard ? 'true' : 'false' } });
    const registrationId = crypto.randomUUID();
    db.prepare(`INSERT INTO registrations(id,tournament_id,team_name,captain_name,email,is_wildcard,amount_paise,status,payment_status,order_id,created_at)
      VALUES(?,?,?,?,?,?,?,'Pending','Pending',?,?)`).run(registrationId, tournamentId, teamName.trim(), captainName.trim(), email.trim().toLowerCase(), wildcard ? 1 : 0, amountPaise, order.id, new Date().toISOString());
    res.json({ keyId, orderId: order.id, amount: order.amount, currency: order.currency, registrationId });
  } catch (error) {
    console.error('Order creation failed:', error.message);
    res.status(502).json({ error: 'Payment order could not be created.' });
  }
});
app.post('/api/payments/verify', async (req, res) => {
  const { razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: signature } = req.body || {};
  if (![orderId, paymentId, signature].every(v => typeof v === 'string' && v)) return res.status(400).json({ error: 'Missing payment verification fields.' });
  const expected = crypto.createHmac('sha256', keySecret).update(`${orderId}|${paymentId}`).digest('hex');
  if (!safeEqual(signature, expected)) return res.status(400).json({ verified: false, error: 'Invalid payment signature.' });
  try {
    // Fetch from Razorpay as a second check; do not trust client-supplied amount/status.
    const payment = await awaitPaymentFetch(paymentId);
    const order = db.prepare('SELECT * FROM registrations WHERE order_id=?').get(orderId);
    if (!order || !payment || payment.order_id !== orderId || payment.status !== 'captured' || Number(payment.amount) !== Number(order.amount_paise)) return res.status(400).json({ verified: false, error: 'Payment is not captured or amount does not match.' });
    const outcome = markPaid(orderId, paymentId, Number(payment.amount));
    return res.json({ verified: true, registrationId: order.id, paymentId, status: outcome.status || 'Pending Review', accepted: outcome.accepted, reviewReason: outcome.reason || null });
  } catch (error) {
    console.error('Payment verification failed:', error.message);
    return res.status(502).json({ verified: false, error: 'Could not verify payment with provider.' });
  }
});
// Await the provider's canonical payment record; signature alone is not enough.
async function awaitPaymentFetch(paymentId) { return razorpay.payments.fetch(paymentId); }
app.put('/api/admin/tournaments/:id', adminOnly, (req, res) => {
  const b = req.body || {};
  const row = { id: req.params.id, name: b.name, game: b.game, fee: Number(b.fee), wildcardFee: Number(b.wildcardFee ?? b.fee), slots: Number(b.slots), status: b.status, structure: b.structure || 'groups', groupCount: Number(b.groupCount || 4), qualifyPerGroup: Number(b.qualifyPerGroup || 2), wildcardDeadline: b.wildcardDeadline || null };
  if (![row.name,row.game,row.status].every(v => typeof v === 'string' && v.trim()) || ![row.fee,row.wildcardFee,row.slots,row.groupCount,row.qualifyPerGroup].every(Number.isFinite) || row.fee < 0 || row.wildcardFee < 0 || row.slots < 1) return res.status(400).json({ error: 'Invalid tournament configuration.' });
  db.prepare(`INSERT INTO tournaments(id,name,game,fee,wildcard_fee,slots,status,structure,group_count,qualify_per_group,wildcard_deadline)
    VALUES(@id,@name,@game,@fee,@wildcardFee,@slots,@status,@structure,@groupCount,@qualifyPerGroup,@wildcardDeadline)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name,game=excluded.game,fee=excluded.fee,wildcard_fee=excluded.wildcard_fee,slots=excluded.slots,status=excluded.status,structure=excluded.structure,group_count=excluded.group_count,qualify_per_group=excluded.qualify_per_group,wildcard_deadline=excluded.wildcard_deadline`).run(row);
  res.json({ saved: true });
});
app.get('/api/admin/transactions.csv', adminOnly, (_req, res) => {
  const rows = db.prepare(`SELECT r.created_at,r.captain_name,r.email,r.team_name,t.name AS tournament,r.amount_paise/100.0 AS amount_inr,r.payment_id,r.order_id,r.utr,r.payment_status,r.status,r.is_wildcard FROM registrations r JOIN tournaments t ON t.id=r.tournament_id ORDER BY r.created_at`).all();
  const quote = v => `"${String(v ?? '').replaceAll('"','""')}"`;
  const csv = ['Timestamp,Captain,Email,Team,Tournament,Amount INR,Payment ID,Order ID,UPI UTR,Payment Status,Registration Status,Wildcard', ...rows.map(r => [r.created_at,r.captain_name,r.email,r.team_name,r.tournament,r.amount_inr,r.payment_id,r.order_id,r.utr,r.payment_status,r.status,r.is_wildcard ? 'Yes' : 'No'].map(quote).join(','))].join('\r\n');
  res.setHeader('Content-Type','text/csv; charset=utf-8'); res.setHeader('Content-Disposition','attachment; filename="manifest-esports-transactions.csv"'); res.send('\ufeff' + csv);
});
app.use((err, _req, res, _next) => { console.error(err.message); res.status(500).json({ error: 'Server error.' }); });
app.listen(port, () => console.log(`Manifest Esports API listening on :${port}; Razorpay ${razorpay ? 'configured' : 'NOT configured'}`));
