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

from fastapi import FastAPI, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.base import BaseHTTPMiddleware

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


# No-cache for static assets so code updates take effect immediately
class NoCacheStaticMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        response = await call_next(request)
        if not request.url.path.startswith("/api/"):
            response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
            response.headers["Pragma"] = "no-cache"
        return response


app.add_middleware(NoCacheStaticMiddleware)


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
        entries, error = get_run_history(job_id, CRON_DIR, OPENCLAW_BIN, limit)

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


@app.get("/api/weekly-runs")
def weekly_runs():
    """
    Run statuses for the past 7 days, bucketed by job and calendar day (UTC).
    Returns:
      {
        "days": ["2026-04-03", ...],   # 7 dates Mon→Sun of current week
        "jobs": {
          "<jobId>": {
            "2026-04-03": [{"status": "ok", "ts": 1234567890000}, ...],
            ...
          }
        }
      }
    """
    import json
    import time
    from datetime import datetime, timedelta, timezone
    from pathlib import Path

    now_utc = datetime.now(timezone.utc)
    # Build the 7-day window: today minus 6 days → today
    cutoff_dt = now_utc - timedelta(days=7)
    cutoff_ms = int(cutoff_dt.timestamp() * 1000)

    # Collect dates for current week Mon-Sun (calendar dates in UTC)
    today_date = now_utc.date()
    monday = today_date - timedelta(days=today_date.weekday())
    days = [(monday + timedelta(days=i)).isoformat() for i in range(7)]
    days_set = set(days)

    runs_dir = Path(CRON_DIR) / "runs"
    jobs_data: dict[str, dict[str, list[dict]]] = {}

    if runs_dir.exists():
        try:
            for run_file in runs_dir.iterdir():
                if run_file.suffix != ".jsonl":
                    continue
                try:
                    with open(run_file) as f:
                        for line in f:
                            line = line.strip()
                            if not line:
                                continue
                            try:
                                entry = json.loads(line)
                            except json.JSONDecodeError:
                                continue

                            ts = entry.get("ts") or entry.get("runAtMs")
                            if not ts or ts < cutoff_ms:
                                continue

                            job_id = entry.get("jobId")
                            if not job_id:
                                continue

                            day = datetime.fromtimestamp(
                                ts / 1000, tz=timezone.utc
                            ).strftime("%Y-%m-%d")
                            if day not in days_set:
                                continue

                            if job_id not in jobs_data:
                                jobs_data[job_id] = {}
                            if day not in jobs_data[job_id]:
                                jobs_data[job_id][day] = []

                            # Truncate summary for tooltip display
                            summary = entry.get("summary") or ""
                            if len(summary) > 200:
                                summary = summary[:200] + "…"

                            jobs_data[job_id][day].append({
                                "status": entry.get("status"),
                                "ts": ts,
                                "durationMs": entry.get("durationMs"),
                                "summary": summary,
                            })
                except (OSError, PermissionError):
                    continue
        except (OSError, PermissionError):
            pass

    return {"days": days, "jobs": jobs_data}


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
