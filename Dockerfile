# ─── OpenClaw Cron Dashboard ─────────────────────────────────────────────────
# Multi-stage build: install dependencies then copy only what's needed.

# ── Stage 1: Install dependencies ─────────────────────────────────────────────
FROM python:3.12-slim AS deps

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir --target=/app/deps -r requirements.txt

# ── Stage 2: Runtime image ────────────────────────────────────────────────────
FROM python:3.12-slim AS runtime

# Add a non-root user for security
RUN groupadd -r dashboard && useradd -r -g dashboard dashboard

WORKDIR /app

# Copy installed dependencies from build stage
COPY --from=deps /app/deps /app/deps

# Copy application source
COPY server/   ./server/
COPY public/   ./public/

# Mount point for OpenClaw cron data (bind-mount ~/.openclaw/cron here)
RUN mkdir -p /data/cron && chown dashboard:dashboard /data/cron

# Add deps to Python path
ENV PYTHONPATH=/app/deps:/app

# Switch to non-root user
USER dashboard

# ─── Environment defaults ─────────────────────────────────────────────────────
# Override these at runtime:
#   docker run -e OPENCLAW_CRON_DIR=/data/cron \
#              -e OPENCLAW_BIN=openclaw \
#              -e PORT=3000 ...
ENV PORT=3000 \
    OPENCLAW_CRON_DIR=/data/cron \
    OPENCLAW_BIN=openclaw

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:${PORT}/api/health')" || exit 1

CMD python -m uvicorn server.main:app --host 0.0.0.0 --port ${PORT}
