const { Schema, model } = require('mongoose');

const Doc = model('Doc', new Schema({
  title: { type: String, required: true },
  text: { type: String, required: true },
  lang: { type: String, default: 'auto' },
  category: { type: String, default: 'General' },
  chunkCount: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now }
}));

const Chunk = model('Chunk', new Schema({
  docId: { type: Schema.Types.ObjectId, ref: 'Doc', index: true },
  title: String,
  text: String,
  category: { type: String, default: 'General' },
  embedding: [Number]
}));

const Conv = model('Conv', new Schema({
  sessionId: { type: String, index: true, unique: true },
  userId: { type: Schema.Types.ObjectId, ref: 'User', index: true, sparse: true },
  title: { type: String, default: 'New Conversation' },
  messages: [{
    role: String,
    content: String,
    sources: [String],
    feedback: { type: String, enum: ['up', 'down', null], default: null },
    detectedLang: String,
    at: { type: Date, default: Date.now }
  }],
  updatedAt: { type: Date, default: Date.now }
}));

const User = model('User', new Schema({
  name: { type: String, required: true, trim: true },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  password: { type: String, required: true },
  role: { type: String, enum: ['user', 'admin'], default: 'user' },
  resetToken: { type: String, default: null },
  resetTokenExpires: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now }
}));

const Session = model('Session', new Schema({
  token: { type: String, required: true, unique: true, index: true },
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  createdAt: { type: Date, default: Date.now, expires: 60 * 60 * 24 * 7 } // expires in 7 days
}));

module.exports = { Doc, Chunk, Conv, User, Session };

