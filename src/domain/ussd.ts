import { PROVIDERS, planById, providerById } from './catalog';
import { checkEligibility, quotePremium } from './pricing';
import type { ComplaintCategory, Enrollee, PaymentFrequency } from './types';
import { prettyDate } from './util';

/**
 * USSD menu for feature phones (no smartphone or data needed).
 * Works like real USSD gateways: the whole session is the `*`-joined input string,
 * so the function is stateless and easy to test.
 */
export const USSD_CODE = '*347*44#';

export type UssdAction =
  | { type: 'pay'; enrolleeId: string; frequency: PaymentFrequency; amount: number }
  | { type: 'complaint'; enrolleeId: string; category: ComplaintCategory }
  | { type: 'callback'; phone: string };

export interface UssdResponse {
  /** CON = session continues, END = session closes (USSD convention). */
  kind: 'CON' | 'END';
  text: string;
  action?: UssdAction;
}

const con = (text: string): UssdResponse => ({ kind: 'CON', text });
const end = (text: string, action?: UssdAction): UssdResponse => ({ kind: 'END', text, action });

const PAY_OPTIONS: PaymentFrequency[] = ['daily', 'weekly', 'monthly'];
const PAY_LABEL: Record<string, string> = { daily: '1 day', weekly: '1 week', monthly: '1 month' };
const COMPLAINTS: [ComplaintCategory, string][] = [
  ['asked_to_pay', 'Asked to pay cash'],
  ['denied_service', 'Refused treatment'],
  ['drug_unavailable', 'Drugs not available'],
  ['long_wait', 'Waited too long'],
];

export function ussd(phone: string, text: string, enrollees: Enrollee[], today: string): UssdResponse {
  const steps = text === '' ? [] : text.split('*');
  const me = enrollees.find((e) => e.phone === phone);

  if (!me) {
    if (steps.length === 0)
      return con('Welcome to HealthGuard.\nThis number is not registered.\n1. Request a call from an enrolment agent\n2. Exit');
    if (steps[0] === '1')
      return end('Thank you! A HealthGuard agent will call you within 24 hours to register you.', { type: 'callback', phone });
    return end('Goodbye.');
  }

  if (steps.length === 0)
    return con(`Welcome ${me.firstName}\n1. Check my cover\n2. Pay premium\n3. Find a hospital\n4. Report a problem\n5. My HealthGuard ID`);

  const plan = planById(me.planId);
  switch (steps[0]) {
    case '1': {
      const elig = checkEligibility(me, today);
      const hosp = providerById(me.primaryProviderId);
      return end(
        `${plan.name}\nStatus: ${elig.status.toUpperCase()}\nPaid till ${prettyDate(me.paidThrough)}\nClinic: ${hosp?.name ?? '-'}`,
      );
    }
    case '2': {
      const quotes = PAY_OPTIONS.map((f) =>
        quotePremium({ planId: me.planId, dependants: me.dependants, frequency: f, groupCode: me.groupCode, sector: me.sector }),
      );
      if (steps.length === 1)
        return con(
          'Pay premium:\n' + PAY_OPTIONS.map((f, i) => `${i + 1}. ${PAY_LABEL[f]} - N${quotes[i].installment.toLocaleString('en-NG')}`).join('\n'),
        );
      const idx = Number(steps[1]) - 1;
      if (!(idx >= 0 && idx < PAY_OPTIONS.length)) return end('Invalid option.');
      if (steps.length === 2)
        return con(`Pay N${quotes[idx].installment.toLocaleString('en-NG')} from your mobile money wallet?\n1. Yes\n2. No`);
      if (steps[2] !== '1') return end('Payment cancelled.');
      return end(`Approve the N${quotes[idx].installment.toLocaleString('en-NG')} prompt on your phone. Your cover is extended for ${quotes[idx].daysCovered} day(s) once it is confirmed by SMS.`, {
        type: 'pay',
        enrolleeId: me.id,
        frequency: PAY_OPTIONS[idx],
        amount: quotes[idx].installment,
      });
    }
    case '3': {
      const list = PROVIDERS.filter((p) => p.state === me.state && p.accredited && p.hmoIds.includes(me.hmoId)).slice(0, 4);
      if (list.length === 0) return end('No HealthGuard hospital found in your state yet.');
      return end(`Hospitals in ${me.state}:\n` + list.map((p) => `${p.name} (${p.lga}) ${p.phone}`).join('\n'));
    }
    case '4': {
      if (steps.length === 1) return con('What happened?\n' + COMPLAINTS.map(([, l], i) => `${i + 1}. ${l}`).join('\n'));
      const c = COMPLAINTS[Number(steps[1]) - 1];
      if (!c) return end('Invalid option.');
      return end('Complaint logged. Your HMO must respond within 48 hours or it is escalated to the regulator.', {
        type: 'complaint',
        enrolleeId: me.id,
        category: c[0],
      });
    }
    case '5':
      return end(`Your HealthGuard ID is ${me.id}. Show it at any HealthGuard hospital.`);
    default:
      return end('Invalid option.');
  }
}
