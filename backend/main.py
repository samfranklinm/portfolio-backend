import asyncio
import json
import os
import re
import time
from contextlib import asynccontextmanager
from random import choice
from pathlib import Path

import httpx
import pymupdf
from google import genai
from google.genai import types as genai_types
from dotenv import load_dotenv
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from slowapi import Limiter
from slowapi.errors import RateLimitExceeded
from slowapi.util import get_remote_address

load_dotenv()

REQUIRED = ["GEMINI_API_KEY", "BASE_PERSONA", "RESUME_URL"]
missing = [k for k in REQUIRED if not os.getenv(k)]
if missing:
    raise RuntimeError(f"[FATAL] Missing required env vars: {', '.join(missing)}")

gemini = genai.Client(api_key=os.environ["GEMINI_API_KEY"])
MODEL = os.getenv("MODEL", "gemini-2.5-flash")

CONFIG = Path(__file__).parent / "config"
greetings = json.loads((CONFIG / "greetings.json").read_text())["greetings"]
contacts  = json.loads((CONFIG / "contacts.json").read_text())["contacts"]
farewells = json.loads((CONFIG / "farewells.json").read_text())["farewells"]

resume_text: str = ""
RESUME_TTL = 20 * 60


def _gdrive_url(url: str) -> str:
    m = re.search(r"/d/([a-zA-Z0-9_-]+)", url)
    if m:
        return f"https://drive.google.com/uc?export=download&id={m.group(1)}"
    m = re.search(r"[?&]id=([a-zA-Z0-9_-]+)", url)
    if m:
        return f"https://drive.google.com/uc?export=download&id={m.group(1)}"
    return url


async def _fetch_resume() -> str:
    raw_url = os.environ["RESUME_URL"]
    is_gdrive = "drive.google.com" in raw_url
    url = _gdrive_url(raw_url) if is_gdrive else raw_url

    async with httpx.AsyncClient(follow_redirects=True, timeout=30) as client:
        r = await client.get(url)
        r.raise_for_status()

    ct = r.headers.get("content-type", "")
    if "application/pdf" in ct or is_gdrive or raw_url.lower().endswith(".pdf"):
        doc = pymupdf.open(stream=r.content, filetype="pdf")
        return "\n".join(page.get_text() for page in doc).strip()

    return json.dumps(r.json(), indent=2)


async def _refresh_loop():
    while True:
        await asyncio.sleep(RESUME_TTL)
        global resume_text
        try:
            resume_text = await _fetch_resume()
            print(f"[resume] Refreshed ({len(resume_text)} chars).")
        except Exception as e:
            print(f"[resume] Refresh failed: {e}. Keeping previous content.")


@asynccontextmanager
async def lifespan(_: FastAPI):
    global resume_text
    resume_text = await _fetch_resume()
    print(f"[resume] Loaded ({len(resume_text)} chars). Next refresh in {RESUME_TTL // 60} min.")
    task = asyncio.create_task(_refresh_loop())
    yield
    task.cancel()


limiter = Limiter(key_func=get_remote_address)
app = FastAPI(lifespan=lifespan)
app.state.limiter = limiter


@app.exception_handler(RateLimitExceeded)
async def _rate_limit_handler(request: Request, exc: RateLimitExceeded):
    return JSONResponse(
        status_code=429,
        content={"error": "Too many requests from this IP, please try again after 15 minutes."},
    )


app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Content-Type"],
)

INJECTION = [
    re.compile(r"ignore (previous|all|above|prior)", re.I),
    re.compile(r"you are now", re.I),
    re.compile(r"system prompt", re.I),
]


class ChatBody(BaseModel):
    question: str


@app.get("/health")
def health():
    return "OK"


@app.get("/api/health")
def api_health():
    return {
        "status": "ok",
        "service": "portfolio-backend",
        "uptime": time.process_time(),
    }


@app.post("/api/chat")
@limiter.limit("50/15minutes")
async def chat(request: Request, body: ChatBody):
    q_raw = body.question.strip()

    if not q_raw:
        return JSONResponse(status_code=400, content={"error": "question must be a non-empty string"})
    if len(q_raw) > 2000:
        return JSONResponse(status_code=400, content={"error": "Message too long. Please keep questions under 2000 characters."})
    if any(p.search(q_raw) for p in INJECTION):
        return JSONResponse(status_code=400, content={"error": "Invalid input."})

    q = q_raw.lower()

    GREETINGS = ["hello", "hey", "hi there", "greetings", "howdy", "salutations",
                 "what's up", "yo", "hiya", "good day", "how's it going", "hi"]
    FAREWELLS = ["goodbye", "bye", "see you later", "later", "cya", "adios",
                 "farewell", "peace out", "take care", "have a good one"]
    CONTACT_WORDS = ["contact", "email", "phone", "reach", "linkedin", "github", "twitter", "social"]

    if any(q.startswith(g) for g in GREETINGS):
        return {"answer": choice(greetings)}
    if any(q.startswith(f) for f in FAREWELLS):
        return {"answer": choice(farewells)}
    if any(c in q for c in CONTACT_WORDS):
        return {"answer": choice(contacts)}

    try:
        result = gemini.models.generate_content(
            model=MODEL,
            contents=q_raw,
            config=genai_types.GenerateContentConfig(
                system_instruction=f"{os.environ['BASE_PERSONA']}\n\nResume:\n{resume_text}",
            ),
        )
        answer = result.text
        if not answer:
            raise ValueError("Empty response from AI service")
        return {"answer": answer}
    except Exception as e:
        status = getattr(e, "status_code", None) or getattr(e, "code", None)
        print(f"[/api/chat] {status or 'ERR'} {e}")
        if status == 429:
            return JSONResponse(status_code=429, content={"error": "Rate limit reached. Please try again shortly."})
        if status and status >= 500:
            return JSONResponse(status_code=502, content={"error": "AI service temporarily unavailable."})
        return JSONResponse(status_code=500, content={"error": "Something went wrong. Please try again."})
