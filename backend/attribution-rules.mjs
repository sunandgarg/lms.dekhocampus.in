import { executeRecords } from './records.mjs';

export function applyAttributionRules(lead, leadData, rules) {
  for (const rule of Array.isArray(rules) ? rules : []) {
    if (!rule || rule.enabled === false) continue;
    if (!['source', 'medium', 'campaign'].some((field) => String(rule.match?.[field] || '').trim())) continue;
    if (!['source', 'medium', 'campaign'].some((field) => String(rule.set?.[field] || '').trim())) continue;
    if (!['source', 'medium', 'campaign'].every((field) =>
      !String(rule.match?.[field] || '').trim() ||
      String(field === 'medium' ? leadData.leadMedium : lead[field] || '').trim().toLowerCase() === String(rule.match[field]).trim().toLowerCase())) continue;
    for (const field of ['source', 'medium', 'campaign']) {
      const value = String(rule.set?.[field] || '').trim();
      if (!value) continue;
      if (field === 'medium') leadData.leadMedium = value;
      else lead[field] = value;
    }
    leadData.leadSource = lead.source;
    leadData.leadCampaign = lead.campaign;
    break;
  }
  return { lead, leadData };
}

export async function applySavedAttributionRules(db, lead, leadData) {
  const { data } = await executeRecords(db, { table: 'app_settings', select: 'value',
    filters: [{ field: 'key', op: 'eq', value: 'lead_attribution_rules' }], single: true });
  if (!data?.value) return { lead, leadData };
  try { return applyAttributionRules(lead, leadData, JSON.parse(data.value)); }
  catch { return { lead, leadData }; }
}
