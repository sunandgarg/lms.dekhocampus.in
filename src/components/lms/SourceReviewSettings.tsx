import { useEffect, useMemo, useState } from 'react';
import { api } from '@/integrations/api/client';
import { useAuth } from '@/hooks/useAuth';
import { useToast } from '@/hooks/use-toast';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';

type Source = { source: string; medium: string; leads: number; campaigns: number; campaign_names: string | null; connections: string | null };
type Review = { id: string; source: string; medium: string; proposed_source: string; proposed_medium: string;
  note: string; status: 'pending' | 'approved' | 'rejected'; author: string; created_at: string };

export function SourceReviewSettings({ onPublished }: { onPublished?: () => void }) {
  const { user } = useAuth();
  const { toast } = useToast();
  const isAdmin = user?.role === 'admin' || user?.role === 'super_admin';
  const [sources, setSources] = useState<Source[]>([]);
  const [reviews, setReviews] = useState<Review[]>([]);
  const [selected, setSelected] = useState<Source | null>(null);
  const [search, setSearch] = useState('');
  const [proposedSource, setProposedSource] = useState('');
  const [proposedMedium, setProposedMedium] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const load = async () => {
    const { data, error } = await api.functions.invoke('source-review', { body: { action: 'list' } });
    if (error) toast({ title: 'Could not load sources', description: String(error), variant: 'destructive' });
    else { setSources(data.sources || []); setReviews(data.reviews || []); }
  };
  useEffect(() => { void load(); }, []);

  const visible = useMemo(() => sources.filter((item) =>
    `${item.source} ${item.medium} ${item.connections || ''} ${item.campaign_names || ''}`
      .toLowerCase().includes(search.trim().toLowerCase())), [sources, search]);

  const choose = (item: Source) => {
    setSelected(item); setProposedSource(''); setProposedMedium(''); setNote('');
  };
  const act = async (body: Record<string, string>) => {
    setBusy(true);
    const { error } = await api.functions.invoke('source-review', { body });
    setBusy(false);
    if (error) { toast({ title: 'Could not save source review', description: String(error), variant: 'destructive' }); return; }
    if (body.action === 'publish' || body.action === 'approve') onPublished?.();
    toast({ title: body.action === 'submit' ? 'Sent to admin for approval' : 'Source review updated' });
    setSelected(null); setProposedSource(''); setProposedMedium(''); setNote('');
    await load();
  };

  return <div className="min-h-0 space-y-3 overflow-y-auto px-5 pb-5">
    <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
      <span>Review incoming labels and campaigns. Published changes affect new leads.</span>
      <Badge variant="outline">{sources.length} combinations</Badge>
    </div>
    <Input aria-label="Search sources and campaigns" className="h-9" placeholder="Search source, medium, connection, or campaign" value={search} onChange={(event) => setSearch(event.target.value)} />
    <div className="max-h-[40vh] overflow-auto rounded-lg border" role="region" aria-label="Source list, scroll horizontally for more columns" tabIndex={0}>
      <table className="w-full min-w-[850px] text-sm">
        <thead className="sticky top-0 bg-muted text-left text-xs text-muted-foreground"><tr>
          <th className="px-3 py-2 font-medium">Source</th><th className="px-3 py-2 font-medium">Medium</th>
          <th className="px-3 py-2 font-medium">Connection</th><th className="px-3 py-2 font-medium">Campaigns</th>
          <th className="px-3 py-2 text-right font-medium">Leads</th><th className="px-3 py-2 text-right font-medium">Action</th>
        </tr></thead>
        <tbody>{visible.map((item) => <tr key={`${item.source}\0${item.medium}`}
          className={`border-t hover:bg-muted/40 ${selected?.source === item.source && selected?.medium === item.medium ? 'bg-primary/5' : ''}`}>
          <td className="max-w-[190px] truncate px-3 py-2 font-medium" title={item.source}>{item.source || 'Unspecified'}</td>
          <td className="max-w-[120px] truncate px-3 py-2" title={item.medium}>{item.medium || '—'}</td>
          <td className="max-w-[180px] truncate px-3 py-2" title={item.connections || ''}>{item.connections || '—'}</td>
          <td className="max-w-[220px] truncate px-3 py-2" title={item.campaign_names || ''}>{item.campaign_names || `${item.campaigns} campaigns`}</td>
          <td className="px-3 py-2 text-right tabular-nums">{item.leads}</td>
          <td className="px-3 py-1 text-right"><Button size="sm" variant="ghost" onClick={() => choose(item)}>Edit / note</Button></td>
        </tr>)}</tbody>
      </table>
      {!visible.length && <p className="py-5 text-center text-sm text-muted-foreground">No matching sources.</p>}
    </div>
    {selected && <div className="space-y-2 rounded-lg border bg-muted/20 p-3">
      <p className="text-sm font-semibold">{selected.source} {selected.medium && `· ${selected.medium}`}</p>
      <div className="grid gap-2 sm:grid-cols-2">
        <Input aria-label="New source label" value={proposedSource} onChange={(event) => setProposedSource(event.target.value)} maxLength={200} placeholder="New source (optional)" />
        <Input aria-label="New medium label" value={proposedMedium} onChange={(event) => setProposedMedium(event.target.value)} maxLength={200} placeholder="New medium (optional)" />
      </div>
      <Textarea aria-label="Note" className="min-h-[64px]" value={note} onChange={(event) => setNote(event.target.value)} maxLength={2000} placeholder="Note for the team (optional)" />
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={busy || !proposedSource.trim() && !proposedMedium.trim() && !note.trim()}
          onClick={() => act({ action: isAdmin ? 'publish' : 'submit', source: selected.source, medium: selected.medium,
            proposed_source: proposedSource, proposed_medium: proposedMedium, note })}>
          {isAdmin ? 'Publish' : 'Send for approval'}
        </Button>
        <Button size="sm" variant="outline" onClick={() => setSelected(null)}>Cancel</Button>
      </div>
    </div>}
    <div className="space-y-2 border-t pt-3">
      <h3 className="text-sm font-semibold">Team notes & approvals</h3>
      <div className="max-h-44 space-y-2 overflow-y-auto">
        {reviews.map((review) => <div key={review.id} className={`rounded-lg border px-3 py-2 text-sm ${review.status === 'pending' ? 'border-amber-300 bg-amber-50/70 dark:bg-amber-950/20' : ''}`}>
          <div className="flex flex-wrap items-center gap-2"><strong>{review.source}</strong><span>· {review.medium || 'No medium'}</span>
            <Badge className={review.status === 'pending' ? 'border-amber-400 bg-amber-100 text-amber-900' : ''} variant="outline">{review.status === 'pending' ? 'Pending admin approval' : review.status}</Badge>
            <span className="ml-auto text-xs text-muted-foreground">{review.author}</span></div>
          {(review.proposed_source || review.proposed_medium) && <p className="mt-1">Proposed: {review.proposed_source || review.source} · {review.proposed_medium || review.medium || 'No medium'}</p>}
          {review.note && <p className="mt-1 whitespace-pre-wrap text-muted-foreground">{review.note}</p>}
          {isAdmin && review.status === 'pending' && <div className="mt-2 flex gap-2">
            <Button size="sm" disabled={busy} onClick={() => act({ action: 'approve', id: review.id })}>Approve</Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => act({ action: 'reject', id: review.id })}>Reject</Button>
          </div>}
        </div>)}
        {!reviews.length && <p className="text-sm text-muted-foreground">No notes yet.</p>}
      </div>
    </div>
  </div>;
}
