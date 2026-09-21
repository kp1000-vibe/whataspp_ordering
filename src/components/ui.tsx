'use client';

/**
 * The small component vocabulary the console is built from.
 * Deliberately tiny: a restaurant owner should understand the screen in five
 * minutes, which means few shapes, repeated.
 */
import type { ReactNode } from 'react';

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`surface rounded-xl ${className}`}>{children}</div>;
}

export function Stat({ label, value, hint, tone = 'default' }: {
  label: string; value: string; hint?: string;
  tone?: 'default' | 'ok' | 'warn' | 'danger';
}) {
  const color = tone === 'ok' ? 'var(--ok)' : tone === 'warn' ? 'var(--warn)' : tone === 'danger' ? 'var(--danger)' : 'var(--text)';
  return (
    <Card className="p-4">
      <div className="text-xs uppercase tracking-wide muted">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums" style={{ color }}>{value}</div>
      {hint ? <div className="mt-1 text-xs muted">{hint}</div> : null}
    </Card>
  );
}

const TONES: Record<string, { bg: string; fg: string }> = {
  neutral: { bg: 'color-mix(in srgb, var(--muted) 14%, transparent)', fg: 'var(--muted)' },
  info:    { bg: 'color-mix(in srgb, var(--accent) 14%, transparent)', fg: 'var(--accent)' },
  ok:      { bg: 'color-mix(in srgb, var(--ok) 16%, transparent)', fg: 'var(--ok)' },
  warn:    { bg: 'color-mix(in srgb, var(--warn) 18%, transparent)', fg: 'var(--warn)' },
  danger:  { bg: 'color-mix(in srgb, var(--danger) 16%, transparent)', fg: 'var(--danger)' },
};

export function Badge({ children, tone = 'neutral' }: {
  children: ReactNode; tone?: keyof typeof TONES | string;
}) {
  const t = TONES[tone] ?? TONES.neutral;
  return (
    <span
      className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium"
      style={{ background: t.bg, color: t.fg }}
    >
      {children}
    </span>
  );
}

export function Button({
  children, onClick, variant = 'secondary', disabled, size = 'md', type = 'button', title,
}: {
  children: ReactNode; onClick?: () => void;
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
  disabled?: boolean; size?: 'sm' | 'md' | 'lg'; type?: 'button' | 'submit'; title?: string;
}) {
  const pad = size === 'lg' ? 'px-5 py-3 text-base' : size === 'sm' ? 'px-2.5 py-1 text-xs' : 'px-3 py-1.5 text-sm';
  const style: Record<string, string> =
    variant === 'primary' ? { background: 'var(--accent)', color: '#fff', border: '1px solid transparent' }
    : variant === 'danger' ? { background: 'var(--danger)', color: '#fff', border: '1px solid transparent' }
    : variant === 'ghost' ? { background: 'transparent', color: 'var(--muted)', border: '1px solid transparent' }
    : { background: 'var(--surface)', color: 'var(--text)', border: '1px solid var(--border)' };

  return (
    <button
      type={type}
      title={title}
      onClick={onClick}
      disabled={disabled}
      style={style}
      className={`rounded-lg font-medium transition-opacity ${pad} ${disabled ? 'opacity-45 cursor-not-allowed' : 'hover:opacity-85 cursor-pointer'}`}
    >
      {children}
    </button>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="block">
      <span className="text-sm font-medium">{label}</span>
      <div className="mt-1">{children}</div>
      {hint ? <span className="mt-1 block text-xs muted">{hint}</span> : null}
    </label>
  );
}

export function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={`w-full rounded-lg px-3 py-2 text-sm surface ${props.className ?? ''}`}
      style={{ background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--text)' }}
    />
  );
}

export function Empty({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="py-14 text-center">
      <div className="text-sm font-medium">{title}</div>
      {hint ? <div className="mt-1 text-sm muted">{hint}</div> : null}
    </div>
  );
}

export const STATUS_TONE: Record<string, string> = {
  DRAFT: 'neutral', CLARIFICATION_REQUIRED: 'warn', READY_FOR_CONFIRMATION: 'info',
  CONFIRMED: 'info', RECEIVED: 'warn', ACCEPTED: 'info', PREPARING: 'info',
  READY: 'ok', PICKED_UP: 'ok', COMPLETED: 'neutral',
  CANCELLED: 'danger', REJECTED: 'danger', EXPIRED: 'danger',
};

export function money(cents: number, currency = 'INR'): string {
  const symbol = currency === 'INR' ? '₹' : currency === 'USD' ? '$' : currency === 'EUR' ? '€' : '';
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${symbol}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

export function clock(iso: string | null | undefined, timeZone = 'Asia/Kolkata'): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString('en-US', {
    hour: 'numeric', minute: '2-digit', timeZone,
  });
}

export function ago(iso: string | null | undefined): string {
  if (!iso) return '—';
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
