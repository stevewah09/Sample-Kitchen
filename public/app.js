const kinds = [
  ['stock', '1. Stock count', 'current_inventory.json', '.json'],
  ['hr_staff', '2. HR staff master', 'HR_Staff_Master_2026-11.json', '.json'],
  ['hr_leave', '3. HR leave', 'HR_Leave_2026-11.json', '.json'],
  ['hr_availability', '4. HR part-time availability', 'HR_Part_Time_Availability_2026-11.json', '.json'],
  ['crm', '5. CRM orders', 'CRM_Weekly_Sales_Orders_2026-10-28.csv', '.csv'],
];
const byId = (id) => document.getElementById(id);
const element = (tag, value) => { const node = document.createElement(tag); if (value !== undefined) node.textContent = String(value); return node; };
const dateTime = (value) => value ? new Intl.DateTimeFormat('en-SG', { timeZone: 'Asia/Singapore', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : '—';

function table(target, columns, rows) {
  const host = byId(target);
  host.replaceChildren();
  if (!rows.length) { host.append(element('p', 'None.')); return; }
  const output = element('table'), head = element('thead'), header = element('tr'), body = element('tbody');
  for (const [label] of columns) header.append(element('th', label));
  head.append(header);
  for (const row of rows) {
    const tr = element('tr');
    for (const [, value] of columns) tr.append(element('td', value(row)));
    body.append(tr);
  }
  output.append(head, body);
  host.append(output);
}

function renderImports(imports, connected) {
  const host = byId('import-grid');
  host.replaceChildren();
  kinds.forEach(([kind, title, filename, accept], index) => {
    const batch = imports[kind];
    const card = element('article'); card.className = 'import-item';
    card.append(element('h3', title));
    card.append(element('p', batch ? `${batch.source_system || 'Stock count'} · ${batch.export_id || batch.source_metadata?.checked_at || 'no export ID'}` : 'Not imported'));
    if (batch) card.append(element('p', `${batch.record_count} records · ${dateTime(batch.imported_at)} · ${batch.source_filename}`));
    const form = element('form');
    const label = element('label', `Choose ${filename}`); label.htmlFor = `file-${kind}`;
    const file = element('input'); file.type = 'file'; file.name = 'file'; file.id = label.htmlFor; file.accept = accept; file.required = true;
    const button = element('button', batch ? 'Import updated file' : 'Import file'); button.type = 'submit';
    button.disabled = file.disabled = !connected || (index > 0 && !imports[kinds[index - 1][0]]);
    const message = element('p'); message.setAttribute('role', 'status');
    form.append(label, file, button, message); card.append(form); host.append(card);
    form.addEventListener('submit', async (event) => {
      event.preventDefault(); button.disabled = true; message.className = ''; message.textContent = 'Validating and saving…';
      try {
        const payload = new FormData(form); payload.set('kind', kind);
        const response = await fetch('/api/import', { method: 'POST', body: payload });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || 'Import failed');
        const notice = result.status === 'already_imported'
          ? `Already imported ${result.record_count} records; no duplicates added.`
          : `Saved ${result.record_count} records at ${dateTime(result.imported_at)}.`;
        await refresh(notice);
      } catch (error) { message.textContent = error.message; message.className = 'error'; button.disabled = false; }
    });
  });
}

function renderPlan(plan) {
  if (plan?.status !== 'ready') {
    byId('plan-content').hidden = true; byId('agents-section').hidden = true; byId('draft-section').hidden = true;
    byId('plan-status').textContent = plan?.missing?.length ? `Still needed: ${plan.missing.join(', ')}.` : 'Waiting for imports.';
    return;
  }
  byId('plan-content').hidden = false; byId('agents-section').hidden = false;
  byId('plan-status').textContent = `${plan.eligible_order_count} eligible order lines; ${plan.excluded_order_count} for manager review. Week ${plan.scenario.week_start}–${plan.scenario.week_end}. Cutoff ${dateTime(plan.scenario.order_cutoff)} Singapore time.`;
  table('production-table', [['Date', (r) => r.date], ['Cheese', (r) => r.by_product.find((p) => p.product_id === 'CHEESE')?.quantity || 0],
    ['Egg', (r) => r.by_product.find((p) => p.product_id === 'EGG')?.quantity || 0],
    ['Chicken', (r) => r.by_product.find((p) => p.product_id === 'CHICKEN')?.quantity || 0],
    ['Total', (r) => r.quantity], ['Labour hours', (r) => r.labour_hours]], plan.daily);
  table('exceptions-table', [['Order', (r) => r.id], ['Date', (r) => r.production_date], ['Customer', (r) => r.customer],
    ['Product', (r) => r.product_id], ['Quantity', (r) => r.quantity], ['Reason', (r) => r.reason]], plan.excluded_orders);
  table('roster-table', [['Date', (r) => r.date], ['Demand hours', (r) => r.demand_hours],
    ['Named draft shifts', (r) => r.assignments.map((s) => `${s.name} (${s.start}–${s.end}, ${s.productive_hours}h)`).join('; ') || 'None'],
    ['Capacity', (r) => r.capacity_hours], ['Uncovered', (r) => r.uncovered_hours],
    ['4h shifts to request', (r) => r.additional_four_hour_shifts_to_request]], plan.roster);
  table('stock-table', [['Ingredient', (r) => r.name], ['Demand', (r) => `${r.demand} ${r.unit}`],
    ['On hand', (r) => r.on_hand], ['Committed', (r) => r.committed], ['Usable', (r) => r.usable],
    ['Shortage', (r) => r.shortage], ['Whole packs', (r) => `${r.packs} × ${r.pack_name}`]], plan.ingredient_request);
  const actions = byId('actions-list'); actions.replaceChildren();
  if (!plan.actions.length) actions.append(element('p', 'No exceptions. Manager reviews and approves the draft plan.'));
  else { const list = element('ul'); for (const action of plan.actions) list.append(element('li', `${action.date}: ${action.finding}. ${action.human_action}`)); actions.append(list); }
}

async function refresh(notice) {
  try {
    const [healthResponse, stateResponse] = await Promise.all([fetch('/api/health', { cache: 'no-store' }), fetch('/api/state', { cache: 'no-store' })]);
    const health = await healthResponse.json();
    if (health.database !== 'connected') {
      byId('database-status').textContent = health.database === 'not_configured' ? 'Postgres is not configured for this deployment.' : 'Backend or database is unavailable.';
      renderImports({}, false); renderPlan(null); return;
    }
    if (!stateResponse.ok) throw new Error('Could not read saved imports');
    const state = await stateResponse.json();
    byId('database-status').textContent = `Backend connected to Postgres; reference data seeded.${notice ? ` ${notice}` : ''}`;
    renderImports(state.imports, true); renderPlan(state.plan);
    if (state.agent_run) { renderAgents(state.agent_run); await loadDraft(); }
    else byId('draft-section').hidden = true;
  } catch {
    byId('database-status').textContent = 'Backend health check is unavailable.';
    renderImports({}, false); renderPlan(null);
  }
}

function renderAgents(run) {
  const host = byId('agent-results'); host.replaceChildren();
  for (const [name, result] of Object.entries(run.recommendations || {})) {
    host.append(element('h3', name), element('p', result.summary));
    const list = element('ul'); for (const action of result.actions || []) list.append(element('li', `${action.date}: ${action.action}`)); host.append(list);
    if (result.draft_text) {
      const draft = element('p', result.draft_text); draft.className = 'draft-text'; host.append(draft);
    }
  }
  host.append(element('h3', 'Handoff trace'));
  const trace = element('ul'); for (const item of run.handoff_trace || []) trace.append(element('li', item)); host.append(trace);
  byId('agent-status').textContent = `${run.model} · saved ${dateTime(run.created_at)}`;
}

async function loadDraft() {
  const section = byId('draft-section'); section.hidden = false;
  const status = byId('draft-status');
  try {
    const response = await fetch('/api/draft', { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not load draft preview');
    byId('draft-to').value = data.saved?.to_address || data.preview.to;
    byId('draft-subject').value = data.saved?.subject || data.preview.subject;
    byId('draft-body').value = data.saved?.body || data.preview.body;
    byId('draft-reviewed').checked = false;
    const created = data.saved?.status === 'created';
    const uncertain = data.saved?.status === 'uncertain';
    byId('draft-form').hidden = created;
    byId('draft-retry-review').hidden = !uncertain;
    byId('draft-absent').required = uncertain;
    byId('draft-absent').checked = false;
    byId('create-draft').textContent = uncertain ? 'Retry Create Gmail draft' : 'Create Gmail draft';
    byId('create-draft').disabled = !data.configured;
    status.textContent = created ? `Draft recorded ${dateTime(data.saved.completed_at)}. Check Gmail Drafts to confirm it is unsent.`
      : data.saved ? 'An earlier draft request is pending or uncertain. Check Gmail Drafts and Zapier History before another attempt.'
        : !data.configured ? 'Zapier MCP is not configured on the server. Add ZAPIER_MCP_TOKEN to Vercel Production and redeploy.'
          : data.preview.classroom_placeholder ? 'Ready for manager review. The recipient is a classroom placeholder.' : 'Ready for manager review.';
  } catch (error) { status.textContent = error.message; byId('draft-form').hidden = true; }
}

byId('draft-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = byId('create-draft'), status = byId('draft-status');
  button.disabled = true; status.textContent = 'Creating an unsent Gmail draft…';
  try {
    const response = await fetch('/api/draft', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ to: byId('draft-to').value, subject: byId('draft-subject').value,
        body: byId('draft-body').value, manager_reviewed: byId('draft-reviewed').checked,
        confirmed_absent: byId('draft-absent').checked }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Draft creation failed');
    status.textContent = data.message;
    byId('draft-form').hidden = true;
  } catch (error) { status.textContent = error.message; button.disabled = false; }
});

byId('run-agents').addEventListener('click', async () => {
  const button = byId('run-agents'), status = byId('agent-status');
  button.disabled = true; status.textContent = 'Running the three planning agents…';
  try {
    const response = await fetch('/api/agents', { method: 'POST' });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Agent call failed');
    renderAgents(result); await loadDraft();
  } catch (error) { status.textContent = `Agent run failed: ${error.message}. The verified numeric plan remains available.`; }
  finally { button.disabled = false; }
});

refresh();
