"""
run_history.py
Fetches run history for a cron job by shelling out to the OpenClaw CLI.
Parses JSON from stdout, ignoring stderr config warnings.
"""

from __future__ import annotations

import json
import re
import subprocess


# Job IDs must be UUID-like: alphanumeric and hyphens only
_VALID_JOB_ID = re.compile(r"^[a-zA-Z0-9-]+$")


def get_run_history(
    job_id: str, openclaw_bin: str = "openclaw", limit: int = 50
) -> tuple[list[dict], str | None]:
    """
    Fetch run history for a given job ID.
    Shells out to: openclaw cron runs --id <jobId>

    Returns:
        (entries, error) — entries is a list of normalized run dicts,
        error is a string message or None.
    """
    if not job_id or not isinstance(job_id, str):
        return [], "Invalid job ID"

    if not _VALID_JOB_ID.match(job_id):
        return [], "Invalid job ID format"

    try:
        result = subprocess.run(
            [openclaw_bin, "cron", "runs", "--id", job_id],
            capture_output=True,
            text=True,
            timeout=15,
        )
    except FileNotFoundError:
        return [], f"OpenClaw binary not found: {openclaw_bin}"
    except subprocess.TimeoutExpired:
        return [], "CLI timed out after 15 seconds"
    except Exception as e:
        print(f"[run_history] subprocess failed for job {job_id}: {e}")
        return [], f"CLI execution failed: {e}"

    stdout = (result.stdout or "").strip()
    if not stdout:
        return [], None

    # Filter config warning lines from stdout before JSON parsing
    json_lines = "\n".join(
        line
        for line in stdout.splitlines()
        if not line.startswith("Config was last written")
    ).strip()

    if not json_lines:
        return [], None

    try:
        parsed = json.loads(json_lines)
    except json.JSONDecodeError as e:
        print(f"[run_history] JSON parse failed for job {job_id}: {e}")
        return [], "Failed to parse CLI output as JSON"

    raw_entries = parsed if isinstance(parsed, list) else parsed.get("entries", [])

    entries = [_normalize_entry(e) for e in raw_entries[:limit]]

    return entries, None


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
