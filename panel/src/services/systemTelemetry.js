/**
 * DARKONYX PANEL — host telemetry sampler
 *
 * CPU and network can only be expressed as a rate, and a rate needs two
 * points in time. Sampling inside a request handler meant the very first
 * request after boot fell back to the "average since boot" figure, which
 * under-reports every burst and made the gauge look frozen.
 *
 * This module samples the host once a second, in the background, so any
 * request — the first one included — reads a real interval measurement.
 * No value here is ever invented: if /proc is unavailable the fields are
 * reported as unmeasured instead of guessed.
 */
const os = require('os');
const fs = require('fs');

const SAMPLE_MS = 1000;

function cpuTicks() {
  let total = 0, idle = 0;
  for (const cpu of os.cpus() || []) {
    for (const type in cpu.times) total += cpu.times[type];
    idle += cpu.times.idle;
  }
  return { total, idle };
}

function netBytes() {
  try {
    const data = fs.readFileSync('/proc/net/dev', 'utf8');
    let rx = 0, tx = 0;
    for (const line of data.split('\n')) {
      if (!line.includes(':') || line.includes('lo:')) continue;
      const parts = line.split(':')[1].trim().split(/\s+/);
      rx += parseInt(parts[0], 10) || 0;
      tx += parseInt(parts[8], 10) || 0;
    }
    return { rx, tx, measured: true };
  } catch (e) {
    return { rx: 0, tx: 0, measured: false };
  }
}

function diskUsage(dir) {
  try {
    const stat = fs.statfsSync(dir || '/');
    const totalBytes = stat.blocks * stat.bsize;
    const freeBytes = stat.bfree * stat.bsize;
    const usedBytes = Math.max(0, totalBytes - freeBytes);
    return {
      total_bytes: totalBytes,
      used_bytes: usedBytes,
      free_bytes: freeBytes,
      percent: totalBytes ? Math.min(100, Math.max(0, Math.round((usedBytes / totalBytes) * 100))) : 0,
      measured: true
    };
  } catch (e) {
    return { total_bytes: 0, used_bytes: 0, free_bytes: 0, percent: 0, measured: false };
  }
}

const state = {
  cpu_percent: null,
  net: { rx_bytes_sec: 0, tx_bytes_sec: 0, total_rx: 0, total_tx: 0, measured: false },
  sampled_at: null,
  samples: 0
};

let prevCpu = null;
let prevNet = null;
let timer = null;

function sample() {
  const now = Date.now();
  const cpu = cpuTicks();
  if (prevCpu && cpu.total > prevCpu.total) {
    const totalDelta = cpu.total - prevCpu.total;
    const idleDelta = cpu.idle - prevCpu.idle;
    state.cpu_percent = Math.max(0, Math.min(100, Math.round((1 - idleDelta / totalDelta) * 100)));
  } else if (state.cpu_percent === null) {
    // no delta yet (first ever tick): this is still a real measurement, just
    // taken over the lifetime of the machine rather than the last second
    state.cpu_percent = cpu.total ? Math.round((1 - cpu.idle / cpu.total) * 100) : 0;
  }
  prevCpu = cpu;

  const net = netBytes();
  if (prevNet && net.measured) {
    const seconds = Math.max(0.25, (now - prevNet.at) / 1000);
    state.net = {
      rx_bytes_sec: Math.max(0, (net.rx - prevNet.rx) / seconds),
      tx_bytes_sec: Math.max(0, (net.tx - prevNet.tx) / seconds),
      total_rx: net.rx,
      total_tx: net.tx,
      measured: true
    };
  } else {
    state.net = { rx_bytes_sec: 0, tx_bytes_sec: 0, total_rx: net.rx, total_tx: net.tx, measured: net.measured };
  }
  prevNet = { rx: net.rx, tx: net.tx, at: now };

  state.sampled_at = now;
  state.samples++;
}

function start() {
  if (timer) return;
  sample();
  timer = setInterval(sample, SAMPLE_MS);
  if (timer.unref) timer.unref();
}

/** Fresh CPU sample on demand — used when a caller needs "right now". */
function cpuPercentNow() {
  const before = cpuTicks();
  return new Promise((resolve) => {
    setTimeout(() => {
      const after = cpuTicks();
      if (after.total <= before.total) return resolve(state.cpu_percent || 0);
      resolve(Math.max(0, Math.min(100, Math.round((1 - (after.idle - before.idle) / (after.total - before.total)) * 100))));
    }, 120);
  });
}

module.exports = {
  start,
  cpuPercentNow,
  get cpuPercent() { return state.cpu_percent; },
  get net() { return state.net; },
  get sampledAt() { return state.sampled_at; },
  get samples() { return state.samples; },
  diskUsage,
  netBytes,
  memory() {
    const total = os.totalmem();
    const free = os.freemem();
    const used = Math.max(0, total - free);
    return {
      total_bytes: total,
      used_bytes: used,
      free_bytes: free,
      percent: total ? Math.round((used / total) * 100) : 0,
      measured: true
    };
  }
};
