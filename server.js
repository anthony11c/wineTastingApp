const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const cors = require('cors');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

const SUPABASE_URL = 'https://ofwesqkqcyipgihbdkip.supabase.co';
// Get this from Supabase Dashboard → Project Settings → API → Service Role Secret
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_SERVICE_KEY) {
  console.error('ERROR: SUPABASE_SERVICE_KEY env var is required. Get it from Supabase Dashboard → Project Settings → API → Service Role Secret');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false },
});

// ─── Admin credentials (bcrypt hash of "admin123") ─────────────────────────
const ADMIN_HASH = '$2a$10$EGVzH1.70v4b/kJhiB5DKOjXxiv9gTI84LdLoqG261YKD0G/vnXHm';

// ─── Middleware ────────────────────────────────────────────────────────────────
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(session({
  secret: process.env.SESSION_SECRET || 'cossetto-winery-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, maxAge: 8 * 60 * 60 * 1000 },
}));
app.use(express.static(path.join(__dirname)));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'wine-degustation-app.html'));
});

function requireAdmin(req, res, next) {
  if (!req.session.adminLoggedIn) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// ─── Auth ──────────────────────────────────────────────────────────────────────
app.post('/api/admin/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  if (username !== 'admin') return res.status(401).json({ error: 'Invalid credentials' });
  const valid = await bcrypt.compare(password, ADMIN_HASH);
  if (!valid) return res.status(401).json({ error: 'Invalid credentials' });
  req.session.adminLoggedIn = true;
  req.session.adminUsername = username;
  res.json({ ok: true, username });
});

app.post('/api/admin/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/admin/me', (req, res) => {
  if (req.session.adminLoggedIn) return res.json({ loggedIn: true, username: req.session.adminUsername });
  res.json({ loggedIn: false });
});

// ─── Packages ─────────────────────────────────────────────────────────────────
app.get('/api/packages', async (req, res) => {
  const { data, error } = await supabase.from('packages').select('*').order('sort_order');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ─── Slots ────────────────────────────────────────────────────────────────────
app.get('/api/slots', async (req, res) => {
  const { date } = req.query;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'date query param required (YYYY-MM-DD)' });
  }

  const [{ data: slotRow }, { data: booked }] = await Promise.all([
    supabase.from('available_slots').select('slots').eq('date', date).maybeSingle(),
    supabase.from('reservations').select('time').eq('date', date).in('status', ['confirmed', 'pending']),
  ]);

  const allSlots = slotRow?.slots || [];
  const bookedTimes = (booked || []).map(r => r.time);
  res.json({ date, slots: allSlots.filter(t => !bookedTimes.includes(t)), allSlots });
});

app.get('/api/slots/calendar', async (req, res) => {
  const { year, month } = req.query;
  if (!year || !month) return res.status(400).json({ error: 'year and month required' });
  const y = parseInt(year, 10);
  const m = String(parseInt(month, 10)).padStart(2, '0');
  const daysInMonth = new Date(y, parseInt(month, 10), 0).getDate();
  const from = `${y}-${m}-01`;
  const to = `${y}-${m}-${String(daysInMonth).padStart(2, '0')}`;

  const [{ data: slotsData }, { data: bookingsData }] = await Promise.all([
    supabase.from('available_slots').select('date, slots').gte('date', from).lte('date', to),
    supabase.from('reservations').select('date').gte('date', from).lte('date', to).in('status', ['confirmed', 'pending']),
  ]);

  const result = {};
  for (const row of (slotsData || [])) {
    const count = (bookingsData || []).filter(r => r.date === row.date).length;
    result[row.date] = { total: row.slots.length, booked: count, available: row.slots.length - count };
  }
  res.json(result);
});

app.put('/api/admin/slots/:date', requireAdmin, async (req, res) => {
  const { date } = req.params;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Invalid date format' });
  const { slots } = req.body;
  if (!Array.isArray(slots)) return res.status(400).json({ error: 'slots must be an array' });
  const { error } = await supabase.from('available_slots').upsert({ date, slots });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ date, slots });
});

app.delete('/api/admin/slots/:date', requireAdmin, async (req, res) => {
  const { date } = req.params;
  const { error } = await supabase.from('available_slots').delete().eq('date', date);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ─── Reservations (Guest) ──────────────────────────────────────────────────────
app.post('/api/reservations', async (req, res) => {
  const { name, email, phone, date, time, pkg, guests, notes } = req.body;

  if (!name || !email || !date || !time || !pkg || !guests) {
    return res.status(400).json({ error: 'Missing required fields: name, email, date, time, pkg, guests' });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Invalid date format' });

  const { data: pkgData } = await supabase.from('packages').select('*').eq('id', pkg).maybeSingle();
  if (!pkgData) return res.status(400).json({ error: `Unknown package: ${pkg}` });

  const guestCount = parseInt(guests, 10);
  if (isNaN(guestCount) || guestCount < 1 || guestCount > 10) {
    return res.status(400).json({ error: 'guests must be between 1 and 10' });
  }

  const { data: slotRow } = await supabase.from('available_slots').select('slots').eq('date', date).maybeSingle();
  if (!slotRow?.slots?.includes(time)) return res.status(409).json({ error: 'This time slot is not available' });

  const { data: existing } = await supabase.from('reservations').select('id')
    .eq('date', date).eq('time', time).in('status', ['confirmed', 'pending']).maybeSingle();
  if (existing) return res.status(409).json({ error: 'This time slot is already booked' });

  const { data: newRes, error } = await supabase.from('reservations').insert({
    name, email, phone: phone || '', date, time,
    pkg: pkgData.name, pkg_id: pkgData.id,
    guests: guestCount, status: 'pending',
    notes: notes || '',
  }).select().single();

  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(newRes);
});

// ─── Reservations (Admin) ──────────────────────────────────────────────────────
app.get('/api/admin/reservations', requireAdmin, async (req, res) => {
  const { status, date } = req.query;
  let query = supabase.from('reservations').select('*').order('id', { ascending: true });
  if (status) query = query.eq('status', status);
  if (date) query = query.eq('date', date);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.get('/api/admin/reservations/:id', requireAdmin, async (req, res) => {
  const { data, error } = await supabase.from('reservations').select('*').eq('id', req.params.id).maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: 'Reservation not found' });
  res.json(data);
});

app.patch('/api/admin/reservations/:id', requireAdmin, async (req, res) => {
  const { status } = req.body;
  const allowed = ['pending', 'confirmed', 'declined'];
  if (!allowed.includes(status)) return res.status(400).json({ error: `status must be one of: ${allowed.join(', ')}` });
  const { data, error } = await supabase.from('reservations')
    .update({ status }).eq('id', req.params.id).select().maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: 'Reservation not found' });
  res.json(data);
});

app.post('/api/admin/reservations/:id/reply', requireAdmin, async (req, res) => {
  const { message } = req.body;
  if (!message?.trim()) return res.status(400).json({ error: 'message is required' });

  const { data: existing, error: fetchErr } = await supabase.from('reservations')
    .select('replies').eq('id', req.params.id).maybeSingle();
  if (fetchErr || !existing) return res.status(404).json({ error: 'Reservation not found' });

  const replies = [
    ...(existing.replies || []),
    { message: message.trim(), sentAt: new Date().toISOString(), sentBy: req.session.adminUsername },
  ];
  const { data, error } = await supabase.from('reservations')
    .update({ replies }).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true, reservation: data });
});

app.get('/api/admin/stats', requireAdmin, async (req, res) => {
  const { data } = await supabase.from('reservations').select('status, guests');
  const all = data || [];
  res.json({
    total: all.length,
    pending: all.filter(r => r.status === 'pending').length,
    confirmed: all.filter(r => r.status === 'confirmed').length,
    declined: all.filter(r => r.status === 'declined').length,
    totalGuests: all.filter(r => r.status === 'confirmed').reduce((s, r) => s + r.guests, 0),
  });
});

// ─── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Cossetto winery backend running on http://localhost:${PORT}`);
  console.log('Admin credentials: username=admin  password=admin123');
});
