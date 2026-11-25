const SAFE_FIELD = /^[\w.-]{1,100}$/;
const SAFE_TARGET = /^[^\x00-\x1f]{1,100}$/;
const RESERVED = new Set(['college_id', '__proto__', 'prototype', 'constructor']);
export function sensitivePartnerField(name) {
  const normalized = String(name || '').toLowerCase();
  return RESERVED.has(normalized) || /key|secret|token|password|authorization/.test(normalized);
}

function targetForMappingEntry(key, value) {
  if (key.startsWith('__static_')) return key.slice(9);
  if (!key.startsWith('__field_')) return '';
  try { return String(JSON.parse(value)?.fieldName || ''); } catch { return ''; }
}

export function redactPartnerMapping(mapping) {
  const clean = { ...(mapping || {}) };
  for (const [key, value] of Object.entries(clean)) {
    if (!sensitivePartnerField(targetForMappingEntry(key, value))) continue;
    if (key.startsWith('__static_')) clean[key] = '';
    else {
      try { clean[key] = JSON.stringify({ ...JSON.parse(value), staticValue: '' }); }
      catch { delete clean[key]; }
    }
  }
  return clean;
}

export function mergePartnerMapping(stored, supplied) {
  const result = Object.keys(supplied || {}).length ? { ...supplied } : { ...(stored || {}) };
  for (const [key, value] of Object.entries(stored || {})) {
    if (sensitivePartnerField(targetForMappingEntry(key, value))) result[key] = value;
  }
  return result;
}

function readPath(source, path) {
  return String(path).split('.').reduce((value, part) => {
    if (!value || typeof value !== 'object') return undefined;
    const key = Object.keys(value).find((item) => item.toLowerCase() === part.toLowerCase());
    return key ? value[key] : undefined;
  }, source);
}

function fieldDefinitions(mapping) {
  const fields = new Map();
  for (const [key, value] of Object.entries(mapping || {})) {
    if (!key.startsWith('__field_')) continue;
    try {
      const config = typeof value === 'string' ? JSON.parse(value) : value;
      const name = String(config?.fieldName || '').trim();
      if (SAFE_TARGET.test(name) && !sensitivePartnerField(name)) fields.set(name, { key, config });
    } catch { /* Skip an invalid saved partner field. */ }
  }
  if (fields.size) return fields;
  for (const [key, value] of Object.entries(mapping || {})) {
    const name = key.startsWith('__static_') ? key.slice(9) : value;
    if (key.startsWith('__') && !key.startsWith('__static_')) continue;
    if (typeof name === 'string' && SAFE_TARGET.test(name) && !sensitivePartnerField(name)) {
      fields.set(name, { key: '', config: { fieldName: name, sourceType: key.startsWith('__static_') ? 'static' : 'lead_data', sourceKey: key } });
    }
  }
  return fields;
}

export function applyInboundFieldOverrides(leadData, payload, university, settings, { retry = false } = {}) {
  let mapping = university?.column_mapping || {};
  if (typeof mapping === 'string') {
    try { mapping = JSON.parse(mapping); } catch { mapping = {}; }
  }
  if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) mapping = {};
  const fields = fieldDefinitions(mapping);
  if (!settings || typeof settings !== 'object' || !fields.size) return null;
  const raw = payload?.lead && typeof payload.lead === 'object' ? payload.lead : payload;
  const defaults = Array.isArray(settings.defaults) ? settings.defaults.slice(0, 50) : [];
  const fixed = Array.isArray(settings.fixed) ? settings.fixed.slice(0, 50) : [];
  const sources = Array.isArray(settings.sources) ? settings.sources.slice(0, 50) : [];
  const transforms = Array.isArray(settings.transforms) ? settings.transforms.slice(0, 50) : [];
  const retryValues = retry && Array.isArray(settings.retry) ? settings.retry.slice(0, 50) : [];
  const nextMapping = { ...mapping };
  let changed = false;

  for (const [target, definition] of fields) {
    const source = sources.find((item) => item?.targetField === target && SAFE_FIELD.test(item.sourceField || ''));
    const sourceKey = source?.sourceField || definition.config.sourceKey || target;
    if (source && definition.key) {
      nextMapping[definition.key] = JSON.stringify({ ...definition.config, sourceType: 'lead_data', sourceKey });
      changed = true;
    }
    const transform = transforms.find((item) => item?.targetField === target && SAFE_FIELD.test(item.sourceField || '') &&
      typeof item.equals === 'string' && typeof item.value === 'string' && item.value.trim() &&
      String(readPath(leadData, item.sourceField) ?? readPath(raw, item.sourceField) ?? '').trim().toLowerCase() === item.equals.trim().toLowerCase());
    const fallback = defaults.find((item) => item?.targetField === target && typeof item.value === 'string' && item.value.trim());
    const always = fixed.find((item) => item?.targetField === target && typeof item.value === 'string' && item.value.trim());
    const retryValue = retryValues.find((item) => item?.targetField === target && typeof item.value === 'string' && item.value.trim());
    const existing = readPath(leadData, sourceKey);
    const value = retryValue?.value || always?.value || transform?.value ||
      (existing == null || String(existing).trim() === '' || !source && definition.config.sourceType === 'static' ? fallback?.value : '');
    if (!value || value.length > 1000) continue;
    if (definition.key) nextMapping[definition.key] = JSON.stringify({ ...definition.config, sourceType: 'static', staticValue: value });
    else nextMapping[`__static_${target}`] = value;
    changed = true;
  }
  return changed ? { columnMapping: nextMapping } : null;
}
