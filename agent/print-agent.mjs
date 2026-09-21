#!/usr/bin/env node
/**
 * Restaurant Print Agent
 * ======================
 * Runs on the restaurant's Windows/Mac/Linux PC. Connects the local thermal
 * printer to the cloud WITHOUT opening any inbound port: it polls for jobs,
 * prints them, and reports the result.
 *
 *   cloud order accepted -> print job queued -> this agent polls -> printer
 *
 * Usage:
 *   node print-agent.mjs --url https://your-app --printer prn_xxx --token pa_xxx
 *
 * Or via environment:
 *   PRINT_AGENT_URL, PRINT_AGENT_PRINTER_ID, PRINT_AGENT_TOKEN
 *
 * Output targets (--target):
 *   stdout   print to the console (default; use this to verify the pipeline)
 *   file     append to ./kot-output.txt
 *   raw      write raw bytes to a device/share (e.g. --device \\\\.\\USB001 or /dev/usb/lp0)
 *   network  ESC/POS over TCP 9100 (--host 192.168.1.50 --port 9100)
 *
 * No dependencies. Node 18+.
 */
import { writeFileSync, appendFileSync, createWriteStream } from 'node:fs';
import net from 'node:net';
import process from 'node:process';

/* ── arguments ── */

function arg(name, fallback = undefined) {
  const index = process.argv.indexOf(`--${name}`);
  if (index !== -1 && process.argv[index + 1]) return process.argv[index + 1];
  return fallback;
}

const CONFIG = {
  url:       (arg('url', process.env.PRINT_AGENT_URL) || 'http://localhost:3000').replace(/\/$/, ''),
  printerId:  arg('printer', process.env.PRINT_AGENT_PRINTER_ID),
  token:      arg('token', process.env.PRINT_AGENT_TOKEN),
  target:     arg('target', 'stdout'),
  device:     arg('device'),
  host:       arg('host'),
  port: Number(arg('port', '9100')),
  intervalMs: Number(arg('interval', '3000')),
};

if (!CONFIG.printerId || !CONFIG.token) {
  console.error('Missing --printer and/or --token.');
  console.error('Find both in the console under Settings > Printers.');
  process.exit(1);
}

/* ── ESC/POS ── */

const ESC = '\x1b';
const GS = '\x1d';

/** Wraps plain text in the minimum ESC/POS a thermal printer needs. */
function toEscPos(text) {
  return Buffer.from(
    `${ESC}@` +          // initialise
    `${ESC}a\x00` +      // left align
    text +
    '\n\n\n' +
    `${GS}V\x00`,        // full cut
    'utf8',
  );
}

/* ── output targets ── */

async function emit(payload) {
  switch (CONFIG.target) {
    case 'file':
      appendFileSync('kot-output.txt', `${payload}\n${'='.repeat(40)}\n`, 'utf8');
      return;

    case 'raw': {
      if (!CONFIG.device) throw new Error('--device is required for --target raw');
      // Windows share or POSIX device node both accept a byte stream.
      await new Promise((resolve, reject) => {
        const stream = createWriteStream(CONFIG.device, { flags: 'a' });
        stream.on('error', reject);
        stream.end(toEscPos(payload), resolve);
      });
      return;
    }

    case 'network': {
      if (!CONFIG.host) throw new Error('--host is required for --target network');
      await new Promise((resolve, reject) => {
        const socket = net.createConnection({ host: CONFIG.host, port: CONFIG.port }, () => {
          socket.end(toEscPos(payload), resolve);
        });
        socket.setTimeout(8000, () => { socket.destroy(); reject(new Error('printer connection timed out')); });
        socket.on('error', reject);
      });
      return;
    }

    default:
      console.log(`\n${payload}\n${'─'.repeat(40)}`);
  }
}

/* ── polling loop ── */

let consecutiveFailures = 0;

async function poll() {
  try {
    const response = await fetch(
      `${CONFIG.url}/api/print/jobs?printerId=${encodeURIComponent(CONFIG.printerId)}`,
      { headers: { Authorization: `Bearer ${CONFIG.token}` } },
    );

    if (response.status === 401) {
      console.error('Authentication failed. Check the printer id and token.');
      process.exit(1);
    }
    if (!response.ok) throw new Error(`poll failed: HTTP ${response.status}`);

    const { jobs = [] } = await response.json();
    if (consecutiveFailures > 0) {
      console.log('Reconnected to the server.');
      consecutiveFailures = 0;
    }

    for (const job of jobs) {
      let ok = true;
      let error = '';
      try {
        await emit(job.payload);
        console.log(`printed job ${job.id}`);
      } catch (err) {
        ok = false;
        error = String(err?.message ?? err);
        // A paper jam must not lose the ticket: the server requeues it.
        console.error(`print failed for job ${job.id}: ${error}`);
      }

      await fetch(`${CONFIG.url}/api/print/result`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${CONFIG.token}` },
        body: JSON.stringify({ printerId: CONFIG.printerId, jobId: job.id, ok, error }),
      }).catch(() => { /* reported again on the next poll */ });
    }
  } catch (err) {
    consecutiveFailures++;
    // Quiet after the first few: a restaurant's wifi drops, and a screenful of
    // red every 3 seconds trains staff to ignore the window entirely.
    if (consecutiveFailures <= 3 || consecutiveFailures % 20 === 0) {
      console.error(`cannot reach the server (${consecutiveFailures}x): ${err?.message ?? err}`);
    }
  }
}

console.log('Restaurant Print Agent');
console.log(`  server  : ${CONFIG.url}`);
console.log(`  printer : ${CONFIG.printerId}`);
console.log(`  target  : ${CONFIG.target}${CONFIG.device ? ` (${CONFIG.device})` : ''}${CONFIG.host ? ` (${CONFIG.host}:${CONFIG.port})` : ''}`);
console.log('  polling every', CONFIG.intervalMs, 'ms — Ctrl+C to stop\n');

await poll();
setInterval(poll, CONFIG.intervalMs);
