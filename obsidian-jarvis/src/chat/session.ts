/** Chat-Sitzungen: Verlauf speichern und begrenzen. */
import type { ProviderId } from '../types';

export interface TurnSourceRef {
  id: string;
  path: string;
  heading: string;
}

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
  at: number;
  sources?: TurnSourceRef[];
  meta?: {
    providerId?: ProviderId;
    model?: string;
    durationMs?: number;
    inputTokens?: number;
    outputTokens?: number;
    escalated?: boolean;
    buffered?: boolean;
    costUsd?: number;
    error?: string;
  };
}

export interface ChatSession {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  turns: ChatTurn[];
}

export const MAX_SESSIONS = 25;
export const MAX_TURNS_PER_SESSION = 40;

export function createSession(): ChatSession {
  const now = Date.now();
  return {
    id: `s${now}${Math.floor(Math.random() * 1000)}`,
    title: 'Neue Unterhaltung',
    createdAt: now,
    updatedAt: now,
    turns: [],
  };
}

export function sessionTitle(session: ChatSession): string {
  const first = session.turns.find((turn) => turn.role === 'user');
  if (!first) return session.title;
  const title = first.content.replace(/\s+/g, ' ').trim();
  return title.length > 48 ? `${title.slice(0, 48)}…` : title || session.title;
}

export class SessionStore {
  private sessions: ChatSession[] = [];
  private activeId = '';

  constructor(
    initial: ChatSession[],
    private persist: (sessions: ChatSession[]) => Promise<void>,
  ) {
    this.sessions = Array.isArray(initial) ? initial.filter(isValidSession) : [];
  }

  list(): ChatSession[] {
    return [...this.sessions].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  active(): ChatSession {
    let session = this.sessions.find((item) => item.id === this.activeId);
    if (!session) {
      session = this.sessions[0] ?? createSession();
      if (!this.sessions.length) this.sessions.push(session);
      this.activeId = session.id;
    }
    return session;
  }

  startNew(): ChatSession {
    const session = createSession();
    this.sessions.unshift(session);
    this.activeId = session.id;
    void this.trim();
    return session;
  }

  select(id: string): ChatSession | undefined {
    const session = this.sessions.find((item) => item.id === id);
    if (session) this.activeId = session.id;
    return session;
  }

  get activeSessionId(): string {
    return this.activeId;
  }

  addTurn(turn: ChatTurn): void {
    const session = this.active();
    session.turns.push(turn);
    session.updatedAt = Date.now();
    session.title = sessionTitle(session);
    if (session.turns.length > MAX_TURNS_PER_SESSION) {
      session.turns = session.turns.slice(-MAX_TURNS_PER_SESSION);
    }
    void this.trim();
  }

  updateLastTurn(patch: Partial<ChatTurn>): void {
    const session = this.active();
    const last = session.turns[session.turns.length - 1];
    if (!last) return;
    Object.assign(last, patch);
    void this.trim();
  }

  clearActive(): void {
    const session = this.active();
    session.turns = [];
    session.updatedAt = Date.now();
    void this.trim();
  }

  remove(id: string): void {
    this.sessions = this.sessions.filter((session) => session.id !== id);
    if (this.activeId === id) this.activeId = this.sessions[0]?.id ?? '';
    void this.trim();
  }

  private async trim(): Promise<void> {
    this.sessions = this.list().slice(0, MAX_SESSIONS);
    try {
      await this.persist(this.sessions);
    } catch {
      // Speichern ist optional
    }
  }
}

function isValidSession(value: unknown): value is ChatSession {
  const session = value as ChatSession;
  return Boolean(session && typeof session.id === 'string' && Array.isArray(session.turns));
}
