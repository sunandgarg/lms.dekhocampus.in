export const GLA_ONLINE_ENDPOINT = 'https://glawebapi.glaonline.com/api/ChannelPartner/CPRegistrationOnline_API';

function required(value, label) {
  const text = String(value || '').trim();
  if (!text) throw Object.assign(new Error(`GLA Online requires ${label}`), { status: 400 });
  return text;
}

function dateOfBirth(value) {
  const raw = required(value, 'DOB');
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  const result = iso ? `${iso[3]}/${iso[2]}/${iso[1]}` : raw;
  if (!/^\d{2}\/\d{2}\/\d{4}$/.test(result)) {
    throw Object.assign(new Error('GLA Online DOB must be DD/MM/YYYY or YYYY-MM-DD'), { status: 400 });
  }
  const [day, month, year] = result.split('/').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCDate() !== day || date.getUTCMonth() !== month - 1 || date.getUTCFullYear() !== year) {
    throw Object.assign(new Error('GLA Online DOB is not a valid date'), { status: 400 });
  }
  return result;
}

function programCode(lead) {
  const explicit = String(lead.ProgramCode || lead.programCode || lead.program_code || '').trim();
  if (explicit) return explicit;
  const course = String(lead.course || lead.Course || '').trim().toUpperCase();
  const specialization = String(lead.specialization || lead.Specialization || '').trim().toLowerCase().replace(/[^a-z]/g, '');
  if (course === 'MBA' && ['humanresourcemanagement', 'hr', 'hrm'].includes(specialization)) return 'OGLAMBA202';
  if (course === 'MCA') return 'OGLAMCA201';
  throw Object.assign(new Error('GLA Online requires a supported ProgramCode; MBA Human Resource Management uses OGLAMBA202'), { status: 400 });
}

export function glaOnlinePayload(lead, source = 'dekho_campus') {
  const mobile = required(lead.mobile || lead.Mobile, 'Mobile').replace(/\D/g, '').slice(-10);
  if (!/^[6-9]\d{9}$/.test(mobile)) throw Object.assign(new Error('GLA Online requires a valid 10-digit mobile'), { status: 400 });
  const email = required(lead.email || lead.EmailId, 'EmailId');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw Object.assign(new Error('GLA Online requires a valid email'), { status: 400 });
  const cityCode = String(lead.glaCityCode || lead.cityCode || (/^\d+$/.test(String(lead.City || '')) ? lead.City : '') || '0').trim();
  if (!/^\d+$/.test(cityCode)) throw Object.assign(new Error('GLA Online City must be a numeric code'), { status: 400 });
  return {
    Name: required(lead.name || lead.Name, 'Name'), DOB: dateOfBirth(lead.dob || lead.DOB),
    EmailId: email, Mobile: mobile, ProgramCode: programCode(lead),
    source: String(source || 'dekho_campus').trim(), City: cityCode,
  };
}

export function glaOnlineRequest(apiUrl, payload) {
  const endpoint = new URL(apiUrl);
  if (endpoint.origin !== new URL(GLA_ONLINE_ENDPOINT).origin || endpoint.pathname !== new URL(GLA_ONLINE_ENDPOINT).pathname || endpoint.search) {
    throw Object.assign(new Error('GLA Online requires the official registration endpoint without test-lead query parameters'), { status: 400 });
  }
  for (const [key, value] of Object.entries(payload)) endpoint.searchParams.set(key, value);
  return { url: endpoint.toString(), method: 'GET', headers: {}, body: null };
}
