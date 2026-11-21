import { executeRecords } from './records.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OPERATORS = new Set(['is', 'is_not', 'contains', 'not_contains', 'starts_with', 'is_empty', 'is_not_empty']);

function pathValue(source, path) {
  return String(path).split('.').reduce((current, part) => {
    if (!current || typeof current !== 'object') return undefined;
    const key = Object.keys(current).find((name) => name.toLowerCase() === part.toLowerCase());
    return key ? current[key] : undefined;
  }, source);
}

export function matchesInboundRule(rule, lead, payload) {
  const conditions = rule.conditions;
  if (!Array.isArray(conditions) || conditions.length === 0) return true;
  const raw = payload?.lead && typeof payload.lead === 'object' ? payload.lead : payload;
  const checks = conditions.map((condition) => {
    if (!condition || typeof condition.field !== 'string' ||
        !/^[\w.-]{1,100}$/.test(condition.field) || !OPERATORS.has(condition.operator)) return false;
    const found = pathValue(lead, condition.field) ?? pathValue(raw, condition.field);
    const value = found == null || typeof found === 'object' ? '' : String(found).trim().toLowerCase();
    const target = String(condition.value || '').trim().toLowerCase();
    if (!['is_empty', 'is_not_empty'].includes(condition.operator) && !target) return false;
    switch (condition.operator) {
      case 'is': return value === target;
      case 'is_not': return value !== target;
      case 'contains': return value.includes(target);
      case 'not_contains': return !value.includes(target);
      case 'starts_with': return value.startsWith(target);
      case 'is_empty': return !value;
      case 'is_not_empty': return Boolean(value);
    }
  });
  return rule.match_mode === 'any' ? checks.some(Boolean) : checks.every(Boolean);
}

export async function matchingInboundRules(db, lead, payload) {
  const { data: rules } = await executeRecords(db, { table: 'inbound_routing_rules', select: '*',
    filters: [{ field: 'status', op: 'eq', value: 'Active' }],
    order: [{ field: 'priority', ascending: true }], limit: 100 });
  return rules.filter((rule) => matchesInboundRule(rule, lead, payload) &&
    Array.isArray(rule.destination_ids) && rule.destination_ids.some((id) => UUID.test(id)));
}
