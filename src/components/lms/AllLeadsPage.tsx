import { useState, useMemo, useCallback, useEffect } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/useAuth";
import { Download, Search, Eye, RefreshCw, ChevronDown, ChevronUp, Filter, Loader2, Zap, Inbox, X, Trash2, CheckCircle2, XCircle, Clock3 } from "lucide-react";
import { api } from "@/integrations/api/client";
import { DataRetentionNotice } from "@/components/ui/DataRetentionNotice";
import { LeadAutomationSettings } from './LeadAutomationSettings';
import { deliveryResult, summarizeDeliveries, type LeadDelivery } from './delivery-summary';
import { maskContactText, maskEmail, maskMobile } from '@/utils/contactMask';

export interface LmsLead {
  id: string;
  name: string;
  email: string;
  mobile: string;
  originalMobile: string;
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
  deliveries: LeadDelivery[];
}

function tenDigitMobile(value: string) {
  if (value.includes('*')) return value;
  const digits = String(value || '').replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : '';
}

function fuzzyMatch(query: string, values: string[]) {
  const text = values.join(' ').toLowerCase();
  const words = text.match(/[a-z0-9]+/g) || [];
  return query.toLowerCase().trim().split(/\s+/).every((term) => {
    if (text.includes(term)) return true;
    const allowed = term.length >= 8 ? 2 : term.length >= 4 ? 1 : 0;
    if (!allowed) return false;
    return words.some((word) => {
      if (Math.abs(word.length - term.length) > allowed) return false;
      let previous = Array.from({ length: word.length + 1 }, (_, index) => index);
      for (let i = 1; i <= term.length; i++) {
        const current = [i];
        for (let j = 1; j <= word.length; j++) current[j] = Math.min(
          current[j - 1] + 1, previous[j] + 1, previous[j - 1] + (term[i - 1] === word[j - 1] ? 0 : 1));
        previous = current;
      }
      return previous[word.length] <= allowed;
    });
  });
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

function leadIdentity(lead: LmsLead) {
  const email = lead.email.trim().toLowerCase();
  const mobile = lead.mobile.replace(/\D/g, '').replace(/^91(?=\d{10}$)/, '');
  return email && mobile ? `${email}|${mobile}` : lead.id;
}

function leadChannel(lead: LmsLead) {
  const source = `${attributionSource(lead)} ${lead.source} ${lead.triggerSource} ${lead.medium}`.toLowerCase();
  if (source.includes('facebook') || source.includes('meta')) return 'facebook';
  if (source.includes('google')) return 'google';
  return 'other';
}

function leadState(lead: LmsLead) { return lead.extraData?.state || lead.extraData?.State || ''; }
function leadCourse(lead: LmsLead) { return lead.course || lead.extraData?.course_interest || lead.extraData?.interest || ''; }
function leadDay(lead: LmsLead) {
  const date = new Date(lead.receivedAt);
  if (Number.isNaN(date.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const value = (type: string) => parts.find((part) => part.type === type)?.value || '';
  return `${value('year')}-${value('month')}-${value('day')}`;
}

function downloadCSV(data: LmsLead[], filename: string, masked = false) {
  const headers = [
    "Lead ID",
    "Name",
    "Email",
    "Mobile",
    "Original Mobile",
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
    masked ? (l.email.includes('*') ? l.email : maskEmail(l.email)) : l.email,
    masked ? (l.mobile.includes('*') ? l.mobile : maskMobile(l.mobile)) : l.mobile,
    masked ? (l.originalMobile.includes('*') ? l.originalMobile : maskMobile(l.originalMobile)) : l.originalMobile,
    l.city,
    l.course,
    attributionSource(l),
    l.medium,
    l.campaign,
    l.university,
    l.status,
    masked ? maskContactText(l.failReason) : l.failReason,
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
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin' || user?.role === 'super_admin';
  const [leads, setLeads] = useState<LmsLead[]>([]);
  const [pageCount, setPageCount] = useState(1);
  const [rowsPerPage, setRowsPerPage] = useState(25);
  const [rowsPerPageMode, setRowsPerPageMode] = useState('25');
  const [customRows, setCustomRows] = useState('');
  const [currentPage, setCurrentPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [sourceFilter, setSourceFilter] = useState("all");
  const [mediumFilter, setMediumFilter] = useState('all');
  const [campaignFilter, setCampaignFilter] = useState("");
  const [courseFilter, setCourseFilter] = useState('all');
  const [universityFilter, setUniversityFilter] = useState("all");
  const [cityFilter, setCityFilter] = useState("all");
  const [stateFilter, setStateFilter] = useState('all');
  const [contactFilter, setContactFilter] = useState('all');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [segment, setSegment] = useState('all');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [retryingBatchId, setRetryingBatchId] = useState<string | null>(null);
  const [detailLead, setDetailLead] = useState<LmsLead | null>(null);
  const [showFilters, setShowFilters] = useState(false);
  const [sortCol, setSortCol] = useState<string>("receivedAt");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [showAutomation, setShowAutomation] = useState(false);
  const fetchLeads = useCallback(
    async (_forceRefresh = false) => {
      setLoading(true);
      try {
        const inboundData: any[] = [];
        let inboundHasMore = false;
        for (let page = 0; page < pageCount; page++) {
          const { data, error } = await api.from('inbound_leads')
            .select('*').is('deleted_at', null).order('created_at', { ascending: false }).range(page * 500, page * 500 + 499);
          if (error) {
            console.error('Could not load incoming leads:', error);
            break;
          }
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
        const deliveries: Record<string, LeadDelivery[]> = {};
        for (let offset = 0; offset < inboundData.length; offset += 500) {
          const { data, error } = await api.functions.invoke('all-leads-deliveries', {
            body: { lead_ids: inboundData.slice(offset, offset + 500).map((lead) => lead.id) },
          });
          if (error) {
            console.error('Could not load lead delivery summary:', error);
            continue;
          }
          Object.assign(deliveries, data?.deliveries || {});
        }

        const leadsData: any[] = [];
        let existingHasMore = false;
        for (let page = 0; page < pageCount; page++) {
          let query = api.from('leads').select('*, universities(name)')
            .is('deleted_at', null).order('created_at', { ascending: false }).range(page * 500, page * 500 + 499);
          const { data, error } = await query;
          if (error) {
            console.error('Could not load partner lead history:', error);
            break;
          }
          leadsData.push(...(data || []));
          existingHasMore = data?.length === 500;
          if (!existingHasMore) break;
        }

        const mapped: LmsLead[] = (leadsData || []).map((l: any) => ({
          id: l.id,
          name: l.name || "",
          email: l.email || "",
          mobile: tenDigitMobile(l.mobile || ""), originalMobile: l.mobile || "",
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
          deliveries: [{ id: l.batch_id || l.id, status: l.status, success_count: l.status === 'Success' ? 1 : 0,
            duplicate_count: l.status === 'Duplicate' ? 1 : 0, fail_count: ['Fail', 'failed'].includes(l.status) ? 1 : 0,
            universities: { name: l.universities?.name || 'University' } }],
        }));

        const incoming: LmsLead[] = (inboundData || []).map((lead: any) => ({
          id: lead.id, name: lead.name || '', email: lead.email || '',
          mobile: tenDigitMobile(lead.mobile || ''), originalMobile: lead.mobile || '',
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
          deliveries: (deliveries[lead.id] || []).map((batch) => ({ ...batch, isInbound: true })),
        }));
        setLeads([...incoming, ...mapped].sort((a, b) => (b.receivedAt || '').localeCompare(a.receivedAt || '')));
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

  const repeatKeys = useMemo(() => {
    const counts = new Map<string, number>();
    for (const lead of leads.filter((item) => item.isInbound)) {
      const key = isAdmin ? leadIdentity(lead) : lead.id;
      if (key !== lead.id) counts.set(key, (counts.get(key) || 0) + 1);
    }
    return new Set([...counts].filter(([, count]) => count > 1).map(([key]) => key));
  }, [leads, isAdmin]);

  const filtered = useMemo(() => {
    const result = leads.filter((l) => {
      if (search.trim() && !fuzzyMatch(search, [l.name, l.email, l.mobile, l.originalMobile, l.campaign,
        attributionSource(l), l.medium, leadCourse(l), l.city, leadState(l), l.university, l.status,
        l.triggerSource, ...Object.entries(l.extraData || {}).flat(),
        ...l.deliveries.flatMap((batch) => [batch.universities?.name || '', deliveryResult(batch)])]))
        return false;
      if (segment === 'repeat' ? !repeatKeys.has(isAdmin ? leadIdentity(l) : l.id) : segment !== 'all' && leadChannel(l) !== segment) return false;
      if (statusFilter !== "all" && l.status !== statusFilter &&
          !l.deliveries.some((batch) => deliveryResult(batch) === statusFilter)) return false;
      if (sourceFilter !== "all" && attributionSource(l) !== sourceFilter) return false;
      if (mediumFilter !== 'all' && l.medium !== mediumFilter) return false;
      if (campaignFilter && !l.campaign.toLowerCase().includes(campaignFilter.toLowerCase())) return false;
      if (courseFilter !== 'all' && leadCourse(l) !== courseFilter) return false;
      if (universityFilter !== "all" && l.university !== universityFilter &&
          !l.deliveries.some((batch) => batch.universities?.name === universityFilter)) return false;
      if (cityFilter !== "all" && l.city !== cityFilter) return false;
      if (stateFilter !== 'all' && leadState(l) !== stateFilter) return false;
      if (contactFilter === 'both' && (!l.email || !l.mobile)) return false;
      if (contactFilter === 'email' && !l.email) return false;
      if (contactFilter === 'mobile' && !l.mobile) return false;
      const day = leadDay(l);
      if ((dateFrom && day < dateFrom) || (dateTo && day > dateTo)) return false;
      return true;
    });
    result.sort((a, b) => {
      const av = sortCol === 'source' ? attributionSource(a) : String(a[sortCol as keyof LmsLead] ?? '');
      const bv = sortCol === 'source' ? attributionSource(b) : String(b[sortCol as keyof LmsLead] ?? '');
      const comparison = av.localeCompare(bv, undefined, { sensitivity: 'base', numeric: true });
      return sortDir === 'asc' ? comparison : -comparison;
    });
    return result;
  }, [leads, repeatKeys, search, segment, statusFilter, sourceFilter, mediumFilter, campaignFilter,
    courseFilter, universityFilter, cityFilter, stateFilter, contactFilter, dateFrom, dateTo, sortCol, sortDir, isAdmin]);

  // A person is grouped only when both contact identifiers agree. Every submission remains available below the row.
  const grouped = useMemo(() => {
    const groups = new Map<string, LmsLead[]>();
    for (const lead of filtered) {
      const key = isAdmin ? leadIdentity(lead) : lead.id;
      groups.set(key, [...(groups.get(key) || []), lead]);
    }
    return [...groups.entries()].map(([key, items]) => {
      const history = [...items].sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
      return { key, items: history, latest: history[0], firstAt: history[history.length - 1].receivedAt };
    });
  }, [filtered, isAdmin]);

  const totalPages = Math.max(1, Math.ceil(grouped.length / rowsPerPage));
  const safePage = Math.min(currentPage, totalPages);
  const pageGroups = grouped.slice((safePage - 1) * rowsPerPage, safePage * rowsPerPage);
  const visibleRows = pageGroups.flatMap(({ key, items, latest }) => expanded.has(key) ? items : [latest]);

  useEffect(() => { setCurrentPage(1); }, [search, segment, statusFilter, sourceFilter, mediumFilter,
    campaignFilter, courseFilter, universityFilter, cityFilter, stateFilter, contactFilter, dateFrom, dateTo,
    sortCol, sortDir, rowsPerPage]);

  const field = (lead: LmsLead, ...names: string[]) => {
    const values = lead.extraData || {};
    const found = Object.entries(values).find(([key]) => names.some((name) =>
      key.toLowerCase().replace(/[^a-z0-9]/g, '') === name.toLowerCase().replace(/[^a-z0-9]/g, '')));
    return found?.[1] || '-';
  };

  const segmentCounts = useMemo(() => {
    const count = (items: LmsLead[]) => new Set(items.map(leadIdentity)).size;
    return { all: count(leads), facebook: count(leads.filter((lead) => leadChannel(lead) === 'facebook')),
      google: count(leads.filter((lead) => leadChannel(lead) === 'google')),
      other: count(leads.filter((lead) => leadChannel(lead) === 'other')), repeat: repeatKeys.size };
  }, [leads, repeatKeys]);
  const viewSummary = useMemo(() => grouped.reduce((counts, group) => {
    const { deliveries, pushed, notPushed } = summarizeDeliveries(group.items);
    if (!deliveries.length) counts.inboxOnly++;
    if (pushed) counts.sent++;
    if (notPushed) counts.needsAttention++;
    return counts;
  }, { inboxOnly: 0, sent: 0, needsAttention: 0 }), [grouped]);

  const sources = useMemo(() => [...new Set(leads.map(attributionSource).filter((value) => value !== '-'))], [leads]);
  const media = useMemo(() => [...new Set(leads.map((lead) => lead.medium).filter(Boolean))], [leads]);
  const courses = useMemo(() => [...new Set(leads.map(leadCourse).filter(Boolean))], [leads]);
  const universities = useMemo(() => [...new Set(leads.flatMap((lead) =>
    lead.deliveries.map((batch) => batch.universities?.name || '').filter(Boolean)))], [leads]);
  const cities = useMemo(() => [...new Set(leads.map((l) => l.city).filter(Boolean))], [leads]);
  const states = useMemo(() => [...new Set(leads.map(leadState).filter(Boolean))], [leads]);

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
      if (visibleRows.every((lead) => next.has(lead.id))) visibleRows.forEach((lead) => next.delete(lead.id));
      else visibleRows.forEach((lead) => next.add(lead.id));
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

  const handleRetryDelivery = useCallback(async (batch: LeadDelivery) => {
    if (!batch.isInbound || retryingBatchId) return;
    setRetryingBatchId(batch.id);
    try {
      const { data, error } = await api.functions.invoke('retry-inbound-delivery', { body: { batch_id: batch.id } });
      if (error) throw error;
      toast({ title: 'Retry completed', description: `${batch.universities?.name || 'University'}: ${data.results?.[0]?.status || 'check delivery result'}` });
      await fetchLeads(true);
    } catch (error: any) {
      toast({ title: 'Could not retry this delivery', description: error.message, variant: 'destructive' });
    } finally {
      setRetryingBatchId(null);
    }
  }, [retryingBatchId, toast, fetchLeads]);

  const handleBulkRetry = useCallback(async () => {
    const selected = leads.filter((lead) => selectedIds.has(lead.id));
    const failedIds = selected.filter((lead) => !lead.isInbound && lead.status === 'Failed').map((lead) => lead.id);
    const inboundBatches = [...new Set(selected.filter((lead) => lead.isInbound)
      .flatMap((lead) => lead.deliveries.filter((batch) => deliveryResult(batch) === 'Failed').map((batch) => batch.id)))];
    if (!failedIds.length && !inboundBatches.length) {
      toast({ title: "No failed leads", description: "Select failed leads to retry", variant: "destructive" });
      return;
    }
    if (failedIds.length + inboundBatches.length > 100) {
      toast({ title: 'Select up to 100 failed deliveries', variant: 'destructive' });
      return;
    }
    try {
      if (failedIds.length) {
        const { error } = await api.functions.invoke('retry-leads', { body: { lead_ids: failedIds } });
        if (error) throw error;
      }
      for (const batchId of inboundBatches) {
        const { error } = await api.functions.invoke('retry-inbound-delivery', { body: { batch_id: batchId } });
        if (error) throw error;
      }
      toast({ title: "Retries finished", description: `${failedIds.length + inboundBatches.length} failed deliveries were retried` });
      setSelectedIds(new Set());
      fetchLeads(true);
    } catch (error: any) {
      toast({ title: 'Retry stopped', description: error.message, variant: 'destructive' });
    }
  }, [selectedIds, leads, toast, fetchLeads]);

  const handleDeleteLeads = useCallback(async (ids: string[]) => {
    if (!isAdmin || !ids.length || !window.confirm(
      `Delete ${ids.length} lead submission${ids.length === 1 ? '' : 's'} from All Leads? Other submissions for the same contact, delivery history, and S3 archives will remain.`)) return;
    const { data, error } = await api.functions.invoke('delete-leads', { body: { lead_ids: ids } });
    if (error) toast({ title: 'Could not delete leads', description: error.message, variant: 'destructive' });
    else {
      toast({ title: `${data.deleted} lead${data.deleted === 1 ? '' : 's'} deleted from All Leads` });
      setSelectedIds(new Set());
      setDetailLead(null);
      fetchLeads(true);
    }
  }, [isAdmin, toast, fetchLeads]);

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

  const deliveryList = (deliveries: LeadDelivery[]) => deliveries.length ? (
    <div className="max-h-80 divide-y overflow-y-auto">
      {deliveries.map((batch) => {
        const result = deliveryResult(batch);
        const Icon = result === 'Pushed' ? CheckCircle2 : result === 'Pending' ? Clock3 : XCircle;
        const color = result === 'Pushed' ? 'text-emerald-700' : result === 'Pending' ? 'text-amber-700' : 'text-red-700';
        return <div key={batch.id} className="flex gap-3 px-4 py-3">
          <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${color}`} aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <div className="flex items-start justify-between gap-2 text-sm">
              <strong className="break-words text-foreground">{batch.universities?.name || 'University'}</strong>
              <span className={`shrink-0 font-semibold ${color}`}>{result}</span>
            </div>
            {batch.error_message && <p className="mt-1 break-words text-xs text-muted-foreground">{batch.error_message}</p>}
            {batch.isInbound && result === 'Failed' && <Button type="button" variant="outline" size="sm"
              className="mt-2 h-8 border-red-200 text-red-700 hover:bg-red-50" disabled={!!retryingBatchId}
              onClick={() => handleRetryDelivery(batch)}>
              <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${retryingBatchId === batch.id ? 'animate-spin' : ''}`} />
              {retryingBatchId === batch.id ? 'Retrying…' : 'Retry this university'}
            </Button>}
          </div>
        </div>;
      })}
    </div>
  ) : <p className="px-4 py-4 text-sm text-muted-foreground">No university push was configured for this lead.</p>;

  const deliveryBattery = (history: LmsLead[]) => {
    const { deliveries, pushed, notPushed, pending } = summarizeDeliveries(history);
    const total = deliveries.length;
    return <Popover>
      <PopoverTrigger asChild>
        <button type="button" aria-label={`View university deliveries: ${pushed} sent, ${notPushed} need attention, ${pending} pending`}
          className="group w-[196px] rounded-lg border bg-background px-3 py-2 text-left transition-colors hover:border-primary/50 hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <span className="flex items-center justify-between gap-2 text-xs font-semibold text-foreground">
            <span>{total ? `${pushed} of ${total} sent` : 'Inbox only'}</span>
            <ChevronDown className="h-3.5 w-3.5 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" aria-hidden="true" />
          </span>
          <span className="mt-2 flex h-2.5 overflow-hidden rounded-full bg-slate-200" aria-hidden="true">
            {pushed > 0 && <span className="bg-emerald-500" style={{ flex: pushed }} />}
            {notPushed > 0 && <span className="bg-red-500" style={{ flex: notPushed }} />}
            {pending > 0 && <span className="bg-amber-400" style={{ flex: pending }} />}
          </span>
          <span className="mt-1.5 flex flex-wrap gap-x-2 gap-y-0.5 text-[11px] font-medium tabular-nums">
            {pushed > 0 && <span className="text-emerald-700">{pushed} sent</span>}
            {notPushed > 0 && <span className="text-red-700">{notPushed} failed/duplicate</span>}
            {pending > 0 && <span className="text-amber-700">{pending} pending</span>}
            {!total && <span className="text-muted-foreground">Not sent to a university</span>}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent side="left" align="start" className="w-80 overflow-hidden p-0 shadow-xl">
        <div className="border-b px-4 py-3">
          <p className="font-semibold">University deliveries</p>
          <p className="text-xs text-muted-foreground">{total ? `${total} universit${total === 1 ? 'y' : 'ies'} · latest result for each` : 'No destinations selected'}</p>
        </div>
        {deliveryList(deliveries)}
      </PopoverContent>
    </Popover>;
  };

  const SortIcon = ({ col }: { col: string }) =>
    sortCol === col ? (
      sortDir === "asc" ? (
        <ChevronUp className="h-3 w-3 inline ml-1" />
      ) : (
        <ChevronDown className="h-3 w-3 inline ml-1" />
      )
    ) : null;

  const clearFilters = () => {
    setSearch(''); setSegment('all'); setStatusFilter('all'); setSourceFilter('all'); setMediumFilter('all');
    setCampaignFilter(''); setCourseFilter('all'); setUniversityFilter('all'); setCityFilter('all');
    setStateFilter('all'); setContactFilter('all'); setDateFrom(''); setDateTo('');
  };
  const activeFilterCount = [statusFilter !== 'all', sourceFilter !== 'all', mediumFilter !== 'all',
    !!campaignFilter, courseFilter !== 'all', universityFilter !== 'all', cityFilter !== 'all',
    stateFilter !== 'all', contactFilter !== 'all', !!dateFrom, !!dateTo].filter(Boolean).length;
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
    <div className="mx-auto w-full max-w-[1760px] space-y-4 px-4 py-5 md:px-8">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-3xl font-display font-bold tracking-tight text-foreground">All Leads</h1>
          <p className="mt-1 text-sm text-muted-foreground">Search enquiries, review university delivery, and act on selected leads.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {isAdmin && <Button variant="outline" size="sm" onClick={() => setShowAutomation(!showAutomation)} aria-expanded={showAutomation}>
            <Zap className="mr-2 h-4 w-4" /> Lead push automation {showAutomation ? <ChevronUp className="ml-2 h-4 w-4" /> : <ChevronDown className="ml-2 h-4 w-4" />}
          </Button>}
          <Button variant="outline" size="sm" onClick={() => fetchLeads(true)} disabled={loading}>
            <RefreshCw className={`mr-2 h-4 w-4 ${loading ? 'animate-spin' : ''}`} /> Refresh
          </Button>
        </div>
      </div>

      {isAdmin && showAutomation && <LeadAutomationSettings incomingExtraFields={[...new Set(leads
        .filter((lead) => lead.isInbound)
        .flatMap((lead) => Object.keys(lead.extraData || {})))].sort()} />}

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" aria-label="Lead overview">
        {[
          ['Matching leads', grouped.length, 'text-foreground'],
          ['Sent to university', viewSummary.sent, 'text-emerald-700'],
          ['Needs attention', viewSummary.needsAttention, 'text-red-700'],
          ['Inbox only', viewSummary.inboxOnly, 'text-muted-foreground'],
        ].map(([label, count, color]) => <Card key={String(label)} className="px-4 py-3 shadow-sm">
          <p className="text-xs font-medium text-muted-foreground">{label}</p>
          <p className={`mt-1 text-2xl font-bold tabular-nums ${color}`}>{count}</p>
        </Card>)}
      </div>

      <Card className="overflow-hidden shadow-sm">
        <div className="space-y-3 border-b p-4">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div><h2 className="text-lg font-semibold">Lead list</h2><p className="text-sm text-muted-foreground">{hasMore ? 'Older leads can be loaded below the list.' : 'Open a name or delivery status for details.'}</p></div>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" onClick={() => setShowFilters(!showFilters)} aria-expanded={showFilters}>
                <Filter className="mr-2 h-4 w-4" /> Filters{activeFilterCount ? ` (${activeFilterCount})` : ''}
              </Button>
              <Button variant="outline" size="sm" onClick={() => downloadCSV(filtered, isAdmin ? 'all-leads.csv' : 'all-leads-masked.csv', !isAdmin)} disabled={!filtered.length}>
                <Download className="mr-2 h-4 w-4" /> {isAdmin ? 'Download leads' : 'Download masked leads'}
              </Button>
            </div>
          </div>
          <div className="flex flex-col gap-2 md:flex-row"><div className="relative flex-1"><Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input aria-label="Search anything in leads" placeholder="Search name, email, mobile, campaign or city" value={search} onChange={(e) => setSearch(e.target.value)} className="h-10 bg-background pl-10" />
          </div>
            <Select value={segment} onValueChange={setSegment}><SelectTrigger aria-label="Lead source group" className="h-10 w-full md:w-56"><SelectValue /></SelectTrigger><SelectContent>
              <SelectItem value="all">All sources ({segmentCounts.all})</SelectItem>
              <SelectItem value="facebook">Meta / Facebook ({segmentCounts.facebook})</SelectItem>
              <SelectItem value="google">Google ({segmentCounts.google})</SelectItem>
              <SelectItem value="other">Other sources ({segmentCounts.other})</SelectItem>
              {isAdmin && <SelectItem value="repeat">Repeat enquiries ({segmentCounts.repeat})</SelectItem>}
            </SelectContent></Select>
          </div>
          <div className="flex flex-wrap gap-1" aria-label="Filter by delivery status">
              {[['all','All'],['Received','Received'],['Failed','Needs attention'],['Pushed','Pushed']].map(([value,label]) =>
                <Button key={value} size="sm" variant={statusFilter === value ? 'default' : 'ghost'} onClick={() => setStatusFilter(value)}>{label}</Button>)}
          </div>
          {showFilters && <div className="rounded-xl border bg-muted/25 p-3 md:p-4">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2"><p className="text-sm font-semibold">Refine your lead list</p>
              <Button variant="ghost" size="sm" onClick={clearFilters}><X className="mr-2 h-4 w-4" /> Clear all</Button></div>
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              <section className="space-y-2 rounded-lg border bg-background p-3"><h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Acquisition</h3>
                <Select value={sourceFilter} onValueChange={setSourceFilter}><SelectTrigger aria-label="Source filter"><SelectValue placeholder="Source" /></SelectTrigger><SelectContent><SelectItem value="all">All sources</SelectItem>{sources.map((value) => <SelectItem key={value} value={value}>{value}</SelectItem>)}</SelectContent></Select>
                <Select value={mediumFilter} onValueChange={setMediumFilter}><SelectTrigger aria-label="Medium filter"><SelectValue placeholder="Medium" /></SelectTrigger><SelectContent><SelectItem value="all">All media</SelectItem>{media.map((value) => <SelectItem key={value} value={value}>{value}</SelectItem>)}</SelectContent></Select>
                <Input aria-label="Campaign filter" list="all-leads-campaigns" placeholder="Campaign contains..." value={campaignFilter} onChange={(e) => setCampaignFilter(e.target.value)} />
                <datalist id="all-leads-campaigns">{[...new Set(leads.map((lead) => lead.campaign).filter(Boolean))].map((value) => <option key={value} value={value} />)}</datalist>
              </section>
              <section className="space-y-2 rounded-lg border bg-background p-3"><h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Student</h3>
                <Select value={courseFilter} onValueChange={setCourseFilter}><SelectTrigger aria-label="Course filter"><SelectValue placeholder="Course" /></SelectTrigger><SelectContent><SelectItem value="all">All courses / interests</SelectItem>{courses.map((value) => <SelectItem key={value} value={value}>{value}</SelectItem>)}</SelectContent></Select>
                <div className="grid grid-cols-2 gap-2"><Select value={stateFilter} onValueChange={setStateFilter}><SelectTrigger aria-label="State filter"><SelectValue placeholder="State" /></SelectTrigger><SelectContent><SelectItem value="all">All states</SelectItem>{states.map((value) => <SelectItem key={value} value={value}>{value}</SelectItem>)}</SelectContent></Select>
                  <Select value={cityFilter} onValueChange={setCityFilter}><SelectTrigger aria-label="City filter"><SelectValue placeholder="City" /></SelectTrigger><SelectContent><SelectItem value="all">All cities</SelectItem>{cities.map((value) => <SelectItem key={value} value={value}>{value}</SelectItem>)}</SelectContent></Select></div>
                <Select value={contactFilter} onValueChange={setContactFilter}><SelectTrigger aria-label="Contact details filter"><SelectValue placeholder="Contact details" /></SelectTrigger><SelectContent><SelectItem value="all">Any contact details</SelectItem><SelectItem value="both">Email and mobile</SelectItem><SelectItem value="email">Has email</SelectItem><SelectItem value="mobile">Has mobile</SelectItem></SelectContent></Select>
              </section>
              <section className="space-y-2 rounded-lg border bg-background p-3"><h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Delivery and date</h3>
                <div className="grid grid-cols-2 gap-2"><Select value={statusFilter} onValueChange={setStatusFilter}><SelectTrigger aria-label="Status filter"><SelectValue placeholder="Status" /></SelectTrigger><SelectContent>
                  {['all','Received','Pending','Pushed','Duplicate','Failed','Needs review'].map((value) => <SelectItem key={value} value={value}>{value === 'all' ? 'All statuses' : value}</SelectItem>)}
                </SelectContent></Select>
                  <Select value={universityFilter} onValueChange={setUniversityFilter}><SelectTrigger aria-label="Destination filter"><SelectValue placeholder="Destination" /></SelectTrigger><SelectContent><SelectItem value="all">All destinations</SelectItem>{universities.map((value) => <SelectItem key={value} value={value}>{value}</SelectItem>)}</SelectContent></Select></div>
                <div className="grid grid-cols-2 gap-2"><Input type="date" aria-label="Received from date" value={dateFrom} max={dateTo || undefined} onChange={(e) => setDateFrom(e.target.value)} /><Input type="date" aria-label="Received through date" value={dateTo} min={dateFrom || undefined} onChange={(e) => setDateTo(e.target.value)} /></div>
                <p className="text-xs text-muted-foreground">Dates use India time. Filters can be combined.</p>
              </section>
            </div>
          </div>}
        </div>

        {selectedIds.size > 0 && <div className="flex flex-wrap items-center gap-2 border-b bg-primary/5 px-4 py-2 text-sm">
          <strong>{selectedIds.size} selected</strong>
          <Button size="sm" variant="outline" onClick={handleBulkRetry}><RefreshCw className="mr-1 h-3.5 w-3.5" /> Retry failed</Button>
          <Button size="sm" variant="outline" onClick={() => downloadCSV(leads.filter((lead) => selectedIds.has(lead.id)), isAdmin ? 'selected-leads.csv' : 'selected-leads-masked.csv', !isAdmin)}><Download className="mr-1 h-3.5 w-3.5" /> {isAdmin ? 'Download selected' : 'Download selected masked'}</Button>
          {isAdmin && <Button size="sm" variant="destructive" disabled={selectedIds.size > 100} onClick={() => handleDeleteLeads([...selectedIds])}><Trash2 className="mr-1 h-3.5 w-3.5" /> Delete selected{selectedIds.size > 100 ? ' (max 100)' : ''}</Button>}
          <Button size="sm" variant="ghost" onClick={() => setSelectedIds(new Set())}>Clear selection</Button>
        </div>}

        <div className="overflow-x-auto">
          {loading ? <div className="flex items-center justify-center py-16 text-sm text-muted-foreground"><Loader2 className="mr-2 h-5 w-5 animate-spin" /> Loading leads...</div> :
          <Table className="min-w-[1420px] text-base">
            <TableHeader><TableRow className="table-header">
              <TableHead className="w-10"><Checkbox aria-label="Select all leads shown on this page" checked={visibleRows.length > 0 && visibleRows.every((lead) => selectedIds.has(lead.id))} onCheckedChange={toggleAll} /></TableHead>
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
              </TableCell></TableRow> : pageGroups.flatMap(({ key, items, latest, firstAt }) =>
                (expanded.has(key) ? items : [latest]).map((lead, index) => <TableRow key={lead.id} className={index > 0 ? 'bg-muted/20' : 'hover:bg-muted/30'}>
                  <TableCell><Checkbox aria-label={`Select ${lead.name || lead.email || 'lead'}`} checked={selectedIds.has(lead.id)} onCheckedChange={() => toggleSelect(lead.id)} /></TableCell>
                  <TableCell className="align-top"><button type="button" onClick={() => setDetailLead(lead)} className="text-left font-semibold text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{lead.name || 'Unnamed lead'}</button></TableCell>
                  <TableCell className="max-w-[220px] truncate align-top text-base" title={lead.email}>{lead.email || '-'}</TableCell>
                  <TableCell className="whitespace-nowrap align-top text-base tabular-nums">{lead.mobile || '-'}</TableCell>
                  <TableCell className="align-top"><Badge variant="outline" className="max-w-[150px] truncate">{attributionSource(lead)}</Badge></TableCell>
                  <TableCell className="align-top text-base">{lead.medium || field(lead,'utm_medium','utmMedium')}</TableCell>
                  <TableCell className="max-w-[200px] truncate align-top text-base" title={lead.campaign}>{lead.campaign || field(lead,'utm_campaign','utmCampaign')}</TableCell>
                  <TableCell className="whitespace-nowrap align-top"><div className="text-base font-medium tabular-nums">{formatDate(lead.receivedAt)}</div><div className="mt-1 text-xs text-muted-foreground">{index > 0 ? 'Earlier submission' : 'Most recent'}</div></TableCell>
                  <TableCell className="align-top">{deliveryBattery(index === 0 ? items : [lead])}
                    {lead.failReason && <p className="mt-1 max-w-[240px] truncate text-xs text-destructive" title={lead.failReason}>{lead.failReason}</p>}</TableCell>
                  <TableCell className="align-top">{index === 0 && items.length > 1 ? <button type="button" aria-expanded={expanded.has(key)} aria-label={`${expanded.has(key) ? 'Collapse' : 'Expand'} ${items.length} submissions for ${lead.name || 'this contact'}`}
                    className="inline-flex min-h-9 items-center gap-1 rounded-md border px-2 text-xs font-medium hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => setExpanded((current) => { const next = new Set(current); if (next.has(key)) next.delete(key); else next.add(key); return next; })}>
                    {expanded.has(key) ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}{items.length} entries</button> : index === 0 ? <span className="text-xs text-muted-foreground">First seen {formatDate(firstAt)}</span> : <span className="text-xs text-muted-foreground">History</span>}</TableCell>
                  <TableCell className="align-top"><div className="flex justify-end gap-1"><Button variant="ghost" size="icon" className="h-9 w-9" aria-label={`View details for ${lead.name || 'lead'}`} onClick={() => setDetailLead(lead)}><Eye className="h-4 w-4" /></Button>
                    {lead.status === 'Failed' && <Button variant="ghost" size="icon" className="h-9 w-9" aria-label={`Retry ${lead.name || 'lead'}`} onClick={() => handleRetryLead(lead)}><RefreshCw className="h-4 w-4" /></Button>}
                    {isAdmin && <Button variant="ghost" size="icon" className="h-9 w-9 text-destructive" aria-label={`Delete submission for ${lead.name || 'lead'}`} onClick={() => handleDeleteLeads([lead.id])}><Trash2 className="h-4 w-4" /></Button>}</div></TableCell>
                </TableRow>))}
            </TableBody>
          </Table>}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t px-4 py-3 text-sm text-muted-foreground">
          <span>Showing {grouped.length ? (safePage - 1) * rowsPerPage + 1 : 0}–{Math.min(safePage * rowsPerPage, grouped.length)} of {grouped.length} matching leads. Selection applies to this page.</span>
          <div className="flex flex-wrap items-center gap-2">
            <span>Rows per page</span>
            <Select value={rowsPerPageMode} onValueChange={(value) => {
              setRowsPerPageMode(value);
              if (value !== 'custom') setRowsPerPage(Number(value));
            }}><SelectTrigger className="h-9 w-24" aria-label="Rows per page"><SelectValue /></SelectTrigger><SelectContent>
              {['10', '25', '50', '100'].map((value) => <SelectItem key={value} value={value}>{value}</SelectItem>)}
              <SelectItem value="custom">Custom</SelectItem>
            </SelectContent></Select>
            {rowsPerPageMode === 'custom' && <Input type="number" min={1} max={1000} aria-label="Custom rows per page" placeholder="1–1000" className="h-9 w-24" value={customRows}
              onChange={(event) => {
                setCustomRows(event.target.value);
                const value = Number(event.target.value);
                if (Number.isInteger(value) && value >= 1 && value <= 1000) setRowsPerPage(value);
              }} />}
            <Button variant="outline" size="sm" disabled={safePage <= 1} onClick={() => setCurrentPage(safePage - 1)}>Previous</Button>
            <span className="min-w-16 text-center">{safePage} / {totalPages}</span>
            <Button variant="outline" size="sm" disabled={safePage >= totalPages} onClick={() => setCurrentPage(safePage + 1)}>Next</Button>
          </div>
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
                    ['Email', detailLead.email], ['Mobile (10 digits)', detailLead.mobile], ['Original mobile', detailLead.originalMobile], ['City', detailLead.city], ['State', field(detailLead,'state')],
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
                  <div className="overflow-hidden rounded-xl border">{deliveryList(detailLead.deliveries)}</div>
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
                  {isAdmin && <Button asChild variant="outline" size="sm"><a href={`/api/inbound/generic-leads/${detailLead.id}/archive.zip`}>
                    <Download className="h-4 w-4 mr-2" /> Download incoming payload ZIP
                  </a></Button>}
                  <p className="text-sm font-medium">Auto-push routing</p>
                  {!!detailLead.matchedRules?.length && <p className="text-xs text-muted-foreground">Matched rules: {detailLead.matchedRules.join(', ')}</p>}
                  {!!detailLead.skippedDestinations && <p className="text-xs text-destructive">{detailLead.skippedDestinations} destination was removed before this lead arrived. Update the automation rule.</p>}
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
                {isAdmin && <Button variant="destructive" className="w-full" onClick={() => handleDeleteLeads([detailLead.id])}>
                  <Trash2 className="h-4 w-4 mr-2" /> Delete this submission
                </Button>}
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}
