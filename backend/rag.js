const { GoogleGenAI } = require('@google/genai');
const { Chunk } = require('./models');

const client = process.env.GEMINI_API_KEY ? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }) : null;
const MIN = parseFloat(process.env.RAG_MIN_SCORE || '0.55');
let extractor;

// Multilingual embeddings (100 languages), runs locally — no API key needed.
async function embed(text, type) {
  if (!extractor) {
    const { pipeline } = await import('@xenova/transformers');
    extractor = await pipeline('feature-extraction', 'Xenova/multilingual-e5-small');
  }
  const out = await extractor(`${type}: ${text}`, { pooling: 'mean', normalize: true });
  return Array.from(out.data);
}

function chunkText(text, max = 600) {
  const parts = text.split(/\n{2,}|(?<=[.!?।])\s+/).map(s => s.trim()).filter(Boolean);
  const out = []; let cur = '';
  for (const p of parts) {
    if (cur && (cur + ' ' + p).length > max) { out.push(cur); cur = p; }
    else cur = cur ? cur + ' ' + p : p;
  }
  if (cur) out.push(cur);
  return out;
}

async function indexDoc(doc) {
  await Chunk.deleteMany({ docId: doc._id });
  for (const text of chunkText(doc.text)) {
    await Chunk.create({ docId: doc._id, title: doc.title, text, embedding: await embed(text, 'passage') });
  }
}

const dot = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);

async function retrieve(query, k = 4) {
  const q = await embed(query, 'query');
  const chunks = await Chunk.find().lean();
  return chunks
    .map(c => ({ title: c.title, text: c.text, score: dot(q, c.embedding) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .filter(c => c.score >= MIN);
}

const SYSTEM = `You are a helpful, friendly customer support assistant.

Behavior rules:
1. GREETINGS & SMALL TALK (hi, hello, how are you, thanks, bye, etc.) — respond warmly and naturally like a real person. Be brief and friendly.
2. SUPPORT QUESTIONS WITH CONTEXT — if CONTEXT passages are provided below the message, use them to give an accurate, specific answer.
3. SUPPORT QUESTIONS WITHOUT CONTEXT — use your own general knowledge to give a genuinely helpful answer. Do NOT say "I don't have that info" when you actually know.
4. LANGUAGE — always reply in the same language and script as the customer's message.
5. ACCURACY — never invent specific prices, policies, or dates that aren't in the context.
6. TONE — keep answers concise, warm, and easy to understand.`;

// Purely casual messages — skip knowledge base search for these
const CASUAL_RE = /^\s*(hi+|hello+|hey+|howdy|greetings|good\s*(morning|afternoon|evening|night|day)|what'?s up|how are you|how r u|how are things|i'?m (good|fine|okay|ok|great)|i am (good|fine|great)|thanks?\.?|thank you\.?|ty|bye+|goodbye|see you|take care|ok|okay|yes|no|sure|cool|great|nice|awesome|👋|🙏|😊|🤝|namaste|vanakkam|నమస్కారం|నమస్తే|नमस्ते|హాయ్|హలో)[\.,!?\s]*$/i;

async function answer(message, history = []) {
  const isCasual = CASUAL_RE.test(message.trim());
  const hits = isCasual ? [] : await retrieve(message);

  // No API key fallback mode
  if (!client) {
    if (isCasual) return { hits, reply: 'Hi there! 👋 How can I help you today?' };
    return {
      hits,
      reply: hits.length
        ? hits[0].text
        : "I couldn't find that in the knowledge base. Would you like to talk to a human agent?"
    };
  }

  // Build context block only when KB hits exist
  const contextBlock = hits.length
    ? `CONTEXT from knowledge base:\n${hits.map((h, i) => `[${i + 1}] (${h.title}): ${h.text}`).join('\n')}\n\n`
    : '';

  const model = process.env.LLM_MODEL || 'gemini-2.5-flash';

  const contents = [
    ...history.slice(-6).map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
    { role: 'user', parts: [{ text: `${contextBlock}CUSTOMER MESSAGE:\n${message}` }] }
  ];

  const res = await client.models.generateContent({
    model,
    contents,
    config: { systemInstruction: SYSTEM, maxOutputTokens: 600 }
  });

  return { hits, reply: res.text };
}

module.exports = { indexDoc, answer };
