import { useCallback, useEffect, useState } from 'react';
import { Check, Copy, Plus, RefreshCw } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useToast } from '@/hooks/use-toast';

type Connection = {
  id: string; name: string; source_label: string;
  field_map: Record<string, string>; is_active: boolean; request_count: number;
  last_used_at?: string | null;
};
const MAPPABLE = [
  { key: 'name', label: 'Name field' }, { key: 'email', label: 'Email field' },
  { key: 'mobile', label: 'Phone field' }, { key: 'source', label: 'Source field' },
  { key: 'campaign', label: 'Campaign field' },
  { key: 'course', label: 'Course / interest field' },
  { key: 'city', label: 'City field' }, { key: 'state', label: 'State field' },
  { key: 'medium', label: 'UTM medium field' },
];

async function call(path: string, method = 'GET', body?: unknown) {
  const response = await fetch(path, { method, credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

export function GenericLeadConnections() {
  const { toast } = useToast();
  const [connections, setConnections] = useState<Connection[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Connection | null>(null);
  const [name, setName] = useState('');
  const [source, setSource] = useState('');
  const [fieldMap, setFieldMap] = useState<Record<string, string>>({});
  const [key, setKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);
  const endpoint = `${window.location.origin}/api/inbound/generic-lead`;

  const load = useCallback(async () => {
    setLoading(true);
    try { setConnections((await call('/api/generic-connections')).connections || []); }
    catch (error) { toast({ title: 'Could not load generic APIs', description: String(error), variant: 'destructive' }); }
    finally { setLoading(false); }
  }, [toast]);
  useEffect(() => { load(); }, [load]);

  const show = (connection: Connection | null) => {
    setEditing(connection);
    setName(connection?.name || '');
    setSource(connection?.source_label || '');
    setFieldMap(connection?.field_map || {});
    setKey('');
    setOpen(true);
  };
  const copy = async (text: string) => {
    try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); }
    catch { toast({ title: 'Copy failed', variant: 'destructive' }); }
  };
  const save = async () => {
    setSaving(true);
    try {
      const body = { name: name.trim(), source_label: source.trim(),
        field_map: Object.fromEntries(Object.entries(fieldMap).filter(([, value]) => value.trim())) };
      const result = editing
        ? await call(`/api/generic-connections/${editing.id}`, 'PATCH', body)
        : await call('/api/generic-connections', 'POST', body);
      if (result.key) setKey(result.key);
      else setOpen(false);
      await load();
      toast({ title: editing ? 'Connection updated' : 'Generic API created' });
    } catch (error) { toast({ title: 'Could not save connection', description: String(error), variant: 'destructive' }); }
    finally { setSaving(false); }
  };
  const toggle = async (connection: Connection) => {
    try {
      await call(`/api/generic-connections/${connection.id}`, 'PATCH', { is_active: !connection.is_active });
      await load();
    } catch (error) { toast({ title: 'Could not update connection', description: String(error), variant: 'destructive' }); }
  };

  return <>
    <Card className="p-5 space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Generic Lead API</h2>
          <p className="text-sm text-muted-foreground">Collect leads from ads, forms, CRMs, or automation tools. Configure automatic push rules under All Leads → Lead automation.</p>
        </div>
        <Button onClick={() => show(null)}><Plus className="h-4 w-4 mr-2" /> New connection</Button>
      </div>
      <div className="flex gap-2 items-center">
        <code className="flex-1 p-2 rounded border text-xs break-all">{endpoint}</code>
        <Button variant="outline" size="icon" aria-label="Copy endpoint" onClick={() => copy(endpoint)}>
          {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">Send one JSON lead per POST with an Authorization: Bearer key header. Include name, email or mobile, and any other fields. Use Idempotency-Key for safe retries. Nested incoming fields can be mapped per connection.</p>
      <pre className="overflow-x-auto p-3 rounded bg-muted text-xs">{`curl -X POST '${endpoint}' \\
  -H 'Authorization: Bearer YOUR_KEY' \\
  -H 'Content-Type: application/json' \\
  -H 'Idempotency-Key: YOUR_EXTERNAL_LEAD_ID' \\
  -d '{"name":"Example Lead","email":"lead@example.com","mobile":"9876543210","source":"Meta Ads","campaign":"November"}'`}</pre>
      <div className="flex justify-between items-center">
        <h3 className="font-medium">Connections</h3>
        <Button variant="ghost" size="sm" onClick={load} disabled={loading}><RefreshCw className="h-4 w-4 mr-1" /> Refresh</Button>
      </div>
      {loading ? <p className="text-sm text-muted-foreground">Loading...</p> : connections.length === 0
        ? <p className="text-sm text-muted-foreground">No generic connections yet.</p>
        : <div className="space-y-2">{connections.map((connection) =>
          <div key={connection.id} className="rounded border p-3 flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2"><strong>{connection.name}</strong>
                <Badge variant={connection.is_active ? 'default' : 'secondary'}>{connection.is_active ? 'Active' : 'Paused'}</Badge></div>
              <p className="text-xs text-muted-foreground">Source: {connection.source_label} · {connection.request_count || 0} received
                {connection.last_used_at ? ` · Last used ${new Date(connection.last_used_at).toLocaleString()}` : ''}</p>
              <p className="text-xs text-muted-foreground">Automatic routing is managed under All Leads.</p>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => show(connection)}>Edit</Button>
              <Button variant="outline" size="sm" onClick={() => toggle(connection)}>{connection.is_active ? 'Pause' : 'Enable'}</Button>
            </div>
          </div>)}</div>}
    </Card>
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-xl max-h-[90vh] overflow-y-auto">
        <DialogHeader><DialogTitle>{editing ? 'Edit generic connection' : 'Create generic connection'}</DialogTitle></DialogHeader>
        {key ? <div className="space-y-3">
          <p className="text-sm">Copy this bearer key now. It will not be shown again.</p>
          <code className="block border rounded p-3 break-all text-xs">{key}</code>
          <Button onClick={() => copy(key)}><Copy className="h-4 w-4 mr-2" /> Copy key</Button>
        </div> : <div className="space-y-4">
          <div><Label>Connection name</Label><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Meta Ads website" /></div>
          <div><Label>Default source label</Label><Input value={source} onChange={(e) => setSource(e.target.value)} placeholder="Meta Ads" /></div>
          <div>
            <Label>Incoming field names (optional)</Label>
            <p className="text-xs text-muted-foreground mb-2">Use these if the sender uses different names. Dot paths such as contact.email are supported.</p>
            <div className="grid grid-cols-2 gap-2">{MAPPABLE.map((item) =>
              <div key={item.key}><Label className="text-xs">{item.label}</Label>
                <Input value={fieldMap[item.key] || ''} onChange={(e) => setFieldMap((prev) => ({ ...prev, [item.key]: e.target.value }))}
                  placeholder={item.key} /></div>)}</div>
          </div>
        </div>}
        <DialogFooter>{key
          ? <Button onClick={() => setOpen(false)}>Done</Button>
          : <Button onClick={save} disabled={saving || !name.trim()}>{saving ? 'Saving...' : editing ? 'Save changes' : 'Create key'}</Button>}</DialogFooter>
      </DialogContent>
    </Dialog>
  </>;
}
