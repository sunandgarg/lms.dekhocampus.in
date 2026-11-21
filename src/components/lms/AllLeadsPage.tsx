import { useState, useMemo, useCallback, useEffect } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { Download, Search, Eye, RefreshCw, ChevronDown, ChevronUp, Filter, Loader2, Zap, AlertCircle, Inbox, Users, ArrowUpRight, X } from "lucide-react";
import { api } from "@/integrations/api/client";
import { DataRetentionNotice } from "@/components/ui/DataRetentionNotice";
import { LeadAutomationSettings } from './LeadAutomationSettings';

export interface LmsLead {
  id: string;
  name: string;
  email: string;
  mobile: string;
  city: string;
  course: string;
  specialization: string;
  source: string;
  medium: string;
  campaign: string;
  university: string;
  universityId: string;
  status: string;
  failReason: string;
  receivedAt: string;
  apiResponse: string;
  retryCount: number;
  batchId: string;
  triggerSource: string;
  isInbound?: boolean;
  destinationCount?: number;
  batchIds?: string[];
  extraData?: Record<string, string>;
  matchedRules?: string[];
  skippedDestinations?: number;
}

function formatDate(iso: string) {
  if (!iso || Number.isNaN(new Date(iso).getTime())) return '-';
  return new Date(iso).toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
}

function attributionSource(lead: LmsLead) {
  return lead.extraData?.utm_source || lead.extraData?.utmSource || lead.source || '-';
}

function downloadCSV(data: LmsLead[], filename: string) {
  const headers = [
    "Lead ID",
    "Name",
    "Email",
    "Mobile",
    "City",
    "Course",
    "Source",
    "Medium",
    "Campaign",
    "University",
    "Status",
    "Fail Reason",
    "Received At",
  ];
  const rows = data.map((l) => [
    l.id.slice(0, 8),
    l.name,
    l.email,
    l.mobile,
    l.city,
    l.course,
    attributionSource(l),
    l.medium,
    l.campaign,
    l.university,
    l.status,
    l.failReason,
    l.receivedAt,
  ]);
  const csv = [headers, ...rows].map((r) => r.map((c) => {
    const text = String(c || '');
    const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
    return `"${safe.replace(/"/g, '""')}"`;
  }).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function mapStatus(s: string | null): string {
  if (!s) return "Pending";
  if (s === "Success") return "Pushed";
  if (s === "Fail" || s === "failed") return "Failed";
  if (s === "Duplicate" || s === "duplicate") return "Duplicate";
  if (s === "Needs_Review") return "Needs review";
  if (s === "Received") return "Received";
  if (s === "pending") return "Pending";
  return s;
}

export function AllLeadsPage() {
  const { toast } = useToast();
  const [leads, setLeads] = useState<LmsLead[]>([]);
  const [pageCount, setPageCount] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [sourceFilter, setSourceFilter] = useState("all");
  const [campaignFilter, setCampaignFilter] = useState("");
  const [universityFilter, setUniversityFilter] = useState("all");
  const [cityFilter, setCityFilter] = useState("all");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [detailLead, setDetailLead] = useState<LmsLead | null>(null);
  const [routeBatches, setRouteBatches] = useState<any[]>([]);
  const [showFilters, setShowFilters] = useState(false);
  const [sortCol, setSortCol] = useState<string>("receivedAt");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [showAutomation, setShowAutomation] = useState(true);

  const fetchLeads = useCallback(
    async (_forceRefresh = false) => {
      setLoading(true);
      try {
        const inboundData: any[] = [];
        let inboundHasMore = false;
        for (let page = 0; page < pageCount; page++) {
          const { data, error } = await api.from('inbound_leads')
            .select('*').order('created_at', { ascending: false }).range(page * 500, page * 500 + 499);
          if (error && error.status !== 403) throw error;
          if (error) break;
          inboundData.push(...(data || []));
          inboundHasMore = data?.length === 500;
          if (!inboundHasMore) break;
        }
        // Only fetch leads that came from campaigns/external sources - NOT from CSV upload batches
        // We identify upload-pushed leads by checking if their batch came from a file upload
        // Instead, we filter by looking at batches where file_name starts with 'API_' (external)
        // or leads that have no batch_id, or leads from marketing campaigns

        // Fetch leads that are NOT from CSV upload batches
        // CSV upload batches have file_name like actual filenames (*.csv)
        // External API leads have file_name like 'API_*'
        const { data: uploadBatches, error: batchError } = await api
          .from("upload_batches")
          .select("id,file_name")
          .order('created_at', { ascending: false }).limit(1000);
        if (batchError) throw batchError;

        const excludeBatchIds = (uploadBatches || [])
          .filter((batch) => !/^(API_|facebook_ads_|google_ads_|bing_ads_|LandingPage:)/i.test(batch.file_name || ''))
          .map((batch) => batch.id);

        const leadsData: any[] = [];
        let existingHasMore = false;
        for (let page = 0; page < pageCount; page++) {
          let query = api.from('leads').select('*, universities(name)')
            .order('created_at', { ascending: false }).range(page * 500, page * 500 + 499);
          if (excludeBatchIds.length > 0) query = query.not('batch_id', 'in', `(${excludeBatchIds.join(',')})`);
          const { data, error } = await query;
          if (error) throw error;
          leadsData.push(...(data || []));
          existingHasMore = data?.length === 500;
          if (!existingHasMore) break;
        }

        const mapped: LmsLead[] = (leadsData || []).map((l: any) => ({
          id: l.id,
          name: l.name || "",
          email: l.email || "",
          mobile: l.mobile || "",
          city: l.city || "",
          course: l.course || "",
          specialization: l.specialization || "",
          source: l.lead_source || "Manual",
          medium: l.lead_medium || '',
          campaign: l.lead_campaign || "",
          university: l.universities?.name || "Unknown",
          universityId: l.university_id,
          status: mapStatus(l.status),
          failReason: l.status === "Fail" || l.status === "failed" ? l.api_response || "Unknown error" : "",
          receivedAt: l.created_at,
          apiResponse: l.api_response || "",
          retryCount: l.retry_count || 0,
          batchId: l.batch_id,
          triggerSource: l.lead_source || "Unknown",
        }));

        const incoming: LmsLead[] = (inboundData || []).map((lead: any) => ({
          id: lead.id, name: lead.name || '', email: lead.email || '', mobile: lead.mobile || '',
          city: lead.city || '', course: lead.course || '', specialization: '',
          source: lead.source || lead.connection_name || 'Generic API', campaign: lead.campaign || '',
          medium: lead.extra_data?.utm_medium || lead.extra_data?.lead_medium || lead.extra_data?.medium || '',
          university: lead.batch_ids?.length ? `${lead.batch_ids.length} destinations` : 'Inbox only',
          universityId: '', status: 'Received', failReason: '', receivedAt: lead.created_at,
          apiResponse: '', retryCount: 0, batchId: '', triggerSource: lead.connection_name || 'Generic API',
          isInbound: true, destinationCount: lead.batch_ids?.length || 0,
          batchIds: lead.batch_ids || [],
          extraData: lead.extra_data || {},
          matchedRules: lead.matched_rules || [],
          skippedDestinations: lead.skipped_destinations || 0,
        }));
        setLeads([...incoming, ...mapped].sort((a, b) => b.receivedAt.localeCompare(a.receivedAt)));
        setHasMore(inboundHasMore || existingHasMore);
      } catch (err: any) {
        console.error("Error fetching leads:", err);
        toast({ title: "Error", description: "Failed to load leads", variant: "destructive" });
      } finally {
        setLoading(false);
      }
    },
    [toast, pageCount],
  );

  useEffect(() => {
    fetchLeads();
  }, [fetchLeads]);

  useEffect(() => {
    setRouteBatches([]);
    if (!detailLead?.batchIds?.length) return;
    api.from('upload_batches').select('id,status,success_count,duplicate_count,fail_count,error_message,universities(name)')
      .in('id', detailLead.batchIds).then(({ data }) => setRouteBatches(data || []));
  }, [detailLead]);

  const filtered = useMemo(() => {
    const result = leads.filter((l) => {
      const q = search.toLowerCase();
      if (q && !l.name.toLowerCase().includes(q) && !l.email.toLowerCase().includes(q) && !l.mobile.includes(q))
        return false;
      if (statusFilter !== "all" && l.status !== statusFilter) return false;
      if (sourceFilter !== "all" && attributionSource(l) !== sourceFilter) return false;
      if (campaignFilter && !l.campaign.toLowerCase().includes(campaignFilter.toLowerCase())) return false;
      if (universityFilter !== "all" && l.university !== universityFilter) return false;
      if (cityFilter !== "all" && l.city !== cityFilter) return false;
      return true;
    });
    result.sort((a: any, b: any) => {
      const av = sortCol === 'source' ? attributionSource(a) : a[sortCol] || "";
      const bv = sortCol === 'source' ? attributionSource(b) : b[sortCol] || "";
      return sortDir === "asc" ? (av > bv ? 1 : -1) : av < bv ? 1 : -1;
    });
    return result;
  }, [leads, search, statusFilter, sourceFilter, campaignFilter, universityFilter, cityFilter, sortCol, sortDir]);

  // A person is grouped only when both contact identifiers agree. Every submission remains available below the row.
  const grouped = useMemo(() => {
    const groups = new Map<string, LmsLead[]>();
    for (const lead of filtered) {
      const email = lead.email.trim().toLowerCase();
      const mobile = lead.mobile.replace(/\D/g, '').replace(/^91(?=\d{10}$)/, '');
      const key = email && mobile ? `${email}|${mobile}` : lead.id;
      groups.set(key, [...(groups.get(key) || []), lead]);
    }
    return [...groups.entries()].map(([key, items]) => {
      const history = [...items].sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
      return { key, items: history, latest: history[0], firstAt: history[history.length - 1].receivedAt };
    });
  }, [filtered]);

  const field = (lead: LmsLead, ...names: string[]) => {
    const values = lead.extraData || {};
    const found = Object.entries(values).find(([key]) => names.some((name) =>
      key.toLowerCase().replace(/[^a-z0-9]/g, '') === name.toLowerCase().replace(/[^a-z0-9]/g, '')));
    return found?.[1] || '-';
  };

  const stats = useMemo(() => {
    let pushed = 0,
      failed = 0,
      pending = 0,
      duplicate = 0;
    for (const l of leads) {
      if (l.status === "Pushed") pushed++;
      else if (l.status === "Failed") failed++;
      else if (l.status === "Pending") pending++;
      else if (l.status === "Duplicate") duplicate++;
    }
    const total = leads.length;
    const attempted = pushed + failed + duplicate;
    return { total, pushed, failed, pending, duplicate, received: leads.filter((lead) => lead.status === 'Received').length,
      rate: attempted ? ((pushed / attempted) * 100).toFixed(1) : "0" };
  }, [leads]);

  const sources = useMemo(() => [...new Set(leads.map(attributionSource).filter((value) => value !== '-'))], [leads]);
  const universities = useMemo(() => [...new Set(leads.map((l) => l.university).filter(Boolean))], [leads]);
  const cities = useMemo(() => [...new Set(leads.map((l) => l.city).filter(Boolean))], [leads]);

  const toggleSort = (col: string) => {
    if (sortCol === col) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortCol(col);
      setSortDir("asc");
    }
  };

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  };

  const toggleAll = () => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (filtered.every((lead) => next.has(lead.id))) filtered.forEach((lead) => next.delete(lead.id));
      else filtered.forEach((lead) => next.add(lead.id));
      return next;
    });
  };

  const handleRetryLead = useCallback(
    async (lead: LmsLead) => {
      toast({ title: "Retrying...", description: `Retrying ${lead.name}` });
      const { error } = await api.functions.invoke('retry-leads', { body: { lead_ids: [lead.id] } });
      if (error) {
        toast({ title: "Error", description: error.message, variant: "destructive" });
      } else {
        toast({ title: "Retry finished", description: `${lead.name} was sent again and archived` });
        fetchLeads(true);
      }
    },
    [toast, fetchLeads],
  );

  const handleBulkRetry = useCallback(async () => {
    const failedIds = Array.from(selectedIds).filter((id) => leads.find((l) => l.id === id)?.status === "Failed");
    if (failedIds.length === 0) {
      toast({ title: "No failed leads", description: "Select failed leads to retry", variant: "destructive" });
      return;
    }
    const { error } = await api.functions.invoke('retry-leads', { body: { lead_ids: failedIds.slice(0, 100) } });
    if (error) {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    } else {
      toast({ title: "Retries finished", description: `${Math.min(failedIds.length, 100)} leads were sent again and archived` });
      setSelectedIds(new Set());
      fetchLeads(true);
    }
  }, [selectedIds, leads, toast, fetchLeads]);

  const statusBadge = (s: string) => {
    const map: Record<string, string> = {
      Pushed: "badge-success",
      Failed: "badge-error",
      Pending: "badge-warning",
      New: "badge-info",
      Duplicate: "badge-warning",
      Received: "badge-info",
    };
    return <span className={map[s] || "badge-info"}>{s}</span>;
  };

  const SortIcon = ({ col }: { col: string }) =>
    sortCol === col ? (
      sortDir === "asc" ? (
        <ChevronUp className="h-3 w-3 inline ml-1" />
      ) : (
        <ChevronDown className="h-3 w-3 inline ml-1" />
      )
    ) : null;

  const kpiClick = (status: string) => setStatusFilter(status === statusFilter ? "all" : status);

  const clearFilters = () => {
    setSearch(''); setStatusFilter('all'); setSourceFilter('all'); setCampaignFilter('');
    setUniversityFilter('all'); setCityFilter('all');
  };
  const activeFilterCount = [statusFilter !== 'all', sourceFilter !== 'all', !!campaignFilter,
    universityFilter !== 'all', cityFilter !== 'all'].filter(Boolean).length;
  const detailField = (_lead: LmsLead, label: string, value: unknown) => (
    <div className="min-w-0" key={label}>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 break-words text-sm font-medium">{value == null || value === '' || value === '-' ? 'Not provided' : String(value)}</dd>
    </div>
  );
  const sortHeader = (label: string, col: string) => (
    <TableHead aria-sort={sortCol === col ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <button type="button" className="inline-flex items-center gap-1 rounded py-2 text-left hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={() => toggleSort(col)}>{label}<SortIcon col={col} /></button>
    </TableHead>
  );

  return (
    <div className="container mx-auto max-w-[1600px] px-4 py-6 space-y-5">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-primary"><Inbox className="h-4 w-4" /> Lead workspace</div>
          <h1 className="text-3xl font-display font-bold tracking-tight text-foreground">All Leads</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">Review incoming enquiries, see each submission and its delivery, and follow up with the right student. File uploads remain in Upload History.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => setShowAutomation(!showAutomation)} aria-expanded={showAutomation}>
            <Zap className="mr-2 h-4 w-4" /> Lead push automation {showAutomation ? <ChevronUp className="ml-2 h-4 w-4" /> : <ChevronDown className="ml-2 h-4 w-4" />}
          </Button>
          <Button variant="outline" size="sm" onClick={() => fetchLeads(true)} disabled={loading}>
            <RefreshCw className={`mr-2 h-4 w-4 ${loading ? 'animate-spin' : ''}`} /> Refresh
          </Button>
        </div>
      </div>

      {showAutomation && <LeadAutomationSettings />}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        {[
          { label: 'Submissions loaded', value: stats.total, note: hasMore ? 'Older records available' : 'All loaded records', icon: Inbox, filter: 'all', tone: 'text-primary bg-primary/10' },
          { label: 'Unique contacts', value: new Set(leads.map((lead) => {
            const email = lead.email.trim().toLowerCase(); const mobile = lead.mobile.replace(/\D/g, '').replace(/^91(?=\d{10}$)/, '');
            return email && mobile ? `${email}|${mobile}` : lead.id;
          })).size, note: 'Email and phone match', icon: Users, filter: '', tone: 'text-blue-600 bg-blue-500/10' },
          { label: 'Received', value: stats.received, note: 'Incoming lead records', icon: Inbox, filter: 'Received', tone: 'text-sky-700 bg-sky-500/10' },
          { label: 'Failed pushes', value: stats.failed, note: 'May need retry', icon: AlertCircle, filter: 'Failed', tone: 'text-destructive bg-destructive/10' },
          { label: 'Pushed', value: stats.pushed, note: `${stats.rate}% of attempted deliveries`, icon: ArrowUpRight, filter: 'Pushed', tone: 'text-emerald-700 bg-emerald-500/10' },
        ].map((item) => <button key={item.label} type="button" onClick={() => item.filter && kpiClick(item.filter)}
          className={`rounded-xl border bg-card p-4 text-left shadow-sm transition-colors hover:border-primary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${item.filter && statusFilter === item.filter ? 'border-primary' : 'border-border'}`}>
          <div className="flex items-center justify-between gap-2"><span className="text-xs font-medium text-muted-foreground">{item.label}</span><span className={`rounded-lg p-1.5 ${item.tone}`}><item.icon className="h-4 w-4" /></span></div>
          <div className="mt-3 text-2xl font-display font-bold tabular-nums">{item.value}</div>
          <div className="mt-1 text-xs text-muted-foreground">{item.note}</div>
        </button>)}
      </div>

      <Card className="overflow-hidden shadow-sm">
        <div className="space-y-3 border-b p-4">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div><h2 className="font-semibold">Lead inbox</h2><p className="text-xs text-muted-foreground">{filtered.length} matching submissions · {grouped.length} contacts shown{hasMore ? ' · load older leads for more' : ''}</p></div>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" onClick={() => setShowFilters(!showFilters)} aria-expanded={showFilters}>
                <Filter className="mr-2 h-4 w-4" /> Filters{activeFilterCount ? ` (${activeFilterCount})` : ''}
              </Button>
              <Button variant="outline" size="sm" onClick={() => downloadCSV(filtered, 'lead-inbox-view.csv')} disabled={!filtered.length}>
                <Download className="mr-2 h-4 w-4" /> Export view ({filtered.length})
              </Button>
            </div>
          </div>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <div className="relative min-w-0 flex-1"><Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input aria-label="Search leads" placeholder="Search name, email or mobile" value={search} onChange={(e) => setSearch(e.target.value)} className="pl-10" />
            </div>
            <div className="flex flex-wrap gap-1" aria-label="Filter by delivery status">
              {[['all','All'],['Received','Received'],['Failed','Needs attention'],['Pushed','Pushed']].map(([value,label]) =>
                <Button key={value} size="sm" variant={statusFilter === value ? 'default' : 'ghost'} onClick={() => setStatusFilter(value)}>{label}</Button>)}
            </div>
          </div>
          {showFilters && <div className="grid gap-2 rounded-lg bg-muted/40 p-3 sm:grid-cols-2 lg:grid-cols-5">
            <Select value={statusFilter} onValueChange={setStatusFilter}><SelectTrigger aria-label="Status filter"><SelectValue placeholder="Status" /></SelectTrigger><SelectContent>
              {['all','Received','Pending','Pushed','Duplicate','Failed','Needs review'].map((value) => <SelectItem key={value} value={value}>{value === 'all' ? 'All statuses' : value}</SelectItem>)}
            </SelectContent></Select>
            <Select value={sourceFilter} onValueChange={setSourceFilter}><SelectTrigger aria-label="Source filter"><SelectValue placeholder="Source" /></SelectTrigger><SelectContent><SelectItem value="all">All sources</SelectItem>{sources.map((value) => <SelectItem key={value} value={value}>{value}</SelectItem>)}</SelectContent></Select>
            <Select value={universityFilter} onValueChange={setUniversityFilter}><SelectTrigger aria-label="Destination filter"><SelectValue placeholder="Destination" /></SelectTrigger><SelectContent><SelectItem value="all">All destinations</SelectItem>{universities.map((value) => <SelectItem key={value} value={value}>{value}</SelectItem>)}</SelectContent></Select>
            <Select value={cityFilter} onValueChange={setCityFilter}><SelectTrigger aria-label="City filter"><SelectValue placeholder="City" /></SelectTrigger><SelectContent><SelectItem value="all">All cities</SelectItem>{cities.map((value) => <SelectItem key={value} value={value}>{value}</SelectItem>)}</SelectContent></Select>
            <Input aria-label="Campaign filter" placeholder="Campaign contains..." value={campaignFilter} onChange={(e) => setCampaignFilter(e.target.value)} />
            <Button variant="ghost" size="sm" onClick={clearFilters} className="justify-start lg:col-span-5"><X className="mr-2 h-4 w-4" /> Clear filters</Button>
          </div>}
        </div>

        {selectedIds.size > 0 && <div className="flex flex-wrap items-center gap-2 border-b bg-primary/5 px-4 py-2 text-sm">
          <strong>{selectedIds.size} selected</strong>
          <Button size="sm" variant="outline" onClick={handleBulkRetry}><RefreshCw className="mr-1 h-3.5 w-3.5" /> Retry failed</Button>
          <Button size="sm" variant="outline" onClick={() => downloadCSV(leads.filter((lead) => selectedIds.has(lead.id)), 'selected-leads.csv')}><Download className="mr-1 h-3.5 w-3.5" /> Export selected</Button>
          <Button size="sm" variant="ghost" onClick={() => setSelectedIds(new Set())}>Clear selection</Button>
        </div>}

        <div className="overflow-x-auto">
          {loading ? <div className="flex items-center justify-center py-16 text-sm text-muted-foreground"><Loader2 className="mr-2 h-5 w-5 animate-spin" /> Loading leads...</div> :
          <Table className="min-w-[1280px]">
            <TableHeader><TableRow className="table-header">
              <TableHead className="w-10"><Checkbox aria-label="Select all matching submissions" checked={filtered.length > 0 && filtered.every((lead) => selectedIds.has(lead.id))} onCheckedChange={toggleAll} /></TableHead>
              {sortHeader('Name','name')}
              <TableHead>Email</TableHead>
              <TableHead>Mobile</TableHead>
              {sortHeader('Source','source')}
              <TableHead>Medium</TableHead>
              <TableHead>Campaign</TableHead>
              {sortHeader('Received','receivedAt')}
              <TableHead>Delivery</TableHead>
              <TableHead className="w-24">History</TableHead>
              <TableHead className="w-28 text-right">Actions</TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {grouped.length === 0 ? <TableRow><TableCell colSpan={11} className="py-16 text-center text-muted-foreground">
                <Inbox className="mx-auto mb-3 h-8 w-8 opacity-40" /><p className="font-medium text-foreground">No matching leads</p><p className="mt-1 text-sm">Try another filter or refresh to check new enquiries.</p>
              </TableCell></TableRow> : grouped.flatMap(({ key, items, latest, firstAt }) =>
                (expanded.has(key) ? items : [latest]).map((lead, index) => <TableRow key={lead.id} className={index > 0 ? 'bg-muted/20' : 'hover:bg-muted/30'}>
                  <TableCell><Checkbox aria-label={`Select ${lead.name || lead.email || 'lead'}`} checked={selectedIds.has(lead.id)} onCheckedChange={() => toggleSelect(lead.id)} /></TableCell>
                  <TableCell className="align-top"><button type="button" onClick={() => setDetailLead(lead)} className="text-left font-semibold text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{lead.name || 'Unnamed lead'}</button></TableCell>
                  <TableCell className="max-w-[220px] truncate align-top text-sm" title={lead.email}>{lead.email || '-'}</TableCell>
                  <TableCell className="whitespace-nowrap align-top text-sm">{lead.mobile || '-'}</TableCell>
                  <TableCell className="align-top"><Badge variant="outline" className="max-w-[150px] truncate">{attributionSource(lead)}</Badge></TableCell>
                  <TableCell className="align-top text-sm">{lead.medium || field(lead,'utm_medium','utmMedium')}</TableCell>
                  <TableCell className="max-w-[200px] truncate align-top text-sm" title={lead.campaign}>{lead.campaign || field(lead,'utm_campaign','utmCampaign')}</TableCell>
                  <TableCell className="whitespace-nowrap align-top"><div className="text-sm font-medium tabular-nums">{formatDate(lead.receivedAt)}</div><div className="mt-1 text-xs text-muted-foreground">{index > 0 ? 'Earlier submission' : 'Most recent'}</div></TableCell>
                  <TableCell className="align-top"><div className="flex flex-wrap items-center gap-2">{statusBadge(lead.status)}<span className="max-w-[170px] truncate text-xs text-muted-foreground" title={lead.university}>{lead.university}</span></div>
                    {lead.failReason && <p className="mt-1 max-w-[240px] truncate text-xs text-destructive" title={lead.failReason}>{lead.failReason}</p>}</TableCell>
                  <TableCell className="align-top">{index === 0 && items.length > 1 ? <button type="button" aria-expanded={expanded.has(key)} aria-label={`${expanded.has(key) ? 'Collapse' : 'Expand'} ${items.length} submissions for ${lead.name || 'this contact'}`}
                    className="inline-flex min-h-9 items-center gap-1 rounded-md border px-2 text-xs font-medium hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => setExpanded((current) => { const next = new Set(current); if (next.has(key)) next.delete(key); else next.add(key); return next; })}>
                    {expanded.has(key) ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}{items.length} entries</button> : index === 0 ? <span className="text-xs text-muted-foreground">First seen {formatDate(firstAt)}</span> : <span className="text-xs text-muted-foreground">History</span>}</TableCell>
                  <TableCell className="align-top"><div className="flex justify-end gap-1"><Button variant="ghost" size="icon" className="h-9 w-9" aria-label={`View details for ${lead.name || 'lead'}`} onClick={() => setDetailLead(lead)}><Eye className="h-4 w-4" /></Button>
                    {lead.status === 'Failed' && <Button variant="ghost" size="icon" className="h-9 w-9" aria-label={`Retry ${lead.name || 'lead'}`} onClick={() => handleRetryLead(lead)}><RefreshCw className="h-4 w-4" /></Button>}</div></TableCell>
                </TableRow>))}
            </TableBody>
          </Table>}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 border-t px-4 py-3 text-xs text-muted-foreground">
          <span>Showing {grouped.length} contacts from {filtered.length} loaded submissions. Same email and mobile are grouped; matching submissions remain available.</span>
          <span>Export includes the current loaded view.</span>
        </div>
      </Card>
      {hasMore && <div className="text-center"><Button variant="outline" onClick={() => setPageCount((count) => count + 1)} disabled={loading}>Load older leads</Button></div>}
      <DataRetentionNotice variant="inline" />

      {/* Lead Detail Drawer */}
      <Sheet open={!!detailLead} onOpenChange={() => setDetailLead(null)}>
        <SheetContent className="w-full sm:max-w-xl overflow-y-auto">
          {detailLead && (
            <>
              <SheetHeader>
                <SheetTitle className="font-display text-xl">{detailLead.name || 'Unnamed lead'}</SheetTitle>
              </SheetHeader>
              <div className="mt-5 space-y-6 pb-6">
                <div className="flex flex-wrap items-center gap-2">{statusBadge(detailLead.status)}<span className="text-xs text-muted-foreground">Received {formatDate(detailLead.receivedAt)}</span></div>
                <section className="space-y-3"><h3 className="border-b pb-2 text-sm font-semibold">Student and contact</h3>
                  <dl className="grid grid-cols-2 gap-3">{[
                    ['Email', detailLead.email], ['Mobile', detailLead.mobile], ['City', detailLead.city], ['State', field(detailLead,'state')],
                    ['Course / interest', detailLead.course || field(detailLead,'interest','program')], ['Specialization', detailLead.specialization],
                    ['Campus', field(detailLead,'campus')], ['Exam', field(detailLead,'exam')], ['Mode', field(detailLead,'mode')], ['Category', field(detailLead,'category')],
                  ].map(([label,value]) => detailField(detailLead,label,value))}</dl>
                </section>
                <section className="space-y-3"><h3 className="border-b pb-2 text-sm font-semibold">Source and campaign</h3>
                  <dl className="grid grid-cols-2 gap-3">{[
                    ['Source',detailLead.source],['Medium',detailLead.medium],['Connection',detailLead.triggerSource],['Campaign',detailLead.campaign],
                    ['UTM source',field(detailLead,'utm_source','utmSource')],['UTM medium',field(detailLead,'utm_medium','utmMedium')],
                    ['UTM campaign',field(detailLead,'utm_campaign','utmCampaign')],['CTA source',field(detailLead,'cta_source','ctaSource')],
                    ['Landing page',field(detailLead,'landing_page','landingPage')],['Page',field(detailLead,'page','page_url','pageUrl')],
                    ['Last query',field(detailLead,'last_query','lastQuery')],['Device',field(detailLead,'device')],
                  ].map(([label,value]) => detailField(detailLead,label,value))}</dl>
                </section>
                <section className="space-y-3"><h3 className="border-b pb-2 text-sm font-semibold">Verification and consent</h3>
                  <p className="text-xs text-muted-foreground">These values are reported by the source. “Not provided” means no evidence was included with this submission.</p>
                  <dl className="grid grid-cols-2 gap-3">{[
                    ['Consent',field(detailLead,'consent')],['OTP verified',field(detailLead,'otp_verified','otpVerified')],
                    ['Registration date',formatDate(field(detailLead,'date_of_registration','registration_date'))],
                    ['First instance date',formatDate(field(detailLead,'first_instance_date','firstInstanceDate'))],
                  ].map(([label,value]) => detailField(detailLead,label,value === '-' ? '' : value))}</dl>
                </section>
                <section className="space-y-3"><h3 className="border-b pb-2 text-sm font-semibold">Delivery</h3>
                  <dl className="grid grid-cols-2 gap-3">{[
                    ['Destination',detailLead.university],['Status',detailLead.status],['Retry count',detailLead.retryCount],
                  ].map(([label,value]) => detailField(detailLead,label,value))}</dl>
                {detailLead.failReason && (
                  <div className="p-3 bg-destructive/10 rounded-lg text-sm text-destructive">
                    <strong>API Response:</strong>
                    <pre className="mt-1 text-xs overflow-x-auto whitespace-pre-wrap">{detailLead.apiResponse}</pre>
                  </div>
                )}
                </section>

                {detailLead.isInbound && <div className="space-y-2 border-t pt-4">
                  <Button asChild variant="outline" size="sm"><a href={`/api/inbound/generic-leads/${detailLead.id}/archive.zip`}>
                    <Download className="h-4 w-4 mr-2" /> Download incoming payload ZIP
                  </a></Button>
                  <p className="text-sm font-medium">Auto-push destinations</p>
                  {!!detailLead.matchedRules?.length && <p className="text-xs text-muted-foreground">Matched rules: {detailLead.matchedRules.join(', ')}</p>}
                  {!!detailLead.skippedDestinations && <p className="text-xs text-destructive">{detailLead.skippedDestinations} destination was removed before this lead arrived. Update the automation rule.</p>}
                  {detailLead.destinationCount === 0 ? <p className="text-xs text-muted-foreground">Collect only — no automatic push configured.</p>
                    : routeBatches.length === 0 ? <p className="text-xs text-muted-foreground">Loading delivery status...</p>
                    : routeBatches.map((batch) => <div key={batch.id} className="text-sm border rounded p-2">
                      <span className="font-medium">{batch.universities?.name || 'University'}</span>: {batch.status}
                      {batch.error_message && <p className="text-xs text-destructive">{batch.error_message}</p>}
                    </div>)}
                </div>}

                {detailLead.extraData && Object.keys(detailLead.extraData).length > 0 && <section className="space-y-3 border-t pt-4">
                  <h3 className="text-sm font-semibold">All incoming fields</h3>
                  <dl className="grid grid-cols-2 gap-3">{Object.entries(detailLead.extraData).map(([label,value]) => detailField(detailLead,label,value))}</dl>
                </section>}

                {detailLead.status === "Failed" && (
                  <Button
                    className="w-full"
                    onClick={() => {
                      handleRetryLead(detailLead);
                      setDetailLead(null);
                    }}
                  >
                    <RefreshCw className="h-4 w-4 mr-2" /> Retry This Lead
                  </Button>
                )}
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}
