import { executeRecords } from './records.mjs';

const FIELDS = { City: 'city', State: 'state', Course: 'course', Specialization: 'specialization',
  Source: 'source', 'Campaign Name': 'campaign', Mobile: 'mobile', Email: 'email' };

export function matchesConditions(lead, conditions) {
  if (!Array.isArray(conditions) || !conditions.length) return false;
  let result = false;
  for (let i = 0; i < conditions.length; i++) {
    const item = conditions[i];
    const field = FIELDS[item.field] || String(item.field || '').toLowerCase();
    const value = String(lead[field] || '').toLowerCase();
    const target = String(item.value || '').toLowerCase();
    const matched = item.field === 'Any Field is Empty'
      ? Object.values(lead).some((entry) => !String(entry || '').trim())
      : item.operator === 'is' ? value === target
        : item.operator === 'is not' ? value !== target
          : item.operator === 'contains' ? value.includes(target)
            : item.operator === 'does not contain' ? !value.includes(target)
              : item.operator === 'starts with' ? value.startsWith(target)
                : item.operator === 'is empty' ? !value.trim()
                  : item.operator === 'is not empty' ? Boolean(value.trim()) : false;
    result = i === 0 ? matched : item.logic === 'OR' ? result || matched : result && matched;
  }
  return result;
}

export async function applyAutomation(db, lead) {
  const { data: rules } = await executeRecords(db, { table: 'automation_rules', select: '*',
    filters: [{ field: 'status', op: 'eq', value: 'Active' }],
    order: [{ field: 'priority', ascending: true }], limit: 100 });
  for (const rule of rules) {
    if (!matchesConditions(lead, rule.conditions)) continue;
    const updated = { ...lead };
    for (const action of rule.actions || []) {
      if (action.type === 'set_default' && action.field && action.value && !updated[action.field]?.trim()) {
        updated[action.field] = String(action.value);
      }
    }
    await db.execute("UPDATE lms_records SET data = JSON_SET(data, '$.triggered_count', COALESCE(CAST(JSON_UNQUOTE(JSON_EXTRACT(data, '$.triggered_count')) AS UNSIGNED), 0) + 1, '$.last_triggered_at', ?) WHERE collection = 'automation_rules' AND id = ?",
      [new Date().toISOString(), rule.id]);
    return { lead: updated, rule };
  }
  return { lead, rule: null };
}

export async function recordAutomation(db, rule, lead, result, universityName) {
  if (!rule) return;
  const field = result.status === 'Success' ? 'success_count' : 'fail_count';
  await db.execute(`UPDATE lms_records SET data = JSON_SET(data, '$.${field}', COALESCE(CAST(JSON_UNQUOTE(JSON_EXTRACT(data, '$.${field}')) AS UNSIGNED), 0) + 1) WHERE collection = 'automation_rules' AND id = ?`, [rule.id]);
  await executeRecords(db, { table: 'automation_logs', action: 'insert', values: {
    rule_id: rule.id, lead_name: lead.name, rule_name: rule.name,
    university_name: universityName || '', result: result.status,
    fail_reason: result.status === 'Fail' ? String(result.response || '').slice(0, 200) : '',
    lead_data: lead,
  } });
}
