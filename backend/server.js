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
const { Doc, Chunk, Conv } = require('./models');
const rag = require('./rag');

const app = express();
app.use(cors(), express.json({ limit: '2mb' }), express.static(path.join(__dirname, '../frontend')));

const wrap = fn => (req, res) => fn(req, res).catch(e => { console.error(e); res.status(500).json({ error: 'Something went wrong on the server.' }); });

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
}).then(() => {
  const port = process.env.PORT || 3000;
  app.listen(port, () => {
    console.log(`Running at http://localhost:${port}`);
    if (rag.warmUp) rag.warmUp();
  });
}).catch(e => { console.error('MongoDB connection failed:', e.message); process.exit(1); });
