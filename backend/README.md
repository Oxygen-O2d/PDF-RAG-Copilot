# Phase 3: Python RAG Backend (FastAPI + Chroma DB)

This directory contains the isolated Python backend that powers the PDF RAG Chrome Extension.

## 1. Environment Setup & Activation Commands (Windows PowerShell)

Open your terminal in `d:\RAGExtension\backend` and run:

```powershell
# 1. Navigate to the backend directory
cd d:\RAGExtension\backend

# 2. Create a Python virtual environment
python -m venv venv

# 3. Activate the virtual environment
.\venv\Scripts\Activate.ps1

# 4. Install all required dependencies
pip install -r requirements.txt
```

> **Note on Activation Script Policy**: If PowerShell blocks script execution, temporarily allow it for your current session:
> ```powershell
> Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope Process
> ```

## 2. API Key Configuration (Optional for LLM generation)

Copy `.env.example` to `.env` and insert your OpenAI or Google Gemini API key:
```powershell
Copy-Item .env.example .env
```

## 3. Start the FastAPI + ChromaDB Server

Run Uvicorn to start the server on `http://localhost:8000`:
```powershell
uvicorn main:app --reload --host 0.0.0.0 --port 8000
```

### Endpoints
- **GET `/health`**: Check server status (`online` / `collection_count`)
- **POST `/ingest`**: Chunk text with `RecursiveCharacterTextSplitter(chunk_size=512, chunk_overlap=50)` and store in local Chroma DB.
- **POST `/chat`**: Retrieve top 4 relevant chunks (`k=4`) and generate an answer grounded in retrieved context.
