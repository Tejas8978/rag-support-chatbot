# Multilingual RAG Customer Support Chatbot (MERN-style: MongoDB + Express + Node + web UI)

**How it works**
1. Support content (FAQs, policies) is split into chunks and embedded with `multilingual-e5-small` (local, 100 languages).
2. Docs, chunks + embeddings, and chat history are stored in MongoDB.
3. On each question: embed the query, find the most similar chunks (cosine similarity), pass them to Claude, which answers only from those passages, in the customer's language.

## Run
```bash
cd backend
npm install
cp .env.example .env      # set ANTHROPIC_API_KEY (optional) and MONGODB_URI
npm run seed              # loads sample English, Telugu and Hindi FAQs (first run downloads the model, ~120 MB)
npm start                 # open http://localhost:3000
```

## API
| Method | Route | Purpose |
|---|---|---|
| GET/POST | `/api/docs` | list / add and index a document |
| DELETE | `/api/docs/:id` | remove a document and its chunks |
| POST | `/api/chat` | `{sessionId, message}` returns `{reply, sources}` |
| GET | `/api/chat/:sid` | conversation history |

## Notes for your project report
- Tune `RAG_MIN_SCORE` on your own data. It controls when the bot says "I don't know".
- For large knowledge bases, replace the in-memory cosine search in `rag.js` with MongoDB Atlas Vector Search.
- Evaluation ideas: retrieval hit-rate@k and answer accuracy per language (English vs low-resource languages).
