/**
 * Starts the app for HTTP/UI evals on :3100 against .data/eval, with the clock
 * pinned to 19:00 IST today, forced mock WhatsApp transport, and known webhook
 * secrets. Launched via .claude/launch.json ("takeaway-eval").
 */
import { spawn } from 'node:child_process';

const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' });
const [y, m, d] = fmt.format(new Date()).split('-').map(Number);
const clock = new Date(Date.UTC(y, m - 1, d, 19, 0) - 330 * 60_000).toISOString();

const env = {
  ...process.env,
  DATABASE_URL: 'pglite://.data/eval',
  TT_CLOCK_START: clock,
  MESSAGING_PROVIDER: 'mock',
  AI_PROVIDER: 'deterministic',
  STT_PROVIDER: 'mock',
  WHATSAPP_APP_SECRET: 'eval-app-secret',
  WHATSAPP_VERIFY_TOKEN: 'eval-verify',
  LOG_LEVEL: 'warn',
};
console.log(`eval server clock pinned to ${clock}`);
const child = spawn('npx', ['next', 'dev', '-p', '3100'], { env, stdio: 'inherit', shell: true });
child.on('exit', (code) => process.exit(code ?? 0));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
