import { useState, useMemo, useCallback, useEffect } from "react";
import { useNavigate } from 'react-router-dom';
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/useAuth";
import { AlertTriangle, BarChart3, Download, Search, Eye, RefreshCw, ChevronDown, ChevronUp, Filter, Loader2, Zap, Inbox, X, Trash2, CheckCircle2, XCircle, Clock3, TrendingUp } from "lucide-react";
import { api } from "@/integrations/api/client";
import { DataRetentionNotice } from "@/components/ui/DataRetentionNotice";
import { LeadAutomationSettings } from './LeadAutomationSettings';
import { AttributionRulesSettings } from './AttributionRulesSettings';
import { SourceReviewSettings } from './SourceReviewSettings';
import { deliveryResult, summarizeDeliveries, type LeadDelivery } from './delivery-summary';
import { retrySources } from './retry-sources';
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

interface RetryCandidate {
  id: string;
  universityId: string;
  universityName: string;
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
  return lead.source || lead.extraData?.utm_source || lead.extraData?.utmSource || '-';
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
  const navigate = useNavigate();
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
  const [totalSubmissions, setTotalSubmissions] = useState<number | null>(null);
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
  const [deleteIds, setDeleteIds] = useState<string[]>([]);
  const [deleteStage, setDeleteStage] = useState<'question' | 'confirm' | null>(null);
  const [deleteText, setDeleteText] = useState('');
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [retryCandidates, setRetryCandidates] = useState<RetryCandidate[]>([]);
  const [retryUniversityId, setRetryUniversityId] = useState('');
  const [retryOpen, setRetryOpen] = useState(false);
  const [retryDiscovering, setRetryDiscovering] = useState(false);
  const [retryRunning, setRetryRunning] = useState(false);
  const [retryProgress, setRetryProgress] = useState(0);
  const [detailLead, setDetailLead] = useState<LmsLead | null>(null);
  const [showFilters, setShowFilters] = useState(false);
  const [sortCol, setSortCol] = useState<string>("receivedAt");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [showAutomation, setShowAutomation] = useState(false);
  const [showAttribution, setShowAttribution] = useState(false);
  const [showSources, setShowSources] = useState(false);
  const [showInsights, setShowInsights] = useState(true);
  const [showUniversityBreakdown, setShowUniversityBreakdown] = useState(false);
  const [failureReasons, setFailureReasons] = useState<Record<string, string>>({});
  const [attributionVersion, setAttributionVersion] = useState(0);
  const fetchLeads = useCallback(
    async (_forceRefresh = false) => {
      setLoading(true);
      try {
        const totalResult = await api.from('inbound_leads').select('id', { count: 'exact', head: true }).is('deleted_at', null);
        if (!totalResult.error) setTotalSubmissions(totalResult.count ?? null);
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

        const incoming: LmsLead[] = (inboundData || []).map((lead: any) => ({
          id: lead.id, name: lead.name || '', email: lead.email || '',
          mobile: tenDigitMobile(lead.mobile || ''), originalMobile: lead.mobile || '',
          city: lead.city || '', course: lead.course || '', specialization: '',
          source: lead.source || lead.connection_name || 'Generic API', campaign: lead.campaign || '',
          medium: lead.extra_data?.attribution_medium || lead.extra_data?.utm_medium || lead.extra_data?.lead_medium || lead.extra_data?.medium || '',
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
        setLeads(incoming.sort((a, b) => (b.receivedAt || '').localeCompare(a.receivedAt || '')));
        setHasMore(inboundHasMore);
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
  const selectedMatchingCount = filtered.filter((lead) => selectedIds.has(lead.id)).length;

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
    const count = (items: LmsLead[]) => items.length;
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
  const insights = useMemo(() => {
    const today = leadDay({ receivedAt: new Date().toISOString() } as LmsLead);
    const delivery = { sent: 0, failed: 0, duplicate: 0, pending: 0 };
    const sourceCounts = new Map<string, number>();
    const campaignCounts = new Map<string, number>();
    let todayCount = 0;
    for (const lead of filtered) {
      if (leadDay(lead) === today) todayCount++;
      const source = attributionSource(lead);
      sourceCounts.set(source, (sourceCounts.get(source) || 0) + 1);
      if (lead.campaign) campaignCounts.set(lead.campaign, (campaignCounts.get(lead.campaign) || 0) + 1);
      for (const item of lead.deliveries) {
        const result = deliveryResult(item);
        if (result === 'Pushed') delivery.sent++;
        else if (result === 'Duplicate') delivery.duplicate++;
        else if (result === 'Pending') delivery.pending++;
        else delivery.failed++;
      }
    }
    const completed = delivery.sent + delivery.failed + delivery.duplicate;
    const highest = (values: Map<string, number>) => [...values].sort((a, b) => b[1] - a[1])[0] || ['', 0];
    return { todayCount, delivery, successRate: completed ? Math.round(delivery.sent / completed * 100) : 0,
      topSource: highest(sourceCounts), topCampaign: highest(campaignCounts) };
  }, [filtered]);
  const universityBreakdown = useMemo(() => {
    const values = new Map<string, { university: string; sent: number; failed: number; duplicate: number; pending: number; total: number }>();
    for (const lead of filtered) for (const item of lead.deliveries) {
      const university = item.universities?.name || 'Unknown university';
      const row = values.get(university) || { university, sent: 0, failed: 0, duplicate: 0, pending: 0, total: 0 };
      const result = deliveryResult(item);
      row.total++;
      if (result === 'Pushed') row.sent++;
      else if (result === 'Duplicate') row.duplicate++;
      else if (result === 'Pending') row.pending++;
      else row.failed++;
      values.set(university, row);
    }
    return [...values.values()].sort((a, b) => b.failed - a.failed || b.sent - a.sent || a.university.localeCompare(b.university));
  }, [filtered]);

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
      if (visibleRows.every((lead) => next.has(lead.id))) return new Set();
      else visibleRows.forEach((lead) => next.add(lead.id));
      return next;
    });
  };

  const prepareRetry = useCallback(async (selected: LmsLead[], onlyBatchId?: string) => {
    if (retryDiscovering || retryRunning) return;
    setRetryDiscovering(true);
    try {
      const { directIds, batchIds } = retrySources(selected, onlyBatchId);
      const { data: universityRows } = await api.from('universities').select('id,name').range(0, 999);
      const universityNames = new Map((universityRows || []).map((row: any) => [row.id, row.name]));
      const candidates = new Map<string, RetryCandidate>();
      for (const [field, ids] of [['id', directIds], ['batch_id', batchIds]] as const) {
        for (let start = 0; start < ids.length; start += 250) {
          for (let offset = 0; ; offset += 1000) {
            const { data, error } = await api.from('leads')
              .select('id,university_id,retry_count,universities(name)')
              .in(field, ids.slice(start, start + 250)).in('status', ['Fail', 'failed'])
              .is('deleted_at', null).range(offset, offset + 999);
            if (error) throw error;
            for (const row of data || []) {
              if (Number(row.retry_count || 0) >= 3) continue;
              candidates.set(row.id, { id: row.id, universityId: row.university_id,
                universityName: universityNames.get(row.university_id) || row.universities?.name || 'Unknown destination' });
            }
            if ((data || []).length < 1000) break;
          }
        }
      }
      const found = [...candidates.values()];
      if (!found.length) {
        toast({ title: 'No failed leads to retry', description: 'The selected deliveries have no eligible failed lead records.' });
        return;
      }
      const universities = new Set(found.map((candidate) => candidate.universityId));
      setRetryCandidates(found);
      setRetryUniversityId(universities.size === 1 ? [...universities][0] : '');
      setRetryProgress(0);
      setRetryOpen(true);
    } catch (error: any) {
      toast({ title: 'Could not check failed leads', description: error.message, variant: 'destructive' });
    } finally {
      setRetryDiscovering(false);
    }
  }, [retryDiscovering, retryRunning, toast]);

  const handleRetryLead = useCallback((lead: LmsLead) => prepareRetry([lead]), [prepareRetry]);
  const handleRetryDelivery = useCallback((batch: LeadDelivery) => prepareRetry([], batch.id), [prepareRetry]);
  const handleBulkRetry = useCallback(() => prepareRetry(leads.filter((lead) => selectedIds.has(lead.id))),
    [prepareRetry, leads, selectedIds]);

  const pushSelectedToUniversities = () => {
    if (!isAdmin) return;
    const selected = leads.filter((lead) => selectedIds.has(lead.id));
    if (!selected.length) return;
    const rows = selected.map((lead) => ({
      ...Object.fromEntries(Object.entries(lead.extraData || {}).filter(([, value]) => typeof value === 'string')),
      name: lead.name, email: lead.email, mobile: lead.mobile, city: lead.city,
      course: lead.course, specialization: lead.specialization, state: leadState(lead),
      leadSource: attributionSource(lead), leadMedium: lead.medium, leadCampaign: lead.campaign,
    }));
    sessionStorage.setItem('lms-multipush-selection', JSON.stringify(rows));
    navigate('/lead-push/multi-push');
  };

  const retryUniversities = [...new Map(retryCandidates.map((candidate) =>
    [candidate.universityId, candidate.universityName] as const)).entries()];
  const chosenRetryCandidates = retryCandidates.filter((candidate) =>
    retryUniversityId === 'all' || candidate.universityId === retryUniversityId);

  const runRetry = async () => {
    if (!retryUniversityId || !chosenRetryCandidates.length || retryRunning) return;
    setRetryRunning(true);
    let attempted = 0;
    try {
      // Small requests keep partner timeouts below the proxy deadline.
      for (let start = 0; start < chosenRetryCandidates.length; start += 2) {
        const ids = chosenRetryCandidates.slice(start, start + 2).map((candidate) => candidate.id);
        const { data, error } = await api.functions.invoke('retry-leads', { body: { lead_ids: ids } });
        if (error) throw error;
        attempted += Number(data?.retried || 0);
        setRetryProgress(Math.min(start + 2, chosenRetryCandidates.length));
      }
      toast({ title: 'Retry completed', description: `${attempted} failed lead${attempted === 1 ? '' : 's'} retried. Review the updated delivery results.` });
      setRetryOpen(false);
      setSelectedIds(new Set());
      await fetchLeads(true);
    } catch (error: any) {
      toast({ title: 'Retry stopped', description: `${attempted} retried before the error. ${error.message} Refresh the lead list before retrying again.`, variant: 'destructive' });
      setRetryOpen(false);
      await fetchLeads(true);
    } finally {
      setRetryRunning(false);
    }
  };

  const requestDelete = (ids: string[]) => {
    if (!isAdmin || !ids.length) return;
    if (ids.length > 100) {
      toast({ title: 'Select up to 100 leads to delete at once', variant: 'destructive' });
      return;
    }
    setDetailLead(null);
    setDeleteIds(ids);
    setDeleteText('');
    setDeleteStage('question');
  };

  const confirmDelete = async () => {
    if (!isAdmin || deleteStage !== 'confirm' || deleteText !== 'DELETE' || deleteBusy) return;
    setDeleteBusy(true);
    try {
      const { data, error } = await api.functions.invoke('delete-leads', { body: { lead_ids: deleteIds } });
      if (error) throw error;
      toast({ title: `${data.deleted} lead${data.deleted === 1 ? '' : 's'} removed from All Leads` });
      setSelectedIds(new Set());
      setDeleteStage(null);
      setDeleteIds([]);
      await fetchLeads(true);
    } catch (error: any) {
      toast({ title: 'Could not delete leads', description: error.message, variant: 'destructive' });
    } finally {
      setDeleteBusy(false);
    }
  };

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

  const loadFailureReason = async (batchId: string) => {
    setFailureReasons((current) => ({ ...current, [batchId]: 'Loading reason…' }));
    const { data, error } = await api.from('leads').select('api_response,status')
      .eq('batch_id', batchId).in('status', ['Fail', 'failed']).order('processed_at', { ascending: false }).limit(1);
    if (error) { setFailureReasons((current) => ({ ...current, [batchId]: 'Could not load the partner response.' })); return; }
    let reason = String(data?.[0]?.api_response || 'No partner response was recorded.');
    try { const parsed = JSON.parse(reason); reason = String(parsed.message || parsed.error || reason); }
    catch { /* The partner returned plain text. */ }
    setFailureReasons((current) => ({ ...current, [batchId]: reason.slice(0, 300) }));
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
            {batch.error_message && <p className="mt-1 break-words text-xs text-muted-foreground">{isAdmin ? batch.error_message : maskContactText(batch.error_message)}</p>}
            {!batch.error_message && result === 'Failed' && <div className="mt-1 text-xs">
              {failureReasons[batch.id]
                ? <p className="break-words text-muted-foreground">{isAdmin ? failureReasons[batch.id] : maskContactText(failureReasons[batch.id])}</p>
                : <Button type="button" size="sm" variant="link" className="h-auto p-0 text-xs" onClick={() => void loadFailureReason(batch.id)}>Why failed?</Button>}
            </div>}
            {batch.isInbound && Number(batch.fail_count || 0) > 0 && <Button type="button" variant="outline" size="sm"
              className="mt-2 h-8 border-red-200 text-red-700 hover:bg-red-50" disabled={retryDiscovering || retryRunning}
              onClick={() => handleRetryDelivery(batch)}>
              <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${retryDiscovering ? 'animate-spin' : ''}`} />
              Retry this university
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
          <Button variant="outline" size="sm" onClick={() => setShowSources(true)} aria-haspopup="dialog">
            Sources & notes
          </Button>
          {isAdmin && <Button variant="outline" size="sm" onClick={() => setShowAttribution(!showAttribution)} aria-expanded={showAttribution}>
            Source · Medium · Campaign defaults {showAttribution ? <ChevronUp className="ml-2 h-4 w-4" /> : <ChevronDown className="ml-2 h-4 w-4" />}
          </Button>}
          {isAdmin && <Button variant="outline" size="sm" onClick={() => setShowAutomation(!showAutomation)} aria-expanded={showAutomation}>
            <Zap className="mr-2 h-4 w-4" /> Lead push automation {showAutomation ? <ChevronUp className="ml-2 h-4 w-4" /> : <ChevronDown className="ml-2 h-4 w-4" />}
          </Button>}
          <Button variant="outline" size="sm" onClick={() => fetchLeads(true)} disabled={loading}>
            <RefreshCw className={`mr-2 h-4 w-4 ${loading ? 'animate-spin' : ''}`} /> Refresh
          </Button>
        </div>
      </div>

      <Dialog open={showSources} onOpenChange={setShowSources}>
        <DialogContent className="flex max-h-[90vh] w-[min(94vw,820px)] max-w-none flex-col gap-3 overflow-hidden p-0">
          <DialogHeader className="border-b px-5 py-4">
            <DialogTitle>Sources & notes</DialogTitle>
          </DialogHeader>
          {showSources && <SourceReviewSettings onPublished={() => setAttributionVersion((value) => value + 1)} />}
        </DialogContent>
      </Dialog>
      {isAdmin && showAutomation && <LeadAutomationSettings incomingExtraFields={[...new Set(leads
        .filter((lead) => lead.isInbound)
        .flatMap((lead) => Object.keys(lead.extraData || {})))].sort()} />}
      {isAdmin && showAttribution && <AttributionRulesSettings key={attributionVersion} />}

      <Card className="overflow-hidden border-primary/20 shadow-md" aria-label="Lead performance overview">
        <button type="button" className="flex w-full items-center justify-between gap-4 bg-gradient-to-r from-primary/10 via-background to-emerald-500/10 px-4 py-3 text-left md:px-5"
          onClick={() => setShowInsights((value) => !value)} aria-expanded={showInsights}>
          <span className="flex min-w-0 items-center gap-3"><span className="rounded-xl bg-primary/10 p-2 text-primary"><BarChart3 className="h-5 w-5" /></span>
            <span><span className="block font-semibold">Lead performance</span><span className="block text-xs text-muted-foreground">Live view of the loaded leads · responds to your filters</span></span></span>
          <span className="flex items-center gap-2"><Badge variant="secondary">{filtered.length} matching</Badge>{showInsights ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}</span>
        </button>
        {showInsights && <div className="space-y-4 p-4 md:p-5">
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-5">
            <button type="button" onClick={() => setStatusFilter('all')} className="rounded-xl border bg-background p-3 text-left transition hover:border-primary/50 hover:shadow-sm">
              <p className="text-xs font-medium text-muted-foreground">Filtered leads</p><p className="mt-1 text-2xl font-bold tabular-nums">{filtered.length}</p>
              <p className="mt-1 text-xs text-muted-foreground">{totalSubmissions ?? leads.length} total in the system</p>
            </button>
            <button type="button" onClick={() => { setStatusFilter('Pushed'); setShowUniversityBreakdown(true); }} className="rounded-xl border border-emerald-200 bg-emerald-50/60 p-3 text-left transition hover:shadow-sm dark:bg-emerald-950/20">
              <p className="text-xs font-medium text-emerald-700">Sent to university</p><p className="mt-1 text-2xl font-bold tabular-nums text-emerald-700">{viewSummary.sent}</p>
              <p className="mt-1 text-xs text-emerald-700/80">{insights.successRate}% accepted · click for universities</p>
            </button>
            <button type="button" onClick={() => { setStatusFilter('Failed'); setShowUniversityBreakdown(true); }} className="rounded-xl border border-red-200 bg-red-50/60 p-3 text-left transition hover:shadow-sm dark:bg-red-950/20">
              <p className="flex items-center gap-1 text-xs font-medium text-red-700"><AlertTriangle className="h-3.5 w-3.5" /> Needs attention</p><p className="mt-1 text-2xl font-bold tabular-nums text-red-700">{viewSummary.needsAttention}</p>
              <p className="mt-1 text-xs text-red-700/80">{insights.delivery.failed} failed · {insights.delivery.duplicate} duplicate · click for universities</p>
            </button>
            <div className="rounded-xl border bg-muted/25 p-3"><p className="text-xs font-medium text-muted-foreground">Inbox only</p><p className="mt-1 text-2xl font-bold tabular-nums">{viewSummary.inboxOnly}</p><p className="mt-1 text-xs text-muted-foreground">No university selected</p></div>
            <div className="rounded-xl border bg-muted/25 p-3"><p className="text-xs font-medium text-muted-foreground">Received today</p><p className="mt-1 text-2xl font-bold tabular-nums">{insights.todayCount}</p><p className="mt-1 flex items-center gap-1 text-xs text-muted-foreground"><TrendingUp className="h-3.5 w-3.5" /> India time</p></div>
          </div>
          <div className="grid gap-3 lg:grid-cols-[1.2fr_1fr]">
            <div className="rounded-xl border p-3"><div className="flex items-center justify-between gap-2"><p className="text-sm font-semibold">University delivery</p><p className="text-xs text-muted-foreground">{insights.delivery.pending} pending</p></div>
              <div className="mt-3 flex h-3 overflow-hidden rounded-full bg-muted" aria-label={`${insights.delivery.sent} sent, ${insights.delivery.failed} failed, ${insights.delivery.duplicate} duplicate, ${insights.delivery.pending} pending`}>
                {!!insights.delivery.sent && <span className="bg-emerald-500" style={{ flex: insights.delivery.sent }} />}
                {!!insights.delivery.failed && <span className="bg-red-500" style={{ flex: insights.delivery.failed }} />}
                {!!insights.delivery.duplicate && <span className="bg-amber-400" style={{ flex: insights.delivery.duplicate }} />}
                {!!insights.delivery.pending && <span className="bg-sky-400" style={{ flex: insights.delivery.pending }} />}
              </div>
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs"><span className="text-emerald-700">● {insights.delivery.sent} sent</span><span className="text-red-700">● {insights.delivery.failed} failed</span><span className="text-amber-700">● {insights.delivery.duplicate} duplicate</span><span className="text-sky-700">● {insights.delivery.pending} pending</span></div>
            </div>
            <div className="grid grid-cols-2 gap-2 rounded-xl border p-3"><div><p className="text-xs text-muted-foreground">Top source</p><p className="mt-1 truncate text-sm font-semibold" title={String(insights.topSource[0])}>{insights.topSource[0] || 'No source yet'}</p><p className="text-xs text-muted-foreground">{insights.topSource[1]} leads</p></div><div><p className="text-xs text-muted-foreground">Top campaign</p><p className="mt-1 truncate text-sm font-semibold" title={String(insights.topCampaign[0])}>{insights.topCampaign[0] || 'No campaign yet'}</p><p className="text-xs text-muted-foreground">{insights.topCampaign[1]} leads</p></div></div>
          </div>
          <div className="flex justify-end"><Button type="button" size="sm" variant="outline" onClick={() => setShowUniversityBreakdown((value) => !value)}>
            {showUniversityBreakdown ? 'Hide university results' : 'View results by university'}
            {showUniversityBreakdown ? <ChevronUp className="ml-2 h-4 w-4" /> : <ChevronDown className="ml-2 h-4 w-4" />}
          </Button></div>
          {showUniversityBreakdown && <div className="overflow-hidden rounded-xl border">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b bg-muted/30 px-4 py-3"><div><p className="text-sm font-semibold">University results</p><p className="text-xs text-muted-foreground">Counts use the same filters as the lead list. One lead can pass at one university and fail at another.</p></div><Badge variant="secondary">{universityBreakdown.length} universities</Badge></div>
            {universityBreakdown.length ? <div className="divide-y overflow-x-auto">{universityBreakdown.map((row) => <button type="button" key={row.university}
              onClick={() => { setUniversityFilter(row.university); setShowFilters(true); }} className="grid w-full grid-cols-[minmax(140px,1fr)_repeat(4,minmax(58px,auto))] items-center gap-2 px-4 py-3 text-left text-xs transition hover:bg-muted/30">
              <span className="min-w-0"><strong className="block truncate text-sm text-foreground" title={row.university}>{row.university}</strong><span className="text-muted-foreground">{row.total} attempts · click to filter</span></span>
              <span className="rounded-lg bg-emerald-50 px-2 py-1.5 text-center font-semibold text-emerald-700 dark:bg-emerald-950/30">{row.sent}<span className="block text-[10px] font-normal">Sent</span></span>
              <span className="rounded-lg bg-red-50 px-2 py-1.5 text-center font-semibold text-red-700 dark:bg-red-950/30">{row.failed}<span className="block text-[10px] font-normal">Failed</span></span>
              <span className="rounded-lg bg-amber-50 px-2 py-1.5 text-center font-semibold text-amber-700 dark:bg-amber-950/30">{row.duplicate}<span className="block text-[10px] font-normal">Duplicate</span></span>
              <span className="rounded-lg bg-sky-50 px-2 py-1.5 text-center font-semibold text-sky-700 dark:bg-sky-950/30">{row.pending}<span className="block text-[10px] font-normal">Pending</span></span>
            </button>)}</div> : <p className="px-4 py-5 text-sm text-muted-foreground">No university delivery attempts match the current filters.</p>}
          </div>}
          <p className="rounded-lg bg-muted/40 px-3 py-2 text-xs text-muted-foreground"><strong className="text-foreground">Source</strong> is where the lead came from · <strong className="text-foreground">Medium</strong> is the traffic type, such as paid · <strong className="text-foreground">Campaign</strong> is the ad or tracking name.</p>
        </div>}
      </Card>

      <Card className="overflow-hidden shadow-sm">
        <div className="space-y-3 border-b p-4">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div><h2 className="text-lg font-semibold">Lead list</h2><p className="text-sm text-muted-foreground">{hasMore ? `Showing the latest ${leads.length} submissions. Load older submissions below for a full count.` : 'Open a name or delivery status for details.'}</p></div>
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

        <Dialog open={retryOpen} onOpenChange={(open) => { if (!retryRunning) setRetryOpen(open); }}>
          <DialogContent>
            <DialogHeader><DialogTitle>Retry failed university leads</DialogTitle></DialogHeader>
            <p className="text-sm text-muted-foreground">Only actual failed lead records are eligible. Successful, duplicate, pending, and unavailable records will not be sent again.</p>
            <div className="space-y-2">
              <label className="text-sm font-medium">University</label>
              <Select value={retryUniversityId} onValueChange={setRetryUniversityId} disabled={retryRunning}>
                <SelectTrigger aria-label="University to retry"><SelectValue placeholder="Choose a university" /></SelectTrigger>
                <SelectContent>
                  {retryUniversities.length > 1 && <SelectItem value="all">All failed universities ({retryCandidates.length})</SelectItem>}
                  {retryUniversities.map(([id, name]) => <SelectItem key={id} value={id}>
                    {name} ({retryCandidates.filter((candidate) => candidate.universityId === id).length})
                  </SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <p className="text-sm">{retryUniversityId ? `${chosenRetryCandidates.length} failed lead${chosenRetryCandidates.length === 1 ? '' : 's'} selected for retry` : 'Choose where to retry the failed leads.'}</p>
            {retryRunning && <p className="text-sm text-muted-foreground">Processed {retryProgress} of {chosenRetryCandidates.length}. Keep this page open until it finishes.</p>}
            <div className="flex justify-end gap-2">
              <Button variant="outline" disabled={retryRunning} onClick={() => setRetryOpen(false)}>Cancel</Button>
              <Button disabled={!retryUniversityId || !chosenRetryCandidates.length || retryRunning} onClick={runRetry}>
                {retryRunning && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Retry {chosenRetryCandidates.length || ''} failed
              </Button>
            </div>
          </DialogContent>
        </Dialog>

        <Dialog open={deleteStage !== null} onOpenChange={(open) => {
          if (!open && !deleteBusy) { setDeleteStage(null); setDeleteIds([]); setDeleteText(''); }
        }}>
          <DialogContent className="sm:max-w-lg">
            {deleteStage === 'question' ? <>
              <DialogHeader><DialogTitle className="flex items-center gap-2"><Trash2 className="h-5 w-5 text-destructive" />Delete {deleteIds.length} lead{deleteIds.length === 1 ? '' : 's'}?</DialogTitle></DialogHeader>
              <p className="text-sm text-muted-foreground">Do you really want to remove {deleteIds.length === 1 ? 'this submission' : 'these submissions'} from All Leads? Related delivery history and private S3 archives will remain.</p>
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setDeleteStage(null)}>Cancel</Button>
                <Button variant="destructive" onClick={() => setDeleteStage('confirm')}>Yes, continue</Button>
              </div>
            </> : <>
              <DialogHeader><DialogTitle className="flex items-center gap-2"><Trash2 className="h-5 w-5 text-destructive" />Confirm deletion</DialogTitle></DialogHeader>
              <p className="text-sm text-muted-foreground">{deleteIds.length} lead submission{deleteIds.length === 1 ? '' : 's'} will be removed from All Leads. Delivery history and private S3 archives will remain. This cannot be undone from this screen.</p>
              <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-4">
                <label htmlFor="confirm-delete-leads" className="mb-2 block text-sm font-medium">Type <strong className="text-destructive">DELETE</strong> to confirm:</label>
                <Input id="confirm-delete-leads" autoFocus autoComplete="off" value={deleteText} onChange={(event) => setDeleteText(event.target.value)} disabled={deleteBusy} />
              </div>
              <div className="flex justify-end gap-2">
                <Button variant="outline" disabled={deleteBusy} onClick={() => setDeleteStage(null)}>Cancel</Button>
                <Button variant="destructive" disabled={deleteText !== 'DELETE' || deleteBusy} onClick={confirmDelete}>
                  {deleteBusy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Delete from All Leads
                </Button>
              </div>
            </>}
          </DialogContent>
        </Dialog>

        {selectedIds.size > 0 && <div className="flex flex-wrap items-center gap-2 border-b bg-primary/5 px-4 py-2 text-sm">
          <strong>{selectedIds.size} selected</strong>
          {visibleRows.length > 0 && visibleRows.every((lead) => selectedIds.has(lead.id)) && selectedMatchingCount < filtered.length &&
            <Button size="sm" variant="secondary" onClick={() => setSelectedIds((current) => new Set([...current, ...filtered.map((lead) => lead.id)]))}>
              Select all {filtered.length} {hasMore ? 'loaded ' : ''}matching leads
            </Button>}
          {selectedMatchingCount === filtered.length && filtered.length > visibleRows.length && <span className="text-xs text-muted-foreground">All loaded matching leads selected{hasMore ? '; load older leads to include more' : ''}.</span>}
          <Button size="sm" variant="outline" disabled={retryDiscovering || retryRunning} onClick={handleBulkRetry}>
            <RefreshCw className={`mr-1 h-3.5 w-3.5 ${retryDiscovering ? 'animate-spin' : ''}`} /> {retryDiscovering ? 'Finding failures…' : 'Retry failed'}
          </Button>
          {isAdmin && <Button size="sm" variant="outline" onClick={pushSelectedToUniversities}><Zap className="mr-1 h-3.5 w-3.5" /> Push to universities</Button>}
          <Button size="sm" variant="outline" onClick={() => downloadCSV(leads.filter((lead) => selectedIds.has(lead.id)), isAdmin ? 'selected-leads.csv' : 'selected-leads-masked.csv', !isAdmin)}><Download className="mr-1 h-3.5 w-3.5" /> {isAdmin ? 'Download selected' : 'Download selected masked'}</Button>
          {isAdmin && <Button size="sm" variant="destructive" disabled={selectedIds.size > 100} onClick={() => requestDelete([...selectedIds])}><Trash2 className="mr-1 h-3.5 w-3.5" /> Delete selected{selectedIds.size > 100 ? ' (max 100)' : ''}</Button>}
          <Button size="sm" variant="ghost" onClick={() => setSelectedIds(new Set())}>Clear selection</Button>
        </div>}

        <div className="overflow-x-auto">
          {loading ? <div className="flex items-center justify-center py-16 text-sm text-muted-foreground"><Loader2 className="mr-2 h-5 w-5 animate-spin" /> Loading leads...</div> :
          <Table className="min-w-[1600px] text-base">
            <TableHeader><TableRow className="table-header">
              <TableHead className="w-10"><Checkbox aria-label="Select all leads shown on this page" checked={visibleRows.length > 0 && visibleRows.every((lead) => selectedIds.has(lead.id))} onCheckedChange={toggleAll} /></TableHead>
              {sortHeader('Name','name')}
              <TableHead>Email</TableHead>
              <TableHead>Mobile</TableHead>
              <TableHead>State</TableHead>
              <TableHead>City</TableHead>
              {sortHeader('Source','source')}
              <TableHead>Medium</TableHead>
              <TableHead>Campaign</TableHead>
              {sortHeader('Received','receivedAt')}
              <TableHead>Delivery</TableHead>
              <TableHead className="w-24">History</TableHead>
              <TableHead className="w-28 text-right">Actions</TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {grouped.length === 0 ? <TableRow><TableCell colSpan={13} className="py-16 text-center text-muted-foreground">
                <Inbox className="mx-auto mb-3 h-8 w-8 opacity-40" /><p className="font-medium text-foreground">No matching leads</p><p className="mt-1 text-sm">Try another filter or refresh to check new enquiries.</p>
              </TableCell></TableRow> : pageGroups.flatMap(({ key, items, latest, firstAt }) =>
                (expanded.has(key) ? items : [latest]).map((lead, index) => <TableRow key={lead.id} className={index > 0 ? 'bg-muted/20' : 'hover:bg-muted/30'}>
                  <TableCell><Checkbox aria-label={`Select ${lead.name || lead.email || 'lead'}`} checked={selectedIds.has(lead.id)} onCheckedChange={() => toggleSelect(lead.id)} /></TableCell>
                  <TableCell className="align-top"><button type="button" onClick={() => setDetailLead(lead)} className="text-left font-semibold text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{lead.name || 'Unnamed lead'}</button></TableCell>
                  <TableCell className="max-w-[220px] truncate align-top text-base" title={lead.email}>{lead.email || '-'}</TableCell>
                  <TableCell className="whitespace-nowrap align-top text-base tabular-nums">{lead.mobile || '-'}</TableCell>
                  <TableCell className="max-w-[150px] truncate align-top text-base" title={leadState(lead)}>{leadState(lead) || '-'}</TableCell>
                  <TableCell className="max-w-[150px] truncate align-top text-base" title={lead.city}>{lead.city || '-'}</TableCell>
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
                    {isAdmin && <Button variant="ghost" size="icon" className="h-9 w-9 text-destructive" aria-label={`Delete submission for ${lead.name || 'lead'}`} onClick={() => requestDelete([lead.id])}><Trash2 className="h-4 w-4" /></Button>}</div></TableCell>
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
                  ].map(([label,value]) => detailField(detailLead,String(label),value))}</dl>
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
                {isAdmin && <Button variant="destructive" className="w-full" onClick={() => requestDelete([detailLead.id])}>
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
