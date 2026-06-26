// Spine & Health Co intro funnel server.
// Serves the static page, captures leads into Bader's GHL New Patient Pipeline,
// fires Meta CAPI (deduped with the browser pixel), and logs page visits to SQLite.
// Everything around the lead capture is best-effort: a DB or analytics failure
// must never break the page or lose the lead.

const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '64kb' }));

// ---------- SQLite (optional, never fatal) ----------
let db = null, insVisit = null, insLead = null, updLead = null;
try {
  const Database = require('better-sqlite3');
  const DB_PATH = process.env.DATABASE_PATH || path.join(__dirname, 'data', 'funnel.db');
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS visits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      visitor_id TEXT, page TEXT, url TEXT, referrer TEXT,
      utm_source TEXT, utm_medium TEXT, utm_campaign TEXT, utm_content TEXT, utm_term TEXT,
      fbc TEXT, fbp TEXT, ip TEXT, user_agent TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS leads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      first_name TEXT, email TEXT, phone TEXT,
      ghl_contact_id TEXT, ghl_status TEXT, event_id TEXT,
      fbc TEXT, fbp TEXT, ip TEXT, user_agent TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);
  insVisit = db.prepare(`INSERT INTO visits (visitor_id,page,url,referrer,utm_source,utm_medium,utm_campaign,utm_content,utm_term,fbc,fbp,ip,user_agent)
    VALUES (@visitor_id,@page,@url,@referrer,@utm_source,@utm_medium,@utm_campaign,@utm_content,@utm_term,@fbc,@fbp,@ip,@user_agent)`);
  insLead = db.prepare(`INSERT INTO leads (first_name,email,phone,event_id,fbc,fbp,ip,user_agent,ghl_status)
    VALUES (@first_name,@email,@phone,@event_id,@fbc,@fbp,@ip,@user_agent,'pending')`);
  updLead = db.prepare(`UPDATE leads SET ghl_contact_id=@cid, ghl_status=@status WHERE id=@id`);
  console.log('sqlite ready at', DB_PATH);
} catch (e) {
  console.error('sqlite unavailable, continuing without local logging:', e.message);
}

const sha = v => v ? crypto.createHash('sha256').update(String(v).trim().toLowerCase()).digest('hex') : undefined;

// ---------- page-visit beacon (like join.strongpilates.ca) ----------
app.post('/api/track', (req, res) => {
  try {
    const b = req.body || {};
    if (insVisit) insVisit.run({
      visitor_id: b.visitorId || null, page: b.page || null, url: b.url || null, referrer: b.referrer || null,
      utm_source: b.utmSource || null, utm_medium: b.utmMedium || null, utm_campaign: b.utmCampaign || null,
      utm_content: b.utmContent || null, utm_term: b.utmTerm || null,
      fbc: b.fbc || null, fbp: b.fbp || null, ip: req.ip || null, user_agent: req.get('user-agent') || null
    });
  } catch (e) { /* analytics never blocks */ }
  res.json({ ok: true });
});

// ---------- lead capture -> his GHL ----------
app.post('/api/lead', async (req, res) => {
  const b = req.body || {};
  const { firstName, email, phone, eventId, fbp, fbc, eventSourceUrl } = b;
  if (!email && !phone) return res.status(400).json({ ok: false, error: 'need email or phone' });

  // 1. local save first (safety net, so the lead is never lost)
  let leadRowId = null;
  try {
    if (insLead) leadRowId = insLead.run({
      first_name: firstName || null, email: email || null, phone: phone || null,
      event_id: eventId || null, fbc: fbc || null, fbp: fbp || null,
      ip: req.ip || null, user_agent: req.get('user-agent') || null
    }).lastInsertRowid;
  } catch (e) { /* keep going */ }

  // 2. create / upsert the GHL contact via the PIT
  let contactId = null, ghlStatus = 'error';
  try {
    const r = await fetch('https://services.leadconnectorhq.com/contacts/', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.GHL_PIT}`,
        Version: '2021-07-28', 'Content-Type': 'application/json', Accept: 'application/json'
      },
      body: JSON.stringify({
        firstName: firstName || undefined,
        email: email || undefined,
        phone: phone || undefined,
        locationId: process.env.GHL_LOCATION_ID,
        source: 'Spine & Health Co funnel ($80 first visit)',
        tags: ['funnel-lead', '$80 first visit']
      })
    });
    const j = await r.json().catch(() => ({}));
    if (r.ok && j.contact && j.contact.id) { contactId = j.contact.id; ghlStatus = 'created'; }
    else if (r.status === 400 && j.meta && j.meta.contactId) { contactId = j.meta.contactId; ghlStatus = 'duplicate'; }
    else { ghlStatus = 'error:' + r.status; console.error('GHL contact error', r.status, JSON.stringify(j).slice(0, 300)); }
  } catch (e) { ghlStatus = 'error:exception'; console.error('GHL contact exception', e.message); }

  // 2b. Opportunity creation is intentionally NOT done here.
  //     The funnel-lead tag (set above) triggers the "Pipeline | 01. New Lead" workflow,
  //     whose Create Opportunity step is the single source of pipeline entry. Keeping it
  //     in one place avoids a second opp being created/renamed on the same contact.

  if (leadRowId && updLead) { try { updLead.run({ id: leadRowId, cid: contactId, status: ghlStatus }); } catch (e) {} }

  // 3. Meta CAPI Lead (same event_id as the browser pixel, so Meta dedupes)
  if (eventId && process.env.META_PIXEL_ID && process.env.META_CAPI_TOKEN) {
    try {
      const payload = {
        data: [{
          event_name: 'Lead', event_time: Math.floor(Date.now() / 1000), event_id: eventId,
          action_source: 'website', event_source_url: eventSourceUrl,
          user_data: {
            em: sha(email), ph: sha(phone), fn: sha(firstName),
            client_ip_address: req.ip, client_user_agent: req.get('user-agent'), fbp, fbc
          }
        }],
        ...(process.env.META_TEST_EVENT_CODE ? { test_event_code: process.env.META_TEST_EVENT_CODE } : {})
      };
      await fetch(`https://graph.facebook.com/v20.0/${process.env.META_PIXEL_ID}/events?access_token=${process.env.META_CAPI_TOKEN}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    } catch (e) { console.error('CAPI exception', e.message); }
  }

  // success as long as the lead reached GHL (or was saved locally to recover)
  return res.json({ ok: true, ghlContactId: contactId, ghlStatus });
});

// ---------- stats read-back (secret-gated) ----------
app.get('/api/stats', (req, res) => {
  if (!process.env.STATS_SECRET || req.query.secret !== process.env.STATS_SECRET) return res.status(401).json({ ok: false });
  if (!db) return res.json({ ok: true, note: 'no db', visits: 0, leads: 0 });
  const visits = db.prepare('SELECT COUNT(*) n FROM visits').get().n;
  const leads = db.prepare('SELECT COUNT(*) n FROM leads').get().n;
  const visitsToday = db.prepare("SELECT COUNT(*) n FROM visits WHERE created_at >= datetime('now','start of day')").get().n;
  const ghlSynced = db.prepare("SELECT COUNT(*) n FROM leads WHERE ghl_contact_id IS NOT NULL").get().n;
  const recent = db.prepare('SELECT created_at, utm_source, utm_campaign FROM visits ORDER BY id DESC LIMIT 10').all();
  res.json({ ok: true, visits, visitsToday, leads, ghlSynced, conversion: visits ? +(leads / visits).toFixed(4) : 0, recent });
});

app.get('/healthz', (req, res) => res.json({ ok: true }));

// ---------- static funnel ----------
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log('Spine funnel listening on ' + PORT));
