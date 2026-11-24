import { useEffect, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { api } from '@/integrations/api/client';
import { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';

type Fields = { source: string; medium: string; campaign: string };
type Rule = { id: string; enabled: boolean; match: Fields; set: Fields };
const fields = ['source', 'medium', 'campaign'] as const;
const blank = (): Fields => ({ source: '', medium: '', campaign: '' });
const newRule = (): Rule => ({ id: crypto.randomUUID(), enabled: true, match: blank(), set: blank() });

export function AttributionRulesSettings() {
  const { toast } = useToast();
  const [settingId, setSettingId] = useState<string | null>(null);
  const [rules, setRules] = useState<Rule[]>([]);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    api.from('app_settings').select('id,value').eq('key', 'lead_attribution_rules').maybeSingle()
      .then(({ data, error }) => {
        if (!active) return;
        if (error) toast({ title: 'Could not load attribution defaults', description: String(error), variant: 'destructive' });
        if (data) {
          setSettingId(data.id);
          try { setRules(Array.isArray(JSON.parse(data.value)) ? JSON.parse(data.value) : []); }
          catch { setRules([]); }
        }
        setLoading(false);
      });
    return () => { active = false; };
  }, [toast]);

  const update = (id: string, side: 'match' | 'set', field: keyof Fields, value: string) =>
    setRules((current) => current.map((rule) => rule.id === id ?
      { ...rule, [side]: { ...rule[side], [field]: value } } : rule));

  const save = async () => {
    if (rules.some((rule) => !fields.some((field) => rule.match[field].trim()) ||
      !fields.some((field) => rule.set[field].trim()))) {
      toast({ title: 'Complete each rule', description: 'Enter at least one incoming value and one replacement value.', variant: 'destructive' });
      return;
    }
    setSaving(true);
    const value = JSON.stringify(rules.map((rule) => ({ ...rule,
      match: Object.fromEntries(fields.map((field) => [field, rule.match[field].trim()])),
      set: Object.fromEntries(fields.map((field) => [field, rule.set[field].trim()])),
    })));
    const result = settingId
      ? await api.from('app_settings').update({ value }).eq('id', settingId).select('id').single()
      : await api.from('app_settings').insert({ key: 'lead_attribution_rules', value }).select('id').single();
    setSaving(false);
    if (result.error) toast({ title: 'Could not save defaults', description: String(result.error), variant: 'destructive' });
    else { setSettingId(result.data.id); toast({ title: 'Attribution defaults saved' }); }
  };

  return <Card className="space-y-4 p-4 md:p-6">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h2 className="text-lg font-semibold">Incoming lead attribution defaults</h2>
        <p className="text-sm text-muted-foreground">When an incoming lead matches, replace only the values you enter. The first matching rule wins. Changes apply to new incoming leads and their university delivery.</p>
      </div>
      <Button onClick={save} disabled={loading || saving}>{saving ? 'Saving…' : 'Save defaults'}</Button>
    </div>
    {loading ? <p className="text-sm text-muted-foreground">Loading…</p> : <>
      {rules.map((rule, index) => <div key={rule.id} className="rounded-lg border p-4">
        <div className="mb-3 flex items-center justify-between gap-3">
          <label className="flex items-center gap-2 text-sm font-medium"><Checkbox checked={rule.enabled} onCheckedChange={(checked) => setRules((current) => current.map((item) => item.id === rule.id ? { ...item, enabled: checked === true } : item))} /> Rule {index + 1} enabled</label>
          <Button variant="ghost" size="sm" aria-label={`Remove rule ${index + 1}`} onClick={() => setRules((current) => current.filter((item) => item.id !== rule.id))}><Trash2 className="h-4 w-4" /></Button>
        </div>
        <div className="grid gap-4 lg:grid-cols-2">
          {(['match', 'set'] as const).map((side) => <div key={side}>
            <p className="mb-2 text-sm font-medium">{side === 'match' ? 'When incoming values equal' : 'Store these values instead'}</p>
            <div className="grid gap-2 sm:grid-cols-3">{fields.map((field) => <label key={field} className="text-xs font-medium capitalize">{field}
              <Input className="mt-1" value={rule[side][field]} onChange={(event) => update(rule.id, side, field, event.target.value)} placeholder={side === 'match' ? 'Any value' : 'Keep incoming'} maxLength={200} />
            </label>)}</div>
          </div>)}
        </div>
      </div>)}
      <Button variant="outline" onClick={() => setRules((current) => [...current, newRule()])}><Plus className="mr-2 h-4 w-4" /> Add rule</Button>
    </>}
  </Card>;
}
