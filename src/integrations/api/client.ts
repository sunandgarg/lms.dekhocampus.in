export interface User {
  id: string;
  email: string;
  user_metadata: { full_name?: string | null };
  role: 'super_admin' | 'admin' | 'user';
  is_approved: boolean;
}

export interface Session { user: User }
export const apiBaseUrl = window.location.origin;
type Result = { data: any; error: any; count?: number | null };
type AuthListener = (event: string, session: Session | null) => void;

const authListeners = new Set<AuthListener>();
let currentSession: Session | null = null;

class ApiError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

async function request(path: string, init: RequestInit = {}) {
  const response = await fetch(path, { credentials: 'same-origin', ...init });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(body.error || `Request failed (${response.status})`, response.status);
  return body;
}

function notify(event: string) {
  authListeners.forEach((listener) => listener(event, currentSession));
}

class RecordQuery implements PromiseLike<Result> {
  private query: Record<string, any>;
  constructor(table: string) { this.query = { table, action: 'select', filters: [], order: [] }; }
  select(columns = '*', options?: { count?: string; head?: boolean }) {
    this.query.select = columns;
    if (options?.count) this.query.count = options.count;
    if (options?.head) this.query.head = true;
    if (this.query.action !== 'select') this.query.returnRows = true;
    return this;
  }
  insert(values: any) { this.query.action = 'insert'; this.query.values = values; return this; }
  update(values: any) { this.query.action = 'update'; this.query.values = values; return this; }
  upsert(values: any, options?: { onConflict?: string; ignoreDuplicates?: boolean }) {
    this.query.action = 'upsert'; this.query.values = values; this.query.upsertOptions = options; return this;
  }
  delete() { this.query.action = 'delete'; return this; }
  eq(field: string, value: any) { return this.filter(field, 'eq', value); }
  neq(field: string, value: any) { return this.filter(field, 'neq', value); }
  gt(field: string, value: any) { return this.filter(field, 'gt', value); }
  gte(field: string, value: any) { return this.filter(field, 'gte', value); }
  lt(field: string, value: any) { return this.filter(field, 'lt', value); }
  lte(field: string, value: any) { return this.filter(field, 'lte', value); }
  like(field: string, value: any) { return this.filter(field, 'like', value); }
  ilike(field: string, value: any) { return this.filter(field, 'ilike', value); }
  in(field: string, value: any[]) { return this.filter(field, 'in', value); }
  is(field: string, value: any) { return this.filter(field, 'is', value); }
  contains(field: string, value: any) { return this.filter(field, 'contains', value); }
  not(field: string, innerOp: string, value: any) {
    this.query.filters.push({ field, op: 'not', innerOp, value }); return this;
  }
  filter(field: string, op: string, value: any) {
    this.query.filters.push({ field, op, value }); return this;
  }
  or(value: string) { (this.query.or ||= []).push(value); return this; }
  order(field: string, options?: { ascending?: boolean; nullsFirst?: boolean }) {
    this.query.order.push({ field, ascending: options?.ascending !== false }); return this;
  }
  range(from: number, to: number) { this.query.offset = from; this.query.limit = to - from + 1; return this; }
  limit(count: number) { this.query.limit = count; return this; }
  single() { this.query.single = true; return this; }
  maybeSingle() { this.query.single = true; return this; }
  async then<TResult1 = Result, TResult2 = never>(
    onfulfilled?: ((value: Result) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    const promise = request('/api/records', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(this.query),
    }).then((result) => ({ ...result, error: null }), (error) => ({ data: null, error, count: null }));
    return promise.then(onfulfilled, onrejected);
  }
}

type Channel = { on: (...args: any[]) => Channel; subscribe: () => Channel; unsubscribe: () => void };
const intervals = new WeakMap<Channel, number>();

export const api = {
  from(table: string) { return new RecordQuery(table); },
  auth: {
    async getSession() {
      try {
        const { user } = await request('/api/auth/me');
        currentSession = { user };
        return { data: { session: currentSession }, error: null };
      } catch (error) {
        currentSession = null;
        if (error instanceof ApiError && error.status === 401) return { data: { session: null }, error: null };
        return { data: { session: null }, error: error as Error };
      }
    },
    async getUser() {
      const { data, error } = await this.getSession();
      return { data: { user: data.session?.user || null }, error };
    },
    async signInWithPassword({ email, password }: { email: string; password: string }) {
      try {
        const { user } = await request('/api/auth/login', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }),
        });
        currentSession = { user };
        notify('SIGNED_IN');
        return { data: { user, session: currentSession }, error: null };
      } catch (error) { return { data: { user: null, session: null }, error: error as Error }; }
    },
    async signOut() {
      try { await request('/api/auth/logout', { method: 'POST' }); }
      catch (error) { return { error: error as Error }; }
      currentSession = null;
      notify('SIGNED_OUT');
      return { error: null };
    },
    async refreshSession() { return this.getSession(); },
    onAuthStateChange(listener: AuthListener) {
      authListeners.add(listener);
      return { data: { subscription: { unsubscribe: () => authListeners.delete(listener) } } };
    },
  },
  functions: {
    async invoke(name: string, options?: { body?: any; signal?: AbortSignal }) {
      try {
        const data = await request(`/api/functions/${encodeURIComponent(name)}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(options?.body || {}), signal: options?.signal,
        });
        return { data, error: null };
      } catch (error) { return { data: null, error: error as Error }; }
    },
  },
  channel(_name: string): Channel {
    const callbacks: Array<() => void> = [];
    const channel: Channel = {
      on: (_event, _filter, callback) => { callbacks.push(callback); return channel; },
      subscribe: () => { intervals.set(channel, window.setInterval(() => callbacks.forEach((callback) => callback()), 10000)); return channel; },
      unsubscribe: () => { const timer = intervals.get(channel); if (timer) window.clearInterval(timer); },
    };
    return channel;
  },
  removeChannel(channel: Channel) { channel.unsubscribe(); },
  async rpc(name: string, args?: Record<string, any>) {
    try {
      const data = await request(`/api/rpc/${encodeURIComponent(name)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(args || {}),
      });
      return { data, error: null };
    } catch (error) { return { data: null, error: error as Error }; }
  },
};
