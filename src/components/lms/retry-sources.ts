interface SelectedLead {
  id: string;
  isInbound?: boolean;
  status: string;
  deliveries: { id: string; fail_count?: number; status: string }[];
}

export function retrySources(selected: SelectedLead[], onlyBatchId?: string) {
  return {
    directIds: onlyBatchId ? [] : selected.filter((lead) => !lead.isInbound && lead.status === 'Failed').map((lead) => lead.id),
    batchIds: onlyBatchId ? [onlyBatchId] : [...new Set(selected.filter((lead) => lead.isInbound)
      .flatMap((lead) => lead.deliveries.filter((batch) => Number(batch.fail_count || 0) > 0 || batch.status === 'failed')
        .map((batch) => batch.id)))],
  };
}
