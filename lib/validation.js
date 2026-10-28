export const importOrder = ['stock', 'hr_staff', 'hr_leave', 'hr_availability', 'crm'];

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
  }
}

function requireValue(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new ValidationError(`${label} is required`);
  return value.trim();
}

function requireDate(value, label) {
  requireValue(value, label);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`)) ||
      new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) {
    throw new ValidationError(`${label} must be a valid YYYY-MM-DD date`);
  }
  return value;
}

function requireTimestamp(value, label) {
  requireValue(value, label);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?\+08:00$/.test(value) || Number.isNaN(Date.parse(value))) {
    throw new ValidationError(`${label} must be a valid Singapore-time timestamp with +08:00 offset`);
  }
  return value;
}

function requireNumber(value, label, { positive = false, integer = false } = {}) {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number) || (positive ? number <= 0 : number < 0) || (integer && !Number.isInteger(number))) {
    throw new ValidationError(`${label} must be ${positive ? 'positive' : 'non-negative'}${integer ? ' whole' : ''} number`);
  }
  return number;
}

function requireArray(value, label) {
  if (!Array.isArray(value) || !value.length) throw new ValidationError(`${label} must be a non-empty array`);
  return value;
}

function unique(records, key, label) {
  const seen = new Set();
  for (const record of records) {
    const value = key(record);
    if (seen.has(value)) throw new ValidationError(`Duplicate ${label}: ${value}`);
    seen.add(value);
  }
}

function parseJson(text, label) {
  try { return JSON.parse(text); }
  catch { throw new ValidationError(`${label} is not valid JSON`); }
}

function validateHrEnvelope(data, kind) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new ValidationError(`${kind} must be a JSON object`);
  const sourceSystem = requireValue(data.source_system, 'source_system');
  const exportId = requireValue(data.export_id, 'export_id');
  const exportedAt = requireTimestamp(data.exported_at, 'exported_at');
  const effectiveMonth = requireValue(data.effective_month, 'effective_month');
  if (!/^\d{4}-\d{2}$/.test(effectiveMonth)) throw new ValidationError('effective_month must be YYYY-MM');
  const records = requireArray(data.records, 'records');
  return { sourceSystem, exportId, records, metadata: { exported_at: exportedAt, effective_month: effectiveMonth } };
}

function validateStock(text, references) {
  const data = requireArray(parseJson(text, 'Stock count'), 'Stock count');
  const known = new Set(references.products_and_recipes.recipes.map((row) => row.ingredient_id));
  const records = data.map((row, index) => {
    const tag = `Stock row ${index + 1}`;
    const ingredientId = requireValue(row.ingredient_id, `${tag} ingredient_id`);
    if (!known.has(ingredientId)) throw new ValidationError(`${tag} has unknown ingredient_id ${ingredientId}`);
    return {
      ingredient_id: ingredientId,
      name: requireValue(row.name, `${tag} name`),
      unit: requireValue(row.unit, `${tag} unit`),
      on_hand: requireNumber(row.on_hand, `${tag} on_hand`),
      committed: requireNumber(row.committed, `${tag} committed`),
      pack_size: requireNumber(row.pack_size, `${tag} pack_size`, { positive: true }),
      pack_name: requireValue(row.pack_name, `${tag} pack_name`),
      checked_at: requireTimestamp(row.checked_at, `${tag} checked_at`),
    };
  });
  unique(records, (row) => row.ingredient_id, 'ingredient_id');
  for (const ingredientId of known) if (!records.some((row) => row.ingredient_id === ingredientId)) {
    throw new ValidationError(`Stock count is missing ingredient ${ingredientId}`);
  }
  const checkedAt = records[0].checked_at;
  if (records.some((row) => row.checked_at !== checkedAt)) throw new ValidationError('All stock rows must share one checked_at time');
  return { records, identityKey: `stock:${checkedAt}`, sourceSystem: 'Physical stock count', exportId: null,
    metadata: { checked_at: checkedAt }, recordKey: (row) => row.ingredient_id };
}

function validateStaff(text) {
  const envelope = validateHrEnvelope(parseJson(text, 'HR staff master'), 'HR staff master');
  const records = envelope.records.map((row, index) => {
    const tag = `Staff row ${index + 1}`;
    const employmentType = requireValue(row.employment_type, `${tag} employment_type`);
    if (!['Permanent', 'Part-time'].includes(employmentType)) throw new ValidationError(`${tag} employment_type must be Permanent or Part-time`);
    const skills = requireArray(row.skills, `${tag} skills`).map((skill) => requireValue(skill, `${tag} skill`));
    return { id: requireValue(row.id, `${tag} id`), name: requireValue(row.name, `${tag} name`),
      employment_type: employmentType, role: requireValue(row.role, `${tag} role`), skills };
  });
  unique(records, (row) => row.id, 'staff id');
  return { records, identityKey: `hr_staff:${envelope.exportId}`, sourceSystem: envelope.sourceSystem,
    exportId: envelope.exportId, metadata: envelope.metadata, recordKey: (row) => row.id };
}

function validateLeave(text, current) {
  const envelope = validateHrEnvelope(parseJson(text, 'HR leave'), 'HR leave');
  const staff = new Set(current.hr_staff.map((row) => row.id));
  const records = envelope.records.map((row, index) => {
    const tag = `Leave row ${index + 1}`;
    const staffId = requireValue(row.staff_id, `${tag} staff_id`);
    if (!staff.has(staffId)) throw new ValidationError(`${tag} refers to unknown staff ${staffId}`);
    const status = requireValue(row.status, `${tag} status`);
    if (!['Approved', 'Pending', 'Rejected', 'Denied'].includes(status)) throw new ValidationError(`${tag} has invalid status ${status}`);
    return { id: requireValue(row.id, `${tag} id`), staff_id: staffId,
      date: requireDate(row.date, `${tag} date`), status, reason: requireValue(row.reason, `${tag} reason`) };
  });
  unique(records, (row) => row.id, 'leave id');
  return { records, identityKey: `hr_leave:${envelope.exportId}`, sourceSystem: envelope.sourceSystem,
    exportId: envelope.exportId, metadata: envelope.metadata, recordKey: (row) => row.id };
}

function validateAvailability(text, current) {
  const envelope = validateHrEnvelope(parseJson(text, 'HR availability'), 'HR availability');
  const staff = new Map(current.hr_staff.map((row) => [row.id, row]));
  const records = envelope.records.map((row, index) => {
    const tag = `Availability row ${index + 1}`;
    const staffId = requireValue(row.staff_id, `${tag} staff_id`);
    if (!staff.has(staffId)) throw new ValidationError(`${tag} refers to unknown staff ${staffId}`);
    if (staff.get(staffId).employment_type !== 'Part-time') throw new ValidationError(`${tag} staff ${staffId} is not part-time`);
    const date = requireDate(row.date, `${tag} date`);
    const start = requireValue(row.start, `${tag} start`);
    const end = requireValue(row.end, `${tag} end`);
    if (!/^\d{2}:\d{2}$/.test(start) || !/^\d{2}:\d{2}$/.test(end)) throw new ValidationError(`${tag} start/end must be HH:MM`);
    const minutes = (value) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
    if (minutes(start) >= minutes(end) || minutes(end) > 24 * 60) throw new ValidationError(`${tag} has invalid shift times`);
    const status = requireValue(row.status, `${tag} status`);
    if (!['Confirmed', 'Pending', 'Unavailable'].includes(status)) throw new ValidationError(`${tag} has invalid status ${status}`);
    if (status === 'Confirmed' && minutes(end) - minutes(start) !== 240) throw new ValidationError(`${tag} confirmed shift must be four hours`);
    return { staff_id: staffId, date, start, end, status };
  });
  unique(records, (row) => `${row.staff_id}:${row.date}`, 'staff/date availability');
  return { records, identityKey: `hr_availability:${envelope.exportId}`, sourceSystem: envelope.sourceSystem,
    exportId: envelope.exportId, metadata: envelope.metadata,
    recordKey: (row) => `${row.staff_id}:${row.date}` };
}

const crmColumns = ['export_id', 'exported_at', 'export_status', 'id', 'production_date', 'customer', 'product_id', 'quantity', 'status', 'received_at'];

function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') { field += '"'; index += 1; }
      else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"' && field === '') quoted = true;
    else if (char === ',') { row.push(field); field = ''; }
    else if (char === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (char !== '\r') field += char;
  }
  if (quoted) throw new ValidationError('CRM CSV has an unclosed quoted field');
  if (row.length || field) { row.push(field); rows.push(row); }
  return rows;
}

function validateCrm(text, references) {
  const rows = parseCsv(text.replace(/^\uFEFF/, ''));
  if (rows.length < 2) throw new ValidationError('CRM CSV must contain a header and order rows');
  const columns = rows.shift();
  if (columns.length !== crmColumns.length || new Set(columns).size !== columns.length ||
      crmColumns.some((column) => !columns.includes(column))) {
    throw new ValidationError(`CRM CSV columns must be: ${crmColumns.join(', ')}`);
  }
  const known = new Set(references.products_and_recipes.products.map((row) => row.id));
  const records = rows.map((values, index) => {
    if (values.length !== columns.length) throw new ValidationError(`CRM row ${index + 2} has ${values.length} columns; expected ${columns.length}`);
    const row = Object.fromEntries(columns.map((column, col) => [column, values[col]]));
    const tag = `CRM row ${index + 2}`;
    const productId = requireValue(row.product_id, `${tag} product_id`);
    if (!known.has(productId)) throw new ValidationError(`${tag} has unknown product_id ${productId}`);
    const status = requireValue(row.status, `${tag} status`);
    if (!['Confirmed', 'Cancelled', 'Pending'].includes(status)) throw new ValidationError(`${tag} has invalid status ${status}`);
    return { export_id: requireValue(row.export_id, `${tag} export_id`),
      exported_at: requireTimestamp(row.exported_at, `${tag} exported_at`),
      export_status: requireValue(row.export_status, `${tag} export_status`),
      id: requireValue(row.id, `${tag} id`), production_date: requireDate(row.production_date, `${tag} production_date`),
      customer: requireValue(row.customer, `${tag} customer`), product_id: productId,
      quantity: requireNumber(row.quantity, `${tag} quantity`, { positive: true, integer: true }),
      status, received_at: requireTimestamp(row.received_at, `${tag} received_at`) };
  });
  unique(records, (row) => row.id, 'order id');
  const first = records[0];
  if (records.some((row) => row.export_id !== first.export_id || row.exported_at !== first.exported_at || row.export_status !== first.export_status)) {
    throw new ValidationError('All CRM rows must share one export ID, export time, and export status');
  }
  return { records, identityKey: `crm:${first.export_id}`, sourceSystem: 'CRM', exportId: first.export_id,
    metadata: { exported_at: first.exported_at, export_status: first.export_status }, recordKey: (row) => row.id };
}

export function validateImport(kind, text, references, current = {}) {
  if (!importOrder.includes(kind)) throw new ValidationError('Unknown import kind');
  if (!references.scenario || !references.products_and_recipes || !references.supplier) {
    throw new ValidationError('Reference data has not been seeded');
  }
  if (kind === 'stock') return validateStock(text, references);
  if (kind === 'hr_staff') return validateStaff(text);
  if (kind === 'hr_leave') return validateLeave(text, current);
  if (kind === 'hr_availability') return validateAvailability(text, current);
  return validateCrm(text, references);
}
