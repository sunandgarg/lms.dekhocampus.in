import { randomBytes, randomUUID } from 'node:crypto';
import collections from './collections.json' with { type: 'json' };
import relations from './relations.json' with { type: 'json' };

const MAX_ROWS = 1000;
const MAX_WRITE_ROWS = 500;
const MAX_FILTERS = 20;

function bad(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

export function checkField(table, field) {
  if (!collections[table]) throw bad('Unknown collection');
  if (!collections[table].includes(field)) throw bad(`Unknown ${table} field: ${field}`);
  return field;
}

function expression(table, field) {
  checkField(table, field);
  if (field === 'id') return 'id';
  if (field === 'created_at' || field === 'updated_at') return field;
  const indexed = { university_id: 'record_university_id', batch_id: 'record_batch_id',
    user_id: 'record_user_id', status: 'record_status', email: 'record_email', mobile: 'record_mobile' }[field];
  if (indexed) return indexed;
  if (['sort_order', 'step_order', 'priority', 'lead_score', 'retry_count', 'clicks'].includes(field)) {
    return `CAST(JSON_UNQUOTE(JSON_EXTRACT(data, '$.${field}')) AS DECIMAL(20,4))`;
  }
  return `JSON_UNQUOTE(JSON_EXTRACT(data, '$.${field}'))`;
}

function condition(table, filter, params) {
  if (!filter || typeof filter !== 'object') throw bad('Invalid filter');
  const { field, op, value } = filter;
  const expr = expression(table, field);
  if (op === 'is') {
    if (value === null) return `${expr} IS NULL`;
    params.push(String(Boolean(value)));
    return `${expr} = ?`;
  }
  if (op === 'in' || (op === 'not' && filter.innerOp === 'in')) {
    const list = Array.isArray(value) ? value : String(value || '').replace(/^\(|\)$/g, '').split(',');
    if (list.length > MAX_ROWS) throw bad('Filter list is too long');
    if (!list.length) return op === 'not' ? '1=1' : '1=0';
    params.push(...list.map(String));
    return `${expr} ${op === 'not' ? 'NOT ' : ''}IN (${list.map(() => '?').join(',')})`;
  }
  if (op === 'contains') {
    params.push(JSON.stringify(value));
    return `JSON_CONTAINS(JSON_EXTRACT(data, '$.${field}'), CAST(? AS JSON))`;
  }
  if (op === 'or') throw bad('Nested OR is unsupported');
  const sqlOp = { eq: '=', neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=', like: 'LIKE', ilike: 'LIKE' }[op];
  if (!sqlOp) {
    if (op === 'not' && filter.innerOp === 'is' && value === null) return `${expr} IS NOT NULL`;
    if (op === 'not' && filter.innerOp === 'like') {
      params.push(String(value));
      return `${expr} NOT LIKE ?`;
    }
    throw bad(`Unsupported filter: ${op}`);
  }
  if (value === null && op === 'eq') return `${expr} IS NULL`;
  if (value === null && op === 'neq') return `${expr} IS NOT NULL`;
  params.push(typeof value === 'boolean' ? String(value) : value);
  return `${op === 'ilike' ? `LOWER(${expr})` : expr} ${sqlOp} ?`;
}

function parseOr(table, raw, params) {
  if (typeof raw !== 'string' || raw.length > 1000) throw bad('Invalid OR filter');
  const parts = raw.split(',');
  if (parts.length > MAX_FILTERS) throw bad('Too many OR conditions');
  return `(${parts.map((part) => {
    const match = /^([a-z_]+)\.(eq|ilike|like)\.(.*)$/.exec(part);
    if (!match) throw bad('Invalid OR condition');
    return condition(table, { field: match[1], op: match[2], value: match[3] }, params);
  }).join(' OR ')})`;
}

export function whereClause(query, params) {
  const { table, filters = [], or = [] } = query;
  if (!collections[table]) throw bad('Unknown collection');
  if (!Array.isArray(filters) || filters.length > MAX_FILTERS || !Array.isArray(or) || or.length > 3) throw bad('Too many filters');
  const pieces = ['collection = ?'];
  params.push(table);
  for (const filter of filters) pieces.push(condition(table, filter, params));
  for (const group of or) pieces.push(parseOr(table, group, params));
  return `WHERE ${pieces.join(' AND ')}`;
}

function splitSelect(select) {
  const result = [];
  let depth = 0;
  let current = '';
  for (const char of String(select || '*')) {
    if (char === '(') depth++;
    if (char === ')') depth--;
    if (depth < 0 || depth > 1) throw bad('Invalid select');
    if (char === ',' && depth === 0) {
      result.push(current.trim());
      current = '';
    } else current += char;
  }
  if (depth) throw bad('Invalid select');
  result.push(current.trim());
  return result;
}

function parseSelect(table, select) {
  const parts = splitSelect(select);
  const fields = [];
  const joins = [];
  for (const part of parts) {
    if (part === '*') { fields.push('*'); continue; }
    const join = /^([a-z_]+)\((\*|[a-z_, ]+)\)$/.exec(part);
    if (join) {
      const relation = (relations[table] || []).find((item) => item.table === join[1]);
      if (!relation) throw bad('Unknown relationship');
      const columns = join[2] === '*' ? ['*'] : join[2].split(',').map((x) => checkField(join[1], x.trim()));
      joins.push({ ...relation, columns });
      continue;
    }
    fields.push(checkField(table, part));
  }
  return { fields, joins };
}

function project(row, fields) {
  if (fields.includes('*')) return { ...row };
  return Object.fromEntries(fields.map((field) => [field, row[field]]));
}

async function attachRelations(db, table, rows, joins) {
  for (const join of joins) {
    const ids = [...new Set(rows.map((row) => row[join.column]).filter(Boolean))];
    if (!ids.length) continue;
    const placeholders = ids.map(() => '?').join(',');
    const expr = expression(join.table, join.referencedColumn);
    const [found] = await db.execute(
      `SELECT data FROM lms_records WHERE collection = ? AND ${expr} IN (${placeholders})`,
      [join.table, ...ids],
    );
    const byId = new Map(found.map(({ data }) => [data[join.referencedColumn], data]));
    for (const row of rows) {
      const target = byId.get(row[join.column]);
      row[join.table] = target ? project(target, join.columns) : null;
    }
  }
}

function cleanRow(table, item, existing = null) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) throw bad('Invalid row');
  const row = { ...(existing || {}) };
  for (const [field, value] of Object.entries(item)) {
    checkField(table, field);
    row[field] = value;
  }
  row.id ||= randomUUID();
  if (table === 'university_api_keys' && !existing) {
    row.api_key ||= `dc_${randomBytes(24).toString('base64url')}`;
    row.is_active ??= true;
    row.request_count ??= 0;
  }
  if (table === 'custom_domains' && !existing) {
    row.verification_token ||= randomBytes(24).toString('hex');
    row.status ||= 'pending';
  }
  if (table === 'url_api_keys' && !existing) {
    row.is_active ??= true;
    row.requests_today ??= 0;
  }
  if (collections[table].includes('created_at')) row.created_at ||= new Date().toISOString();
  if (collections[table].includes('updated_at')) row.updated_at = new Date().toISOString();
  if (JSON.stringify(row).length > 1_000_000) throw bad('Row is too large');
  return row;
}

async function matching(db, query) {
  const params = [];
  const where = whereClause(query, params);
  const [rows] = await db.execute(`SELECT id, data FROM lms_records ${where} LIMIT ${MAX_WRITE_ROWS + 1}`, params);
  if (rows.length > MAX_WRITE_ROWS) throw bad('Write would affect too many rows');
  return rows;
}

export async function executeRecords(db, query) {
  if (!query || !collections[query.table]) throw bad('Unknown collection');
  const action = query.action || 'select';
  if (action === 'delete' && ['upload_batches', 'leads', 'inbound_leads', 'api_logs'].includes(query.table)) {
    const error = new Error('Lead history is retained so batch ZIP reports remain available');
    error.status = 403;
    throw error;
  }
  const { fields, joins } = parseSelect(query.table, query.select || '*');
  if (action === 'select') {
    const params = [];
    const where = whereClause(query, params);
    let count = null;
    if (query.count === 'exact') {
      const [countRows] = await db.execute(`SELECT COUNT(*) AS total FROM lms_records ${where}`, params);
      count = Number(countRows[0].total);
    }
    if (query.head) return { data: null, count };
    const sorts = Array.isArray(query.order) ? query.order.slice(0, 3) : [];
    const order = sorts.length ? `ORDER BY ${sorts.map(({ field, ascending }) => `${expression(query.table, field)} ${ascending === false ? 'DESC' : 'ASC'}`).join(', ')}` : 'ORDER BY created_at DESC';
    const offset = Math.max(0, Math.min(Number(query.offset) || 0, 100000));
    const limit = Math.max(1, Math.min(Number(query.limit) || MAX_ROWS, MAX_ROWS));
    const [found] = await db.execute(`SELECT data FROM lms_records ${where} ${order} LIMIT ? OFFSET ?`, [...params, limit, offset]);
    const all = found.map(({ data }) => data);
    await attachRelations(db, query.table, all, joins);
    const data = all.map((row) => project(row, fields));
    return { data: query.single ? data[0] || null : data, count };
  }

  if (action === 'insert' || action === 'upsert') {
    const items = Array.isArray(query.values) ? query.values : [query.values];
    if (!items.length || items.length > MAX_WRITE_ROWS) throw bad('Invalid batch size');
    const inserted = [];
    for (const item of items) {
      let existing = null;
      if (action === 'upsert' && query.upsertOptions?.onConflict) {
        const conflictFields = String(query.upsertOptions.onConflict).split(',').map((field) => checkField(query.table, field.trim()));
        if (conflictFields.length > 3 || conflictFields.some((field) => item?.[field] == null)) throw bad('Invalid conflict fields');
        const params = [];
        const where = whereClause({ table: query.table, filters: conflictFields.map((field) => ({ field, op: 'eq', value: item[field] })) }, params);
        const [matches] = await db.execute(`SELECT data FROM lms_records ${where} LIMIT 1`, params);
        existing = matches[0]?.data || null;
        if (existing && query.upsertOptions.ignoreDuplicates) continue;
      }
      const row = cleanRow(query.table, item, existing);
      const sql = action === 'upsert'
        ? 'INSERT INTO lms_records (collection, id, data) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE data = VALUES(data)'
        : 'INSERT INTO lms_records (collection, id, data) VALUES (?, ?, ?)';
      await db.execute(sql, [query.table, row.id, JSON.stringify(row)]);
      inserted.push(project(row, fields));
    }
    return { data: query.returnRows ? (query.single ? inserted[0] : inserted) : null, count: null };
  }

  if (action === 'update' || action === 'delete') {
    if (!query.filters?.length && !query.or?.length) throw bad('Bulk write requires a filter');
    const found = await matching(db, query);
    const changed = [];
    for (const item of found) {
      if (action === 'delete') {
        await db.execute('DELETE FROM lms_records WHERE collection = ? AND id = ?', [query.table, item.id]);
        changed.push(project(item.data, fields));
      } else {
        const row = cleanRow(query.table, query.values, item.data);
        if (row.id !== item.id) throw bad('Cannot change row ID');
        await db.execute('UPDATE lms_records SET data = ? WHERE collection = ? AND id = ?', [JSON.stringify(row), query.table, item.id]);
        changed.push(project(row, fields));
      }
    }
    return { data: query.returnRows ? (query.single ? changed[0] || null : changed) : null, count: null };
  }
  throw bad('Unsupported record action');
}
