import { useCallback, useEffect, useState } from 'react';
import { Plus, Trash2, Zap } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import { api } from '@/integrations/api/client';

type Condition = { field: string; operator: string; value: string };
type Rule = { id: string; name: string; priority: number; status: 'Active' | 'Paused';
  match_mode: 'all' | 'any'; conditions: Condition[]; destination_ids: string[]; triggered_count?: number };
type University = { id: string; name: string };
const OPERATORS = [
  ['is', 'is'], ['is_not', 'is not'], ['contains', 'contains'],
  ['not_contains', 'does not contain'], ['starts_with', 'starts with'],
  ['is_empty', 'is empty'], ['is_not_empty', 'is not empty'],
] as const;
const NEEDS_VALUE = new Set(['is', 'is_not', 'contains', 'not_contains', 'starts_with']);

export function LeadAutomationSettings() {
  const { toast } = useToast();
  const [rules, setRules] = useState<Rule[]>([]);
  const [universities, setUniversities] = useState<University[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Rule | null>(null);
  const [name, setName] = useState('');
  const [priority, setPriority] = useState(1);
  const [matchMode, setMatchMode] = useState<'all' | 'any'>('all');
  const [conditions, setConditions] = useState<Condition[]>([]);
  const [destinations, setDestinations] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const [ruleResult, universityResult] = await Promise.all([
      api.from('inbound_routing_rules').select('*').order('priority', { ascending: true }).limit(100),
      api.from('universities').select('id,name').order('name').limit(1000),
    ]);
    if (ruleResult.error || universityResult.error) {
      toast({ title: 'Could not load lead automation', description: String(ruleResult.error || universityResult.error),
        variant: 'destructive' });
    } else {
      setRules(ruleResult.data || []);
      setUniversities(universityResult.data || []);
    }
    setLoading(false);
  }, [toast]);
  useEffect(() => { load(); }, [load]);

  const show = (rule: Rule | null) => {
    setEditing(rule);
    setName(rule?.name || '');
    setPriority(rule?.priority || rules.length + 1);
    setMatchMode(rule?.match_mode || 'all');
    setConditions(rule?.conditions?.map((condition) => ({ ...condition })) || []);
    setDestinations(rule?.destination_ids || []);
    setOpen(true);
  };
  const save = async () => {
    if (!name.trim() || destinations.length === 0 ||
        conditions.some((condition) => !/^[\w.-]{1,100}$/.test(condition.field.trim()) ||
          NEEDS_VALUE.has(condition.operator) && !condition.value.trim())) {
      toast({ title: 'Complete the rule', description: 'Add a name, a destination, and valid conditions.',
        variant: 'destructive' });
      return;
    }
    setSaving(true);
    try {
      const values = { name: name.trim(), priority: Math.max(1, priority || 1),
        status: editing?.status || 'Active', match_mode: matchMode,
        conditions: conditions.map((condition) => ({ ...condition, field: condition.field.trim(), value: condition.value.trim() })),
        destination_ids: destinations };
      const query = editing
        ? api.from('inbound_routing_rules').update(values).eq('id', editing.id)
        : api.from('inbound_routing_rules').insert(values);
      const { error } = await query;
      if (error) throw error;
      setOpen(false);
      await load();
      toast({ title: editing ? 'Automation updated' : 'Automation created' });
    } catch (error) {
      toast({ title: 'Could not save automation', description: String(error), variant: 'destructive' });
    } finally { setSaving(false); }
  };
  const toggle = async (rule: Rule) => {
    const { error } = await api.from('inbound_routing_rules')
      .update({ status: rule.status === 'Active' ? 'Paused' : 'Active' }).eq('id', rule.id);
    if (error) toast({ title: 'Could not update automation', description: String(error), variant: 'destructive' });
    else await load();
  };
  const remove = async (rule: Rule) => {
    if (!confirm('Delete "' + rule.name + '"? New leads will stop using this rule.')) return;
    const { error } = await api.from('inbound_routing_rules').delete().eq('id', rule.id);
    if (error) toast({ title: 'Could not delete automation', description: String(error), variant: 'destructive' });
    else await load();
  };
  const destinationNames = (ids: string[]) => ids.map((id) =>
    universities.find((university) => university.id === id)?.name || 'Unknown university').join(', ');

  return <>
    <Card className="p-4 space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-semibold flex items-center gap-2"><Zap className="h-4 w-4" /> Lead automation</h2>
          <p className="text-xs text-muted-foreground">Route every new Generic Lead API lead by city, state, course, source, campaign, or any incoming field.</p>
        </div>
        <Button size="sm" onClick={() => show(null)}><Plus className="h-4 w-4 mr-1" /> New rule</Button>
      </div>
      {loading ? <p className="text-sm text-muted-foreground">Loading rules...</p>
        : rules.length === 0 ? <p className="text-sm text-muted-foreground">No rules yet. New leads are saved here without an automatic push.</p>
        : <div className="space-y-2">{rules.map((rule) => <div key={rule.id} className="border rounded p-3 flex flex-wrap justify-between gap-2">
          <div>
            <div className="flex items-center gap-2"><strong className="text-sm">{rule.name}</strong>
              <Badge variant={rule.status === 'Active' ? 'default' : 'secondary'}>{rule.status}</Badge></div>
            <p className="text-xs text-muted-foreground">{rule.conditions?.length
              ? (rule.match_mode === 'any' ? 'Any: ' : 'All: ') + rule.conditions.map((condition) =>
                condition.field + ' ' + (OPERATORS.find(([key]) => key === condition.operator)?.[1] || condition.operator) + ' ' + condition.value).join('; ')
              : 'Every new lead'}</p>
            <p className="text-xs text-muted-foreground">Push to: {destinationNames(rule.destination_ids || [])} · Triggered {rule.triggered_count || 0} times</p>
          </div>
          <div className="flex gap-1">
            <Button size="sm" variant="outline" onClick={() => show(rule)}>Edit</Button>
            <Button size="sm" variant="outline" onClick={() => toggle(rule)}>{rule.status === 'Active' ? 'Pause' : 'Enable'}</Button>
            <Button size="sm" variant="ghost" aria-label={'Delete ' + rule.name} onClick={() => remove(rule)}><Trash2 className="h-4 w-4" /></Button>
          </div>
        </div>)}</div>}
    </Card>
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-xl max-h-[90vh] overflow-y-auto">
        <DialogHeader><DialogTitle>{editing ? 'Edit lead automation' : 'New lead automation'}</DialogTitle></DialogHeader>
        <div className="space-y-4">
          <div className="grid grid-cols-[1fr_6rem] gap-3">
            <div><Label>Rule name</Label><Input value={name} onChange={(event) => setName(event.target.value)} placeholder="Delhi MBA leads" /></div>
            <div><Label>Priority</Label><Input type="number" min="1" value={priority} onChange={(event) => setPriority(Number(event.target.value))} /></div>
          </div>
          <div>
            <Label>Conditions</Label>
            <p className="text-xs text-muted-foreground">No conditions means every new lead. Add conditions to route selected leads only.</p>
            {conditions.length > 1 && <Select value={matchMode} onValueChange={(value) => setMatchMode(value as 'all' | 'any')}>
              <SelectTrigger className="mt-2"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="all">Match all conditions</SelectItem><SelectItem value="any">Match any condition</SelectItem></SelectContent>
            </Select>}
            <div className="space-y-2 mt-2">{conditions.map((condition, index) => <div key={index} className="grid grid-cols-[1fr_9rem_1fr_auto] gap-2 items-center">
              <Input list="lead-automation-fields" value={condition.field} placeholder="city"
                onChange={(event) => setConditions((prev) => prev.map((item, i) => i === index ? { ...item, field: event.target.value } : item))} />
              <Select value={condition.operator} onValueChange={(value) => setConditions((prev) =>
                prev.map((item, i) => i === index ? { ...item, operator: value } : item))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{OPERATORS.map(([key, label]) => <SelectItem key={key} value={key}>{label}</SelectItem>)}</SelectContent>
              </Select>
              <Input value={condition.value} placeholder="Value" disabled={!NEEDS_VALUE.has(condition.operator)}
                onChange={(event) => setConditions((prev) => prev.map((item, i) => i === index ? { ...item, value: event.target.value } : item))} />
              <Button variant="ghost" size="icon" aria-label="Remove condition"
                onClick={() => setConditions((prev) => prev.filter((_, i) => i !== index))}><Trash2 className="h-4 w-4" /></Button>
            </div>)}</div>
            <datalist id="lead-automation-fields">{['name', 'email', 'mobile', 'city', 'state', 'course', 'source', 'campaign', 'leadMedium']
              .map((field) => <option key={field} value={field} />)}</datalist>
            <Button size="sm" variant="outline" className="mt-2" onClick={() =>
              setConditions((prev) => [...prev, { field: 'city', operator: 'is', value: '' }])}>
              <Plus className="h-3 w-3 mr-1" /> Add condition
            </Button>
          </div>
          <div>
            <Label>Push matching leads to</Label>
            <ScrollArea className="h-44 border rounded p-2 mt-1"><div className="space-y-1">{universities.map((university) =>
              <label key={university.id} className="flex items-center gap-2 text-sm cursor-pointer">
                <Checkbox checked={destinations.includes(university.id)} onCheckedChange={(checked) =>
                  setDestinations((prev) => checked ? [...prev, university.id] : prev.filter((id) => id !== university.id))} />
                {university.name}
              </label>)}</div></ScrollArea>
          </div>
        </div>
        <DialogFooter><Button onClick={save} disabled={saving}>{saving ? 'Saving...' : 'Save rule'}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </>;
}
