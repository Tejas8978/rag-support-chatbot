const { GoogleGenAI } = require('@google/genai');
const { Chunk, Doc } = require('./models');
const client = process.env.GEMINI_API_KEY ? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }) : null;
const MIN = parseFloat(process.env.RAG_MIN_SCORE || '0.28');

// Language detection helper
function detectLanguage(text) {
  if (/[\u0C00-\u0C7F]/.test(text)) return { code: 'te', name: 'Telugu', label: 'Telugu / తెలుగు' };
  if (/[\u0900-\u097F]/.test(text)) return { code: 'hi', name: 'Hindi', label: 'Hindi / हिन्दी' };
  if (/[\u0B80-\u0BFF]/.test(text)) return { code: 'ta', name: 'Tamil', label: 'Tamil / தமிழ்' };
  if (/[\u0C80-\u0CFF]/.test(text)) return { code: 'kn', name: 'Kannada', label: 'Kannada / ಕನ್ನಡ' };
  return { code: 'en', name: 'English', label: 'English' };
}

let extractor = null;
let extractorPromise = null;

// Lightweight embeddings model (22MB download, 200MB RAM — fits comfortably on Render 512MB free tier)
async function getExtractor() {
  if (extractor) return extractor;
  if (!extractorPromise) {
    extractorPromise = (async () => {
      const { pipeline, env } = await import('@xenova/transformers');
      env.allowLocalModels = false;
      const modelName = process.env.EMBEDDING_MODEL || 'Xenova/all-MiniLM-L6-v2';
      const ext = await pipeline('feature-extraction', modelName, {
        quantized: true,
      });
      extractor = ext;
      return ext;
    })().catch(err => {
      extractorPromise = null;
      throw err;
    });
  }
  return extractorPromise;
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

const NO_CONTEXT_REPLIES = {
  te: "క్షమించండి, మా సపోర్ట్ నాలెడ్జ్ బేస్‌లో ఈ సమాచారం అందుబాటులో లేదు. దయచేసి మా సపోర్ట్ డాక్యుమెంట్‌లకు సంబంధించిన ప్రశ్నను అడగండి.",
  hi: "क्षमा करें, हमारे सपोर्ट नॉलेज बेस में यह जानकारी उपलब्ध नहीं है। कृपया हमारे सपोर्ट डॉक्यूमेंट्स से संबंधित प्रश्न पूछें।",
  ta: "மன்னிக்கவும், எங்கள் ஆதரவு அறிவுத் தளத்தில் இந்தத் தகவல் கிடைக்கவில்லை. தயவுசெய்து எங்கள் ஆதரவு ஆவணங்கள் தொடர்பான கேள்வியைக் கேட்கவும்.",
  kn: "ಕ್ಷಮಿಸಿ, ನಮ್ಮ ಬೆಂಬಲ ಜ್ಞಾನ ನೆಲೆಯಲ್ಲಿ ಈ ಮಾಹಿತಿ ಲಭ್ಯವಿಲ್ಲ. ದಯವಿಟ್ಟು ನಮ್ಮ ಬೆಂಬಲ ದಾಖಲೆಗಳಿಗೆ ಸಂಬಂಧಿಸಿದ ಪ್ರಶ್ನೆಯನ್ನು ಕೇಳಿ.",
  en: "I'm sorry, but I couldn't find that information in our support knowledge base. Please ask a question related to our documented policies or support topics."
};

const SYSTEM = `You are a strict Retrieval-Augmented Generation (RAG) customer support assistant.

CRITICAL BEHAVIOR RULES:
1. STRICT KNOWLEDGE BASE ONLY — You must answer ONLY and EXCLUSIVELY using the provided CONTEXT passages from the knowledge base below.
2. ABSOLUTELY NO OUTSIDE KNOWLEDGE — Never use general training knowledge, world knowledge, or external facts to answer support questions. If the CONTEXT does not contain the answer, you must state clearly: "I'm sorry, but I do not have information about that in the support knowledge base."
3. GREETINGS & CASUAL MESSAGES — For greetings (e.g. "hi", "hello", "thanks", "bye"), respond politely in 1-2 friendly sentences, inviting the customer to ask about our support topics.
4. ACCURACY — Never invent or extrapolate policies, prices, dates, or specifications that are not explicitly stated in the context passages.
5. LANGUAGE & SCRIPT — Always reply in the exact same language and script as the customer's query (e.g., Telugu, Hindi, English).
6. FORMATTING — Use clean, readable Markdown (bullet points, bold text for key terms).`;

const CASUAL_GREETINGS = {
  te: "నమస్కారం! 👋 నేను మీకు ఎలా సహాయపడగలను? దయచేసి మా సపోర్ట్ డాక్యుమెంట్‌లకు సంబంధించిన ప్రశ్నను అడగండి.",
  hi: "नमस्ते! 👋 मैं आपकी क्या मदद कर सकता हूँ? कृपया हमारे सपोर्ट डॉक्यूमेंट्स से संबंधित प्रश्न पूछें।",
  ta: "வணக்கம்! 👋 நான் உங்களுக்கு எவ்வாறு உதவ முடியும்? எங்கள் ஆதரவு ஆவணங்கள் பற்றிய கேள்வியைக் கேட்கவும்.",
  kn: "ನಮಸ್ಕಾರ! 👋 ನಾನು ನಿಮಗೆ ಹೇಗೆ ಸಹಾಯ ಮಾಡಬಹುದು? ದಯವಿಟ್ಟು ನಮ್ಮ ಬೆಂಬಲ ದಾಖಲೆಗಳಿಗೆ ಸಂಬಂಧಿಸಿದ ಪ್ರಶ್ನೆಯನ್ನು ಕೇಳಿ.",
  en: "Hi there! 👋 How can I help you today? Please ask any question about our support documentation."
};

function isCasualMessage(text) {
  const clean = text.trim().toLowerCase().replace(/[.,!?;:👋🙏😊🤝]/gu, ' ').replace(/\s+/g, ' ').trim();
  if (!clean) return true;
  const casualPhrases = new Set([
    'hi', 'hello', 'hey', 'howdy', 'greetings',
    'good morning', 'good afternoon', 'good evening', 'good night', 'good day',
    'whats up', "what's up", 'how are you', 'how r u', 'how are things',
    'im good', 'im fine', 'im ok', 'im great', 'i am good', 'i am fine',
    'thanks', 'thank you', 'thank you very much', 'thanks a lot', 'thx', 'ty',
    'bye', 'goodbye', 'see you', 'take care',
    'ok', 'okay', 'yes', 'no', 'sure', 'cool', 'great', 'nice', 'awesome',
    'namaste', 'vanakkam', 'నమస్కారం', 'నమస్తే', 'नमस्ते', 'హాయ్', 'హలో'
  ]);
  if (casualPhrases.has(clean)) return true;
  const tokens = clean.split(' ');
  const greetingTokens = new Set([
    'hi', 'hello', 'hey', 'good', 'morning', 'afternoon', 'evening', 'night', 'day',
    'there', 'everyone', 'team', 'bot', 'assistant', 'howdy', 'greetings', 'thanks',
    'thank', 'you', 'very', 'much', 'bye', 'ok', 'okay', 'yes', 'sure', 'namaste', 'vanakkam'
  ]);
  if (tokens.length <= 4 && tokens.every(t => greetingTokens.has(t))) {
    return true;
  }
  return false;
}

// Streaming generator for real-time SSE output
async function* answerStream(message, history = [], category = null) {
  const detectedLang = detectLanguage(message);
  const isCasual = isCasualMessage(message);
  const hits = isCasual ? [] : await retrieve(message, 4, category);

  yield { type: 'meta', hits, detectedLang: detectedLang.label };

  // STRICT RAG: If non-casual and no context matches found in the knowledge base, strictly decline
  if (!isCasual && (!hits || hits.length === 0)) {
    const noInfoReply = NO_CONTEXT_REPLIES[detectedLang.code] || NO_CONTEXT_REPLIES.en;
    const words = noInfoReply.split(' ');
    for (let i = 0; i < words.length; i++) {
      yield { type: 'token', text: (i === 0 ? '' : ' ') + words[i] };
    }
    yield { type: 'done', fullReply: noInfoReply };
    return;
  }

  if (!client) {
    let reply = '';
    if (isCasual) {
      reply = CASUAL_GREETINGS[detectedLang.code] || CASUAL_GREETINGS.en;
    } else {
      reply = hits.length
        ? hits[0].text
        : (NO_CONTEXT_REPLIES[detectedLang.code] || NO_CONTEXT_REPLIES.en);
    }
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

