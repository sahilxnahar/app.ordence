export interface UniversalFlow { key: string; title: string; description: string; }

const REMAINING_UX_FLOWS: Array<[number, string]> = [
  [26, 'Contact creation flow'],
  [27, 'Company creation flow'],
  [28, 'Deal stage flow'],
  [29, 'Project setup flow'],
  [30, 'Compliance task flow'],
];

export const UNIVERSAL_FLOWS: UniversalFlow[] = REMAINING_UX_FLOWS.map(([number, name]) => ({
  key: `UX-${String(number).padStart(2, '0')}`,
  title: `UX-${number} ${name}`,
  description: `Run ${name} as a structured universal flow.`,
}));
