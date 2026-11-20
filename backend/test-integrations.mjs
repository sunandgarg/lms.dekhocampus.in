import { randomUUID } from 'node:crypto';
import { archiveAndDeliver } from './archive.mjs';
import { buildPayload, categorizeResponse } from './lead-payload.mjs';
import { validPartnerUrl } from './lead-processor.mjs';

function nested(value, path) {
  return String(path || '').split('.').reduce((current, key) => current?.[key], value);
}

function template(value, fields) {
  if (Array.isArray(value)) return value.map((entry) => template(entry, fields));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, template(entry, fields)]));
  const match = typeof value === 'string' && /^\{\{\s*([^}]+)\s*\}\}$/.exec(value);
  return match ? fields[match[1].trim()] ?? value : value;
}

async function sendTest(url, method, headers, body, seconds = 30) {
  validPartnerUrl(url);
  const response = await fetch(url, { method, headers, body: ['GET', 'HEAD'].includes(method) ? undefined : JSON.stringify(body),
    redirect: 'error', signal: AbortSignal.timeout(Math.min(60, Math.max(5, Number(seconds) || 30)) * 1000) });
  const text = (await response.text()).slice(0, 64_000);
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: response.status, ok: response.ok, text, parsed };
}

export async function testApi(input, { s3, bucket } = {}) {
  if (!s3 || !bucket) throw new Error('Test transaction archive is not configured');
  const sample = { name: 'Test Lead', email: `test_${Date.now()}@test.invalid`, mobile: '9999999999',
    state: 'Test State', city: 'Test City', course: 'Test Course', specialization: 'Test Specialization' };
  const provided = input.leadData;
  if (provided && (typeof provided !== 'object' || Array.isArray(provided) ||
      JSON.stringify(provided).length > 100_000 || Object.values(provided).some((value) => typeof value !== 'string'))) {
    throw Object.assign(new Error('Invalid test lead data'), { status: 400 });
  }
  const lead = provided || sample;
  const config = { apiUrl: input.apiUrl, secretKey: input.secretKey || '', collegeId: input.collegeId || '',
    source: input.source || '', medium: input.medium || '', campaign: input.campaign || '',
    apiType: input.apiType || 'generic', columnMapping: input.columnMapping || {},
    customHeaders: input.customHeaders || {}, authType: input.authType,
    authHeaderKey: input.authHeaderKey, authHeaderValue: input.authHeaderValue };
  const { payload, headers } = buildPayload(lead, config);
  const body = input.payloadWrapper === 'array' ? [payload] : payload;
  const archiveId = randomUUID();
  const response = await archiveAndDeliver({ s3, bucket, batchId: archiveId,
    input: { leadData: lead, outbound: { url: input.apiUrl, method: 'POST', headers, body }, apiConfig: config },
    deliver: () => sendTest(input.apiUrl, 'POST', headers, body, input.apiTimeoutSeconds),
  });
  const status = categorizeResponse(response.status, response.text, response.ok);
  const message = String(response.parsed?.message || response.parsed?.Message || '').slice(0, 500);
  const credentialsRejected = /college id|secret|authentication|unauthorized|invalid key|forbidden/i.test(message);
  const dataRejected = /already exist|duplicate|invalid email|invalid mobile|required field/i.test(message);
  const isConfigValid = !credentialsRejected && (status === 'Success' || status === 'Duplicate' || dataRejected);
  return { isConfigValid, status, errorMessage: isConfigValid ? (dataRejected ? `Config valid; ${message}` : '') : message || `Partner returned HTTP ${response.status}`,
    httpStatus: response.status, response: response.text, archiveId };
}

export async function testCustomIntegration(input) {
  const method = String(input.method || 'POST').toUpperCase();
  if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH'].includes(method)) throw Object.assign(new Error('Unsupported method'), { status: 400 });
  const headers = { 'Content-Type': 'application/json', ...(input.headers || {}) };
  const auth = input.authConfig || {};
  if (input.authType === 'bearer' && auth.apiKey) headers.Authorization = `Bearer ${auth.apiKey}`;
  if (input.authType === 'basic' && auth.username) headers.Authorization = `Basic ${Buffer.from(`${auth.username}:${auth.password || ''}`).toString('base64')}`;
  if (input.authType === 'api_key' && auth.headerName) headers[auth.headerName] = auth.apiKey;
  if (input.authType === 'custom' && auth.customKey) headers[auth.customKey] = auth.customValue;
  const body = template(input.requestBodyTemplate || {}, input.testPayload || {});
  const response = await sendTest(input.baseUrl, method, headers, body);
  const success = input.responseSuccessPath
    ? [true, 1, 'success', 'Success'].includes(nested(response.parsed, input.responseSuccessPath))
    : response.ok;
  const value = input.responseMessagePath ? nested(response.parsed, input.responseMessagePath) : null;
  return { success, message: value == null ? success ? 'API call successful' : `HTTP ${response.status}` : String(value),
    httpStatus: response.status, response: response.parsed };
}
