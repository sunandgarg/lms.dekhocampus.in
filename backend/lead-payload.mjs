// Partner payload mapping retained from the existing lead processor.
function buildPayload(leadData, apiConfig) {
    const headers = { "Content-Type": "application/json" };
    const columnMapping = normalizeStringRecord(apiConfig.columnMapping);
    const customHeaders = normalizeStringRecord(apiConfig.customHeaders);
    const customColumnMapping = normalizeStringRecord(apiConfig.customColumnMapping);
    const universityDefaults = normalizeStringRecord(apiConfig.universityDefaults);
    if (apiConfig.authType === "bearer" && apiConfig.authHeaderValue) {
        headers["Authorization"] = `Bearer ${apiConfig.authHeaderValue}`;
    }
    else if (apiConfig.authType === "custom_header" && apiConfig.authHeaderKey && apiConfig.authHeaderValue) {
        headers[apiConfig.authHeaderKey] = apiConfig.authHeaderValue;
    }
    if (customHeaders) {
        Object.entries(customHeaders).forEach(([key, value]) => {
            if (key && value)
                headers[key] = value;
        });
    }
    const payloadFields = [];
    const staticFields = {};
    const fixedDefaults = {};
    const fieldMappings = {};
    Object.entries(columnMapping).forEach(([key, value]) => {
        if (key.startsWith("__field_")) {
            const field = parsePayloadFieldConfig(value);
            if (field)
                payloadFields.push(field);
        }
        else if (key.startsWith("__static_")) {
            staticFields[key.replace("__static_", "")] = value;
        }
        else if (key.startsWith("__fixed_")) {
            fixedDefaults[key.replace("__fixed_", "")] = value;
        }
        else {
            fieldMappings[key] = value;
        }
    });
    Object.entries(customColumnMapping).forEach(([key, value]) => {
        if (value)
            fieldMappings[key] = value;
    });
    payloadFields.sort((a, b) => a.sortOrder - b.sortOrder);
    const leadDataWithDefaults = { ...leadData };
    Object.entries(fixedDefaults).forEach(([key, defaultValue]) => {
        if (!leadDataWithDefaults[key] || !leadDataWithDefaults[key].trim()) {
            leadDataWithDefaults[key] = defaultValue;
        }
    });
    Object.entries(universityDefaults).forEach(([key, defaultValue]) => {
        if (defaultValue && (!leadDataWithDefaults[key] || !leadDataWithDefaults[key].trim())) {
            leadDataWithDefaults[key] = defaultValue;
        }
    });
    // The source lead stays untouched for the inbox and archives; only partner payloads use ten digits.
    const tenDigitMobile = (value, label) => {
        const digits = String(value).replace(/\D/g, "");
        if (digits.length < 10) throw Object.assign(new Error(`Invalid mobile number in ${label}: need at least 10 digits`), { status: 400 });
        return digits.slice(-10);
    };
    for (const [key, value] of Object.entries(staticFields)) {
        if (value && /mobile|phone(?:.?number)?/i.test(key) && !/code/i.test(key))
            staticFields[key] = tenDigitMobile(value, key);
    }
    for (const key of ["mobile", "phone.number", "phone", "phone_number", "mobile_number", "contact_number"]) {
        if (!leadDataWithDefaults[key]) continue;
        leadDataWithDefaults[key] = tenDigitMobile(leadDataWithDefaults[key], key);
    }
    for (const [source, target] of Object.entries(fieldMappings)) {
        if (leadDataWithDefaults[source] && /mobile|phone(?:.?number)?/i.test(target) && !/code/i.test(target))
            leadDataWithDefaults[source] = tenDigitMobile(leadDataWithDefaults[source], source);
    }
    let payload;
    if (apiConfig.apiType === "upgrad") {
        const src = leadDataWithDefaults.leadSource || apiConfig.source || "";
        const med = leadDataWithDefaults.leadMedium || apiConfig.medium || "";
        const camp = leadDataWithDefaults.leadCampaign || apiConfig.campaign || "";
        if (src)
            headers["utm_source"] = src;
        if (med)
            headers["utm_medium"] = med;
        if (camp)
            headers["utm_campaign"] = camp;
        const sk = (apiConfig.secretKey || "").trim();
        if (sk) {
            if (sk.toLowerCase().startsWith("basic "))
                headers["Authorization"] = sk;
            else if (sk.includes(":"))
                headers["Authorization"] = `Basic ${btoa(sk)}`;
            else
                headers["Authorization"] = `Basic ${sk}`;
        }
        const upgradSrcMap = {};
        const upgradMeta = {};
        Object.entries(columnMapping).forEach(([k, v]) => {
            if (k.startsWith("__upgrad_src_") && v)
                upgradSrcMap[k.replace("__upgrad_src_", "")] = v;
            else if (k.startsWith("__upgrad_meta_") && v)
                upgradMeta[k.replace("__upgrad_meta_", "")] = v;
        });
        const readField = (upgradField, fallbackCsv) => {
            const aliasMap = {
                mobile: ["phone.number", "mobile"],
                course: ["course", "programOfInterest"],
                firstname: ["firstname", "name"],
                lastname: ["lastname"],
            };
            const csvKey = upgradSrcMap[upgradField] || fallbackCsv;
            const candidates = [csvKey, upgradField, ...(aliasMap[upgradField] || []), fallbackCsv];
            for (const candidate of candidates) {
                const value = leadDataWithDefaults[candidate];
                if (value)
                    return value;
            }
            return "";
        };
        const fullName = (leadDataWithDefaults.name || "").trim();
        const nameParts = fullName.split(/\s+/).filter(Boolean);
        const firstname = (readField("firstname", "firstname") || nameParts.shift() || "Lead").trim();
        const lastname = (readField("lastname", "lastname") || nameParts.join(" ") || firstname).trim();
        const rawMobileInput = (readField("mobile", "phone.number") || "").trim();
        let phoneCode = (leadDataWithDefaults["phone.code"] || leadDataWithDefaults["phone.countryCode"] || "+91").trim() || "+91";
        let phoneNumber = rawMobileInput.replace(/\D/g, "");
        const plusMatch = rawMobileInput.match(/^\+(\d{1,3})/);
        if (plusMatch) {
            phoneCode = `+${plusMatch[1]}`;
            phoneNumber = phoneNumber.slice(plusMatch[1].length);
        }
        else if (phoneNumber.length === 12 && phoneNumber.startsWith("91")) {
            phoneNumber = phoneNumber.slice(2);
        }
        else if (phoneNumber.length === 11 && phoneNumber.startsWith("0")) {
            phoneNumber = phoneNumber.slice(1);
        }
        const upPayload = {
            firstname,
            lastname,
            email: readField("email", "email"),
            phone: { number: phoneNumber, code: phoneCode },
            course: readField("course", "course"),
            sendWelcomeMail: false,
            city: readField("city", "city"),
            state: readField("state", "state"),
            country: leadDataWithDefaults.country || upgradMeta.country || "India",
            isDetectLocation: false,
            affiliateSource: leadDataWithDefaults.affiliateSource || upgradMeta.affiliateSource || "aff_id=1&sub_aff_id=12",
            leadSource: {
                platform: leadDataWithDefaults["leadSource.platform"] || "",
                platformSection: leadDataWithDefaults["leadSource.platformSection"] || "",
            },
            extraFields: {
                chatLink: leadDataWithDefaults["extraFields.chatLink"] || upgradMeta.chatLink || "haptik.com/1234567",
            },
            emailTemplateSuffix: leadDataWithDefaults.emailTemplateSuffix || upgradMeta.emailTemplateSuffix || "in",
        };
        Object.entries(staticFields).forEach(([k, v]) => {
            if (!v)
                return;
            if (k === "extraFields.LSQID")
                return;
            if (k.includes(".")) {
                const segments = k.split(".");
                let cursor = upPayload;
                for (let i = 0; i < segments.length - 1; i++) {
                    const seg = segments[i];
                    if (typeof cursor[seg] !== "object" || cursor[seg] === null)
                        cursor[seg] = {};
                    cursor = cursor[seg];
                }
                cursor[segments[segments.length - 1]] = v;
            }
            else {
                upPayload[k] = v;
            }
        });
        payload = upPayload;
    }
    else if (payloadFields.length > 0) {
        const formPayload = {};
        const manualAcademicFieldKeys = new Set(["campus", "course", "specialization", "specialisation", "program"]);
        const payloadFieldKeys = new Set(payloadFields
            .flatMap((field) => [field.fieldName, field.sourceKey, field.displayName])
            .filter(Boolean)
            .map((field) => String(field).trim().toLowerCase()));
        payloadFields.forEach((field) => {
            if (!field.fieldName)
                return;
            let value = "";
            if (field.sourceType === "lead_data") {
                // Legacy university configurations sometimes saved an empty sourceKey.
                // Falling back to fieldName keeps those configurations usable and makes
                // the generated sample/mapping behavior consistent with the payload.
                const sourceKey = field.sourceKey?.trim() || field.fieldName;
                value = readLeadValue(leadDataWithDefaults, field.fieldName, sourceKey, field.displayName);
            }
            else if (field.sourceType === "static") {
                value = field.staticValue || "";
            }
            else if (field.sourceType === "dynamic") {
                switch (field.dynamicType) {
                    case "source":
                        value = leadDataWithDefaults.leadSource || apiConfig.source;
                        break;
                    case "medium":
                        value = leadDataWithDefaults.leadMedium || apiConfig.medium;
                        break;
                    case "campaign":
                        value = leadDataWithDefaults.leadCampaign || apiConfig.campaign;
                        break;
                    case "college_id":
                        value = apiConfig.collegeId;
                        break;
                    case "secret_key":
                        value = apiConfig.secretKey;
                        break;
                }
            }
            if (value || field.isRequired)
                formPayload[field.fieldName] = value && /mobile|phone(?:.?number)?/i.test(field.fieldName)
                    && !/code/i.test(field.fieldName) ? tenDigitMobile(value, field.fieldName) : value;
        });
        Object.entries(leadDataWithDefaults).forEach(([key, value]) => {
            if (value && !["leadSource", "leadMedium", "leadCampaign"].includes(key)) {
                if (isMappedCanonicalDuplicate(key, value, formPayload, payloadFields))
                    return;
                // Preserve a manual CSV target even when it is not present as a key in
                // the university's saved mapping (for example, Campus vs campus).
                const normalizedKey = key.trim().toLowerCase();
                const apiKey = fieldMappings[key] ||
                    (payloadFieldKeys.has(normalizedKey) || manualAcademicFieldKeys.has(normalizedKey) ? key : "");
                if (apiKey && !formPayload[apiKey])
                    formPayload[apiKey] = value;
            }
        });
        Object.entries(staticFields).forEach(([key, value]) => {
            if (value && !formPayload[key])
                formPayload[key] = value;
        });
        if (apiConfig.apiType === "meritto" || apiConfig.apiType === "nopaperforms") {
            normalizeMerittoNoPaperFormsPayload(formPayload, apiConfig);
        }
        if (apiConfig.apiType === "leadsquared") {
            normalizeLeadSquaredTrackingFields(formPayload);
            ensureLeadSquaredTrackingFields(formPayload, apiConfig);
            payload = buildLeadSquaredAttributePayload(formPayload);
        }
        else {
            payload = formPayload;
        }
    }
    else if (apiConfig.apiType === "leadsquared") {
        const lsPayload = {};
        Object.entries(leadDataWithDefaults).filter(([_, v]) => v).forEach(([key, value]) => {
            lsPayload[fieldMappings[key] || key] = value;
        });
        Object.entries(staticFields).forEach(([key, value]) => { if (value)
            lsPayload[key] = value; });
        normalizeLeadSquaredTrackingFields(lsPayload);
        ensureLeadSquaredTrackingFields(lsPayload, apiConfig);
        payload = buildLeadSquaredAttributePayload(lsPayload);
    }
    else if (apiConfig.apiType === "meritto" || apiConfig.apiType === "nopaperforms") {
        const formData = {};
        Object.entries(leadDataWithDefaults).forEach(([key, value]) => {
            if (value)
                formData[fieldMappings[key] || key] = value;
        });
        formData[fieldMappings["medium"] || "medium"] = leadDataWithDefaults.leadMedium || apiConfig.medium;
        formData[fieldMappings["campaign"] || "campaign"] = leadDataWithDefaults.leadCampaign || apiConfig.campaign;
        formData.college_id = apiConfig.collegeId;
        formData[fieldMappings["source"] || "source"] = leadDataWithDefaults.leadSource || apiConfig.source;
        formData.secret_key = apiConfig.secretKey;
        Object.entries(staticFields).forEach(([key, value]) => { formData[key] = value; });
        normalizeMerittoNoPaperFormsPayload(formData, apiConfig);
        payload = formData;
    }
    else {
        const genericPayload = {};
        const hasSourceMapping = Object.keys(apiConfig.columnMapping).some((k) => k === "leadSource" || k === "source");
        const hasMediumMapping = Object.keys(apiConfig.columnMapping).some((k) => k === "leadMedium" || k === "medium");
        const hasCampaignMapping = Object.keys(apiConfig.columnMapping).some((k) => k === "leadCampaign" || k === "campaign");
        Object.entries(leadDataWithDefaults).forEach(([key, value]) => {
            if (value && !["leadSource", "leadMedium", "leadCampaign"].includes(key)) {
                genericPayload[fieldMappings[key] || key] = value;
            }
        });
        if (hasSourceMapping) {
            const v = leadDataWithDefaults.leadSource || apiConfig.source;
            if (v)
                genericPayload[fieldMappings["leadSource"] || fieldMappings["source"] || "source"] = v;
        }
        if (hasMediumMapping) {
            const v = leadDataWithDefaults.leadMedium || apiConfig.medium;
            if (v)
                genericPayload[fieldMappings["leadMedium"] || fieldMappings["medium"] || "medium"] = v;
        }
        if (hasCampaignMapping) {
            const v = leadDataWithDefaults.leadCampaign || apiConfig.campaign;
            if (v)
                genericPayload[fieldMappings["leadCampaign"] || fieldMappings["campaign"] || "campaign"] = v;
        }
        if (apiConfig.collegeId)
            genericPayload.college_id = apiConfig.collegeId;
        if (apiConfig.secretKey)
            genericPayload.secret_key = apiConfig.secretKey;
        Object.entries(staticFields).forEach(([key, value]) => { if (value)
            genericPayload[key] = value; });
        payload = genericPayload;
    }
    if (apiConfig.apiType === "leadsquared" && !Array.isArray(payload)) {
        const flat = payload;
        normalizeLeadSquaredTrackingFields(flat);
        ensureLeadSquaredTrackingFields(flat, apiConfig);
        payload = buildLeadSquaredAttributePayload(flat);
    }
    else {
        payload = normalizeCustomUiPublisherPayload(payload, apiConfig.apiUrl);
    }
    if (apiConfig.apiType === "leadsquared") {
        headers["Content-Type"] = "application/json";
    }
    return { payload: normalizeAmityExternalPartnerPayload(payload, apiConfig.apiUrl), headers };
}
function normalizeStringRecord(value) {
    const parsed = parseJsonLike(value, {});
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        return {};
    return Object.fromEntries(Object.entries(parsed)
        .filter(([key]) => Boolean(key))
        .map(([key, entryValue]) => [key, typeof entryValue === "string" ? entryValue : JSON.stringify(entryValue ?? "")]));
}
function parseJsonLike(value, fallback) {
    if (typeof value === "string") {
        try {
            return JSON.parse(value);
        }
        catch {
            return fallback;
        }
    }
    return value ?? fallback;
}
function parsePayloadFieldConfig(value) {
    const parsed = parseJsonLike(value, value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        return null;
    const fieldName = String(parsed.fieldName ?? "").trim();
    const displayName = String(parsed.displayName ?? fieldName).trim();
    const sourceType = parsed.sourceType === "static" || parsed.sourceType === "dynamic" || parsed.sourceType === "lead_data"
        ? parsed.sourceType
        : "lead_data";
    if (!fieldName)
        return null;
    return {
        fieldName,
        displayName,
        sourceType,
        sourceKey: String(parsed.sourceKey ?? "").trim() || undefined,
        staticValue: String(parsed.staticValue ?? "").trim() || undefined,
        dynamicType: parsed.dynamicType,
        isRequired: Boolean(parsed.isRequired),
        sortOrder: Number(parsed.sortOrder) || 0,
    };
}
function readLeadValue(leadData, ...candidates) {
    const seen = new Set();
    const expanded = candidates
        .filter(Boolean)
        .flatMap((candidate) => aliasesForField(candidate))
        .filter((candidate) => {
        if (seen.has(candidate))
            return false;
        seen.add(candidate);
        return true;
    });
    for (const candidate of expanded) {
        const value = leadData[candidate];
        if (value !== undefined && value !== null && String(value).trim() !== "")
            return String(value);
    }
    return "";
}
function aliasesForField(field) {
    const normalized = String(field || "").trim().toLowerCase();
    if (["specialisation", "specialization"].includes(normalized))
        return FIELD_ALIASES.specialization;
    if (["program", "field_program", "programname", "program_name"].includes(normalized))
        return FIELD_ALIASES.program;
    if (normalized === "course")
        return FIELD_ALIASES.course;
    if (normalized === "campus")
        return FIELD_ALIASES.campus;
    return [field].filter(Boolean);
}
const FIELD_ALIASES = {
    campus: ["campus", "Campus"],
    course: ["course", "Course"],
    program: ["program", "Program", "field_program", "programName", "program_name"],
    specialization: ["specialization", "Specialization", "Specialisation", "specialisation", "specializationName", "specialization_name"],
};
function normalizeMerittoNoPaperFormsPayload(payload, apiConfig) {
    if (apiConfig.collegeId)
        payload.college_id = apiConfig.collegeId;
    if (apiConfig.secretKey)
        payload.secret_key = apiConfig.secretKey;
    addFirstAvailableAlias(payload, FIELD_ALIASES.campus);
    canonicalizeField(payload, "course", ["Course"]);
    canonicalizeField(payload, "specialization", [
        "Specialization",
        "Specialisation",
        "specialisation",
        "specializationName",
        "specialization_name",
    ]);
}
function addFirstAvailableAlias(payload, aliases) {
    const existingValue = aliases
        .map((key) => payload[key])
        .find((value) => value !== undefined && value !== null && String(value).trim() !== "");
    if (!existingValue)
        return;
    aliases.forEach((key) => {
        if (!payload[key] || !String(payload[key]).trim()) {
            payload[key] = String(existingValue);
        }
    });
}
function canonicalizeField(payload, canonicalKey, aliases) {
    const existingValue = [canonicalKey, ...aliases]
        .map((key) => payload[key])
        .find((value) => value !== undefined && value !== null && String(value).trim() !== "");
    if (existingValue !== undefined && existingValue !== null) {
        payload[canonicalKey] = String(existingValue);
    }
    aliases.forEach((key) => {
        if (key !== canonicalKey)
            delete payload[key];
    });
}
function normalizeLeadSquaredTrackingFields(payload) {
    const sourceValue = payload.leadSource || payload.source || "";
    const mediumValue = payload.leadMedium || payload.medium || "";
    const campaignValue = payload.leadCampaign || payload.campaign || "";
    delete payload.source;
    delete payload.medium;
    delete payload.campaign;
    if (sourceValue)
        payload.leadSource = sourceValue;
    if (mediumValue)
        payload.leadMedium = mediumValue;
    if (campaignValue)
        payload.leadCampaign = campaignValue;
}
function ensureLeadSquaredTrackingFields(payload, apiConfig) {
    if (!payload.leadSource && apiConfig.source)
        payload.leadSource = apiConfig.source;
    if (!payload.leadMedium && apiConfig.medium)
        payload.leadMedium = apiConfig.medium;
    if (!payload.leadCampaign && apiConfig.campaign)
        payload.leadCampaign = apiConfig.campaign;
}
function buildLeadSquaredAttributePayload(payload) {
    const preferredOrder = [
        "FirstName",
        "EmailAddress",
        "Phone",
        "mx_State",
        "mx_City",
        "mx_Course",
        "leadSource",
        "leadMedium",
        "leadCampaign",
    ];
    const orderIndex = new Map(preferredOrder.map((key, index) => [key, index]));
    return Object.entries(payload)
        .filter(([_, value]) => value !== undefined && value !== null && String(value).trim() !== "")
        .sort(([left], [right]) => {
        const leftIndex = orderIndex.has(left) ? orderIndex.get(left) : preferredOrder.length;
        const rightIndex = orderIndex.has(right) ? orderIndex.get(right) : preferredOrder.length;
        return leftIndex === rightIndex ? 0 : leftIndex - rightIndex;
    })
        .map(([key, value]) => ({ Attribute: key, Value: String(value) }));
}
function normalizeCustomUiPublisherPayload(payload, apiUrl) {
    if (!isLeadSquaredCustomUiPublisher(apiUrl) || Array.isArray(payload) || !payload || typeof payload !== "object") {
        return payload;
    }
    const normalized = { ...payload };
    addAcademicFieldAliases(normalized);
    return normalized;
}
function isLeadSquaredCustomUiPublisher(apiUrl) {
    return String(apiUrl || "").toLowerCase().includes("customui.leadsquared.com");
}
function addAcademicFieldAliases(payload) {
    addFirstAvailableAlias(payload, FIELD_ALIASES.campus);
    addFirstAvailableAlias(payload, FIELD_ALIASES.course);
    addFirstAvailableAlias(payload, FIELD_ALIASES.specialization);
}
export function isMappedCanonicalDuplicate(key, value, payload, fields) {
    if (!["name", "email", "mobile", "course"].includes(key))
        return false;
    return fields.some((field) => {
        const target = field.fieldName.toLowerCase().replace(/[^a-z0-9]/g, "");
        return field.sourceType === "lead_data" && field.fieldName !== key &&
            (target.includes(key) || (key === "mobile" && target.includes("phone"))) &&
            payload[field.fieldName] === value;
    });
}
export function normalizeAmityExternalPartnerPayload(payload, apiUrl) {
    let url;
    try {
        url = new URL(apiUrl);
    }
    catch {
        return payload;
    }
    if (url.hostname !== "portal.amity.edu" ||
        url.pathname.toLowerCase() !== "/onlineform/api/v1/externalpartner/create-profile" ||
        !payload || typeof payload !== "object" || Array.isArray(payload))
        return payload;
    const record = payload;
    return { ...record, isInterNational: record.isInterNational === true || record.isInterNational === "true" };
}
export { buildPayload };

function categorizeResponse(httpStatus, responseBody, isHttpOk) {
    const rs = responseBody.toLowerCase();
    const isDuplicate = rs.includes("duplicate") || rs.includes("already exist") || rs.includes("already registered") ||
        rs.includes("already present") || rs.includes("record exists") || rs.includes("lead already") ||
        rs.includes("entry already") || rs.includes("email already") || rs.includes("mobile already") ||
        rs.includes("phone already") || rs.includes("contact already");
    if (httpStatus === 409 || isDuplicate) {
        return "Duplicate";
    }
    if (isHttpOk && isProfileCreatedResponse(responseBody))
        return "Success";
    if (isHttpOk) {
        try {
            const jr = JSON.parse(responseBody);
            const errCode = String(jr.errorCode || jr.error_code || "").toLowerCase();
            const jrStatus = String(jr.status || jr.Status || "").toLowerCase();
            const leadSquaredIsCreated = jr?.Message && typeof jr.Message === "object" && "IsCreated" in jr.Message
                ? jr.Message.IsCreated
                : jr.IsCreated;
            // LeadSquared: IsCreated=true is a new lead; false is an accepted
            // existing/secondary lead and should not be shown as a hard failure.
            if (leadSquaredIsCreated === false) {
                return "Duplicate";
            }
            if (leadSquaredIsCreated === true) {
                return "Success";
            }
            if (errCode === "duplicate" || jrStatus === "duplicate") {
                return "Duplicate";
            }
            const errMsg = String(jr.error || jr.message || jr.Message || "").toLowerCase();
            if (errMsg.includes("duplicate") || errMsg.includes("already exist") || errMsg.includes("already registered") ||
                errMsg.includes("email already") || errMsg.includes("mobile already")) {
                return "Duplicate";
            }
            // Check isLeadExists / leadAlreadyExists - if lead already exists, treat as Duplicate
            if (jr.isLeadExists === true || jr.leadAlreadyExists === true) {
                return "Duplicate";
            }
            // upGrad: firstByUser=false means lead already existed → Duplicate
            if (jr.firstByUser === false) {
                return "Duplicate";
            }
            // upGrad Lead-Drop returns a leadIdentifier on success (HTTP 2xx) with firstByUser=true
            if (jr.leadIdentifier || jr.lead_identifier || jr.leadId) {
                return "Success";
            }
            const numericStatus = Number(jr.status ?? jr.Status ?? jr.statusCode ?? jr.code);
            if (!isNaN(numericStatus) && numericStatus >= 200 && numericStatus < 300) {
                return "Success";
            }
            const msgLower = String(jr.message || jr.Message || "").toLowerCase();
            if (msgLower.includes("submitted successfully") ||
                msgLower.includes("submitted succesfully") ||
                msgLower.includes("success") ||
                msgLower === "data submitted") {
                return "Success";
            }
            if (jrStatus === "success" || jr.status === true || jr.status === 1 ||
                jr.success === true || jr.success === 1 ||
                jr.result === true || jr.result === 1 ||
                String(jr.result || jr.Result || "").toLowerCase() === "success" || jr.message === "1") {
                return "Success";
            }
            if (jrStatus === "fail" || jrStatus === "failed" || jr.success === false || jr.error) {
                return "Fail";
            }
            return "Fail";
        }
        catch {
            // Some partner APIs return a plain success token instead of JSON.
            const plain = responseBody.trim().toLowerCase().replace(/^['"]|['"]$/g, "");
            if (["1", "true", "success", "ok"].includes(plain))
                return "Success";
            return "Fail";
        }
    }
    return "Fail";
}
export function isProfileCreatedResponse(body) {
    let response;
    try {
        response = JSON.parse(body);
    }
    catch {
        response = body;
    }
    const message = typeof response === "string"
        ? response
        : response && typeof response === "object" && !Array.isArray(response)
            ? response.message ?? response.Message
            : null;
    return typeof message === "string" && message.trim().toLowerCase() === "profile created successfully!!";
}
export { categorizeResponse };
