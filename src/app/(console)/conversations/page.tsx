'use client';

/**
 * Chats — conversation audit and human takeover.
 *
 * Section 27 of the spec: a customer must never be trapped in an automated
 * conversation. Taking over silences the AI completely until staff hand back.
 */
import { useCallback, useEffect, useState } from 'react';
import { Card, Badge, Button, Input, Empty, ago } from '../../../components/ui';

type Conversation = {
  id: string; handledBy: 'AI' | 'STAFF'; lastMessageAt: string | null;
  activeDraftOrderId: string | null;
  customer: { name: string | null; phone: string; language: string } | null;
};
type Message = { id: string; direction: string; authorType: string; body: string; createdAt: string; kind: string };

export default function ConversationsPage() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);

  const loadList = useCallback(async () => {
    const data = await fetch('/api/conversations').then((r) => r.json());
    setConversations(data.conversations ?? []);
    if (!selected && data.conversations?.[0]) setSelected(data.conversations[0].id);
  }, [selected]);

  const loadThread = useCallback(async (id: string) => {
    const data = await fetch(`/api/conversations?id=${encodeURIComponent(id)}`).then((r) => r.json());
    setMessages(data.messages ?? []);
  }, []);

  useEffect(() => { loadList(); const t = setInterval(loadList, 8000); return () => clearInterval(t); }, [loadList]);
  useEffect(() => { if (selected) { loadThread(selected); const t = setInterval(() => loadThread(selected), 6000); return () => clearInterval(t); } }, [selected, loadThread]);

  const current = conversations.find((c) => c.id === selected) ?? null;

  async function act(action: 'takeover' | 'release' | 'send', text?: string) {
    if (!selected) return;
    setBusy(true);
    try {
      await fetch('/api/conversations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversationId: selected, action, text }),
      });
      await Promise.all([loadList(), loadThread(selected)]);
      if (action === 'send') setDraft('');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[300px_minmax(0,1fr)]">
      <Card className="max-h-[75vh] overflow-y-auto">
        {conversations.length === 0 ? (
          <Empty title="No conversations yet" />
        ) : (
          conversations.map((c) => (
            <button
              key={c.id}
              onClick={() => setSelected(c.id)}
              className="block w-full px-3 py-2.5 text-left"
              style={{
                borderBottom: '1px solid var(--border)',
                background: c.id === selected ? 'color-mix(in srgb, var(--accent) 10%, transparent)' : 'transparent',
              }}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-sm font-medium">{c.customer?.name ?? c.customer?.phone ?? 'Unknown'}</span>
                {c.handledBy === 'STAFF' ? <Badge tone="warn">staff</Badge> : <Badge tone="ok">AI</Badge>}
              </div>
              <div className="mt-0.5 flex items-center gap-2 text-xs muted">
                <span>{ago(c.lastMessageAt)}</span>
                {c.customer?.language && c.customer.language !== 'en' ? <span>· {c.customer.language}</span> : null}
                {c.activeDraftOrderId ? <span>· ordering</span> : null}
              </div>
            </button>
          ))
        )}
      </Card>

      <Card className="flex h-[75vh] flex-col overflow-hidden">
        {current ? (
          <>
            <div className="flex items-center gap-2 border-b px-4 py-2" style={{ borderColor: 'var(--border)' }}>
              <div className="text-sm font-medium">{current.customer?.name ?? current.customer?.phone}</div>
              <span className="text-xs muted">{current.customer?.phone}</span>
              <div className="ml-auto flex items-center gap-2">
                {current.handledBy === 'AI' ? (
                  <Button size="sm" onClick={() => act('takeover')} disabled={busy}>Take over</Button>
                ) : (
                  <Button size="sm" variant="primary" onClick={() => act('release')} disabled={busy}>Return to AI</Button>
                )}
              </div>
            </div>

            <div className="flex-1 space-y-2 overflow-y-auto p-4">
              {messages.map((m) => (
                <div key={m.id} className={`flex ${m.direction === 'INBOUND' ? 'justify-start' : 'justify-end'}`}>
                  <div
                    className="max-w-[75%] whitespace-pre-wrap rounded-2xl px-3 py-2 text-sm"
                    style={
                      m.direction === 'INBOUND'
                        ? { background: 'var(--bg)', border: '1px solid var(--border)' }
                        : { background: 'color-mix(in srgb, var(--accent) 16%, transparent)' }
                    }
                  >
                    {m.kind === 'AUDIO' ? <div className="mb-1 text-[10px] uppercase muted">voice note — transcript</div> : null}
                    {m.body}
                    <div className="mt-1 text-[10px] uppercase tracking-wide muted">
                      {m.authorType.toLowerCase()} · {ago(m.createdAt)}
                    </div>
                  </div>
                </div>
              ))}
            </div>

            <div className="border-t p-3" style={{ borderColor: 'var(--border)' }}>
              {current.handledBy === 'STAFF' ? (
                <div className="flex gap-2">
                  <Input
                    value={draft}
                    placeholder="Reply as the restaurant…"
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter' && draft.trim()) act('send', draft.trim()); }}
                  />
                  <Button variant="primary" disabled={busy || !draft.trim()} onClick={() => act('send', draft.trim())}>
                    Send
                  </Button>
                </div>
              ) : (
                <p className="text-xs muted">
                  The assistant is handling this chat. Take over to reply yourself — it will stop responding immediately.
                </p>
              )}
            </div>
          </>
        ) : (
          <Empty title="Pick a conversation" />
        )}
      </Card>
    </div>
  );
}
