"""
OpenClaw Cron Dashboard — Server

A lightweight FastAPI server that exposes OpenClaw cron job data
via a simple REST API and serves the static frontend.

Environment variables:
    PORT              - HTTP port (default: 3000)
    OPENCLAW_CRON_DIR - Path to OpenClaw cron directory (default: /data/cron)
    OPENCLAW_BIN      - Path to openclaw binary (default: openclaw)
"""

import os
import signal
import sys

from fastapi import FastAPI, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .cron_reader import read_jobs
from .run_history import get_run_history

PORT = int(os.environ.get("PORT", "3000"))
CRON_DIR = os.environ.get("OPENCLAW_CRON_DIR", "/data/cron")
OPENCLAW_BIN = os.environ.get("OPENCLAW_BIN", "openclaw")

PUBLIC_DIR = os.path.join(os.path.dirname(__file__), "..", "public")

app = FastAPI(
    title="OpenClaw Cron Dashboard",
    version="1.0.0",
    docs_url=None,  # disable Swagger UI in production
    redoc_url=None,
)

# CORS: allow any origin (self-hosted, users may proxy from another port)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "OPTIONS"],
    allow_headers=["Content-Type"],
)


# ─── API Routes ────────────────────────────────────────────────────────────────


@app.get("/api/health")
def health():
    """Simple health check. Returns service status and config paths."""
    import time

    return {
        "status": "ok",
        "version": "1.0.0",
        "config": {
            "cronDir": CRON_DIR,
            "openclawBin": OPENCLAW_BIN,
        },
        "timestamp": int(time.time() * 1000),
    }


@app.get("/api/jobs")
def jobs():
    """
    All cron jobs with enriched schedule info and current state.
    Reads directly from jobs.json — no CLI invocation needed.
    """
    import time

    try:
        job_list = read_jobs(CRON_DIR)
        return {
            "jobs": job_list,
            "count": len(job_list),
            "serverTime": int(time.time() * 1000),
            "serverTz": _get_server_tz(),
        }
    except Exception as e:
        return {"error": "Failed to read jobs", "message": str(e)}


@app.get("/api/jobs/{job_id}/runs")
def job_runs(job_id: str, limit: int = Query(default=50, le=200, ge=1)):
    """
    Run history for a specific job.
    Shells out to: openclaw cron runs --id <job_id>
    """
    try:
        entries, error = get_run_history(job_id, OPENCLAW_BIN, limit)

        return {
            "entries": entries,
            "count": len(entries),
            "jobId": job_id,
            "error": error,
        }
    except Exception as e:
        return {
            "error": "Failed to fetch run history",
            "message": str(e),
            "entries": [],
        }


# ─── Static file serving ──────────────────────────────────────────────────────

# Mount static files AFTER API routes so /api/* takes priority
app.mount("/", StaticFiles(directory=PUBLIC_DIR, html=True), name="static")


# ─── Helpers ───────────────────────────────────────────────────────────────────


def _get_server_tz() -> str:
    """Get the server's IANA timezone string."""
    try:
        import datetime

        return str(datetime.datetime.now().astimezone().tzinfo)
    except Exception:
        return "UTC"


# ─── Graceful shutdown ─────────────────────────────────────────────────────────


def _handle_sigterm(*_):
    print("Received SIGTERM, shutting down gracefully...")
    sys.exit(0)


signal.signal(signal.SIGTERM, _handle_sigterm)
