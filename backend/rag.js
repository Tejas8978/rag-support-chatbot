const { GoogleGenAI } = require('@google/genai');
const { Chunk, Doc } = require('./models');

const client = process.env.GEMINI_API_KEY ? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }) : null;
const MIN = parseFloat(process.env.RAG_MIN_SCORE || '0.50');
let extractor;

// Language detection helper
function detectLanguage(text) {
  if (/[\u0C00-\u0C7F]/.test(text)) return { code: 'te', name: 'Telugu', label: 'Telugu / తెలుగు' };
  if (/[\u0900-\u097F]/.test(text)) return { code: 'hi', name: 'Hindi', label: 'Hindi / हिन्दी' };
  if (/[\u0B80-\u0BFF]/.test(text)) return { code: 'ta', name: 'Tamil', label: 'Tamil / தமிழ்' };
  if (/[\u0C80-\u0CFF]/.test(text)) return { code: 'kn', name: 'Kannada', label: 'Kannada / ಕನ್ನಡ' };
  return { code: 'en', name: 'English', label: 'English' };
}

// Multilingual embeddings (100 languages), runs locally — no API key needed.
async function getExtractor() {
  if (!extractor) {
    const { pipeline, env } = await import('@xenova/transformers');
    env.allowLocalModels = false;
    extractor = await pipeline('feature-extraction', 'Xenova/multilingual-e5-small', {
      quantized: true,
    });
  }
  return extractor;
}

async function embed(text, type) {
  const ext = await getExtractor();
  const out = await ext(`${type}: ${text}`, { pooling: 'mean', normalize: true });
  return Array.from(out.data);
}

// Vectorized batch embedding: processes multiple chunks in 1 fast ONNX pass
async function embedBatch(texts, type, batchSize = 8) {
  if (!texts.length) return [];
  const ext = await getExtractor();
  const results = [];
  const dim = 384;
  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    const inputs = batch.map(t => `${type}: ${t}`);
    const out = await ext(inputs, { pooling: 'mean', normalize: true });
    for (let j = 0; j < batch.length; j++) {
      const start = j * dim;
      results.push(Array.from(out.data.slice(start, start + dim)));
    }
    // Yield event loop between batches so small memory instances (e.g. Render 512MB) can GC
    if (i + batchSize < texts.length) {
      await new Promise(resolve => setImmediate(resolve));
    }
  }
  return results;
}

async function warmUp() {
  try {
    await embed('warmup', 'query');
    console.log('Multilingual embedding model initialized and ready.');
  } catch (err) {
    console.warn('Embedding model warm-up notice:', err.message);
  }
}

function chunkText(text, max = 800) {
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
  const chunks = chunkText(doc.text, 800);
  if (!chunks.length) return 0;

  // Batch embed all chunks in parallel passes instead of slow sequential calls
  const embeddings = await embedBatch(chunks, 'passage', 8);

  const chunkDocs = chunks.map((text, idx) => ({
    docId: doc._id,
    title: doc.title,
    text,
    category: doc.category || 'General',
    embedding: embeddings[idx]
  }));

  if (chunkDocs.length > 0) {
    await Chunk.insertMany(chunkDocs);
  }

  await Doc.findByIdAndUpdate(doc._id, { chunkCount: chunks.length });
  return chunks.length;
}


const dot = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);

function extractWords(str) {
  return (str.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).filter(w => w.length > 2);
}

// Hybrid retrieval: Dense vector cosine similarity + Keyword overlap boost
async function retrieve(query, k = 4, category = null) {
  const q = await embed(query, 'query');
  const filter = category && category !== 'All' ? { category } : {};
  const chunks = await Chunk.find(filter).lean();
  if (!chunks.length) return [];

  const queryWords = extractWords(query);

  return chunks
    .map(c => {
      const semScore = dot(q, c.embedding);
      
      // Keyword overlap calculation for exact terms
      let kwScore = 0;
      if (queryWords.length > 0) {
        const chunkWords = new Set(extractWords((c.title || '') + ' ' + (c.text || '')));
        let matches = 0;
        for (const qw of queryWords) {
          if (chunkWords.has(qw)) matches++;
        }
        kwScore = matches / queryWords.length;
      }

      // Hybrid combination (85% vector similarity, 15% keyword overlap)
      const combinedScore = (semScore * 0.85) + (kwScore * 0.15);

      return {
        title: c.title,
        text: c.text,
        category: c.category || 'General',
        score: combinedScore
      };
    })
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
5. FORMATTING — format clear explanations using clean Markdown (bullet points, bold text for key terms, numbered steps).
6. ACCURACY — never invent specific prices, policies, or dates that aren't in the context.
7. TONE — keep answers concise, warm, and easy to understand.`;

// Purely casual messages — skip knowledge base search for these
const CASUAL_RE = /^\s*(hi+|hello+|hey+|howdy|greetings|good\s*(morning|afternoon|evening|night|day)|what'?s up|how are you|how r u|how are things|i'?m (good|fine|okay|ok|great)|i am (good|fine|great)|thanks?\.?|thank you\.?|ty|bye+|goodbye|see you|take care|ok|okay|yes|no|sure|cool|great|nice|awesome|👋|🙏|😊|🤝|namaste|vanakkam|నమస్కారం|నమస్తే|नमस्ते|హాయ్|హలో)[\.,!?\s]*$/i;

// Streaming generator for real-time SSE output
async function* answerStream(message, history = [], category = null) {
  const detectedLang = detectLanguage(message);
  const isCasual = CASUAL_RE.test(message.trim());
  const hits = isCasual ? [] : await retrieve(message, 4, category);

  yield { type: 'meta', hits, detectedLang: detectedLang.label };

  if (!client) {
    let reply = '';
    if (isCasual) {
      reply = 'Hi there! 👋 How can I help you today? Feel free to ask questions about our products, refund policies, or account support.';
    } else {
      reply = hits.length
        ? hits[0].text
        : "I couldn't find a direct match in our knowledge base. Would you like to rephrase or reach out to human support?";
    }
    // Stream fallback tokens
    const words = reply.split(' ');
    for (let i = 0; i < words.length; i++) {
      yield { type: 'token', text: (i === 0 ? '' : ' ') + words[i] };
    }
    yield { type: 'done', fullReply: reply };
    return;
  }

  const contextBlock = hits.length
    ? `CONTEXT from knowledge base:\n${hits.map((h, i) => `[${i + 1}] (${h.title} - ${h.category}): ${h.text}`).join('\n')}\n\n`
    : '';

  const model = process.env.LLM_MODEL || 'gemini-2.5-flash';

  const contents = [
    ...history.slice(-6).map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
    { role: 'user', parts: [{ text: `${contextBlock}CUSTOMER MESSAGE:\n${message}` }] }
  ];

  try {
    const responseStream = await client.models.generateContentStream({
      model,
      contents,
      config: { systemInstruction: SYSTEM, maxOutputTokens: 800 }
    });

    let fullReply = '';
    for await (const chunk of responseStream) {
      if (chunk.text) {
        fullReply += chunk.text;
        yield { type: 'token', text: chunk.text };
      }
    }
    yield { type: 'done', fullReply };
  } catch (err) {
    console.error('LLM generation error:', err);
    const fallbackMsg = `Error generating AI reply: ${err.message || 'Please try again later.'}`;
    yield { type: 'token', text: fallbackMsg };
    yield { type: 'done', fullReply: fallbackMsg };
  }
}

async function answer(message, history = [], category = null) {
  let fullReply = '';
  let hits = [];
  let detectedLang = 'English';

  for await (const event of answerStream(message, history, category)) {
    if (event.type === 'meta') {
      hits = event.hits;
      detectedLang = event.detectedLang;
    } else if (event.type === 'token') {
      fullReply += event.text;
    } else if (event.type === 'done' && event.fullReply) {
      fullReply = event.fullReply;
    }
  }

  return { hits, reply: fullReply, detectedLang };
}

module.exports = { indexDoc, retrieve, answer, answerStream, warmUp, detectLanguage };

