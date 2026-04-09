"""
run_history.py
Reads run history for a cron job directly from JSONL files on disk.
Falls back to OpenClaw CLI if direct file reading isn't available.
"""

from __future__ import annotations

import json
import os
import re
from pathlib import Path


# Job IDs must be UUID-like: alphanumeric and hyphens only
_VALID_JOB_ID = re.compile(r"^[a-zA-Z0-9-]+$")


def get_run_history(
    job_id: str,
    cron_dir: str = "/data/cron",
    openclaw_bin: str = "openclaw",
    limit: int = 50,
) -> tuple[list[dict], str | None]:
    """
    Fetch run history for a given job ID.
    Reads directly from JSONL run files in the cron directory.

    Returns:
        (entries, error) — entries is a list of normalized run dicts,
        error is a string message or None.
    """
    if not job_id or not isinstance(job_id, str):
        return [], "Invalid job ID"

    if not _VALID_JOB_ID.match(job_id):
        return [], "Invalid job ID format"

    runs_dir = Path(cron_dir) / "runs"
    if not runs_dir.exists():
        return [], None

    # Collect all run entries for this job from all JSONL files
    entries: list[dict] = []

    try:
        for run_file in runs_dir.iterdir():
            if not run_file.suffix == ".jsonl":
                continue
            try:
                with open(run_file, "r") as f:
                    for line in f:
                        line = line.strip()
                        if not line:
                            continue
                        try:
                            entry = json.loads(line)
                            if entry.get("jobId") == job_id:
                                entries.append(entry)
                        except json.JSONDecodeError:
                            continue
            except (OSError, PermissionError):
                continue
    except (OSError, PermissionError) as e:
        return [], f"Cannot read runs directory: {e}"

    # Sort by timestamp descending (most recent first)
    entries.sort(key=lambda e: e.get("ts", 0), reverse=True)

    # Normalize and limit
    normalized = [_normalize_entry(e) for e in entries[:limit]]

    return normalized, None


def _normalize_entry(entry: dict) -> dict:
    """
    Normalize a raw run entry into a consistent shape.
    Strips fields we don't need and ensures all expected fields are present.
    """
    usage = entry.get("usage")
    normalized_usage = None
    if usage:
        normalized_usage = {
            "inputTokens": usage.get("input_tokens", 0),
            "outputTokens": usage.get("output_tokens", 0),
            "totalTokens": usage.get("total_tokens", 0),
        }

    return {
        "ts": entry.get("ts"),
        "runAtMs": entry.get("runAtMs") or entry.get("ts"),
        "action": entry.get("action"),
        "status": entry.get("status"),
        "summary": entry.get("summary"),
        "durationMs": entry.get("durationMs"),
        "model": entry.get("model"),
        "provider": entry.get("provider"),
        "usage": normalized_usage,
        "delivered": entry.get("delivered"),
        "deliveryStatus": entry.get("deliveryStatus"),
        "sessionId": entry.get("sessionId"),
    }
