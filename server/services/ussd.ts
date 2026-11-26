import { COMPLAINT_LABELS } from '../../src/domain/catalog';
import { ussd } from '../../src/domain/ussd';
import type { Ctx } from '../context';
import { enrollees } from '../db/repo';
import { fileComplaint } from './care';
import { initiatePayment, normalisePhone } from './members';

/**
 * USSD gateway callback (Africa's Talking-style: sessionId, phoneNumber, text).
 * Returns the plain-text body the gateway expects: "CON …" to continue, "END …" to close.
 */
export async function handleUssd(ctx: Ctx, rawPhone: string, text: string): Promise<string> {
  const phone = normalisePhone(rawPhone);
  const me = await enrollees.findByPhone(ctx.sql, phone);
  const res = ussd(phone, text, me ? [me] : [], ctx.today());
  const a = res.action;
  if (a?.type === 'pay') {
    // Triggers a mobile-money debit prompt; cover is extended when the gateway confirms.
    await initiatePayment(ctx, { role: 'member', id: `ussd:${phone}` }, a.enrolleeId, a.frequency, 'ussd');
  } else if (a?.type === 'complaint') {
    await fileComplaint(ctx, { role: 'member', id: `ussd:${phone}` }, a.enrolleeId, {
      category: a.category,
      description: `${COMPLAINT_LABELS[a.category]} (reported by USSD)`,
      channel: 'ussd',
    });
  } else if (a?.type === 'callback') {
    await ctx.sql.query(`INSERT INTO enrolment_callbacks (phone, channel) VALUES ($1, 'ussd')`, [phone]);
  }
  return `${res.kind} ${res.text}`;
}
