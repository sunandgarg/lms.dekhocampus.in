import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Upload, Send, FileText, Star, Layers, Info, UserPlus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { useToast } from '@/hooks/use-toast';
import { api } from '@/integrations/api/client';
import { PresetManager } from './PresetManager';
import { MultiPushReport } from './MultiPushReport';
import { parseCSV } from '@/utils/csvParser';

interface MultiPushViewProps {
  universities: any[];
}

interface CsvLead {
  name: string;
  email: string;
  mobile: string;
  state?: string;
  city?: string;
  [key: string]: string | undefined;
}

export interface PushResult {
  rowIndex: number;
  lead: CsvLead;
  universityId: string;
  universityName: string;
  status: 'pending' | 'success' | 'duplicate' | 'fail';
  response?: string;
}

const REQUIRED_HEADERS = ['name', 'email', 'mobile'];

function parseCsv(text: string): CsvLead[] {
  const parsed = parseCSV(text);
  const rawHeaders = parsed.headers;

  // Normalize common aliases so multi-push only ever sees: name / email / mobile (+ optional)
  const aliasMap: Record<string, string> = {
    firstname: 'name', first_name: 'name', fullname: 'name', full_name: 'name', student_name: 'name', candidate_name: 'name',
    email_id: 'email', email_address: 'email', mail: 'email',
    phone: 'mobile', phone_number: 'mobile', mobile_number: 'mobile', contact: 'mobile', 'phone.number': 'mobile',
    state_name: 'state', city_name: 'city',
  };
  const headers = rawHeaders.map((h) => aliasMap[h] || h);

  const out: CsvLead[] = [];
  for (const source of parsed.data) {
    const row: any = {};
    headers.forEach((h, idx) => {
      if (!row[h]) row[h] = source[rawHeaders[idx]] || '';
    });
    // Preserve original raw header values too (e.g. lastname, phone.code) so process-lead can read them
    rawHeaders.forEach((h) => {
      if (!(h in row)) row[h] = source[h] || '';
    });
    if (row.name || row.email || row.mobile) out.push(row);
  }
  return out;
}

export function MultiPushView({ universities }: MultiPushViewProps) {
  const navigate = useNavigate();
  const { toast } = useToast();

  const [leads, setLeads] = useState<CsvLead[]>([]);
  const [fileName, setFileName] = useState('');
  const [sourceCsv, setSourceCsv] = useState('');
  const [selectedUniIds, setSelectedUniIds] = useState<string[]>([]);
  const [presets, setPresets] = useState<any[]>([]);
  const [defaultsMap, setDefaultsMap] = useState<Record<string, Record<string, string>>>({});
  const [isPushing, setIsPushing] = useState(false);
  const [results, setResults] = useState<PushResult[]>([]);
  const [progress, setProgress] = useState(0);
  const [inputMode, setInputMode] = useState<'csv' | 'quick'>('csv');
  const [quickLead, setQuickLead] = useState({ name: '', email: '', mobile: '' });
  const [throughput, setThroughput] = useState<{ done: number; elapsedMs: number }>({ done: 0, elapsedMs: 0 });


  // Fetch presets + defaults (from universities.default_values) on mount
  useEffect(() => {
    (async () => {
      const [presetRes, uniRes] = await Promise.all([
        api.from('multi_push_presets').select('*').order('is_default', { ascending: false }),
        api.from('universities').select('id, default_values'),
      ]);
      setPresets(presetRes.data || []);
      const map: Record<string, Record<string, string>> = {};
      (uniRes.data || []).forEach((u: any) => {
        if (u.default_values && typeof u.default_values === 'object') {
          map[u.id] = u.default_values;
        }
      });
      setDefaultsMap(map);

      // Auto-select default preset
      const def = (presetRes.data || []).find((p: any) => p.is_default);
      if (def && def.university_ids?.length) setSelectedUniIds(def.university_ids);
    })();
  }, []);

  const handleFile = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => {
        const text = String(ev.target?.result || '');
        let parsed: CsvLead[];
        try { parsed = parseCsv(text); }
        catch (error) {
          toast({ title: 'Invalid CSV', description: String(error), variant: 'destructive' });
          return;
        }
        if (!parsed.length) {
          toast({ title: 'Empty CSV', description: 'No valid rows found', variant: 'destructive' });
          return;
        }
        const missing = REQUIRED_HEADERS.filter((h) => !(h in parsed[0]));
        if (missing.length) {
          toast({
            title: 'Missing required columns',
            description: `Need: ${missing.join(', ')}`,
            variant: 'destructive',
          });
          return;
        }
        setLeads(parsed);
        setFileName(file.name);
        setSourceCsv(text);
        setResults([]);
        setProgress(0);
        toast({ title: 'CSV loaded', description: `${parsed.length} leads ready` });
      };
      reader.readAsText(file);
    },
    [toast],
  );

  const toggleUni = useCallback((id: string) => {
    setSelectedUniIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }, []);

  const applyPreset = useCallback((preset: any) => {
    setSelectedUniIds(preset.university_ids || []);
    toast({ title: 'Preset applied', description: preset.name });
  }, [toast]);

  const selectedUniversities = useMemo(
    () => universities.filter((u) => selectedUniIds.includes(u.id)),
    [universities, selectedUniIds],
  );

  const totalPushes = leads.length * selectedUniversities.length;

  const handlePush = useCallback(async () => {
    if (!leads.length || !selectedUniversities.length) {
      toast({ title: 'Nothing to push', description: 'Need leads and at least one university', variant: 'destructive' });
      return;
    }
    if (!sourceCsv) {
      toast({ title: 'Source file missing', description: 'Load the CSV or quick lead again', variant: 'destructive' });
      return;
    }

    setIsPushing(true);
    setProgress(0);
    setResults([]);
    setThroughput({ done: 0, elapsedMs: 0 });
    const startedAt = performance.now();
    const batchByUni: Record<string, string> = {};
    let sealed = 0;
    try {
      // Save every university batch and its source before allowing any delivery.
      const created = await Promise.all(selectedUniversities.map(async (uni) => {
        const { data, error } = await api.from('upload_batches').insert({
          file_name: `MultiPush: ${fileName}`, university_id: uni.id,
          total_leads: leads.length, status: 'uploading',
          is_paused: false, is_cancelled: false,
          source_label: uni.source || null,
        }).select().single();
        return { universityId: uni.id, batchId: data?.id as string | undefined, error };
      }));
      for (const item of created) if (item.batchId) batchByUni[item.universityId] = item.batchId;
      if (created.some((item) => item.error || !item.batchId)) throw new Error('Could not create every university batch. No leads were sent.');

      for (const batchId of Object.values(batchByUni)) {
        const archived = await fetch(`/api/batches/${batchId}/source`, {
          method: 'POST',
          headers: { 'Content-Type': 'text/csv',
            'X-Filename': `original-${fileName || 'multipush.csv'}`.replace(/[^\x20-\x7e]/g, '_') },
          body: sourceCsv,
        });
        if (!archived.ok) throw new Error('Could not archive every source CSV. No leads were sent.');
      }

      // Queue every lead for every university before starting any batch.
      for (const uni of selectedUniversities) {
        const batchId = batchByUni[uni.id];
        const customColumnMapping: Record<string, string> = {};
        (uni.customColumns || []).forEach((column: any) => {
          if (column.columnKey) customColumnMapping[column.columnKey] = column.apiFieldName || column.columnKey;
        });
        const apiConfig = { columnMapping: uni.column_mapping || {}, customColumnMapping,
          apiTimeoutSeconds: uni.api_timeout_seconds };
        for (let start = 0; start < leads.length; start += 10) {
          const tasks = leads.slice(start, start + 10).map((lead, offset) => ({
            index: start + offset, apiConfig,
            leadData: {
              name: lead.name || '', email: lead.email || '', mobile: lead.mobile || '',
              address: lead.address || '', state: lead.state || '', city: lead.city || '',
              ...lead,
              leadSource: lead.leadSource || uni.source || '',
              leadMedium: lead.leadMedium || uni.medium || '',
              leadCampaign: lead.leadCampaign || uni.campaign || '',
            },
          }));
          const response = await fetch(`/api/batches/${batchId}/queue`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tasks }),
          });
          if (!response.ok) throw new Error('Could not save every lead to the server queue. No new batch was started.');
        }
      }

      for (const batchId of Object.values(batchByUni)) {
        const response = await fetch(`/api/batches/${batchId}/queue`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ finalize: true }),
        });
        if (!response.ok) throw new Error('Could not start every university batch. Check Upload History.');
        sealed++;
      }
      toast({ title: 'Multi-Push queued', description: 'The server will continue processing if you close this page.' });

      let batchStates: any[] = [];
      let finished = false;
      for (let attempt = 0; attempt < 300; attempt++) {
        const { data, error } = await api.from('upload_batches')
          .select('id, status, processed_count, error_message')
          .in('id', Object.values(batchByUni)).limit(1000);
        if (error) throw error;
        batchStates = data || [];
        const done = batchStates.reduce((sum, batch) => sum + Number(batch.processed_count || 0), 0);
        setProgress(Math.round((done / totalPushes) * 100));
        setThroughput({ done, elapsedMs: performance.now() - startedAt });
        finished = batchStates.length === selectedUniversities.length &&
          batchStates.every((batch) => ['completed', 'failed', 'cancelled'].includes(batch.status));
        if (finished) break;
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      if (!finished) {
        toast({ title: 'Multi-Push is still processing', description: 'Check Upload History for the final report.' });
        return;
      }

      const states = new Map<string, any>(batchStates.map((batch) => [batch.id, batch]));
      const rowsByUni = new Map<string, Map<number, any>>();
      for (const uni of selectedUniversities) {
        const byIndex = new Map<number, any>();
        let offset = 0;
        while (true) {
          const { data, error } = await api.from('leads')
            .select('extra_data, status, api_response')
            .eq('batch_id', batchByUni[uni.id]).range(offset, offset + 499);
          if (error) throw error;
          const page = data || [];
          for (const row of page) {
            const index = Number(row.extra_data?.lead_index);
            if (Number.isInteger(index)) byIndex.set(index, row);
          }
          if (page.length < 500) break;
          offset += 500;
        }
        rowsByUni.set(uni.id, byIndex);
      }
      const report: PushResult[] = [];
      for (let rowIndex = 0; rowIndex < leads.length; rowIndex++) {
        for (const uni of selectedUniversities) {
          const row = rowsByUni.get(uni.id)?.get(rowIndex);
          const status = String(row?.status || '').toLowerCase();
          report.push({ rowIndex, lead: leads[rowIndex], universityId: uni.id,
            universityName: uni.name,
            status: status === 'success' ? 'success' : status === 'duplicate' ? 'duplicate' : row ? 'fail' : 'pending',
            response: row?.api_response || states.get(batchByUni[uni.id])?.error_message ||
              (row ? '' : 'No saved result; check the batch ZIP before retrying'),
          });
        }
      }
      setResults(report);
      const done = report.filter((row) => row.status === 'success').length;
      const needsReview = batchStates.some((batch) => batch.status === 'failed');
      toast({ title: needsReview ? 'Multi-Push needs review' : 'Multi-Push complete',
        description: `${done}/${report.length} succeeded. Batch ZIPs are available in Upload History.`,
        variant: needsReview ? 'destructive' : 'default' });
    } catch (error) {
      await Promise.all(Object.values(batchByUni).map((batchId) =>
        api.from('upload_batches').update({ status: 'failed', error_message: String(error) })
          .eq('id', batchId).eq('status', 'uploading')));
      toast({ title: sealed ? 'Multi-Push continues on the server' : 'Multi-Push could not start',
        description: `${String(error)} Check Upload History before trying again.`, variant: 'destructive' });
    } finally {
      setIsPushing(false);
    }
  }, [leads, selectedUniversities, fileName, sourceCsv, totalPushes, toast]);


  return (
    <div className="container mx-auto px-4 py-6 space-y-6">
      <Button variant="ghost" size="sm" onClick={() => navigate('/lead-push')} className="text-muted-foreground">
        <ArrowLeft className="h-4 w-4 mr-2" /> Back to Lead Push
      </Button>

      <div className="flex items-center gap-3">
        <div className="p-2 rounded-xl bg-gradient-to-br from-orange-500/20 to-orange-500/5">
          <Layers className="h-6 w-6 text-orange-500" />
        </div>
        <div>
          <h1 className="text-2xl font-bold">Multi-Push</h1>
          <p className="text-muted-foreground text-sm">
            Push one CSV of leads to multiple universities at once with pre-configured defaults.
          </p>
        </div>
      </div>

      {/* Step 1: Input - CSV or Quick Lead */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Upload className="h-4 w-4" /> Step 1 - Add Leads
          </CardTitle>
          <CardDescription>
            Only <code className="text-xs bg-muted px-1 rounded">name, email, mobile</code> are required.
            Everything else (course, specialization, etc.) is pulled from each university's saved defaults.
            Each university maps <code className="text-xs bg-muted px-1 rounded">name</code> to its own API field automatically
            (firstname/fullname/etc. as configured in that university's Payload).
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Tabs value={inputMode} onValueChange={(v) => setInputMode(v as 'csv' | 'quick')}>
            <TabsList className="grid w-full max-w-md grid-cols-2">
              <TabsTrigger value="csv"><FileText className="h-3.5 w-3.5 mr-1.5" /> Upload CSV</TabsTrigger>
              <TabsTrigger value="quick"><UserPlus className="h-3.5 w-3.5 mr-1.5" /> Quick Lead</TabsTrigger>
            </TabsList>

            <TabsContent value="csv" className="mt-4">
              <div className="flex items-center gap-3 flex-wrap">
                <Input type="file" accept=".csv" onChange={handleFile} className="max-w-md" />
                {fileName && (
                  <Badge variant="secondary" className="gap-1">
                    <FileText className="h-3 w-3" /> {fileName} · {leads.length} rows
                  </Badge>
                )}
              </div>
            </TabsContent>

            <TabsContent value="quick" className="mt-4">
              <div className="grid sm:grid-cols-3 gap-3 max-w-2xl">
                <div>
                  <Label className="text-xs">Name *</Label>
                  <Input
                    value={quickLead.name}
                    onChange={(e) => setQuickLead((p) => ({ ...p, name: e.target.value }))}
                    placeholder="Full name"
                  />
                </div>
                <div>
                  <Label className="text-xs">Email *</Label>
                  <Input
                    type="email"
                    value={quickLead.email}
                    onChange={(e) => setQuickLead((p) => ({ ...p, email: e.target.value }))}
                    placeholder="email@example.com"
                  />
                </div>
                <div>
                  <Label className="text-xs">Mobile *</Label>
                  <Input
                    value={quickLead.mobile}
                    onChange={(e) => setQuickLead((p) => ({ ...p, mobile: e.target.value }))}
                    placeholder="9876543210"
                  />
                </div>
              </div>
              <div className="flex items-center gap-3 mt-3">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    const { name, email, mobile } = quickLead;
                    if (!name || !email || !mobile) {
                      toast({ title: 'Fill all 3 fields', description: 'Name, email & mobile are required', variant: 'destructive' });
                      return;
                    }
                    setLeads([{ name: name.trim(), email: email.trim(), mobile: mobile.trim() }]);
                    setFileName(`QuickLead: ${name.trim()}`);
                    setSourceCsv('name,email,mobile\n' + [name, email, mobile].map((value) => `"${value.trim().replace(/"/g, '""')}"`).join(',') + '\n');
                    setResults([]);
                    setProgress(0);
                    toast({ title: 'Quick lead ready', description: 'Now select universities & push' });
                  }}
                >
                  Use this lead
                </Button>
                {fileName.startsWith('QuickLead:') && (
                  <Badge variant="secondary" className="gap-1">
                    <UserPlus className="h-3 w-3" /> {fileName.replace('QuickLead: ', '')}
                  </Badge>
                )}
              </div>
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>

      {/* Step 2: Select universities */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Star className="h-4 w-4" /> Step 2 - Select Universities ({selectedUniIds.length} selected)
          </CardTitle>
          <CardDescription>Pick universities individually or apply a saved preset.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <PresetManager
            presets={presets}
            universities={universities}
            selectedIds={selectedUniIds}
            onApply={applyPreset}
            onChange={async () => {
              const { data } = await api
                .from('multi_push_presets')
                .select('*')
                .order('is_default', { ascending: false });
              setPresets(data || []);
            }}
          />

          <Separator />

          <ScrollArea className="h-64 border rounded-md p-3">
            <div className="grid sm:grid-cols-2 gap-2">
              {universities.map((u) => {
                const dCount = Object.values(defaultsMap[u.id] || {}).filter(Boolean).length;
                return (
                  <div key={u.id} className="flex items-center gap-2">
                    <Checkbox
                      checked={selectedUniIds.includes(u.id)}
                      onCheckedChange={() => toggleUni(u.id)}
                      id={`uni-${u.id}`}
                    />
                    <Label htmlFor={`uni-${u.id}`} className="text-sm cursor-pointer flex-1 truncate">
                      {u.name}
                    </Label>
                    {dCount > 0 ? (
                      <Badge variant="secondary" className="text-[10px] h-5">{dCount} default{dCount > 1 ? 's' : ''}</Badge>
                    ) : (
                      <Badge variant="outline" className="text-[10px] h-5 text-muted-foreground">no defaults</Badge>
                    )}
                  </div>
                );
              })}
            </div>
          </ScrollArea>

          <div className="flex items-start gap-2 p-3 rounded-md bg-muted/40 border text-xs text-muted-foreground">
            <Info className="h-3.5 w-3.5 mt-0.5 shrink-0" />
            <span>
              Default values (course, specialization, campus, etc.) are now configured directly inside each university (Add/Edit University → "Default / Fallback Values"). Multi-Push reads them automatically.
            </span>
          </div>
        </CardContent>
      </Card>

      {/* Step 3: Push */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Send className="h-4 w-4" /> Step 3 - Push
          </CardTitle>
          <CardDescription>
            Will execute <strong>{totalPushes}</strong> API calls ({leads.length} leads × {selectedUniversities.length}{' '}
            universities).
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-end gap-4">
            <div className="space-y-1">
              <Label className="text-xs flex items-center gap-1">Server queue</Label>
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Badge variant="secondary">Up to 2 at once</Badge>
                <span>Continues processing after this page closes</span>
              </div>
            </div>
            <Button onClick={handlePush} disabled={isPushing || !totalPushes} size="lg">
              <Send className="h-4 w-4 mr-2" />
              {isPushing ? `Pushing… ${progress}%` : `Push to ${selectedUniversities.length} universities`}
            </Button>
          </div>
          {isPushing && (
            <>
              <Progress value={progress} className="h-2" />
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>{throughput.done} / {totalPushes} done</span>
                <span>
                  {throughput.elapsedMs > 500
                    ? `${(throughput.done / (throughput.elapsedMs / 1000)).toFixed(1)} pushes/sec · ETA ${
                        throughput.done > 0
                          ? Math.max(0, Math.round(((totalPushes - throughput.done) * (throughput.elapsedMs / throughput.done)) / 1000))
                          : '-'
                      }s`
                    : 'warming up…'}
                </span>
              </div>
            </>
          )}
        </CardContent>

      </Card>

      {/* Step 5: Report */}
      {results.length > 0 && <MultiPushReport results={results} universities={selectedUniversities} totalLeads={leads.length} />}
    </div>
  );
}

export default memo(MultiPushView);
