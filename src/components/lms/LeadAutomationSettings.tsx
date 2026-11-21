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
import { columnMappingToPayloadFields } from '@/components/universities/PayloadFieldsEditor';

type Condition = { field: string; operator: string; value: string };
type FieldDefault = { targetField: string; value: string };
type FieldSource = { targetField: string; sourceField: string };
type FieldTransform = { sourceField: string; equals: string; targetField: string; value: string };
type DestinationOverrides = { defaults: FieldDefault[]; sources: FieldSource[]; transforms: FieldTransform[] };
type Rule = { id: string; name: string; priority: number; status: 'Active' | 'Paused';
  match_mode: 'all' | 'any'; conditions: Condition[]; destination_ids: string[];
  field_overrides?: Record<string, DestinationOverrides>; triggered_count?: number };
type University = { id: string; name: string; column_mapping?: Record<string, string> | string; default_values?: Record<string, string> };
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
  const [fieldOverrides, setFieldOverrides] = useState<Record<string, DestinationOverrides>>({});
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const [ruleResult, universityResult] = await Promise.all([
      api.from('inbound_routing_rules').select('*').order('priority', { ascending: true }).limit(100),
      api.from('universities').select('id,name,column_mapping,default_values').order('name').limit(1000),
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
    setFieldOverrides(structuredClone(rule?.field_overrides || {}));
    setOpen(true);
  };
  const save = async () => {
    if (!name.trim() || destinations.length === 0 ||
        conditions.some((condition) => !/^[\w.-]{1,100}$/.test(condition.field.trim()) ||
          NEEDS_VALUE.has(condition.operator) && !condition.value.trim()) ||
        destinations.some((id) => (fieldOverrides[id]?.sources || []).some((row) => !/^[\w.-]{1,100}$/.test(row.sourceField.trim()))) ||
        destinations.some((id) => (fieldOverrides[id]?.transforms || []).some((row) =>
          !/^[\w.-]{1,100}$/.test(row.sourceField.trim()) || !row.targetField || !row.value.trim()))) {
      toast({ title: 'Complete the rule', description: 'Add a name, a destination, and valid conditions.',
        variant: 'destructive' });
      return;
    }
    setSaving(true);
    try {
      const values = { name: name.trim(), priority: Math.max(1, priority || 1),
        status: editing?.status || 'Active', match_mode: matchMode,
        conditions: conditions.map((condition) => ({ ...condition, field: condition.field.trim(), value: condition.value.trim() })),
        destination_ids: destinations,
        field_overrides: Object.fromEntries(destinations.map((id) => [id, fieldOverrides[id] || { defaults: [], sources: [], transforms: [] }])) };
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
  const partnerFields = (university: University) => {
    let mapping: Record<string, string> = {};
    try { mapping = typeof university.column_mapping === 'string' ? JSON.parse(university.column_mapping) : university.column_mapping || {}; }
    catch { mapping = {}; }
    if (!mapping || Array.isArray(mapping)) mapping = {};
    const fields = Object.keys(mapping).some((key) => key.startsWith('__field_'))
      ? columnMappingToPayloadFields(mapping).map((field) => ({ name: field.fieldName,
          label: field.displayName || field.fieldName, source: field.sourceKey || field.sourceType,
          saved: field.staticValue || university.default_values?.[field.sourceKey || ''] || '' }))
      : Object.entries(mapping).filter(([key]) => !key.startsWith('__') || key.startsWith('__static_'))
          .map(([key,value]) => ({ name: key.startsWith('__static_') ? key.slice(9) : value,
            label: key.startsWith('__static_') ? key.slice(9) : value, source: key, saved: key.startsWith('__static_') ? value : university.default_values?.[key] || '' }));
    return fields.filter((field) => field.name && !/key|secret|token|password|authorization/i.test(field.name) && !['college_id','__proto__','prototype','constructor'].includes(field.name.toLowerCase()));
  };
  const updateOverrides = (id: string, update: (value: DestinationOverrides) => DestinationOverrides) =>
    setFieldOverrides((previous) => ({ ...previous, [id]: update(previous[id] || { defaults: [], sources: [], transforms: [] }) }));

  return <>
    <Card className="p-4 space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-semibold flex items-center gap-2"><Zap className="h-4 w-4" /> Lead push on creation</h2>
          <p className="text-xs text-muted-foreground">Route new API and connected ad leads by city, state, course, source, campaign, or any incoming field. Set partner field values for each destination.</p>
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
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader><DialogTitle>{editing ? 'Edit lead push on creation' : 'New lead push on creation'}</DialogTitle></DialogHeader>
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
          {destinations.map((id) => {
            const university = universities.find((item) => item.id === id);
            if (!university) return null;
            const fields = partnerFields(university);
            const override = fieldOverrides[id] || { defaults: [], sources: [], transforms: [] };
            return <div key={id} className="space-y-3 rounded-lg border p-4">
              <div><h3 className="font-semibold">{university.name} · partner fields</h3>
                <p className="text-xs text-muted-foreground">Use the fields saved in this university integration. Choose an incoming field, set a fallback if it is empty, or add a conditional value. Credential fields are hidden.</p></div>
              {fields.length ? <div className="max-h-64 overflow-auto rounded-md border">
                <table className="w-full text-sm"><thead className="bg-muted/50 text-left text-xs"><tr><th className="p-2">Partner field</th><th className="p-2">Saved mapping / value</th><th className="p-2">Use incoming field</th><th className="p-2">Fallback value</th></tr></thead>
                  <tbody>{fields.map((field) => <tr key={field.name} className="border-t"><td className="p-2 font-medium">{field.label}<span className="block text-xs font-normal text-muted-foreground">{field.name}</span></td>
                    <td className="p-2 text-xs text-muted-foreground">{field.source}{field.saved ? ` · ${field.saved}` : ''}</td>
                    <td className="p-2"><Input list="lead-automation-fields" aria-label={`Incoming field for ${field.name} at ${university.name}`} placeholder={field.source === 'lead_data' || field.source === 'static' || field.source === 'dynamic' ? 'Use saved mapping' : field.source}
                      maxLength={100} value={override.sources?.find((item) => item.targetField === field.name)?.sourceField || ''}
                      onChange={(event) => updateOverrides(id, (current) => ({ ...current,
                        sources: [...(current.sources || []).filter((item) => item.targetField !== field.name),
                          ...(event.target.value ? [{ targetField: field.name, sourceField: event.target.value }] : [])] }))} /></td>
                    <td className="p-2"><Input aria-label={`Fallback ${field.name} for ${university.name}`} placeholder={field.saved || 'Use incoming value'} maxLength={1000}
                      value={override.defaults.find((item) => item.targetField === field.name)?.value || ''}
                      onChange={(event) => updateOverrides(id, (current) => ({ ...current,
                        defaults: [...current.defaults.filter((item) => item.targetField !== field.name),
                          ...(event.target.value ? [{ targetField: field.name, value: event.target.value }] : [])] }))} /></td></tr>)}</tbody>
                </table></div> : <p className="text-xs text-muted-foreground">Add partner payload fields in the university integration before setting field values here.</p>}
              {!!fields.length && <div className="space-y-2"><div><h4 className="text-sm font-semibold">Conditional field values</h4><p className="text-xs text-muted-foreground">The first box is an incoming LMS lead field (or a field from the incoming API payload), not a partner API key. Leave Equals blank to match an empty or missing field. The first matching row for a partner field wins.</p></div>
                <div className="hidden sm:grid sm:grid-cols-[1fr_1fr_1fr_1fr_auto] gap-2 px-2 text-xs font-medium text-muted-foreground"><span>Incoming lead field</span><span>Equals (blank = empty)</span><span>Partner API field</span><span>Send this value</span><span className="w-9" /></div>
                {override.transforms.map((row,index) => <div key={index} className="grid grid-cols-1 gap-2 rounded-md bg-muted/30 p-2 sm:grid-cols-[1fr_1fr_1fr_1fr_auto] sm:items-center">
                  <Input list="lead-automation-fields" aria-label="Incoming lead field" placeholder="e.g. city or leadMedium" value={row.sourceField} maxLength={100}
                    onChange={(event) => updateOverrides(id, (current) => ({ ...current, transforms: current.transforms.map((item,i) => i === index ? { ...item, sourceField: event.target.value } : item) }))} />
                  <Input aria-label="Equals value; leave empty to match blank" placeholder="Leave blank to match empty" value={row.equals} maxLength={1000}
                    onChange={(event) => updateOverrides(id, (current) => ({ ...current, transforms: current.transforms.map((item,i) => i === index ? { ...item, equals: event.target.value } : item) }))} />
                  <Select value={row.targetField} onValueChange={(value) => updateOverrides(id, (current) => ({ ...current, transforms: current.transforms.map((item,i) => i === index ? { ...item, targetField: value } : item) }))}>
                    <SelectTrigger aria-label="Partner field to set"><SelectValue placeholder="Partner field" /></SelectTrigger><SelectContent>{fields.map((field) => <SelectItem key={field.name} value={field.name}>{field.label}</SelectItem>)}</SelectContent>
                  </Select>
                  <Input aria-label="Send as value" placeholder="Send as, e.g. AAA" value={row.value} maxLength={1000}
                    onChange={(event) => updateOverrides(id, (current) => ({ ...current, transforms: current.transforms.map((item,i) => i === index ? { ...item, value: event.target.value } : item) }))} />
                  <Button variant="ghost" size="icon" aria-label="Remove conditional value" onClick={() => updateOverrides(id, (current) => ({ ...current, transforms: current.transforms.filter((_,i) => i !== index) }))}><Trash2 className="h-4 w-4" /></Button>
                </div>)}
                <Button variant="outline" size="sm" disabled={override.transforms.length >= 50} onClick={() => updateOverrides(id, (current) => ({ ...current, transforms: [...current.transforms, { sourceField: '', equals: '', targetField: '', value: '' }] }))}><Plus className="mr-1 h-4 w-4" /> Add condition</Button>
              </div>}
            </div>;
          })}
        </div>
        <DialogFooter><Button onClick={save} disabled={saving}>{saving ? 'Saving...' : 'Save rule'}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </>;
}
