import { createHash } from 'node:crypto';

export function supplierDraft(plan, supplier) {
  if (plan.status !== 'ready') throw new Error('The current plan is incomplete');
  const lines = plan.ingredient_request.filter((item) => item.packs > 0)
    .map((item) => `- ${item.packs} × ${item.pack_name} (${item.name}; ${item.requested_quantity} ${item.unit} total)`);
  return {
    to: supplier.default_draft_to,
    subject: `Sample Central Kitchen stock request, ${plan.scenario.week_start} to ${plan.scenario.week_end}`,
    body: [
      'Hello,',
      '',
      `Please review this proposed stock request for the production week ${plan.scenario.week_start} to ${plan.scenario.week_end}:`,
      '',
      ...(lines.length ? lines : ['No additional stock packs are requested.']),
      '',
      'This request is based on the current physical stock count and confirmed orders received by the cutoff. The late order is excluded pending a manager decision.',
      '',
      'Please confirm availability and delivery timing before any order is placed.',
      '',
      'Sample Central Kitchen',
    ].join('\n'),
    classroom_placeholder: Boolean(supplier.classroom_placeholder),
  };
}

export function validateDraft(value) {
  const to = typeof value?.to === 'string' ? value.to.trim() : '';
  const subject = typeof value?.subject === 'string' ? value.subject.trim() : '';
  const body = typeof value?.body === 'string' ? value.body.trim() : '';
  if (!/^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(to)) throw new Error('Enter one valid recipient email address');
  if (!subject || subject.length > 200) throw new Error('Subject must be 1–200 characters');
  if (!body || body.length > 10_000) throw new Error('Body must be 1–10,000 characters');
  return { to, subject, body };
}

export function draftHash(importVersion, draft) {
  return createHash('sha256').update(JSON.stringify([importVersion, draft.to, draft.subject, draft.body])).digest('hex');
}
