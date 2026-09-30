# Multilingual RAG Customer Support Chatbot (MERN-style: MongoDB + Express + Node + Glassmorphic UI)

An enterprise-grade multilingual customer support assistant powered by **Retrieval-Augmented Generation (RAG)**, local dense vector embeddings (100+ languages), Gemini LLM generation, and a reactive glassmorphic web interface.

---

## 🌟 What's New & Key Features

### 1. 🛡️ Role-Based Access Control (RBAC) & Persistent Sessions
- **Admin vs. User Permissions**: Unauthenticated guests operate in read-only mode. Adding, editing, uploading, and deleting knowledge base documents requires Admin authentication.
- **Pre-seeded Admin Account**: `demo@example.com` / `demo1234` with 1-click login.
- **User-Tied Conversation History**: Sessions and chat histories are bound to user accounts in MongoDB.

### 2. ⚡ Real-Time Streaming (SSE) & Markdown Answers
- **Server-Sent Events (`/api/chat/stream`)**: Responses stream word-by-word with live typewriter effects.
- **Rich Markdown Formatting**: Answers render bold terms, bullet points, numbered steps, code blocks, and tables using `marked` & `DOMPurify`.
- **Action Bar**:
  - 📋 **One-Click Copy**: Copies answer text to clipboard.
  - 👍 / 👎 **Feedback Buttons**: Rates responses and logs feedback to MongoDB.

### 3. 🔍 Hybrid RAG Retrieval & Categorization
- **Hybrid Scoring**: Combines dense vector cosine similarity (85%) with lexical keyword overlap matching (15%) for pinpoint accuracy on specific terms, dates, and order numbers.
- **Category Filtering**: Route retrieval queries through specific categories (`Billing`, `Technical`, `Refunds & Policies`, `Account`, `General`).
- **Dynamic Chunk Counter**: Real-time chunk count estimator when authoring documents.

### 4. 📂 Knowledge Base Management & File Upload Ingestion
- **Drag-and-Drop Ingestion**: Upload `.txt`, `.md`, and `.pdf` files.
- **Client-Side PDF Text Extraction**: Uses `pdf.js` to extract text in-browser with zero server CPU overhead.
- **Live Search & Category Filtering**: Instantly search across all indexed documents by keyword or category pill.
- **Document Editing (`PUT /api/docs/:id`)**: Edit existing documents with automatic re-chunking and re-indexing.

### 5. 🌐 Multilingual Voice Accessibility & Multi-Chat Sidebar
- **🎙️ Speech-to-Text (Voice Input)**: Web Speech API microphone for voice queries in English, Telugu, Hindi, etc.
- **🔊 Text-to-Speech (Voice Output)**: Native browser voice playback matching detected query language.
- **Language Detection**: Automatically identifies script (Telugu, Hindi, English, etc.) and tags responses.
- **Multi-Chat Session Sidebar**: Create new chats, switch between past conversations, delete sessions, and export transcripts (`.txt`).

---

## 🚀 Quickstart

```bash
cd backend
npm install
npm run seed              # Seeds demo admin and sample English, Telugu, and Hindi docs
npm start                 # Starts server at http://localhost:3000
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

---

## 📡 API Reference

| Method | Route | Description | Auth Required |
|---|---|---|---|
| `POST` | `/api/auth/register` | Register new user account | No |
| `POST` | `/api/auth/login` | Log in and receive session token | No |
| `GET` | `/api/auth/me` | Fetch authenticated user profile | Token |
| `POST` | `/api/auth/logout` | Invalidate current session | Token |
| `GET` | `/api/docs?q=&category=` | List/search indexed documents | No |
| `POST` | `/api/docs` | Add & index a new document into chunks | **Admin** |
| `PUT` | `/api/docs/:id` | Update document and re-index chunks | **Admin** |
| `DELETE` | `/api/docs/:id` | Delete document and all associated chunks | **Admin** |
| `POST` | `/api/chat/stream` | Stream LLM answer with passage citations (SSE) | No |
| `POST` | `/api/chat` | Non-streaming fallback chat | No |
| `GET` | `/api/chat/sessions` | Fetch user's conversation sessions | Optional |
| `POST` | `/api/chat/session` | Create a new conversation session | Optional |
| `DELETE` | `/api/chat/session/:sid` | Delete conversation session and messages | Optional |
| `GET` | `/api/chat/:sid` | Fetch message history for a session | No |
| `POST` | `/api/chat/feedback` | Record thumbs up/down rating for a message | No |
