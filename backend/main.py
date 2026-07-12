"""
main.py — Isolated Python RAG Backend (FastAPI + Chroma DB + LangChain)
Provides local document ingestion, chunking (RecursiveCharacterTextSplitter),
embedding storage via Chroma DB, and context-aware LLM generation.
"""

import os
from typing import List, Optional, Dict, Any
from fastapi import FastAPI, HTTPException, status
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
import chromadb
from chromadb.config import Settings
from dotenv import load_dotenv

# LangChain imports
from langchain_text_splitters import RecursiveCharacterTextSplitter

load_dotenv()

# =====================================================================
# 1. FastAPI Application & CORS Setup
# =====================================================================
app = FastAPI(
    title="PDF RAG Copilot API",
    description="Local vector database & RAG server for Manifest V3 Chrome Extension",
    version="1.0.0",
)

# Configure CORS to accept requests from any Chrome Extension or local UI
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Allows chrome-extension://<id> and local dev servers
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# =====================================================================
# 2. Vector Database Initialization (Chroma DB)
# =====================================================================
CHROMA_PERSIST_DIR = os.getenv("CHROMA_PERSIST_DIR", "./chroma_data")
os.makedirs(CHROMA_PERSIST_DIR, exist_ok=True)

# Initialize persistent ChromaDB client
chroma_client = chromadb.PersistentClient(path=CHROMA_PERSIST_DIR)

# Get or create our primary RAG collection
rag_collection = chroma_client.get_or_create_collection(
    name="pdf_rag_chunks",
    metadata={"hnsw:space": "cosine"}
)

# =====================================================================
# 3. Pydantic Request & Response Schemas
# =====================================================================
class PageItem(BaseModel):
    page: int
    text: str

class IngestRequest(BaseModel):
    raw_text: Optional[str] = Field(None, description="Raw extracted text string from PDF")
    pages: Optional[List[PageItem]] = Field(None, description="Structured page-by-page text items")
    doc_id: Optional[str] = Field("default_doc", description="Unique document URL or identifier")
    title: Optional[str] = Field("Untitled PDF", description="Document title")

class IngestResponse(BaseModel):
    status: str
    chunk_count: int
    doc_id: str
    message: str

class ChatRequest(BaseModel):
    query: str = Field(..., description="User's natural language question")
    doc_id: Optional[str] = Field(None, description="Optional document filter")
    top_k: int = Field(4, description="Number of most relevant chunks to retrieve")

class ChatResponse(BaseModel):
    answer: str
    sources: List[Dict[str, Any]]

# =====================================================================
# 4. Helper: LLM & Embedding Selection
# =====================================================================
def normalize_llm_output(content: Any) -> str:
    """
    Ensure LLM output is always returned as a clean string regardless of whether
    the SDK returns a str or a list of content blocks (e.g. [{'type': 'text', 'text': ...}]).
    """
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for item in content:
            if isinstance(item, str):
                parts.append(item)
            elif isinstance(item, dict):
                parts.append(str(item.get("text", "")))
            elif hasattr(item, "text"):
                parts.append(str(item.text))
            else:
                parts.append(str(item))
        return "\n".join(p for p in parts if p).strip()
    return str(content)

def generate_llm_response(prompt: str) -> str:
    """
    Invokes configured LLM provider (OpenAI or Google Gemini) with the RAG prompt.
    Returns explicit error diagnostics if model invocation throws an exception.
    """
    openai_key = os.getenv("OPENAI_API_KEY")
    google_key = os.getenv("GOOGLE_API_KEY")

    if openai_key and openai_key != "your_openai_api_key_here":
        try:
            from langchain_openai import ChatOpenAI
            llm = ChatOpenAI(model="gpt-4o-mini", temperature=0.2)
            response = llm.invoke(prompt)
            return normalize_llm_output(response.content)
        except Exception as e:
            import traceback
            err_details = traceback.format_exc()
            print(f"[OpenAI Error] {err_details}")
            return (
                "**OpenAI Invocation Error:**\n\n"
                f"An exception occurred while calling `ChatOpenAI(model='gpt-4o-mini')`:\n\n"
                f"```text\n{type(e).__name__}: {str(e)}\n```"
            )

    if google_key and google_key != "your_gemini_api_key_here":
        # Check if user specified a custom GEMINI_MODEL in .env, otherwise start with gemini-3.5-flash
        custom_model = os.getenv("GEMINI_MODEL")
        candidate_models = [
            custom_model,
            "gemini-3.5-flash",
            "gemini-2.5-flash",
            "gemini-1.5-flash-latest",
            "gemini-1.5-pro-latest",
            "gemini-1.5-flash",
            "gemini-pro",
        ]
        candidate_models = [m for m in candidate_models if m]
        last_error = None

        for model_name in candidate_models:
            try:
                from langchain_google_genai import ChatGoogleGenerativeAI
                llm = ChatGoogleGenerativeAI(
                    model=model_name,
                    google_api_key=google_key,
                    temperature=0.2
                )
                response = llm.invoke(prompt)
                return normalize_llm_output(response.content)
            except Exception as e:
                last_error = e
                print(f"[Gemini Model '{model_name}' failed]: {e}")
                continue

        # If LangChain wrappers fail, try direct google.generativeai SDK fallback
        try:
            import google.generativeai as genai
            genai.configure(api_key=google_key)
            for m_name in candidate_models:
                try:
                    model = genai.GenerativeModel(m_name)
                    res = model.generate_content(prompt)
                    if res and res.text:
                        return res.text
                except Exception:
                    continue
        except Exception:
            pass

        import traceback
        err_details = traceback.format_exc()
        underlying = getattr(last_error, "__cause__", "") or getattr(last_error, "response", "")
        return (
            "**Google Gemini Invocation Error (404 Model Not Found):**\n\n"
            "We attempted to call Google Gemini across multiple compatible model names (`gemini-1.5-flash-latest`, `gemini-1.5-pro-latest`, `gemini-pro`, `gemini-1.5-flash`), but the API returned 404 NOT FOUND.\n\n"
            f"**Last Error:**\n```text\n{str(last_error)}\n```\n\n"
            f"**Underlying Cause:**\n```text\n{underlying}\n```\n\n"
            "**Fix:**\n"
            "Run `pip install --upgrade langchain-google-genai google-generativeai` in your terminal inside `venv` to update the Google GenAI SDK to the latest API endpoint."
        )

    # Local fallback when neither API key is configured
    return (
        "**Local RAG Response:**\n\n"
        "I retrieved context chunks from your PDF stored in **Chroma DB**, but no valid LLM API key "
        "(`OPENAI_API_KEY` or `GOOGLE_API_KEY`) was found in `.env`.\n\n"
        "To enable live AI completions, add your API key to `backend/.env` and restart Uvicorn."
    )

# =====================================================================
# 5. Endpoints
# =====================================================================

@app.get("/health", summary="API Health Check")
async def health_check():
    """Returns backend status for Side Panel health indicator."""
    return {
        "status": "online",
        "service": "PDF RAG Copilot Backend",
        "vector_db": "ChromaDB",
        "collection_count": rag_collection.count()
    }

@app.post("/ingest", response_model=IngestResponse, summary="Ingest & Vectorize PDF Text")
async def ingest_document(payload: IngestRequest):
    """
    Chunks extracted PDF text using LangChain's RecursiveCharacterTextSplitter
    (chunk_size=512, chunk_overlap=50) and stores embeddings in Chroma DB.
    """
    # 1. Combine or extract raw text
    full_text = payload.raw_text or ""
    if not full_text and payload.pages:
        full_text = "\n\n".join(f"[Page {p.page}]\n{p.text}" for p in payload.pages)

    if not full_text.strip():
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No text provided for ingestion."
        )

    # 2. Initialize LangChain RecursiveCharacterTextSplitter
    text_splitter = RecursiveCharacterTextSplitter(
        chunk_size=512,
        chunk_overlap=50,
        separators=["\n\n", "\n", ". ", " ", ""]
    )

    # 3. Split text into chunks
    raw_chunks = text_splitter.split_text(full_text)

    # 4. Prepare ChromaDB input arrays
    ids: List[str] = []
    documents: List[str] = []
    metadatas: List[Dict[str, Any]] = []

    for idx, chunk in enumerate(raw_chunks):
        chunk_id = f"{payload.doc_id}_chunk_{idx}"
        ids.append(chunk_id)
        documents.append(chunk)
        metadatas.append({
            "doc_id": payload.doc_id,
            "title": payload.title or "Untitled PDF",
            "chunk_index": idx
        })

    # 5. Upsert chunks into Chroma DB collection
    try:
        rag_collection.upsert(
            ids=ids,
            documents=documents,
            metadatas=metadatas
        )
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Chroma DB upsert failed: {str(e)}"
        )

    return IngestResponse(
        status="success",
        chunk_count=len(documents),
        doc_id=payload.doc_id,
        message=f"Successfully ingested {len(documents)} chunks (size=512, overlap=50) into Chroma DB."
    )

@app.post("/chat", response_model=ChatResponse, summary="Query RAG Knowledge Base")
async def chat_query(payload: ChatRequest):
    """
    Performs similarity search on Chroma DB to retrieve top 4 relevant chunks (k=4)
    and passes contextualized prompt to LLM.
    """
    if rag_collection.count() == 0:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No documents indexed in Chroma DB yet. Please ingest a PDF first."
        )

    # 1. Query Chroma DB for top-k (default=4) most similar chunks
    query_params: Dict[str, Any] = {
        "query_texts": [payload.query],
        "n_results": min(payload.top_k, rag_collection.count())
    }

    # Apply optional document filter
    if payload.doc_id and payload.doc_id != "default_doc":
        query_params["where"] = {"doc_id": payload.doc_id}

    try:
        results = rag_collection.query(**query_params)
    except Exception as e:
        # Fallback to unfiltered query if where clause misses
        results = rag_collection.query(
            query_texts=[payload.query],
            n_results=min(payload.top_k, rag_collection.count())
        )

    retrieved_docs = results.get("documents", [[]])[0]
    retrieved_meta = results.get("metadatas", [[]])[0]

    # 2. Format retrieved chunks as structured source references
    sources = []
    context_blocks = []
    for idx, (doc_text, meta) in enumerate(zip(retrieved_docs, retrieved_meta)):
        sources.append({
            "chunk_id": idx + 1,
            "page": meta.get("chunk_index", idx) + 1,
            "doc_id": meta.get("doc_id", "Unknown"),
            "snippet": doc_text[:150]
        })
        context_blocks.append(f"--- [Retrieved Chunk {idx+1}] ---\n{doc_text}")

    joined_context = "\n\n".join(context_blocks)

    # 3. Construct RAG Prompt
    prompt = f"""You are an expert PDF RAG AI Assistant. Answer the user's question accurately using ONLY the provided document context chunks below.

### Retrieved Context:
{joined_context}

### User Question:
{payload.query}

### Instructions:
- Speak directly and confidently as a helpful AI peer.
- NEVER say "Based on the provided text...", "According to the chunks...", or mention "retrieved context" to the user. Just answer the question directly using the information.
- Format your response using clean Markdown headers (###), bold text (**), bullet points, and code blocks where applicable.
- If the answer cannot be determined from the context, state clearly what information is missing.
"""

    # 4. Generate LLM Completion
    answer = normalize_llm_output(generate_llm_response(prompt))

    return ChatResponse(answer=answer, sources=sources)
