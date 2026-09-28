const { Schema, model } = require('mongoose');

const Doc = model('Doc', new Schema({
  title: { type: String, required: true },
  text: { type: String, required: true },
  lang: { type: String, default: 'auto' },
  createdAt: { type: Date, default: Date.now }
}));

const Chunk = model('Chunk', new Schema({
  docId: { type: Schema.Types.ObjectId, ref: 'Doc', index: true },
  title: String,
  text: String,
  embedding: [Number]
}));

const Conv = model('Conv', new Schema({
  sessionId: { type: String, index: true },
  messages: [{ role: String, content: String, sources: [String], at: { type: Date, default: Date.now } }]
}));

module.exports = { Doc, Chunk, Conv };
