<script lang="ts">
/**
 * SVG-based line chart for displaying metrics over time.
 * No external chart library -- pure SVG.
 */

interface DataPoint {
  timestamp: number;
  value: number;
}

interface Series {
  label: string;
  color: string;
  data: DataPoint[];
}

interface Props {
  series: Series[];
  title?: string;
  height?: number;
  yLabel?: string;
  formatValue?: (v: number) => string;
}

let {
  series,
  title = "",
  height = 200,
  yLabel = "",
  formatValue = (v: number) => String(Math.round(v)),
}: Props = $props();

const PADDING = { top: 24, right: 16, bottom: 32, left: 52 };
const WIDTH = 600;

function computeBounds(allSeries: Series[]): { minTime: number; maxTime: number; minVal: number; maxVal: number } {
  let minTime = Infinity;
  let maxTime = -Infinity;
  let minVal = Infinity;
  let maxVal = -Infinity;

  for (const s of allSeries) {
    for (const pt of s.data) {
      if (pt.timestamp < minTime) minTime = pt.timestamp;
      if (pt.timestamp > maxTime) maxTime = pt.timestamp;
      if (pt.value < minVal) minVal = pt.value;
      if (pt.value > maxVal) maxVal = pt.value;
    }
  }

  if (minTime === Infinity) {
    minTime = 0;
    maxTime = 1;
    minVal = 0;
    maxVal = 1;
  }

  // Add 10% padding on Y axis
  const yRange = maxVal - minVal;
  if (yRange === 0) {
    minVal = minVal > 0 ? 0 : minVal - 1;
    maxVal = maxVal + 1;
  } else {
    minVal = Math.max(0, minVal - yRange * 0.1);
    maxVal = maxVal + yRange * 0.1;
  }

  return { minTime, maxTime, minVal, maxVal };
}

function toX(timestamp: number, minTime: number, maxTime: number): number {
  const range = maxTime - minTime;
  if (range === 0) return PADDING.left;
  return PADDING.left + ((timestamp - minTime) / range) * (WIDTH - PADDING.left - PADDING.right);
}

function toY(value: number, minVal: number, maxVal: number, h: number): number {
  const range = maxVal - minVal;
  if (range === 0) return h - PADDING.bottom;
  return h - PADDING.bottom - ((value - minVal) / range) * (h - PADDING.top - PADDING.bottom);
}

function buildPath(data: DataPoint[], minTime: number, maxTime: number, minVal: number, maxVal: number, h: number): string {
  if (data.length === 0) return "";
  const sorted = [...data].sort((a, b) => a.timestamp - b.timestamp);
  const parts = sorted.map((pt, i) => {
    const x = toX(pt.timestamp, minTime, maxTime);
    const y = toY(pt.value, minVal, maxVal, h);
    return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
  });
  return parts.join(" ");
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function yTicks(minVal: number, maxVal: number, count: number): number[] {
  const step = (maxVal - minVal) / count;
  const ticks: number[] = [];
  for (let i = 0; i <= count; i++) {
    ticks.push(minVal + step * i);
  }
  return ticks;
}

function xTicks(minTime: number, maxTime: number, count: number): number[] {
  const step = (maxTime - minTime) / count;
  const ticks: number[] = [];
  for (let i = 0; i <= count; i++) {
    ticks.push(minTime + step * i);
  }
  return ticks;
}
</script>

<div class="chart-container">
  {#if title}
    <h3 class="chart-title">{title}</h3>
  {/if}

  {#if series.length === 0 || series.every((s) => s.data.length === 0)}
    <div class="chart-empty" style="height: {height}px">
      No data available
    </div>
  {:else}
    {@const bounds = computeBounds(series)}
    {@const yTickValues = yTicks(bounds.minVal, bounds.maxVal, 4)}
    {@const xTickValues = xTicks(bounds.minTime, bounds.maxTime, 4)}

    <svg
      viewBox="0 0 {WIDTH} {height}"
      preserveAspectRatio="xMidYMid meet"
      class="chart-svg"
      role="img"
      aria-label="{title || 'Metrics chart'}{yLabel ? ` (${yLabel})` : ''}"
    >
      <!-- Grid lines -->
      {#each yTickValues as tick}
        <line
          x1={PADDING.left}
          y1={toY(tick, bounds.minVal, bounds.maxVal, height)}
          x2={WIDTH - PADDING.right}
          y2={toY(tick, bounds.minVal, bounds.maxVal, height)}
          class="grid-line"
        />
        <text
          x={PADDING.left - 8}
          y={toY(tick, bounds.minVal, bounds.maxVal, height) + 4}
          class="tick-label tick-y"
        >
          {formatValue(tick)}
        </text>
      {/each}

      {#each xTickValues as tick}
        <text
          x={toX(tick, bounds.minTime, bounds.maxTime)}
          y={height - 8}
          class="tick-label tick-x"
        >
          {formatTime(tick)}
        </text>
      {/each}

      <!-- Y axis label -->
      {#if yLabel}
        <text
          x={12}
          y={height / 2}
          class="axis-label"
          transform="rotate(-90, 12, {height / 2})"
        >
          {yLabel}
        </text>
      {/if}

      <!-- Data lines -->
      {#each series as s}
        <path
          d={buildPath(s.data, bounds.minTime, bounds.maxTime, bounds.minVal, bounds.maxVal, height)}
          fill="none"
          stroke={s.color}
          stroke-width="2"
          class="data-line"
        />
        <!-- Data points -->
        {#each s.data as pt}
          <circle
            cx={toX(pt.timestamp, bounds.minTime, bounds.maxTime)}
            cy={toY(pt.value, bounds.minVal, bounds.maxVal, height)}
            r="3"
            fill={s.color}
            class="data-point"
          >
            <title>{s.label}: {formatValue(pt.value)} at {formatTime(pt.timestamp)}</title>
          </circle>
        {/each}
      {/each}
    </svg>

    <!-- Legend -->
    {#if series.length > 1}
      <div class="chart-legend">
        {#each series as s}
          <div class="legend-item">
            <span class="legend-color" style="background: {s.color}"></span>
            <span class="legend-label">{s.label}</span>
          </div>
        {/each}
      </div>
    {/if}
  {/if}
</div>

<style>
  .chart-container {
    width: 100%;
  }

  .chart-title {
    font-size: 13px;
    font-weight: 600;
    color: var(--text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.5px;
    margin-bottom: 8px;
  }

  .chart-empty {
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--text-secondary);
    font-size: 13px;
    background: var(--bg-tertiary);
    border-radius: var(--radius);
  }

  .chart-svg {
    width: 100%;
    height: auto;
  }

  .grid-line {
    stroke: var(--border);
    stroke-width: 1;
    stroke-dasharray: 4 4;
  }

  .tick-label {
    font-size: 10px;
    fill: var(--text-secondary);
  }

  .tick-y {
    text-anchor: end;
  }

  .tick-x {
    text-anchor: middle;
  }

  .axis-label {
    font-size: 10px;
    fill: var(--text-secondary);
    text-anchor: middle;
  }

  .data-line {
    transition: stroke-width 0.15s;
  }

  .data-line:hover {
    stroke-width: 3;
  }

  .data-point {
    opacity: 0.8;
    transition: r 0.15s;
  }

  .data-point:hover {
    r: 5;
    opacity: 1;
  }

  .chart-legend {
    display: flex;
    gap: 16px;
    justify-content: center;
    margin-top: 8px;
  }

  .legend-item {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: var(--text-secondary);
  }

  .legend-color {
    width: 12px;
    height: 3px;
    border-radius: 1px;
  }
</style>
