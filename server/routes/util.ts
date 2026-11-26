import { z } from 'zod';
import type { FastifyRequest } from 'fastify';
import { HttpError } from '../context';
import type { Principal } from '../auth';

export const parse = <S extends z.ZodType>(schema: S, data: unknown): z.infer<S> => schema.parse(data);

export const principal = (req: FastifyRequest): Principal => {
  if (!req.principal) throw new HttpError(401, 'unauthenticated', 'Not signed in');
  return req.principal;
};

export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').refine((s) => !Number.isNaN(Date.parse(s)), 'Invalid date');
export const frequency = z.enum(['daily', 'weekly', 'monthly', 'quarterly', 'annual']);
export const method = z.enum(['card', 'ussd', 'bank_transfer', 'mobile_money', 'agent']);
export const category = z.enum(['consultation', 'laboratory', 'drugs', 'imaging', 'maternity', 'admission', 'surgery', 'emergency', 'dental', 'optical']);
export const complaintCategory = z.enum(['denied_service', 'asked_to_pay', 'drug_unavailable', 'long_wait', 'poor_attitude', 'claim_dispute', 'other']);
export const naira = z.number().int().min(0).max(100_000_000);
export const text = (max: number) => z.string().trim().min(1).max(max);
