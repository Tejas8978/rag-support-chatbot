require('dotenv').config();
const dns = require('dns');
// Prefer IPv4 first to avoid 30s IPv6 connect timeouts on Windows
dns.setDefaultResultOrder('ipv4first');
// Fast DNS servers for Atlas SRV lookup (Cloudflare + Google DNS)
dns.setServers(['1.1.1.1', '1.0.0.1', '8.8.8.8']);
const crypto = require('crypto');
const path = require('path');
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const { Doc, Chunk, Conv, User, Session } = require('./models');
const { hashPassword, verifyPassword, createSession, authMiddleware, requireAuth, requireAdmin, ensureDefaultUser } = require('./auth');
const rag = require('./rag');

const app = express();
app.use(cors(), express.json({ limit: '5mb' }), authMiddleware, express.static(path.join(__dirname, '../frontend')));

const wrap = fn => (req, res) => fn(req, res).catch(e => { console.error(e); res.status(500).json({ error: e.message || 'Something went wrong on the server.' }); });

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

app.post('/api/auth/forgot-password', wrap(async (req, res) => {
  const { email } = req.body;
  if (!email?.trim() || !/^\S+@\S+\.\S+$/.test(email.trim())) {
    return res.status(400).json({ error: 'Please enter a valid registered email address.' });
  }

  const user = await User.findOne({ email: email.trim().toLowerCase() });
  const resetToken = crypto.randomBytes(20).toString('hex');
  if (user) {
    user.resetToken = resetToken;
    user.resetTokenExpires = new Date(Date.now() + 30 * 60 * 1000); // 30 minutes
    await user.save();
  }

  res.json({
    ok: true,
    message: `Password reset instructions sent! A reset link has been dispatched to ${email.trim()} (valid for 30 minutes).`,
    email: email.trim(),
    resetToken: user ? resetToken : null
  });
}));

app.post('/api/auth/reset-password', wrap(async (req, res) => {
  const { email, newPassword, resetToken } = req.body;
  if (!email?.trim()) return res.status(400).json({ error: 'Email address is required.' });
  if (!newPassword || newPassword.length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters long.' });

  const user = await User.findOne({ email: email.trim().toLowerCase() });
  if (!user) {
    return res.status(404).json({ error: 'No account found with this email address.' });
  }

  if (resetToken && user.resetToken && user.resetTokenExpires && user.resetTokenExpires < new Date()) {
    return res.status(400).json({ error: 'Reset link has expired (valid for 30 minutes). Please request a new one.' });
  }

  user.password = hashPassword(newPassword);
  user.resetToken = null;
  user.resetTokenExpires = null;
  await user.save();

  res.json({
    ok: true,
    message: 'Your password has been successfully updated! You can now sign in with your new password.'
  });
}));

// Knowledge Base Routes with RBAC & Search
app.get('/api/docs', wrap(async (req, res) => {
  const { q, category } = req.query;
  const filter = {};
  if (category && category !== 'All') filter.category = category;
  if (q && q.trim()) {
    filter.$or = [
      { title: { $regex: q.trim(), $options: 'i' } },
      { text: { $regex: q.trim(), $options: 'i' } }
    ];
  }
  const docs = await Doc.find(filter).sort({ createdAt: -1 }).lean();
  res.json(docs);
}));

app.post('/api/docs', wrap(async (req, res) => {
  const { title, text, lang, category } = req.body;
  if (!title?.trim() || !text?.trim()) return res.status(400).json({ error: 'Please provide both a title and text.' });
  let doc;
  try {
    doc = await Doc.create({
      title: title.trim(),
      text: text.trim(),
      lang: lang || 'auto',
      category: category?.trim() || 'General'
    });
    const chunkCount = await rag.indexDoc(doc);
    doc.chunkCount = chunkCount;
    res.status(201).json(doc);
  } catch (err) {
    if (doc?._id) await Doc.findByIdAndDelete(doc._id);
    console.error('Failed to index document:', err);
    res.status(500).json({ error: 'Failed to index document: ' + (err.message || 'Unknown error') });
  }
}));

app.put('/api/docs/:id', wrap(async (req, res) => {
  const { title, text, category, lang } = req.body;
  const doc = await Doc.findById(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Document not found.' });

  if (title?.trim()) doc.title = title.trim();
  if (text?.trim()) doc.text = text.trim();
  if (category?.trim()) doc.category = category.trim();
  if (lang) doc.lang = lang;

  await doc.save();
  const chunkCount = await rag.indexDoc(doc);
  doc.chunkCount = chunkCount;
  res.json(doc);
}));

app.delete('/api/docs/:id', wrap(async (req, res) => {
  await Doc.findByIdAndDelete(req.params.id);
  await Chunk.deleteMany({ docId: req.params.id });
  res.json({ ok: true, id: req.params.id });
}));


// Conversation & Session Management
app.get('/api/chat/sessions', wrap(async (req, res) => {
  const filter = req.user ? { userId: req.user.id } : {};
  const sessions = await Conv.find(filter)
    .select('sessionId title updatedAt messages')
    .sort({ updatedAt: -1 })
    .limit(30)
    .lean();
  res.json(sessions.map(s => ({
    sessionId: s.sessionId,
    title: s.title || (s.messages?.[0]?.content?.slice(0, 32) + '…') || 'New Conversation',
    messageCount: s.messages?.length || 0,
    updatedAt: s.updatedAt
  })));
}));

app.post('/api/chat/session', wrap(async (req, res) => {
  const sessionId = req.body.sessionId || require('crypto').randomUUID();
  const conv = await Conv.create({
    sessionId,
    userId: req.user?.id || null,
    title: req.body.title || 'New Conversation',
    messages: []
  });
  res.json({ sessionId: conv.sessionId, title: conv.title });
}));

app.delete('/api/chat/session/:sid', wrap(async (req, res) => {
  await Conv.deleteOne({ sessionId: req.params.sid });
  res.json({ ok: true });
}));

app.get('/api/chat/:sid', wrap(async (req, res) => {
  const conv = await Conv.findOne({ sessionId: req.params.sid }).lean();
  res.json(conv?.messages || []);
}));

// Message Feedback (Thumbs up / down)
app.post('/api/chat/feedback', wrap(async (req, res) => {
  const { sessionId, messageIndex, feedback } = req.body;
  if (!sessionId || messageIndex === undefined) return res.status(400).json({ error: 'Missing sessionId or messageIndex' });
  const conv = await Conv.findOne({ sessionId });
  if (!conv || !conv.messages[messageIndex]) return res.status(404).json({ error: 'Message not found' });
  conv.messages[messageIndex].feedback = feedback;
  await conv.save();
  res.json({ ok: true, feedback });
}));

// Streaming Chat API (Server-Sent Events)
app.post('/api/chat/stream', async (req, res) => {
  const { sessionId, message, category } = req.body;
  if (!sessionId || !message?.trim()) {
    return res.status(400).json({ error: 'Type a message first.' });
  }

  // Set SSE Headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const conv = (await Conv.findOne({ sessionId })) || new Conv({
    sessionId,
    userId: req.user?.id || null,
    title: message.trim().slice(0, 36),
    messages: []
  });

  if (req.user && !conv.userId) {
    conv.userId = req.user.id;
  }
  if (!conv.title || conv.title === 'New Conversation') {
    conv.title = message.trim().slice(0, 36);
  }

  let finalHits = [];
  let finalReply = '';
  let detectedLang = 'English';

  try {
    for await (const event of rag.answerStream(message, conv.messages, category)) {
      if (event.type === 'meta') {
        finalHits = event.hits;
        detectedLang = event.detectedLang;
        res.write(`data: ${JSON.stringify({ type: 'meta', hits: finalHits, detectedLang })}\n\n`);
      } else if (event.type === 'token') {
        finalReply += event.text;
        res.write(`data: ${JSON.stringify({ type: 'token', text: event.text })}\n\n`);
      } else if (event.type === 'done') {
        if (event.fullReply) finalReply = event.fullReply;
      }
    }

    conv.messages.push(
      { role: 'user', content: message, at: new Date() },
      {
        role: 'assistant',
        content: finalReply,
        sources: finalHits.map(h => h.title),
        detectedLang,
        at: new Date()
      }
    );
    conv.updatedAt = new Date();
    await conv.save();

    res.write(`data: ${JSON.stringify({ type: 'done', fullReply: finalReply })}\n\n`);
  } catch (err) {
    console.error('Streaming error:', err);
    res.write(`data: ${JSON.stringify({ type: 'error', error: err.message })}\n\n`);
  } finally {
    res.end();
  }
});

// Non-streaming fallback Chat API
app.post('/api/chat', wrap(async (req, res) => {
  const { sessionId, message, category } = req.body;
  if (!sessionId || !message?.trim()) return res.status(400).json({ error: 'Type a message first.' });

  const conv = (await Conv.findOne({ sessionId })) || new Conv({
    sessionId,
    userId: req.user?.id || null,
    title: message.trim().slice(0, 36),
    messages: []
  });

  if (req.user && !conv.userId) conv.userId = req.user.id;
  if (!conv.title || conv.title === 'New Conversation') conv.title = message.trim().slice(0, 36);

  const { reply, hits, detectedLang } = await rag.answer(message, conv.messages, category);
  conv.messages.push(
    { role: 'user', content: message, at: new Date() },
    { role: 'assistant', content: reply, sources: hits.map(h => h.title), detectedLang, at: new Date() }
  );
  conv.updatedAt = new Date();
  await conv.save();

  res.json({
    reply,
    detectedLang,
    sources: hits.map(h => ({ title: h.title, text: h.text, category: h.category, score: +h.score.toFixed(3) }))
  });
}));

mongoose.connect(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/rag_support', {
  family: 4,
  serverSelectionTimeoutMS: 15000,
}).then(async () => {
  const port = process.env.PORT || 3000;
  await ensureDefaultUser();
  const server = app.listen(port, () => {
    console.log(`Running at http://localhost:${port}`);
    if (rag.warmUp) rag.warmUp();
  });
  server.keepAliveTimeout = 120000;
  server.headersTimeout = 125000;
}).catch(e => { console.error('MongoDB connection failed:', e.message); process.exit(1); });


