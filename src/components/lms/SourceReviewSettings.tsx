import { useEffect, useMemo, useState } from 'react';
import { api } from '@/integrations/api/client';
import { useAuth } from '@/hooks/useAuth';
import { useToast } from '@/hooks/use-toast';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
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

  return <Card className="space-y-5 p-4 md:p-6">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h2 className="text-lg font-semibold">Sources & team notes</h2>
        <p className="text-sm text-muted-foreground">See where leads arrived from. Published source and medium labels apply to future incoming leads.</p>
      </div>
      <Badge variant="outline">{sources.length} source and medium combinations</Badge>
    </div>
    <Input aria-label="Search sources and campaigns" placeholder="Search source, medium, connection, or campaign" value={search} onChange={(event) => setSearch(event.target.value)} />
    <div className="max-h-[380px] space-y-2 overflow-y-auto pr-1">
      {visible.map((item) => <button key={`${item.source}\0${item.medium}`} type="button" onClick={() => choose(item)}
        className={`w-full rounded-lg border px-4 py-3 text-left transition-colors hover:bg-muted/60 ${selected?.source === item.source && selected?.medium === item.medium ? 'border-primary bg-primary/5' : ''}`}>
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-semibold">{item.source || 'Unspecified'}</span>
          <Badge variant="secondary">{item.medium || 'No medium'}</Badge>
          <span className="ml-auto text-sm font-medium">{item.leads} leads</span>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">{item.connections || 'Unknown connection'} · {item.campaigns} campaign{Number(item.campaigns) === 1 ? '' : 's'}</p>
        {!!item.campaign_names && <p className="mt-1 truncate text-xs text-muted-foreground" title={item.campaign_names}>{item.campaign_names}</p>}
      </button>)}
      {!visible.length && <p className="py-6 text-center text-sm text-muted-foreground">No matching sources.</p>}
    </div>
    {selected && <div className="space-y-3 rounded-lg border bg-muted/20 p-4">
      <div><h3 className="font-semibold">{selected.source} {selected.medium && `· ${selected.medium}`}</h3>
        <p className="text-xs text-muted-foreground">Leave a label blank to keep the incoming value. Notes can be submitted without changing labels.</p></div>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-sm font-medium">New source label<Input className="mt-1" value={proposedSource} onChange={(event) => setProposedSource(event.target.value)} maxLength={200} placeholder="Keep incoming source" /></label>
        <label className="text-sm font-medium">New medium label<Input className="mt-1" value={proposedMedium} onChange={(event) => setProposedMedium(event.target.value)} maxLength={200} placeholder="Keep incoming medium" /></label>
      </div>
      <label className="block text-sm font-medium">Note<Textarea className="mt-1" value={note} onChange={(event) => setNote(event.target.value)} maxLength={2000} placeholder="Why should this source be labeled this way?" /></label>
      <div className="flex flex-wrap gap-2">
        <Button disabled={busy || !proposedSource.trim() && !proposedMedium.trim() && !note.trim()}
          onClick={() => act({ action: isAdmin ? 'publish' : 'submit', source: selected.source, medium: selected.medium,
            proposed_source: proposedSource, proposed_medium: proposedMedium, note })}>
          {isAdmin ? 'Publish labels & note' : 'Send to admin for approval'}
        </Button>
        <Button variant="outline" onClick={() => setSelected(null)}>Cancel</Button>
      </div>
    </div>}
    <div className="space-y-2">
      <h3 className="font-semibold">Team notes & approvals</h3>
      {reviews.map((review) => <div key={review.id} className={`rounded-lg border p-3 ${review.status === 'pending' ? 'border-amber-300 bg-amber-50/70 dark:bg-amber-950/20' : ''}`}>
        <div className="flex flex-wrap items-center gap-2 text-sm"><strong>{review.source}</strong><span>· {review.medium || 'No medium'}</span>
          <Badge className={review.status === 'pending' ? 'border-amber-400 bg-amber-100 text-amber-900' : ''} variant="outline">{review.status === 'pending' ? 'Pending admin approval' : review.status}</Badge>
          <span className="ml-auto text-xs text-muted-foreground">{review.author}</span></div>
        {(review.proposed_source || review.proposed_medium) && <p className="mt-1 text-sm">Proposed: {review.proposed_source || review.source} · {review.proposed_medium || review.medium || 'No medium'}</p>}
        {review.note && <p className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">{review.note}</p>}
        {isAdmin && review.status === 'pending' && <div className="mt-2 flex gap-2">
          <Button size="sm" disabled={busy} onClick={() => act({ action: 'approve', id: review.id })}>Approve & publish</Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => act({ action: 'reject', id: review.id })}>Reject</Button>
        </div>}
      </div>)}
      {!reviews.length && <p className="text-sm text-muted-foreground">No notes yet.</p>}
    </div>
  </Card>;
}
