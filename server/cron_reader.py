"""
cron_reader.py
Reads and parses OpenClaw jobs.json, enriching each job with
human-readable schedule descriptions and 24-hour firing times
for timeline visualization.
"""

from __future__ import annotations

import json
import os
from datetime import datetime, timedelta
from typing import Any

from croniter import croniter


def read_jobs(cron_dir: str) -> list[dict]:
    """
    Read and enrich all jobs from jobs.json.
    Returns an empty list if the file doesn't exist or can't be parsed.
    """
    jobs_path = os.path.join(cron_dir, "jobs.json")

    if not os.path.exists(jobs_path):
        return []

    try:
        with open(jobs_path) as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError) as e:
        print(f"[cron_reader] Failed to read/parse jobs.json: {e}")
        return []

    # jobs.json may be an array or { jobs: [] }
    jobs = data if isinstance(data, list) else data.get("jobs", [])

    return [_enrich_job(job) for job in jobs]


def _enrich_job(job: dict) -> dict:
    """Enrich a raw job object with display-friendly fields."""
    schedule = job.get("schedule", {})
    state = job.get("state", {})
    payload = job.get("payload", {})
    delivery = job.get("delivery", {})

    return {
        "id": job.get("id"),
        "name": job.get("name") or job.get("id"),
        "agentId": job.get("agentId"),
        "enabled": job.get("enabled", True),
        "sessionTarget": job.get("sessionTarget"),
        # Schedule info
        "schedule": {
            "kind": schedule.get("kind"),
            "expr": schedule.get("expr"),
            "tz": schedule.get("tz"),
            "everyMs": schedule.get("everyMs"),
            "at": schedule.get("at"),
        },
        # Human-readable schedule string
        "scheduleHuman": _humanize_schedule(schedule),
        # Firing times as fractions of day [0, 1) for timeline rendering
        "firingFractions": _compute_firing_fractions(schedule),
        # Firing fractions per day of current week {"mon": [...], ...}
        "weeklyFiringFractions": compute_weekly_fractions(schedule),
        # Payload metadata
        "model": payload.get("model"),
        "channel": delivery.get("channel"),
        "deliveryMode": delivery.get("mode"),
        # Current state
        "state": {
            "nextRunAtMs": state.get("nextRunAtMs"),
            "lastRunAtMs": state.get("lastRunAtMs"),
            "lastRunStatus": state.get("lastRunStatus"),
            "consecutiveErrors": state.get("consecutiveErrors", 0),
            "lastDurationMs": state.get("lastDurationMs"),
            "lastDeliveryStatus": state.get("lastDeliveryStatus"),
        },
    }


# ─── Schedule Humanization ─────────────────────────────────────────────────────


def _humanize_schedule(schedule: dict) -> str:
    """
    Convert a schedule object to a human-readable string.
    e.g. "9:30, 12:30, 15:30 on weekdays (America/New_York)"
    """
    kind = schedule.get("kind")
    if not kind:
        return "Unknown"

    if kind == "cron":
        desc = _humanize_cron(schedule.get("expr", ""))
        tz = schedule.get("tz")
        return f"{desc} ({tz})" if tz else desc

    if kind == "every":
        return _humanize_every(schedule.get("everyMs", 0))

    if kind == "at":
        at_val = schedule.get("at")
        if not at_val:
            return "Once (no time set)"
        try:
            d = datetime.fromisoformat(str(at_val))
            return f"Once at {d}"
        except (ValueError, TypeError):
            return f"Once at {at_val}"

    return kind


def _humanize_cron(expr: str) -> str:
    """
    Humanize a 5-field cron expression.
    Handles common patterns; falls back to raw expression for edge cases.
    """
    if not expr:
        return "Invalid cron"

    parts = expr.strip().split()
    if len(parts) != 5:
        return expr

    min_f, hour_f, dom_f, _, dow_f = parts

    # Try to expand minute and hour fields to value lists
    hours = _expand_cron_field(hour_f, 0, 23)
    mins = _expand_cron_field(min_f, 0, 59)

    # Determine time part
    if hour_f == "*" and min_f == "*":
        time_part = "every minute"
    elif hour_f == "*" and min_f == "0":
        time_part = "every hour"
    elif hour_f == "*" and min_f.startswith("*/"):
        n = int(min_f[2:])
        time_part = f"every {n} minute{'s' if n != 1 else ''}"
    elif hour_f.startswith("*/") and min_f == "0":
        n = int(hour_f[2:])
        time_part = f"every {n} hour{'s' if n != 1 else ''}"
    elif hours is not None and mins is not None:
        times = [f"{h}:{m:02d}" for h in hours for m in mins]
        time_part = ", ".join(times)
    elif hour_f == "*" and mins is not None:
        min_str = ", ".join(f":{m:02d}" for m in mins)
        time_part = f"every hour at {min_str}"
    else:
        time_part = f"{min_f} {hour_f}"

    # Day-of-week
    day_names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]

    if dow_f == "*" and dom_f == "*":
        day_part = "daily"
    elif dow_f == "1-5":
        day_part = "on weekdays"
    elif dow_f in ("6-7", "0,6", "6,0", "0,7"):
        day_part = "on weekends"
    elif dow_f != "*":
        days = _expand_cron_field(dow_f, 0, 7)
        if days is not None:
            names = [day_names[d % 7] for d in days]
            day_part = f"on {', '.join(names)}"
        else:
            day_part = f"on day {dow_f}"
    elif dom_f != "*":
        day_part = f"on day {dom_f} of month"
    else:
        day_part = ""

    return f"{time_part} {day_part}".strip()


def _expand_cron_field(field: str, min_val: int, max_val: int) -> list[int] | None:
    """
    Expand a cron field (e.g. "9,12,15", "1-5", "*/2") into
    a sorted list of integer values. Returns None for wildcard/complex fields.
    """
    if not field or field == "*":
        return None

    values: set[int] = set()

    for part in field.split(","):
        if "/" in part:
            range_part, step_str = part.split("/", 1)
            try:
                step = int(step_str)
            except ValueError:
                return None
            start = min_val if range_part == "*" else int(range_part)
            for i in range(start, max_val + 1, step):
                values.add(i)
        elif "-" in part:
            try:
                start, end = (int(x) for x in part.split("-", 1))
            except ValueError:
                return None
            for i in range(start, end + 1):
                values.add(i)
        else:
            try:
                values.add(int(part))
            except ValueError:
                return None

    return sorted(values)


def _humanize_every(ms: Any) -> str:
    """Humanize an 'every N ms' schedule."""
    try:
        ms = int(ms)
    except (TypeError, ValueError):
        return "Unknown interval"

    if ms <= 0:
        return "Unknown interval"

    total_seconds = ms // 1000
    total_minutes = total_seconds // 60
    total_hours = total_minutes // 60

    if total_hours >= 1 and total_minutes % 60 == 0:
        return f"Every {total_hours} hour{'s' if total_hours != 1 else ''}"
    if total_minutes >= 1 and total_seconds % 60 == 0:
        return f"Every {total_minutes} minute{'s' if total_minutes != 1 else ''}"
    if total_seconds >= 1:
        return f"Every {total_seconds} second{'s' if total_seconds != 1 else ''}"
    return f"Every {ms}ms"


# ─── Timeline Firing Fractions ─────────────────────────────────────────────────


def _compute_firing_fractions(schedule: dict) -> list[float]:
    """
    Compute firing times as fractions of the current day [0, 1).
    Used by the frontend timeline.
    """
    kind = schedule.get("kind")
    if not kind:
        return []

    if kind == "cron":
        return _compute_cron_fractions(schedule.get("expr"), schedule.get("tz"))

    if kind == "every":
        ms = schedule.get("everyMs")
        if not ms or ms <= 0:
            return []
        day_ms = 24 * 60 * 60 * 1000
        fractions = []
        t = ms
        while t < day_ms:
            fractions.append(t / day_ms)
            t += ms
        return fractions

    if kind == "at":
        at_val = schedule.get("at")
        if not at_val:
            return []
        try:
            d = datetime.fromisoformat(str(at_val))
            midnight = d.replace(hour=0, minute=0, second=0, microsecond=0)
            frac = (d - midnight).total_seconds() / 86400
            return [frac] if 0 <= frac < 1 else []
        except (ValueError, TypeError):
            return []

    return []


def _compute_cron_fractions(expr: str | None, tz: str | None) -> list[float]:
    """
    Compute all cron firing fractions for today (midnight → midnight).
    Uses croniter to iterate over the day's firing times.
    """
    if not expr:
        return []

    try:
        import zoneinfo

        now = datetime.now()

        # If the job has a timezone, compute fractions in that timezone
        if tz:
            try:
                tzinfo = zoneinfo.ZoneInfo(tz)
                now = datetime.now(tzinfo)
            except (KeyError, Exception):
                pass  # fall back to server local time

        start_of_day = now.replace(hour=0, minute=0, second=0, microsecond=0)
        end_of_day = start_of_day + timedelta(days=1)

        # Start iteration from just before midnight
        iter_start = start_of_day - timedelta(seconds=1)
        cron = croniter(expr, iter_start)

        fractions: list[float] = []
        for _ in range(300):  # safety cap
            next_time = cron.get_next(datetime)
            if next_time >= end_of_day:
                break
            if next_time >= start_of_day:
                frac = (next_time - start_of_day).total_seconds() / 86400
                if 0 <= frac < 1:
                    fractions.append(frac)

        return fractions

    except Exception:
        return []


# ─── Weekly Firing Fractions ───────────────────────────────────────────────────


_WEEK_DAY_KEYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]


def compute_weekly_fractions(schedule: dict) -> dict[str, list[float]]:
    """
    Compute firing times as fractions of each day for the current week (Mon-Sun).
    Returns a dict like {"mon": [0.39, 0.52], "tue": [...], ...}
    where each value is a list of fractions in [0, 1).
    """
    kind = schedule.get("kind")
    empty = {k: [] for k in _WEEK_DAY_KEYS}

    if not kind:
        return empty

    if kind == "cron":
        return _compute_weekly_cron_fractions(
            schedule.get("expr"), schedule.get("tz")
        )

    if kind == "every":
        # Interval-based: same firing pattern every day
        fracs = _compute_firing_fractions(schedule)
        return {k: fracs for k in _WEEK_DAY_KEYS}

    if kind == "at":
        # One-shot: only fires on the specific date if it's this week
        at_val = schedule.get("at")
        if not at_val:
            return empty
        try:
            from datetime import date as _date

            d = datetime.fromisoformat(str(at_val))
            today = _date.today()
            monday = today - timedelta(days=today.weekday())
            sunday = monday + timedelta(days=6)

            fire_date = d.date() if hasattr(d, "date") else today
            if not (monday <= fire_date <= sunday):
                return empty

            day_idx = fire_date.weekday()  # 0=Mon, 6=Sun
            midnight = d.replace(hour=0, minute=0, second=0, microsecond=0)
            frac = (d - midnight).total_seconds() / 86400
            result = {k: [] for k in _WEEK_DAY_KEYS}
            if 0 <= frac < 1:
                result[_WEEK_DAY_KEYS[day_idx]] = [frac]
            return result
        except (ValueError, TypeError):
            return empty

    return empty


def _compute_weekly_cron_fractions(
    expr: str | None, tz: str | None
) -> dict[str, list[float]]:
    """
    Compute cron firing fractions for each day of the current week (Mon-Sun).
    Accounts for day-of-week restrictions in the cron expression.
    """
    empty = {k: [] for k in _WEEK_DAY_KEYS}
    if not expr:
        return empty

    try:
        import zoneinfo
        from datetime import date as _date

        today = _date.today()
        monday = today - timedelta(days=today.weekday())

        tzinfo = None
        if tz:
            try:
                tzinfo = zoneinfo.ZoneInfo(tz)
            except Exception:
                pass

        result: dict[str, list[float]] = {}
        for i, key in enumerate(_WEEK_DAY_KEYS):
            day_date = monday + timedelta(days=i)

            if tzinfo:
                start_of_day = datetime(
                    day_date.year, day_date.month, day_date.day,
                    0, 0, 0, tzinfo=tzinfo,
                )
            else:
                start_of_day = datetime(
                    day_date.year, day_date.month, day_date.day, 0, 0, 0
                )

            end_of_day = start_of_day + timedelta(days=1)
            iter_start = start_of_day - timedelta(seconds=1)
            cron = croniter(expr, iter_start)

            fractions: list[float] = []
            for _ in range(300):  # safety cap
                next_time = cron.get_next(datetime)
                if next_time >= end_of_day:
                    break
                if next_time >= start_of_day:
                    frac = (next_time - start_of_day).total_seconds() / 86400
                    if 0 <= frac < 1:
                        fractions.append(frac)

            result[key] = fractions

        return result

    except Exception:
        return empty
