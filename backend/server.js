require('dotenv').config();
const dns = require('dns');
// Prefer IPv4 first to avoid 30s IPv6 connect timeouts on Windows
dns.setDefaultResultOrder('ipv4first');
// Fast DNS servers for Atlas SRV lookup (Cloudflare + Google DNS)
dns.setServers(['1.1.1.1', '1.0.0.1', '8.8.8.8']);
const path = require('path');
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const { Doc, Chunk, Conv, User, Session } = require('./models');
const { hashPassword, verifyPassword, createSession, authMiddleware, ensureDefaultUser } = require('./auth');
const rag = require('./rag');

const app = express();
app.use(cors(), express.json({ limit: '2mb' }), authMiddleware, express.static(path.join(__dirname, '../frontend')));

const wrap = fn => (req, res) => fn(req, res).catch(e => { console.error(e); res.status(500).json({ error: 'Something went wrong on the server.' }); });

// Authentication Routes connected to MongoDB
app.post('/api/auth/register', wrap(async (req, res) => {
  const { name, email, password } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Please enter your name.' });
  if (!email?.trim() || !/^\S+@\S+\.\S+$/.test(email.trim())) return res.status(400).json({ error: 'Please provide a valid email address.' });
  if (!password || password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters long.' });

  const existing = await User.findOne({ email: email.trim().toLowerCase() });
  if (existing) return res.status(409).json({ error: 'An account with this email already exists.' });

  const user = await User.create({
    name: name.trim(),
    email: email.trim().toLowerCase(),
    password: hashPassword(password),
    role: 'user'
  });

  const token = await createSession(user._id);
  res.status(201).json({
    ok: true,
    user: { id: user._id, name: user.name, email: user.email, role: user.role },
    token
  });
}));

app.post('/api/auth/login', wrap(async (req, res) => {
  const { email, password } = req.body;
  if (!email?.trim() || !password) return res.status(400).json({ error: 'Email and password are required.' });

  const user = await User.findOne({ email: email.trim().toLowerCase() });
  if (!user || !verifyPassword(password, user.password)) {
    return res.status(401).json({ error: 'Invalid email or password.' });
  }

  const token = await createSession(user._id);
  res.json({
    ok: true,
    user: { id: user._id, name: user.name, email: user.email, role: user.role },
    token
  });
}));

app.get('/api/auth/me', wrap(async (req, res) => {
  if (!req.user) {
    return res.json({ authenticated: false, user: null });
  }
  res.json({ authenticated: true, user: req.user });
}));

app.post('/api/auth/logout', wrap(async (req, res) => {
  if (req.sessionToken) {
    await Session.deleteOne({ token: req.sessionToken });
  }
  res.json({ ok: true });
}));

app.get('/api/docs', wrap(async (_, res) => res.json(await Doc.find().sort({ createdAt: -1 }).lean())));

app.post('/api/docs', wrap(async (req, res) => {
  const { title, text, lang } = req.body;
  if (!title?.trim() || !text?.trim()) return res.status(400).json({ error: 'Add a title and some text.' });
  let doc;
  try {
    doc = await Doc.create({ title: title.trim(), text: text.trim(), lang: lang || 'auto' });
    await rag.indexDoc(doc);
    res.json(doc);
  } catch (err) {
    if (doc?._id) await Doc.findByIdAndDelete(doc._id);
    console.error('Failed to index document:', err);
    res.status(500).json({ error: 'Failed to index document: ' + (err.message || 'Unknown error') });
  }
}));

app.delete('/api/docs/:id', wrap(async (req, res) => {
  await Doc.findByIdAndDelete(req.params.id);
  await Chunk.deleteMany({ docId: req.params.id });
  res.json({ ok: true });
}));

app.get('/api/chat/:sid', wrap(async (req, res) => {
  const conv = await Conv.findOne({ sessionId: req.params.sid }).lean();
  res.json(conv?.messages || []);
}));

app.post('/api/chat', wrap(async (req, res) => {
  const { sessionId, message } = req.body;
  if (!sessionId || !message?.trim()) return res.status(400).json({ error: 'Type a message first.' });
  const conv = (await Conv.findOne({ sessionId })) || new Conv({ sessionId, messages: [] });
  const { reply, hits } = await rag.answer(message, conv.messages);
  conv.messages.push({ role: 'user', content: message }, { role: 'assistant', content: reply, sources: hits.map(h => h.title) });
  await conv.save();
  res.json({ reply, sources: hits.map(h => ({ title: h.title, text: h.text, score: +h.score.toFixed(3) })) });
}));

mongoose.connect(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/rag_support', {
  family: 4,
  serverSelectionTimeoutMS: 15000,
}).then(async () => {
  const port = process.env.PORT || 3000;
  await ensureDefaultUser();
  app.listen(port, () => {
    console.log(`Running at http://localhost:${port}`);
    if (rag.warmUp) rag.warmUp();
  });
}).catch(e => { console.error('MongoDB connection failed:', e.message); process.exit(1); });
