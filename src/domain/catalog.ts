import type { Benefit, Hmo, Plan, Provider, ServiceCategory, TariffItem } from './types';

// Reference data. Organisation names are fictional and used for demonstration only.

export const STATES = ['Lagos', 'FCT', 'Kano', 'Oyo', 'Rivers', 'Enugu', 'Kaduna', 'Edo'] as const;

export const CATEGORY_LABELS: Record<ServiceCategory, string> = {
  consultation: 'GP consultation',
  laboratory: 'Lab tests',
  drugs: 'Prescribed drugs',
  imaging: 'X-ray & scans',
  maternity: 'Antenatal & delivery',
  admission: 'Hospital admission',
  surgery: 'Surgery',
  emergency: 'Emergency care',
  dental: 'Dental',
  optical: 'Eye care',
};

const b = (covered: boolean, copay = 0, requiresPA = false, perVisitCap?: number): Benefit => ({
  covered,
  copay,
  requiresPA,
  perVisitCap,
});

export const PLANS: Plan[] = [
  {
    id: 'basic',
    name: 'HealthGuard Basic',
    tagline: 'Primary care for traders, artisans and families — under ₦120 a day',
    monthlyPremium: 3500,
    annualLimit: 500_000,
    waitingPeriodDays: 30,
    capitationRate: 1200,
    benefits: {
      consultation: b(true),
      laboratory: b(true, 0.1),
      drugs: b(true, 0.1),
      imaging: b(true, 0.2, true, 40_000),
      maternity: b(true, 0, true, 150_000),
      admission: b(true, 0.1, true, 120_000),
      surgery: b(false),
      emergency: b(true, 0, false, 100_000),
      dental: b(false),
      optical: b(false),
    },
  },
  {
    id: 'standard',
    name: 'HealthGuard Standard',
    tagline: 'Primary + secondary care, minor surgery and full maternity',
    monthlyPremium: 8500,
    annualLimit: 1_500_000,
    waitingPeriodDays: 30,
    capitationRate: 1800,
    benefits: {
      consultation: b(true),
      laboratory: b(true),
      drugs: b(true, 0.05),
      imaging: b(true, 0.1, true),
      maternity: b(true, 0, true, 400_000),
      admission: b(true, 0, true),
      surgery: b(true, 0.1, true, 500_000),
      emergency: b(true),
      dental: b(true, 0.2),
      optical: b(true, 0.2, false, 30_000),
    },
  },
  {
    id: 'premium',
    name: 'HealthGuard Premium',
    tagline: 'Comprehensive cover with tertiary care and no co-pays',
    monthlyPremium: 20000,
    annualLimit: 5_000_000,
    waitingPeriodDays: 14,
    capitationRate: 2500,
    benefits: {
      consultation: b(true),
      laboratory: b(true),
      drugs: b(true),
      imaging: b(true, 0, true),
      maternity: b(true, 0, true),
      admission: b(true, 0, true),
      surgery: b(true, 0, true),
      emergency: b(true),
      dental: b(true),
      optical: b(true),
    },
  },
];

export const HMOS: Hmo[] = [
  { id: 'hmo-unity', name: 'Unity Health HMO', claimsSlaDays: 14 },
  { id: 'hmo-crest', name: 'Crestline Care HMO', claimsSlaDays: 14 },
  { id: 'hmo-arewa', name: 'Arewa Health Partners', claimsSlaDays: 14 },
];

const ALL_HMOS = HMOS.map((h) => h.id);

export const PROVIDERS: Provider[] = [
  { id: 'prv-001', name: 'Ikeja Family Clinic', level: 'primary', state: 'Lagos', lga: 'Ikeja', accredited: true, hmoIds: ALL_HMOS, phone: '08031110001' },
  { id: 'prv-002', name: 'Surulere Community Health Centre', level: 'primary', state: 'Lagos', lga: 'Surulere', accredited: true, hmoIds: ['hmo-unity', 'hmo-crest'], phone: '08031110002' },
  { id: 'prv-003', name: 'Lagoon General Hospital', level: 'secondary', state: 'Lagos', lga: 'Lagos Island', accredited: true, hmoIds: ALL_HMOS, phone: '08031110003' },
  { id: 'prv-004', name: 'Garki Wellness Clinic', level: 'primary', state: 'FCT', lga: 'AMAC', accredited: true, hmoIds: ALL_HMOS, phone: '08031110004' },
  { id: 'prv-005', name: 'Capital Specialist Hospital', level: 'tertiary', state: 'FCT', lga: 'Gwagwalada', accredited: true, hmoIds: ['hmo-unity', 'hmo-arewa'], phone: '08031110005' },
  { id: 'prv-006', name: 'Sabon Gari Primary Care', level: 'primary', state: 'Kano', lga: 'Fagge', accredited: true, hmoIds: ['hmo-arewa', 'hmo-unity'], phone: '08031110006' },
  { id: 'prv-007', name: 'Dala Mother & Child Hospital', level: 'secondary', state: 'Kano', lga: 'Dala', accredited: true, hmoIds: ['hmo-arewa'], phone: '08031110007' },
  { id: 'prv-008', name: 'Bodija Medical Centre', level: 'primary', state: 'Oyo', lga: 'Ibadan North', accredited: true, hmoIds: ALL_HMOS, phone: '08031110008' },
  { id: 'prv-009', name: 'Garden City Clinic', level: 'primary', state: 'Rivers', lga: 'Port Harcourt', accredited: true, hmoIds: ['hmo-crest', 'hmo-unity'], phone: '08031110009' },
  { id: 'prv-010', name: 'Coal City Hospital', level: 'secondary', state: 'Enugu', lga: 'Enugu North', accredited: true, hmoIds: ['hmo-crest'], phone: '08031110010' },
  { id: 'prv-011', name: 'Kaduna Central PHC', level: 'primary', state: 'Kaduna', lga: 'Kaduna North', accredited: true, hmoIds: ['hmo-arewa'], phone: '08031110011' },
  { id: 'prv-012', name: 'Ring Road Clinic', level: 'primary', state: 'Edo', lga: 'Oredo', accredited: false, hmoIds: ['hmo-crest'], phone: '08031110012' },
];

/** Agreed (capped) tariff list. Providers may not bill above these prices. */
export const TARIFFS: TariffItem[] = [
  { code: 'CON-01', description: 'GP consultation', category: 'consultation', price: 5000 },
  { code: 'CON-02', description: 'Specialist consultation', category: 'consultation', price: 12000 },
  { code: 'LAB-01', description: 'Malaria parasite test (MP/RDT)', category: 'laboratory', price: 2500 },
  { code: 'LAB-02', description: 'Full blood count', category: 'laboratory', price: 6000 },
  { code: 'LAB-03', description: 'Urinalysis', category: 'laboratory', price: 2000 },
  { code: 'LAB-04', description: 'Widal test', category: 'laboratory', price: 3000 },
  { code: 'DRG-01', description: 'Artemether-lumefantrine (ACT) course', category: 'drugs', price: 3500 },
  { code: 'DRG-02', description: 'Amoxicillin 500mg x 21', category: 'drugs', price: 2800 },
  { code: 'DRG-03', description: 'Paracetamol 500mg x 20', category: 'drugs', price: 600 },
  { code: 'DRG-04', description: 'Amlodipine 5mg x 30', category: 'drugs', price: 4500 },
  { code: 'DRG-05', description: 'Metformin 500mg x 60', category: 'drugs', price: 4000 },
  { code: 'IMG-01', description: 'Chest X-ray', category: 'imaging', price: 15000 },
  { code: 'IMG-02', description: 'Obstetric ultrasound scan', category: 'imaging', price: 12000 },
  { code: 'MAT-01', description: 'Antenatal care package', category: 'maternity', price: 45000 },
  { code: 'MAT-02', description: 'Normal delivery', category: 'maternity', price: 90000 },
  { code: 'MAT-03', description: 'Caesarean section', category: 'maternity', price: 350000 },
  { code: 'ADM-01', description: 'Ward admission (per day)', category: 'admission', price: 15000 },
  { code: 'SUR-01', description: 'Appendectomy', category: 'surgery', price: 300000 },
  { code: 'SUR-02', description: 'Hernia repair', category: 'surgery', price: 250000 },
  { code: 'EMR-01', description: 'Emergency resuscitation & stabilisation', category: 'emergency', price: 40000 },
  { code: 'DEN-01', description: 'Tooth extraction', category: 'dental', price: 10000 },
  { code: 'OPT-01', description: 'Eye examination', category: 'optical', price: 8000 },
];

export const DIAGNOSES = [
  'B54 Malaria, unspecified',
  'A01.0 Typhoid fever',
  'J06.9 Upper respiratory tract infection',
  'I10 Essential hypertension',
  'E11.9 Type 2 diabetes',
  'Z34.9 Supervision of normal pregnancy',
  'O80 Normal delivery',
  'K35.8 Acute appendicitis',
  'N39.0 Urinary tract infection',
  'K40.9 Inguinal hernia',
  'K02.9 Dental caries',
  'H52.1 Myopia',
];

export const planById = (id: string) => PLANS.find((p) => p.id === id)!;
export const hmoById = (id: string) => HMOS.find((h) => h.id === id)!;
export const providerById = (id: string) => PROVIDERS.find((p) => p.id === id);
export const tariffByCode = (code: string) => TARIFFS.find((t) => t.code === code);

/** Valid group codes (cooperatives, market associations, employers) and their premium discount. */
export const GROUPS: Record<string, { name: string; discount: number }> = {
  'OSHODI-TRADERS': { name: 'Oshodi Market Traders Association', discount: 0.1 },
  'OKADA-COOP': { name: 'Riders Cooperative Society', discount: 0.1 },
  'TECHHUB-STAFF': { name: 'TechHub Ltd (employer scheme)', discount: 0.15 },
};
