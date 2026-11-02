import type { ReferenceRange, ResultTemplateDraft } from '#shared';

/**
 * Result templates a facility may adopt, linked to the standard tests they serve
 * (standardTests.ts keys). Only the server holds this list.
 *
 * Ranges are typical adult reference intervals, split by sex where that is well
 * established, and apply from 18 years: no children's bands are supplied, so a
 * child's result shows no range until the laboratory sets one. Urine dipstick pH
 * and specific gravity are not age-dependent and apply to anyone. Every range is a
 * starting point that each laboratory must confirm against its own methods.
 */
export type StandardTemplate = { key: string; name: string; tests: readonly string[]; parts: ResultTemplateDraft['parts'] };

type Range = ReferenceRange[];
const adult = { value: 18, unit: 'years' } as const;
const adults = (low: number, high: number): Range => [{ ageFrom: adult, low, high }];
const adultsUpTo = (high: number): Range => [{ ageFrom: adult, high }];
const bySex = (male: [number, number], female: [number, number]): Range => [{ sex: 'male', ageFrom: adult, low: male[0], high: male[1] }, { sex: 'female', ageFrom: adult, low: female[0], high: female[1] }];
const bySexUpTo = (male: number, female: number): Range => [{ sex: 'male', ageFrom: adult, high: male }, { sex: 'female', ageFrom: adult, high: female }];
const bySexFrom = (male: number, female: number): Range => [{ sex: 'male', ageFrom: adult, low: male }, { sex: 'female', ageFrom: adult, low: female }];
const number = (key: string, label: string, unit: string, decimals: number, ranges: Range = [], required = true) => ({ key, label, kind: 'number' as const, ...(unit ? { unit } : {}), decimals, ranges, required });
const choice = (key: string, label: string, answers: string[], required = true) => ({ key, label, kind: 'choice' as const, answers, required });
const note = (key: string, label: string, required = false) => ({ key, label, kind: 'text' as const, required });
const section = (key: string, label: string, required = false) => ({ key, label, kind: 'section' as const, required });
const images = { key: 'images', label: 'Images', kind: 'images' as const, maxFiles: 6, required: false };

const GRADES = ['Negative', 'Trace', '1+', '2+', '3+'];
const TITRES = ['Less than 1:20', '1:20', '1:40', '1:80', '1:160', '1:320 or higher'];
const ANTIBIOTICS = ['Amoxicillin-clavulanate', 'Ampicillin', 'Azithromycin', 'Cefuroxime', 'Ceftriaxone', 'Ceftazidime', 'Ciprofloxacin', 'Levofloxacin', 'Clindamycin', 'Cloxacillin', 'Co-trimoxazole', 'Erythromycin', 'Gentamicin', 'Amikacin', 'Imipenem', 'Meropenem', 'Nitrofurantoin', 'Vancomycin'];

const haemoglobin = number('haemoglobin', 'Haemoglobin', 'g/dL', 1, bySex([13, 17], [12, 15]));
const pcv = number('pcv', 'Packed cell volume', '%', 0, bySex([40, 50], [36, 46]));
const creatinine = number('creatinine', 'Creatinine', 'µmol/L', 0, bySex([62, 106], [44, 80]));
const albumin = number('albumin', 'Albumin', 'g/L', 0, adults(35, 52));
const totalProtein = number('total_protein', 'Total protein', 'g/L', 0, adults(64, 83));

export const STANDARD_TEMPLATES: readonly StandardTemplate[] = [
  { key: 'fbc', name: 'Full blood count', tests: ['fbc'], parts: [
    haemoglobin, pcv, number('wbc', 'White cell count', '×10⁹/L', 1, adults(4, 11)),
    number('neutrophils', 'Neutrophils', '%', 0, adults(40, 75), false), number('lymphocytes', 'Lymphocytes', '%', 0, adults(20, 45), false),
    number('platelets', 'Platelets', '×10⁹/L', 0, adults(150, 400)), note('film', 'Film comment'),
  ] },
  { key: 'haemoglobin', name: 'Haemoglobin', tests: ['haemoglobin'], parts: [haemoglobin] },
  { key: 'pcv', name: 'Packed cell volume', tests: ['pcv'], parts: [pcv] },
  { key: 'esr', name: 'Erythrocyte sedimentation rate', tests: ['esr'], parts: [number('esr', 'ESR', 'mm/hr', 0, bySexUpTo(15, 20))] },
  { key: 'malaria-film', name: 'Blood film for malaria parasites', tests: ['malaria-film'], parts: [
    choice('result', 'Result', ['No parasites seen', 'Parasites seen']),
    choice('species', 'Species', ['P. falciparum', 'P. malariae', 'P. ovale', 'P. vivax', 'Mixed infection'], false),
    number('density', 'Parasite density', 'parasites/µL', 0, [], false),
  ] },
  { key: 'rapid-reactive', name: 'Rapid test: Reactive / Non-reactive', tests: ['hiv-rapid', 'hbsag', 'hcv', 'rpr'], parts: [choice('result', 'Result', ['Non-reactive', 'Reactive', 'Invalid, repeat test'])] },
  { key: 'rapid-positive', name: 'Rapid test: Positive / Negative', tests: ['malaria-rdt', 'pregnancy', 'h-pylori', 'sickling', 'fobt'], parts: [choice('result', 'Result', ['Negative', 'Positive', 'Invalid, repeat test'])] },
  { key: 'genotype', name: 'Haemoglobin genotype', tests: ['genotype'], parts: [choice('genotype', 'Genotype', ['AA', 'AS', 'AC', 'SS', 'SC', 'CC'])] },
  { key: 'blood-group', name: 'Blood group and Rh', tests: ['blood-group'], parts: [choice('abo', 'ABO group', ['A', 'B', 'AB', 'O']), choice('rh', 'Rh (D)', ['Rh D positive', 'Rh D negative'])] },
  { key: 'crossmatch', name: 'Crossmatch', tests: ['crossmatch'], parts: [choice('result', 'Result', ['Compatible', 'Incompatible']), note('units', 'Units crossmatched')] },
  // A random glucose has no single normal range; the laboratory sets one if it wants it shown.
  { key: 'rbs', name: 'Random blood glucose', tests: ['rbs'], parts: [number('glucose', 'Glucose', 'mmol/L', 1)] },
  { key: 'fbs', name: 'Fasting blood glucose', tests: ['fbs'], parts: [number('glucose', 'Glucose', 'mmol/L', 1, adults(3.9, 5.5))] },
  { key: 'hba1c', name: 'HbA1c', tests: ['hba1c'], parts: [number('hba1c', 'HbA1c', '%', 1, adults(4, 5.6))] },
  { key: 'eucr', name: 'Electrolytes, urea and creatinine', tests: ['eucr'], parts: [
    number('sodium', 'Sodium', 'mmol/L', 0, adults(135, 145)), number('potassium', 'Potassium', 'mmol/L', 1, adults(3.5, 5.1)),
    number('chloride', 'Chloride', 'mmol/L', 0, adults(98, 107)), number('bicarbonate', 'Bicarbonate', 'mmol/L', 0, adults(22, 29)),
    number('urea', 'Urea', 'mmol/L', 1, adults(2.5, 7.8)), creatinine,
  ] },
  { key: 'creatinine', name: 'Serum creatinine', tests: ['creatinine'], parts: [creatinine] },
  { key: 'lft', name: 'Liver function tests', tests: ['lft'], parts: [
    number('bilirubin_total', 'Total bilirubin', 'µmol/L', 0, adultsUpTo(21)), number('bilirubin_direct', 'Direct bilirubin', 'µmol/L', 1, adultsUpTo(5)),
    number('alt', 'ALT', 'U/L', 0, bySexUpTo(41, 33)), number('ast', 'AST', 'U/L', 0, bySexUpTo(40, 32)),
    number('alp', 'ALP', 'U/L', 0, adults(40, 130)), albumin, totalProtein,
  ] },
  { key: 'lipids', name: 'Lipid profile', tests: ['lipids'], parts: [
    number('cholesterol', 'Total cholesterol', 'mmol/L', 2, adultsUpTo(5.2)), number('hdl', 'HDL cholesterol', 'mmol/L', 2, bySexFrom(1, 1.2)),
    number('ldl', 'LDL cholesterol', 'mmol/L', 2, adultsUpTo(3.4)), number('triglycerides', 'Triglycerides', 'mmol/L', 2, adultsUpTo(1.7)),
  ] },
  { key: 'uric-acid', name: 'Serum uric acid', tests: ['uric-acid'], parts: [number('uric_acid', 'Uric acid', 'µmol/L', 0, bySex([200, 420], [140, 360]))] },
  { key: 'protein', name: 'Total protein and albumin', tests: ['protein'], parts: [totalProtein, albumin] },
  { key: 'urinalysis', name: 'Urinalysis (dipstick)', tests: ['urinalysis'], parts: [
    note('appearance', 'Appearance'), number('ph', 'pH', '', 1, [{ low: 4.5, high: 8 }]), number('specific_gravity', 'Specific gravity', '', 3, [{ low: 1.005, high: 1.03 }]),
    choice('protein', 'Protein', GRADES), choice('glucose', 'Glucose', GRADES), choice('ketones', 'Ketones', GRADES), choice('blood', 'Blood', GRADES),
    choice('bilirubin', 'Bilirubin', GRADES), choice('urobilinogen', 'Urobilinogen', ['Normal', '1+', '2+', '3+']),
    choice('nitrite', 'Nitrite', ['Negative', 'Positive']), choice('leucocytes', 'Leucocytes', GRADES),
  ] },
  { key: 'urine-microscopy', name: 'Urine microscopy', tests: ['urine-microscopy'], parts: [
    note('pus_cells', 'Pus cells (per high-power field)'), note('red_cells', 'Red cells (per high-power field)'), note('epithelial', 'Epithelial cells'),
    note('casts', 'Casts'), note('crystals', 'Crystals'), note('other', 'Other findings'),
  ] },
  { key: 'stool-op', name: 'Stool microscopy (ova and parasites)', tests: ['stool-op'], parts: [
    note('macroscopy', 'Macroscopy'), choice('parasites', 'Ova, cysts and parasites', ['None seen', 'Seen']), note('findings', 'Organisms seen'),
  ] },
  { key: 'culture', name: 'Culture and sensitivity', tests: ['urine-mcs', 'blood-culture', 'wound-mcs'], parts: [
    note('microscopy', 'Microscopy'), { key: 'culture', label: 'Culture', kind: 'culture', antibiotics: ANTIBIOTICS, required: true }, note('comment', 'Comment'),
  ] },
  { key: 'afb', name: 'Sputum AFB smear', tests: ['afb'], parts: [choice('result', 'Result', ['Negative', 'Scanty', '1+', '2+', '3+'])] },
  { key: 'genexpert', name: 'GeneXpert MTB/RIF', tests: ['genexpert'], parts: [
    choice('mtb', 'MTB', ['MTB not detected', 'MTB detected', 'Invalid, repeat test']),
    choice('rifampicin', 'Rifampicin resistance', ['Not detected', 'Detected', 'Indeterminate'], false),
  ] },
  { key: 'widal', name: 'Widal test', tests: ['widal'], parts: [
    choice('typhi_o', 'S. Typhi O', TITRES), choice('typhi_h', 'S. Typhi H', TITRES),
    choice('paratyphi_ah', 'S. Paratyphi AH', TITRES, false), choice('paratyphi_bh', 'S. Paratyphi BH', TITRES, false),
  ] },
  { key: 'cd4', name: 'CD4 count', tests: ['cd4'], parts: [number('cd4', 'CD4', 'cells/µL', 0, adults(500, 1500))] },
  { key: 'viral-load', name: 'HIV viral load', tests: ['viral-load'], parts: [choice('result', 'Result', ['Target not detected', 'Detected']), number('copies', 'Viral load', 'copies/mL', 0, [], false)] },
  { key: 'imaging', name: 'Imaging report', tests: [], parts: [
    section('clinical', 'Clinical information'), section('technique', 'Technique'), section('findings', 'Findings', true), section('impression', 'Impression', true), images,
  ] },
  { key: 'obstetric-us', name: 'Obstetric ultrasound', tests: [], parts: [
    number('fetuses', 'Number of fetuses', '', 0), choice('heartbeat', 'Fetal heartbeat', ['Present', 'Absent']),
    choice('presentation', 'Presentation', ['Cephalic', 'Breech', 'Transverse', 'Oblique', 'Variable'], false), note('gestation', 'Gestational age'),
    note('placenta', 'Placenta'), choice('liquor', 'Liquor volume', ['Adequate', 'Reduced', 'Increased'], false), section('impression', 'Impression', true), images,
  ] },
];
