/**
 * OpenClaw Cron Dashboard — Frontend
 *
 * Fetches job data from the local API, renders a 24h timeline,
 * job cards, and a run history panel with output summaries.
 * Auto-refreshes every 30 seconds.
 */

'use strict';

// ─── Configuration ────────────────────────────────────────────────────────────

const REFRESH_INTERVAL_MS = 30_000; // 30 seconds
const API_BASE = ''; // same origin

// ─── State ────────────────────────────────────────────────────────────────────

let allJobs = [];
let weeklyData = null;
let activeView = 'today'; // 'today' | 'week'
let serverTz = null;
let activeJobId = null;
let refreshTimer = null;
let countdownTimer = null;
let countdownRemaining = REFRESH_INTERVAL_MS;

// Tooltip hitbox tracking: arrays of { x, y, r, data } for each canvas
let dailyDotHits = [];
let weeklyDotHits = [];

// ─── DOM refs ─────────────────────────────────────────────────────────────────

const $ = id => document.getElementById(id);

const dom = {
  statusDot:        $('status-dot'),
  lastUpdated:      $('last-updated'),
  refreshBtn:       $('refresh-btn'),
  refreshBar:       $('refresh-bar'),
  refreshCountdown: $('refresh-countdown'),
  loadingState:     $('loading-state'),
  errorState:       $('error-state'),
  errorMessage:     $('error-message'),
  emptyState:       $('empty-state'),
  emptyCronDir:     $('empty-cron-dir'),
  jobsGrid:         $('jobs-grid'),
  jobsCountBadge:   $('jobs-count-badge'),
  statTotal:        $('stat-total'),
  statOk:           $('stat-ok'),
  statErrors:       $('stat-errors'),
  statDisabled:     $('stat-disabled'),
  timelineTzBadge:  $('timeline-tz-badge'),
  timelineCanvas:   $('timeline-canvas'),
  weeklyCanvas:     $('weekly-canvas'),
  tabToday:         $('tab-today'),
  tabWeek:          $('tab-week'),
  timelineDaily:    $('timeline-daily'),
  timelineWeekly:   $('timeline-weekly'),
  panelOverlay:     $('panel-overlay'),
  runPanel:         $('run-panel'),
  panelJobName:     $('panel-job-name'),
  panelJobSchedule: $('panel-job-schedule'),
  panelBody:        $('panel-body'),
  panelCloseBtn:    $('panel-close-btn'),
  toastContainer:   $('toast-container'),
  tooltip:          $('canvas-tooltip'),
};

// ─── Bootstrap ────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  setupEventListeners();
  loadJobs();
  startAutoRefresh();
});

// ─── Event Listeners ─────────────────────────────────────────────────────────

function setupEventListeners() {
  dom.refreshBtn.addEventListener('click', () => {
    resetAutoRefresh();
    loadJobs();
  });

  dom.panelCloseBtn.addEventListener('click', closePanel);
  dom.panelOverlay.addEventListener('click', closePanel);

  dom.tabToday.addEventListener('click', () => switchView('today'));
  dom.tabWeek.addEventListener('click', () => switchView('week'));

  // Canvas tooltip hover
  dom.timelineCanvas.addEventListener('mousemove', e => handleCanvasHover(e, dom.timelineCanvas, dailyDotHits));
  dom.timelineCanvas.addEventListener('mouseleave', hideTooltip);
  dom.weeklyCanvas.addEventListener('mousemove', e => handleCanvasHover(e, dom.weeklyCanvas, weeklyDotHits));
  dom.weeklyCanvas.addEventListener('mouseleave', hideTooltip);

  // Keyboard shortcuts
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closePanel();
    if (e.key === 'r' && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
      const active = document.activeElement;
      const isInput = active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA');
      if (!isInput) {
        resetAutoRefresh();
        loadJobs();
      }
    }
  });
}

// ─── Data Fetching ────────────────────────────────────────────────────────────

async function loadJobs() {
  setStatus('loading');
  dom.refreshBtn.classList.add('spinning');

  try {
    const [jobsRes, weeklyRes] = await Promise.all([
      fetch(`${API_BASE}/api/jobs`),
      fetch(`${API_BASE}/api/weekly-runs`).catch(() => null),
    ]);

    if (!jobsRes.ok) throw new Error(`HTTP ${jobsRes.status}: ${jobsRes.statusText}`);

    const data = await jobsRes.json();
    allJobs = data.jobs || [];
    serverTz = data.serverTz || null;

    if (weeklyRes && weeklyRes.ok) {
      weeklyData = await weeklyRes.json();
    }

    renderAll(allJobs);
    setStatus('ok');
    dom.lastUpdated.textContent = `Updated ${formatTimeAgo(Date.now())}`;
  } catch (err) {
    console.error('[dashboard] Failed to load jobs:', err);
    setStatus('error');
    showError(err.message);
  } finally {
    dom.refreshBtn.classList.remove('spinning');
  }
}

async function loadRunHistory(jobId) {
  const res = await fetch(`${API_BASE}/api/jobs/${encodeURIComponent(jobId)}/runs`);
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  return res.json();
}

// ─── Rendering ────────────────────────────────────────────────────────────────

function renderAll(jobs) {
  // Update stats
  const enabled = jobs.filter(j => j.enabled);
  const disabled = jobs.filter(j => !j.enabled);
  const okJobs = jobs.filter(j => j.state?.lastRunStatus === 'ok');
  const errJobs = jobs.filter(j => j.state?.consecutiveErrors > 0);

  dom.statTotal.textContent = jobs.length;
  dom.statOk.textContent = okJobs.length;
  dom.statErrors.textContent = errJobs.length;
  dom.statDisabled.textContent = disabled.length;
  dom.jobsCountBadge.textContent = jobs.length;

  // Timeline
  if (serverTz) {
    dom.timelineTzBadge.textContent = serverTz;
  }
  renderTimeline(jobs);
  if (activeView === 'week') {
    renderWeeklyTimeline(jobs, weeklyData);
  }

  // Job cards
  renderJobCards(jobs);

  // Show appropriate state
  dom.loadingState.classList.add('hidden');
  dom.errorState.classList.add('hidden');

  if (jobs.length === 0) {
    dom.emptyState.classList.remove('hidden');
    dom.jobsGrid.innerHTML = '';
  } else {
    dom.emptyState.classList.add('hidden');
  }
}

function showError(message) {
  dom.loadingState.classList.add('hidden');
  dom.emptyState.classList.add('hidden');
  dom.errorState.classList.remove('hidden');
  dom.errorMessage.textContent = message || 'Unknown error';
}

// ─── Timeline ─────────────────────────────────────────────────────────────────

/**
 * Draw the 24-hour schedule timeline on a canvas element.
 * Each job gets a row; firing times are shown as colored dots.
 * The current time is marked with a vertical line.
 */
function renderTimeline(jobs) {
  const canvas = dom.timelineCanvas;
  const ctx = canvas.getContext('2d');
  dailyDotHits = [];  // reset hitboxes

  const enabledJobs = jobs.filter(j => j.enabled && j.firingFractions?.length > 0);

  // Layout constants
  const PADDING_LEFT  = 140; // space for job names
  const PADDING_RIGHT = 20;
  const HOUR_LABEL_HEIGHT = 28;
  const ROW_HEIGHT = 28;
  const DOT_RADIUS = 4;
  const NOW_LINE_WIDTH = 1.5;

  const totalRows = Math.max(enabledJobs.length, 1);
  const canvasHeight = HOUR_LABEL_HEIGHT + totalRows * ROW_HEIGHT + 16;

  // Use device pixel ratio for sharp rendering on HiDPI screens
  const dpr = window.devicePixelRatio || 1;
  const displayWidth = canvas.parentElement.clientWidth || 800;

  canvas.width = displayWidth * dpr;
  canvas.height = canvasHeight * dpr;
  canvas.style.width = `${displayWidth}px`;
  canvas.style.height = `${canvasHeight}px`;
  ctx.scale(dpr, dpr);

  const trackWidth = displayWidth - PADDING_LEFT - PADDING_RIGHT;

  // CSS custom property colors (read from computed style)
  const style = getComputedStyle(document.documentElement);
  const colors = {
    bgSurface:    style.getPropertyValue('--bg-surface').trim()  || '#161b22',
    border:       style.getPropertyValue('--border').trim()      || '#30363d',
    textMuted:    style.getPropertyValue('--text-muted').trim()  || '#6e7681',
    textSecondary:style.getPropertyValue('--text-secondary').trim() || '#8b949e',
    textPrimary:  style.getPropertyValue('--text-primary').trim() || '#e6edf3',
    accent:       style.getPropertyValue('--accent').trim()      || '#58a6ff',
    green:        style.getPropertyValue('--green').trim()       || '#3fb950',
    red:          style.getPropertyValue('--red').trim()         || '#f85149',
    yellow:       style.getPropertyValue('--yellow').trim()      || '#d29922',
  };

  // Background
  ctx.fillStyle = colors.bgSurface;
  ctx.fillRect(0, 0, displayWidth, canvasHeight);

  // Hour grid lines and labels
  const hours = [0, 3, 6, 9, 12, 15, 18, 21, 24];
  ctx.font = `11px ${getComputedStyle(document.body).getPropertyValue('font-family')}`;
  ctx.textAlign = 'center';

  for (const hour of hours) {
    const x = PADDING_LEFT + (hour / 24) * trackWidth;

    // Vertical grid line
    ctx.strokeStyle = colors.border;
    ctx.lineWidth = hour === 0 || hour === 24 ? 1.5 : 0.5;
    ctx.beginPath();
    ctx.moveTo(x, HOUR_LABEL_HEIGHT - 6);
    ctx.lineTo(x, canvasHeight - 4);
    ctx.stroke();

    // Hour label
    ctx.fillStyle = colors.textMuted;
    const label = hour === 24 ? '0' : String(hour).padStart(2, '0') + ':00';
    ctx.fillText(label, x, 16);
  }

  // No jobs with firing times — show placeholder
  if (enabledJobs.length === 0) {
    ctx.fillStyle = colors.textMuted;
    ctx.textAlign = 'center';
    ctx.font = `13px ${getComputedStyle(document.body).getPropertyValue('font-family')}`;
    ctx.fillText('No scheduled jobs with computable firing times', displayWidth / 2, HOUR_LABEL_HEIGHT + ROW_HEIGHT * 0.7);
    return;
  }

  // Draw rows for each job
  enabledJobs.forEach((job, rowIdx) => {
    const y = HOUR_LABEL_HEIGHT + rowIdx * ROW_HEIGHT;
    const rowCenterY = y + ROW_HEIGHT / 2;

    // Alternating row background
    if (rowIdx % 2 === 1) {
      ctx.fillStyle = 'rgba(255,255,255,0.02)';
      ctx.fillRect(0, y, displayWidth, ROW_HEIGHT);
    }

    // Track line
    ctx.strokeStyle = colors.border;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(PADDING_LEFT, rowCenterY);
    ctx.lineTo(PADDING_LEFT + trackWidth, rowCenterY);
    ctx.stroke();

    // Job name label (truncated)
    const maxNameWidth = PADDING_LEFT - 12;
    ctx.fillStyle = colors.textSecondary;
    ctx.textAlign = 'right';
    ctx.font = `12px ${getComputedStyle(document.body).getPropertyValue('font-family')}`;
    const displayName = truncateText(ctx, job.name, maxNameWidth);
    ctx.fillText(displayName, PADDING_LEFT - 10, rowCenterY + 4);

    // Determine dot color based on last status
    const lastStatus = job.state?.lastRunStatus;
    let dotColor;
    if (lastStatus === 'ok')       dotColor = colors.green;
    else if (lastStatus === 'error') dotColor = colors.red;
    else                             dotColor = colors.accent;

    // Draw dots at each firing time
    const fractions = job.firingFractions || [];
    for (const fraction of fractions) {
      const dotX = PADDING_LEFT + fraction * trackWidth;

      // Glow effect
      const gradient = ctx.createRadialGradient(dotX, rowCenterY, 0, dotX, rowCenterY, DOT_RADIUS * 2.5);
      gradient.addColorStop(0, dotColor + 'aa');
      gradient.addColorStop(1, dotColor + '00');
      ctx.fillStyle = gradient;
      ctx.beginPath();
      ctx.arc(dotX, rowCenterY, DOT_RADIUS * 2.5, 0, Math.PI * 2);
      ctx.fill();

      // Solid dot
      ctx.fillStyle = dotColor;
      ctx.beginPath();
      ctx.arc(dotX, rowCenterY, DOT_RADIUS, 0, Math.PI * 2);
      ctx.fill();

      // Record hitbox for tooltip
      const hours = Math.floor(fraction * 24);
      const mins = Math.floor((fraction * 24 - hours) * 60);
      dailyDotHits.push({
        x: dotX, y: rowCenterY, r: DOT_RADIUS * 2.5,
        data: {
          name: job.name,
          time: `${String(hours).padStart(2,'0')}:${String(mins).padStart(2,'0')}`,
          status: lastStatus,
          schedule: job.scheduleHuman || '',
        }
      });
    }
  });

  // Current time indicator
  const now = new Date();
  const nowFraction = (now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds()) / 86400;
  const nowX = PADDING_LEFT + nowFraction * trackWidth;

  ctx.strokeStyle = colors.red + 'cc';
  ctx.lineWidth = NOW_LINE_WIDTH;
  ctx.setLineDash([4, 3]);
  ctx.beginPath();
  ctx.moveTo(nowX, HOUR_LABEL_HEIGHT - 6);
  ctx.lineTo(nowX, canvasHeight - 4);
  ctx.stroke();
  ctx.setLineDash([]);

  // Current time label
  ctx.fillStyle = colors.red;
  ctx.textAlign = 'center';
  ctx.font = `bold 10px ${getComputedStyle(document.body).getPropertyValue('font-family')}`;
  const nowLabel = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
  ctx.fillText(nowLabel, Math.min(Math.max(nowX, 25), displayWidth - 25), 10);
}

// --- View Toggle -----------------------------------------------------------

/**
 * Switch between Today and Week views.
 */
function switchView(view) {
  activeView = view;
  const isToday = view === 'today';

  dom.tabToday.classList.toggle('active', isToday);
  dom.tabToday.setAttribute('aria-selected', String(isToday));
  dom.tabWeek.classList.toggle('active', !isToday);
  dom.tabWeek.setAttribute('aria-selected', String(!isToday));

  dom.timelineDaily.classList.toggle('hidden', !isToday);
  dom.timelineWeekly.classList.toggle('hidden', isToday);

  if (!isToday && allJobs.length > 0) {
    renderWeeklyTimeline(allJobs, weeklyData);
  }
}

// --- Weekly Timeline --------------------------------------------------------

/**
 * Draw the weekly schedule timeline: 7 day-columns, one row per job.
 * Dots are color-coded by actual run status from weeklyRunsData.
 */
function renderWeeklyTimeline(jobs, weeklyRunsData) {
  const canvas = dom.weeklyCanvas;
  const ctx = canvas.getContext('2d');
  weeklyDotHits = [];  // reset hitboxes

  const enabledJobs = jobs.filter(j => j.enabled && j.weeklyFiringFractions);

  const PADDING_LEFT     = 140;
  const PADDING_RIGHT    = 20;
  const DAY_LABEL_HEIGHT = 32;
  const ROW_HEIGHT       = 28;
  const DOT_RADIUS       = 3.5;
  const MIN_COL_WIDTH    = 80;
  const NUM_DAYS         = 7;

  const totalRows = Math.max(enabledJobs.length, 1);
  const canvasHeight = DAY_LABEL_HEIGHT + totalRows * ROW_HEIGHT + 16;

  const dpr = window.devicePixelRatio || 1;
  // Canvas must be at least wide enough for 7 columns; can grow wider
  const containerWidth = canvas.parentElement.clientWidth || 800;
  const displayWidth = Math.max(
    containerWidth,
    PADDING_LEFT + NUM_DAYS * MIN_COL_WIDTH + PADDING_RIGHT
  );

  canvas.width  = displayWidth * dpr;
  canvas.height = canvasHeight * dpr;
  canvas.style.width  = `${displayWidth}px`;
  canvas.style.height = `${canvasHeight}px`;
  ctx.scale(dpr, dpr);

  const trackWidth = displayWidth - PADDING_LEFT - PADDING_RIGHT;
  const colWidth   = trackWidth / NUM_DAYS;

  // Current week dates Mon-Sun (local)
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const mondayOffset = (today.getDay() + 6) % 7; // Mon=0 … Sun=6
  const monday = new Date(today);
  monday.setDate(today.getDate() - mondayOffset);

  const weekDates = Array.from({ length: NUM_DAYS }, (_, i) => {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    return d;
  });

  const todayStr  = today.toISOString().slice(0, 10);
  const dayKeys   = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
  const dayLabels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  // Read CSS custom property colors
  const style  = getComputedStyle(document.documentElement);
  const colors = {
    bgSurface:     style.getPropertyValue('--bg-surface').trim()     || '#161b22',
    border:        style.getPropertyValue('--border').trim()         || '#30363d',
    textMuted:     style.getPropertyValue('--text-muted').trim()     || '#6e7681',
    textSecondary: style.getPropertyValue('--text-secondary').trim() || '#8b949e',
    textPrimary:   style.getPropertyValue('--text-primary').trim()   || '#e6edf3',
    accent:        style.getPropertyValue('--accent').trim()         || '#58a6ff',
    green:         style.getPropertyValue('--green').trim()          || '#3fb950',
    red:           style.getPropertyValue('--red').trim()            || '#f85149',
  };
  const fontFamily = getComputedStyle(document.body).getPropertyValue('font-family');

  // Background
  ctx.fillStyle = colors.bgSurface;
  ctx.fillRect(0, 0, displayWidth, canvasHeight);

  // --- Day columns: highlight, separators, labels ---
  weekDates.forEach((date, colIdx) => {
    const colX    = PADDING_LEFT + colIdx * colWidth;
    const dateStr = date.toISOString().slice(0, 10);
    const isToday = dateStr === todayStr;

    // Today's column highlight
    if (isToday) {
      ctx.fillStyle = 'rgba(88, 166, 255, 0.06)';
      ctx.fillRect(colX, 0, colWidth, canvasHeight);
    }

    // Vertical separator (skip leftmost — that's the name/track boundary)
    if (colIdx > 0) {
      ctx.strokeStyle = colors.border;
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      ctx.moveTo(colX, 0);
      ctx.lineTo(colX, canvasHeight);
      ctx.stroke();
    }

    // Day label: "Mon 4/7"
    const monthDay = `${date.getMonth() + 1}/${date.getDate()}`;
    ctx.textAlign = 'center';
    ctx.font = `${isToday ? '600' : '400'} 11px ${fontFamily}`;
    ctx.fillStyle = isToday ? colors.accent : colors.textMuted;
    ctx.fillText(`${dayLabels[colIdx]} ${monthDay}`, colX + colWidth / 2, 18);
  });

  // Left name-column border
  ctx.strokeStyle = colors.border;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(PADDING_LEFT, 0);
  ctx.lineTo(PADDING_LEFT, canvasHeight);
  ctx.stroke();

  // Header / body separator
  ctx.strokeStyle = colors.border;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, DAY_LABEL_HEIGHT);
  ctx.lineTo(displayWidth, DAY_LABEL_HEIGHT);
  ctx.stroke();

  // Empty state
  if (enabledJobs.length === 0) {
    ctx.fillStyle = colors.textMuted;
    ctx.textAlign = 'center';
    ctx.font = `13px ${fontFamily}`;
    ctx.fillText(
      'No scheduled jobs with computable firing times',
      displayWidth / 2,
      DAY_LABEL_HEIGHT + ROW_HEIGHT * 0.7
    );
    return;
  }

  // --- Job rows ---
  enabledJobs.forEach((job, rowIdx) => {
    const y         = DAY_LABEL_HEIGHT + rowIdx * ROW_HEIGHT;
    const rowCenterY = y + ROW_HEIGHT / 2;

    // Alternating row background
    if (rowIdx % 2 === 1) {
      ctx.fillStyle = 'rgba(255,255,255,0.02)';
      ctx.fillRect(0, y, displayWidth, ROW_HEIGHT);
    }

    // Job name label (right-aligned, truncated)
    const maxNameWidth = PADDING_LEFT - 12;
    ctx.fillStyle   = colors.textSecondary;
    ctx.textAlign   = 'right';
    ctx.font        = `12px ${fontFamily}`;
    const displayName = truncateText(ctx, job.name, maxNameWidth);
    ctx.fillText(displayName, PADDING_LEFT - 10, rowCenterY + 4);

    // --- Day cells ---
    dayKeys.forEach((dayKey, colIdx) => {
      const colX      = PADDING_LEFT + colIdx * colWidth;
      const dateStr   = weekDates[colIdx].toISOString().slice(0, 10);
      const fractions = (job.weeklyFiringFractions || {})[dayKey] || [];

      if (fractions.length === 0) return;

      // Determine color: check actual run data for this job+day
      const dayRuns   = (weeklyRunsData && weeklyRunsData.jobs &&
                         weeklyRunsData.jobs[job.id] &&
                         weeklyRunsData.jobs[job.id][dateStr]) || [];
      const dayStatus = _weekDayStatus(dayRuns);

      const dotColor = dayStatus === 'ok'    ? colors.green
                     : dayStatus === 'error' ? colors.red
                     : colors.accent; // blue = scheduled / no data

      // Track line across the cell
      ctx.strokeStyle = colors.border;
      ctx.lineWidth   = 0.8;
      ctx.beginPath();
      ctx.moveTo(colX + 3,          rowCenterY);
      ctx.lineTo(colX + colWidth - 3, rowCenterY);
      ctx.stroke();

      // Dots at firing fractions
      for (const frac of fractions) {
        const dotX = colX + frac * colWidth;

        // Glow halo
        const grad = ctx.createRadialGradient(
          dotX, rowCenterY, 0,
          dotX, rowCenterY, DOT_RADIUS * 2.5
        );
        grad.addColorStop(0, dotColor + 'aa');
        grad.addColorStop(1, dotColor + '00');
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(dotX, rowCenterY, DOT_RADIUS * 2.5, 0, Math.PI * 2);
        ctx.fill();

        // Solid dot
        ctx.fillStyle = dotColor;
        ctx.beginPath();
        ctx.arc(dotX, rowCenterY, DOT_RADIUS, 0, Math.PI * 2);
        ctx.fill();

        // Record hitbox for tooltip
        const hours = Math.floor(frac * 24);
        const mins = Math.floor((frac * 24 - hours) * 60);
        // Find the closest matching run for this dot's time
        const closestRun = _findClosestRun(dayRuns, hours, mins);
        weeklyDotHits.push({
          x: dotX, y: rowCenterY, r: DOT_RADIUS * 2.5,
          data: {
            name: job.name,
            day: dayLabels[colIdx] + ' ' + weekDates[colIdx].toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' }),
            time: `${String(hours).padStart(2,'0')}:${String(mins).padStart(2,'0')}`,
            status: closestRun?.status || (dateStr <= todayStr ? dayStatus : null),
            summary: closestRun?.summary || null,
            durationMs: closestRun?.durationMs || null,
          }
        });
      }
    });
  });

  // --- Current-time needle in today's column ---
  const todayColIdx = weekDates.findIndex(
    d => d.toISOString().slice(0, 10) === todayStr
  );
  if (todayColIdx >= 0) {
    const now   = new Date();
    const frac  = (now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds()) / 86400;
    const colX  = PADDING_LEFT + todayColIdx * colWidth;
    const nowX  = colX + frac * colWidth;

    ctx.strokeStyle = colors.red + 'cc';
    ctx.lineWidth   = 1.5;
    ctx.setLineDash([3, 2]);
    ctx.beginPath();
    ctx.moveTo(nowX, DAY_LABEL_HEIGHT);
    ctx.lineTo(nowX, canvasHeight - 4);
    ctx.stroke();
    ctx.setLineDash([]);
  }
}

/**
 * Derive a day-level run status from a list of run entries.
 * Returns 'ok', 'error', or 'none' (no data / future).
 */
function _weekDayStatus(dayRuns) {
  if (!dayRuns || dayRuns.length === 0) return 'none';
  const hasError = dayRuns.some(r => r.status === 'error' || r.status === 'timeout');
  if (hasError) return 'error';
  const hasOk = dayRuns.some(r => r.status === 'ok');
  return hasOk ? 'ok' : 'none';
}

/**
 * Find the run entry closest to a given hour:minute in a day's runs.
 */
function _findClosestRun(dayRuns, targetHours, targetMins) {
  if (!dayRuns || dayRuns.length === 0) return null;
  const targetMinOfDay = targetHours * 60 + targetMins;
  let closest = null;
  let minDiff = Infinity;
  for (const run of dayRuns) {
    if (!run.ts) continue;
    const d = new Date(run.ts);
    const runMinOfDay = d.getUTCHours() * 60 + d.getUTCMinutes();
    const diff = Math.abs(runMinOfDay - targetMinOfDay);
    if (diff < minDiff) {
      minDiff = diff;
      closest = run;
    }
  }
  // Only match if within 30 minutes
  return minDiff <= 30 ? closest : null;
}

// ─── Canvas Tooltip ───────────────────────────────────────────────────────────

/**
 * Handle mousemove on a canvas, showing a tooltip when hovering near a dot.
 */
function handleCanvasHover(event, canvas, hitboxes) {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  // Mouse position in CSS pixels relative to canvas
  const mx = event.clientX - rect.left;
  const my = event.clientY - rect.top;

  // Find the nearest dot within its radius
  let hit = null;
  let minDist = Infinity;
  for (const dot of hitboxes) {
    const dx = mx - dot.x;
    const dy = my - dot.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist <= dot.r * 1.5 && dist < minDist) {
      minDist = dist;
      hit = dot;
    }
  }

  if (hit) {
    showTooltipAt(event.clientX, event.clientY, hit.data);
  } else {
    hideTooltip();
  }
}

/**
 * Show the tooltip near the cursor with formatted content.
 */
function showTooltipAt(clientX, clientY, data) {
  const tt = dom.tooltip;
  if (!tt) return;

  const statusClass = data.status === 'ok' ? 'ok' : data.status === 'error' ? 'error' : 'none';
  const statusLabel = data.status === 'ok' ? 'OK' : data.status === 'error' ? 'Error' : data.status === 'timeout' ? 'Timeout' : 'Scheduled';

  let html = `<div class="tt-header"><span class="tt-status ${statusClass}"></span>${escHtml(data.name)}</div>`;

  const meta = [];
  if (data.day) meta.push(data.day);
  if (data.time) meta.push(data.time);
  meta.push(statusLabel);
  if (data.durationMs) meta.push(formatDuration(data.durationMs));
  if (data.schedule && !data.day) meta.push(data.schedule);
  html += `<div class="tt-meta">${escHtml(meta.join(' · '))}</div>`;

  if (data.summary) {
    html += `<div class="tt-output">${escHtml(data.summary)}</div>`;
  }

  tt.innerHTML = html;
  tt.classList.add('visible');

  // Position: offset from cursor, clamped to viewport
  const pad = 12;
  let left = clientX + pad;
  let top = clientY + pad;

  // Measure after setting content
  const ttRect = tt.getBoundingClientRect();
  if (left + ttRect.width > window.innerWidth - pad) {
    left = clientX - ttRect.width - pad;
  }
  if (top + ttRect.height > window.innerHeight - pad) {
    top = clientY - ttRect.height - pad;
  }

  tt.style.left = `${Math.max(pad, left)}px`;
  tt.style.top = `${Math.max(pad, top)}px`;
}

/**
 * Hide the canvas tooltip.
 */
function hideTooltip() {
  const tt = dom.tooltip;
  if (tt) tt.classList.remove('visible');
}

/**
 * Truncate text to fit within maxWidth pixels, appending ellipsis if needed.
 */
function truncateText(ctx, text, maxWidth) {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let truncated = text;
  while (truncated.length > 0 && ctx.measureText(truncated + '…').width > maxWidth) {
    truncated = truncated.slice(0, -1);
  }
  return truncated + '…';
}

// ─── Job Cards ────────────────────────────────────────────────────────────────

function renderJobCards(jobs) {
  // Sort: errors first, then by name
  const sorted = [...jobs].sort((a, b) => {
    const aErr = (a.state?.consecutiveErrors || 0) > 0;
    const bErr = (b.state?.consecutiveErrors || 0) > 0;
    if (aErr && !bErr) return -1;
    if (!aErr && bErr) return 1;
    return (a.name || '').localeCompare(b.name || '');
  });

  dom.jobsGrid.innerHTML = sorted.map(job => renderJobCard(job)).join('');

  // Attach click handlers
  dom.jobsGrid.querySelectorAll('.job-card').forEach(card => {
    card.addEventListener('click', () => {
      const jobId = card.dataset.jobId;
      openPanel(jobId);
    });
  });

  // Mark active card if panel is open
  if (activeJobId) {
    const activeCard = dom.jobsGrid.querySelector(`[data-job-id="${activeJobId}"]`);
    activeCard?.classList.add('active');
  }
}

function renderJobCard(job) {
  const state = job.state || {};
  const status = state.lastRunStatus || null;
  const errors = state.consecutiveErrors || 0;

  const statusIcon = statusEmoji(status);
  const statusClass = status === 'ok' ? 'ok' : status === 'error' ? 'error' : '';

  const enabledClass = job.enabled ? 'enabled' : 'disabled';
  const enabledLabel = job.enabled ? 'enabled' : 'disabled';

  const lastRun = state.lastRunAtMs
    ? `${statusIcon} ${formatTimeAgo(state.lastRunAtMs)}`
    : '—';

  const nextRun = state.nextRunAtMs
    ? formatNextRun(state.nextRunAtMs)
    : '—';

  const duration = state.lastDurationMs
    ? formatDuration(state.lastDurationMs)
    : '—';

  const cardStatusClass = errors > 0 ? 'status-error' : (status === 'ok' ? 'status-ok' : '');

  const tags = [];
  if (job.model) {
    const shortModel = job.model.split('/').pop() || job.model;
    tags.push(`<span class="job-meta-tag" title="${escHtml(job.model)}">${escHtml(shortModel)}</span>`);
  }
  if (job.channel) {
    tags.push(`<span class="job-meta-tag">${escHtml(job.channel)}</span>`);
  }
  if (errors > 0) {
    tags.push(`<span class="error-count-badge">${errors} error${errors !== 1 ? 's' : ''}</span>`);
  }

  return `
    <div class="job-card ${cardStatusClass} ${job.enabled ? '' : 'disabled'}"
         data-job-id="${escHtml(job.id)}"
         role="button"
         tabindex="0"
         aria-label="View run history for ${escHtml(job.name)}"
         title="Click to view run history">
      <div class="job-card-header">
        <div class="job-name">${escHtml(job.name)}</div>
        <span class="job-enabled-badge ${enabledClass}">${enabledLabel}</span>
      </div>

      <div class="job-schedule">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
          <circle cx="12" cy="12" r="10"/>
          <polyline points="12 6 12 12 16 14"/>
        </svg>
        ${escHtml(job.scheduleHuman || 'Unknown schedule')}
      </div>

      <div class="job-stats">
        <div class="job-stat">
          <span class="job-stat-label">Last Run</span>
          <span class="job-stat-value ${statusClass}">${lastRun}</span>
        </div>
        <div class="job-stat">
          <span class="job-stat-label">Duration</span>
          <span class="job-stat-value">${duration}</span>
        </div>
        <div class="job-stat">
          <span class="job-stat-label">Next Run</span>
          <span class="job-stat-value">${escHtml(nextRun)}</span>
        </div>
        <div class="job-stat">
          <span class="job-stat-label">Health</span>
          <span class="job-stat-value">${state.lastStatus === 'ok' || state.lastRunStatus === 'ok' ? '✅ OK' : state.lastStatus === 'error' || state.lastRunStatus === 'error' ? '❌ Error' : escHtml(state.lastStatus || state.lastRunStatus || '—')}</span>
        </div>
      </div>

      ${tags.length > 0 ? `
      <div class="job-card-footer">
        ${tags.join('')}
      </div>` : ''}
    </div>
  `;
}

// ─── Run History Panel ────────────────────────────────────────────────────────

async function openPanel(jobId) {
  const job = allJobs.find(j => j.id === jobId);
  if (!job) return;

  activeJobId = jobId;

  // Update active card styling
  dom.jobsGrid.querySelectorAll('.job-card').forEach(c => c.classList.remove('active'));
  const activeCard = dom.jobsGrid.querySelector(`[data-job-id="${jobId}"]`);
  activeCard?.classList.add('active');

  // Set panel header
  dom.panelJobName.textContent = job.name;
  dom.panelJobSchedule.textContent = job.scheduleHuman || '';

  // Show panel with loading state
  dom.panelBody.innerHTML = `
    <div class="panel-loading" aria-label="Loading run history">
      <div class="spinner"></div>
      <span>Loading run history…</span>
    </div>
  `;

  dom.panelOverlay.classList.add('open');
  dom.panelOverlay.setAttribute('aria-hidden', 'false');
  dom.runPanel.classList.add('open');
  dom.runPanel.setAttribute('aria-hidden', 'false');

  // Fetch run history
  try {
    const data = await loadRunHistory(jobId);
    renderRunHistory(data);
  } catch (err) {
    dom.panelBody.innerHTML = `
      <div class="panel-error">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <circle cx="12" cy="12" r="10"/>
          <line x1="12" y1="8" x2="12" y2="12"/>
          <line x1="12" y1="16" x2="12.01" y2="16"/>
        </svg>
        <span>${escHtml(err.message)}</span>
      </div>
    `;
  }
}

function closePanel() {
  activeJobId = null;
  dom.panelOverlay.classList.remove('open');
  dom.panelOverlay.setAttribute('aria-hidden', 'true');
  dom.runPanel.classList.remove('open');
  dom.runPanel.setAttribute('aria-hidden', 'true');
  dom.jobsGrid.querySelectorAll('.job-card').forEach(c => c.classList.remove('active'));
}

function renderRunHistory(data) {
  const entries = data.entries || [];
  const error = data.error;

  if (entries.length === 0) {
    dom.panelBody.innerHTML = `
      <div class="panel-empty">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <rect x="3" y="4" width="18" height="18" rx="2"/>
          <line x1="16" y1="2" x2="16" y2="6"/>
          <line x1="8" y1="2" x2="8" y2="6"/>
          <line x1="3" y1="10" x2="21" y2="10"/>
        </svg>
        <span>${error ? escHtml(error) : 'No run history yet'}</span>
      </div>
    `;
    return;
  }

  const html = entries.map((entry, idx) => renderRunEntry(entry, idx)).join('');
  dom.panelBody.innerHTML = `<div class="run-list">${html}</div>`;

  // Expand the most recent run by default
  const firstEntry = dom.panelBody.querySelector('.run-entry');
  if (firstEntry) toggleRunEntry(firstEntry);

  // Attach toggle handlers
  dom.panelBody.querySelectorAll('.run-entry-header').forEach(header => {
    header.addEventListener('click', () => {
      toggleRunEntry(header.closest('.run-entry'));
    });
    header.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggleRunEntry(header.closest('.run-entry'));
      }
    });
  });
}

function toggleRunEntry(entry) {
  entry.classList.toggle('expanded');
}

function renderRunEntry(entry, idx) {
  const ts = entry.runAtMs || entry.ts;
  const icon = statusEmoji(entry.status);
  const timeStr = ts ? formatDateTime(ts) : '—';
  const timeAgo = ts ? formatTimeAgo(ts) : '';
  const duration = entry.durationMs ? formatDuration(entry.durationMs) : '—';
  const model = entry.model || '';
  const summary = entry.summary || null;

  const runHealthy = entry.status === 'ok';
  const wasDelivered = entry.deliveryStatus === 'delivered' || entry.delivered === true;
  const healthLabel = runHealthy ? (wasDelivered ? '✅ delivered' : '✅ silent') : entry.status === 'error' ? '❌ error' : entry.deliveryStatus || '—';
  const healthClass = runHealthy ? '' : 'failed';

  const tokenInfo = entry.usage
    ? `<div class="run-tokens">
        <span title="Input tokens">↑ ${entry.usage.inputTokens.toLocaleString()}</span>
        <span title="Output tokens">↓ ${entry.usage.outputTokens.toLocaleString()}</span>
        <span title="Total tokens">∑ ${entry.usage.totalTokens.toLocaleString()}</span>
       </div>`
    : '';

  const outputSection = summary
    ? `<div class="run-output-label">Output</div>
       <pre class="run-output-text">${escHtml(summary)}</pre>
       ${tokenInfo}`
    : `<div class="run-output-label">Output</div>
       <div class="run-output-text" style="color:var(--text-muted);font-style:italic">No output recorded</div>`;

  return `
    <div class="run-entry" data-idx="${idx}" role="article">
      <div class="run-entry-header" role="button" tabindex="0" aria-expanded="false"
           aria-label="${icon} ${timeStr} — ${entry.status || 'unknown'}">
        <span class="run-status-icon" aria-hidden="true">${icon}</span>
        <div class="run-time">
          <div class="run-timestamp">${timeStr}</div>
          <div class="run-time-ago">${escHtml(timeAgo)}</div>
        </div>
        <div class="run-meta">
          <span class="run-duration">${escHtml(duration)}</span>
          ${model ? `<span class="run-model" title="${escHtml(model)}">${escHtml(model.split('/').pop() || model)}</span>` : ''}
          ${healthLabel !== '—' ? `<span class="run-delivery ${healthClass}">${escHtml(healthLabel)}</span>` : ''}
        </div>
        <span class="run-expand-icon" aria-hidden="true">▶</span>
      </div>
      <div class="run-output">
        ${outputSection}
      </div>
    </div>
  `;
}

// ─── Auto-refresh ─────────────────────────────────────────────────────────────

function startAutoRefresh() {
  resetAutoRefresh();
}

function resetAutoRefresh() {
  if (refreshTimer) clearTimeout(refreshTimer);
  if (countdownTimer) clearInterval(countdownTimer);

  countdownRemaining = REFRESH_INTERVAL_MS;
  updateCountdown();

  countdownTimer = setInterval(() => {
    countdownRemaining -= 1000;
    updateCountdown();
  }, 1000);

  refreshTimer = setTimeout(() => {
    clearInterval(countdownTimer);
    loadJobs().then(() => resetAutoRefresh());
  }, REFRESH_INTERVAL_MS);
}

function updateCountdown() {
  const seconds = Math.max(0, Math.round(countdownRemaining / 1000));
  dom.refreshCountdown.textContent = `${seconds}s`;
  const pct = ((REFRESH_INTERVAL_MS - countdownRemaining) / REFRESH_INTERVAL_MS) * 100;
  dom.refreshBar.style.width = `${Math.min(100, pct)}%`;
  dom.refreshBar.style.transition = `width 1s linear`;
}

// ─── Status ───────────────────────────────────────────────────────────────────

function setStatus(status) {
  dom.statusDot.className = 'status-dot';
  if (status === 'loading') dom.statusDot.classList.add('loading');
  if (status === 'error') dom.statusDot.classList.add('error');
}

// ─── Toast Notifications ──────────────────────────────────────────────────────

function showToast(message, type = '') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  dom.toastContainer.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

// ─── Formatting Utilities ─────────────────────────────────────────────────────

/**
 * Format a timestamp as a human-readable "time ago" string.
 */
function formatTimeAgo(ts) {
  const diff = Date.now() - ts;
  const abs = Math.abs(diff);
  const future = diff < 0;

  if (abs < 60_000)        return future ? 'in a moment'  : 'just now';
  if (abs < 3_600_000)     return `${future ? 'in ' : ''}${Math.floor(abs / 60_000)}m${future ? '' : ' ago'}`;
  if (abs < 86_400_000)    return `${future ? 'in ' : ''}${Math.floor(abs / 3_600_000)}h${future ? '' : ' ago'}`;
  if (abs < 7 * 86_400_000) return `${future ? 'in ' : ''}${Math.floor(abs / 86_400_000)}d${future ? '' : ' ago'}`;
  return formatDate(ts);
}

/**
 * Format a next-run timestamp compactly.
 */
function formatNextRun(ts) {
  if (!ts) return '—';
  const diff = ts - Date.now();
  if (diff < 0) return 'overdue';

  const mins  = Math.floor(diff / 60_000);
  const hours = Math.floor(diff / 3_600_000);

  if (mins < 1)   return 'in <1m';
  if (mins < 60)  return `in ${mins}m`;
  if (hours < 24) return `in ${hours}h ${Math.floor((diff % 3_600_000) / 60_000)}m`;

  return formatDateTime(ts);
}

/**
 * Format duration in milliseconds to a human-readable string.
 */
function formatDuration(ms) {
  if (!ms || ms < 0) return '—';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${m}m ${s}s`;
}

/**
 * Format a timestamp as a short date string.
 */
function formatDate(ts) {
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/**
 * Format a timestamp as a full date+time string.
 */
function formatDateTime(ts) {
  const d = new Date(ts);
  return d.toLocaleString(undefined, {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  });
}

/**
 * Map a run status to an emoji icon.
 */
function statusEmoji(status) {
  switch (status) {
    case 'ok':      return '✅';
    case 'error':   return '❌';
    case 'skipped': return '⏭️';
    case 'timeout': return '⏱️';
    default:        return '⬜';
  }
}

/**
 * Escape HTML special characters to prevent XSS.
 */
function escHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ─── Resize Timeline on Window Resize ─────────────────────────────────────────

let resizeDebounce;
window.addEventListener('resize', () => {
  clearTimeout(resizeDebounce);
  resizeDebounce = setTimeout(() => {
    if (allJobs.length > 0) {
      renderTimeline(allJobs);
      if (activeView === 'week') {
        renderWeeklyTimeline(allJobs, weeklyData);
      }
    }
  }, 150);
});
