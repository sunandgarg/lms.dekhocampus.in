export interface LeadDelivery {
  id: string;
  status: string;
  isInbound?: boolean;
  success_count?: number;
  duplicate_count?: number;
  fail_count?: number;
  error_message?: string;
  universities?: { name?: string };
}

export function deliveryResult(batch: LeadDelivery): 'Pushed' | 'Duplicate' | 'Failed' | 'Pending' {
  if (Number(batch.success_count) > 0) return 'Pushed';
  if (Number(batch.duplicate_count) > 0) return 'Duplicate';
  if (Number(batch.fail_count) > 0 || ['failed', 'cancelled', 'paused', 'completed'].includes(String(batch.status).toLowerCase())) return 'Failed';
  return 'Pending';
}

export function summarizeDeliveries(history: { deliveries: LeadDelivery[] }[]) {
  // History is newest first; each university contributes only its latest delivery.
  const byUniversity = new Map<string, LeadDelivery>();
  for (const lead of history) for (const batch of lead.deliveries) {
    const key = batch.universities?.name || batch.id;
    if (!byUniversity.has(key)) byUniversity.set(key, batch);
  }
  const deliveries = [...byUniversity.values()];
  return {
    deliveries,
    pushed: deliveries.filter((batch) => deliveryResult(batch) === 'Pushed').length,
    notPushed: deliveries.filter((batch) => ['Failed', 'Duplicate'].includes(deliveryResult(batch))).length,
    pending: deliveries.filter((batch) => deliveryResult(batch) === 'Pending').length,
  };
}
