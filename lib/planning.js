import { createHash } from 'node:crypto';
import { importOrder } from './validation.js';

const rounded = (value) => Math.round((value + Number.EPSILON) * 1_000_000) / 1_000_000;

function planningDates(start, end) {
  const dates = [];
  for (let day = new Date(`${start}T00:00:00Z`); day <= new Date(`${end}T00:00:00Z`); day.setUTCDate(day.getUTCDate() + 1)) {
    dates.push(day.toISOString().slice(0, 10));
  }
  return dates;
}

function pickByWorkload(workers, hours) {
  return [...workers].sort((a, b) => (hours.get(a.id) || 0) - (hours.get(b.id) || 0) || a.name.localeCompare(b.name));
}

export function calculatePlan({ batches, records, references }) {
  const missing = importOrder.filter((kind) => !batches[kind]);
  if (missing.length) return { status: 'incomplete', missing };

  const scenario = references.scenario;
  const products = references.products_and_recipes.products;
  const recipes = references.products_and_recipes.recipes;
  const productById = new Map(products.map((row) => [row.id, row]));
  const dates = planningDates(scenario.week_start, scenario.week_end);
  const cutoff = Date.parse(scenario.order_cutoff);
  const eligibleOrders = [];
  const excludedOrders = [];
  for (const order of records.crm) {
    let reason = null;
    if (order.status !== 'Confirmed') reason = `Order status: ${order.status}`;
    else if (order.production_date < scenario.week_start || order.production_date > scenario.week_end) reason = 'Outside planning week';
    else if (Date.parse(order.received_at) > cutoff) reason = 'Received after order cutoff; manager decision required';
    (reason ? excludedOrders : eligibleOrders).push(reason ? { ...order, reason } : order);
  }

  const daily = dates.map((date) => {
    const byProduct = products.map((product) => ({ product_id: product.id, product_name: product.name,
      quantity: eligibleOrders.filter((order) => order.production_date === date && order.product_id === product.id)
        .reduce((sum, order) => sum + order.quantity, 0) }));
    const quantity = byProduct.reduce((sum, row) => sum + row.quantity, 0);
    const labourHours = rounded(byProduct.reduce((sum, row) => sum + row.quantity * productById.get(row.product_id).labour_hours_per_unit, 0));
    return { date, quantity, by_product: byProduct, labour_hours: labourHours };
  });

  const productTotals = Object.fromEntries(products.map((product) => [product.id,
    eligibleOrders.filter((order) => order.product_id === product.id).reduce((sum, order) => sum + order.quantity, 0)]));
  const ingredientDemand = new Map();
  for (const recipe of recipes) ingredientDemand.set(recipe.ingredient_id,
    rounded((ingredientDemand.get(recipe.ingredient_id) || 0) + productTotals[recipe.product_id] * recipe.quantity_per_unit));
  const stockRequest = records.stock.map((item) => {
    const demand = ingredientDemand.get(item.ingredient_id) || 0;
    const usable = rounded(item.on_hand - item.committed);
    const shortage = rounded(Math.max(0, demand - usable));
    const packs = Math.ceil(shortage / item.pack_size);
    return { ingredient_id: item.ingredient_id, name: item.name, unit: item.unit,
      demand, on_hand: item.on_hand, committed: item.committed, usable,
      shortage, pack_size: item.pack_size, pack_name: item.pack_name, packs,
      requested_quantity: rounded(packs * item.pack_size) };
  });

  const approvedLeave = new Set(records.hr_leave.filter((row) => row.status === 'Approved').map((row) => `${row.staff_id}:${row.date}`));
  const pendingLeave = records.hr_leave.filter((row) => row.status === 'Pending');
  const assignedHours = new Map(records.hr_staff.map((worker) => [worker.id, 0]));
  const roster = daily.map((day) => {
    const assigned = [];
    const used = new Set();
    let capacity = 0;
    const availablePermanent = records.hr_staff.filter((worker) => worker.employment_type === 'Permanent' &&
      worker.skills.includes('production') && !approvedLeave.has(`${worker.id}:${day.date}`));
    const leads = pickByWorkload(availablePermanent.filter((worker) => worker.skills.includes('supervisor')), assignedHours);
    const lead = leads[0] || null;
    const add = (worker, hours, start, end, role) => {
      if (used.has(worker.id)) return;
      used.add(worker.id);
      capacity = rounded(capacity + hours);
      assignedHours.set(worker.id, rounded(assignedHours.get(worker.id) + hours));
      assigned.push({ staff_id: worker.id, name: worker.name, role, employment_type: worker.employment_type,
        start, end, productive_hours: hours });
    };
    if (lead) add(lead, scenario.settings.permanent_productive_hours,
      scenario.settings.permanent_shift_start, scenario.settings.permanent_shift_end, 'Kitchen lead');
    for (const worker of pickByWorkload(availablePermanent.filter((row) => row.id !== lead?.id), assignedHours)) {
      if (capacity >= day.labour_hours) break;
      add(worker, scenario.settings.permanent_productive_hours,
        scenario.settings.permanent_shift_start, scenario.settings.permanent_shift_end, worker.role);
    }
    const confirmed = records.hr_availability.filter((row) => row.date === day.date && row.status === 'Confirmed');
    const partTime = records.hr_staff.filter((worker) => worker.employment_type === 'Part-time' &&
      worker.skills.includes('production') && !approvedLeave.has(`${worker.id}:${day.date}`) &&
      confirmed.some((shift) => shift.staff_id === worker.id));
    for (const worker of pickByWorkload(partTime, assignedHours)) {
      if (capacity >= day.labour_hours) break;
      const shift = confirmed.find((row) => row.staff_id === worker.id);
      add(worker, scenario.settings.part_time_productive_hours, shift.start, shift.end, worker.role);
    }
    const uncoveredHours = rounded(Math.max(0, day.labour_hours - capacity));
    return { date: day.date, demand_hours: day.labour_hours, capacity_hours: capacity,
      lead_present: Boolean(lead), assignments: assigned, uncovered_hours: uncoveredHours,
      additional_four_hour_shifts_to_request: Math.ceil(uncoveredHours / scenario.settings.part_time_productive_hours) };
  });

  const actions = [];
  for (const order of excludedOrders) actions.push({ date: order.production_date,
    finding: `${order.id} (${order.customer}) was excluded: ${order.reason}`,
    human_action: 'Manager decides whether to accept the late order and revise the plan.' });
  for (const day of roster) {
    if (!day.lead_present) actions.push({ date: day.date, finding: 'No available supervisor-qualified kitchen lead',
      human_action: 'Manager reviews lead cover before approving the roster.' });
    if (day.uncovered_hours > 0) actions.push({ date: day.date,
      finding: `${day.uncovered_hours} productive hours uncovered`,
      human_action: `Manager requests ${day.additional_four_hour_shifts_to_request} additional four-hour part-time shift(s); no worker is booked.` });
  }
  for (const leave of pendingLeave) actions.push({ date: leave.date,
    finding: `Pending leave for ${leave.staff_id}`, human_action: 'Manager checks the HR decision before approving the roster.' });
  if (stockRequest.some((row) => row.packs > 0)) actions.push({ date: scenario.week_start,
    finding: 'Ingredient shortages require whole supplier packs',
    human_action: 'Manager reviews the stock request and supplier draft; requested stock is not counted as on hand.' });
  actions.sort((a, b) => a.date.localeCompare(b.date) || a.finding.localeCompare(b.finding));

  const importVersion = createHash('sha256').update(importOrder.map((kind) => batches[kind].id).join('|')).digest('hex');
  return { status: 'ready', import_version: importVersion, scenario: { timezone: scenario.timezone,
    order_cutoff: scenario.order_cutoff, week_start: scenario.week_start, week_end: scenario.week_end },
    eligible_order_count: eligibleOrders.length, excluded_order_count: excludedOrders.length,
    eligible_orders: eligibleOrders, excluded_orders: excludedOrders,
    daily, product_totals: productTotals, ingredient_request: stockRequest, roster, pending_leave: pendingLeave, actions };
}
