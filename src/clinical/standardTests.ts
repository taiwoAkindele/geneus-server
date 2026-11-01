/**
 * Commonly performed laboratory tests a facility may adopt into its own catalogue,
 * drawn from the WHO Essential Diagnostics List and Nigerian primary and secondary
 * care practice. Only the server holds this list: devices send the keys they chose
 * and every name, specimen and code written comes from here.
 *
 * LOINC codes were checked against the NLM LOINC service (clinicaltables.nlm.nih.gov)
 * in November 2026. Tests without an exact LOINC match carry no code rather than
 * an approximate one.
 */
export type StandardTest = { key: string; name: string; specimen: string; classification: string; aliases: string[]; loinc?: string };

export const LOINC_SYSTEM = 'http://loinc.org';
/** Marks catalogue entries adopted from this list that have no exact LOINC code. */
export const STANDARD_TEST_SYSTEM = 'urn:geneus:standard-test';

export const STANDARD_TESTS: readonly StandardTest[] = [
  // Haematology
  { key: 'fbc', name: 'Full blood count', specimen: 'Whole blood (EDTA)', classification: 'Haematology', aliases: ['FBC', 'CBC', 'Complete blood count'], loinc: '58410-2' },
  { key: 'haemoglobin', name: 'Haemoglobin', specimen: 'Whole blood (EDTA)', classification: 'Haematology', aliases: ['Hb', 'HB'], loinc: '718-7' },
  { key: 'pcv', name: 'Packed cell volume', specimen: 'Whole blood (EDTA)', classification: 'Haematology', aliases: ['PCV', 'Haematocrit', 'HCT'], loinc: '4545-0' },
  { key: 'esr', name: 'Erythrocyte sedimentation rate', specimen: 'Whole blood (EDTA)', classification: 'Haematology', aliases: ['ESR'], loinc: '4537-7' },
  { key: 'malaria-film', name: 'Blood film for malaria parasites', specimen: 'Whole blood (EDTA)', classification: 'Haematology', aliases: ['MP', 'Malaria parasite', 'Thick and thin film'], loinc: '32700-7' },
  { key: 'sickling', name: 'Sickling test', specimen: 'Whole blood (EDTA)', classification: 'Haematology', aliases: ['Sickle cell screen'] },
  { key: 'genotype', name: 'Haemoglobin genotype', specimen: 'Whole blood (EDTA)', classification: 'Haematology', aliases: ['Genotype', 'Hb electrophoresis'], loinc: '49316-3' },
  { key: 'blood-group', name: 'Blood group and Rh', specimen: 'Whole blood (EDTA)', classification: 'Haematology', aliases: ['Blood grouping', 'ABO and Rh', 'Grouping'], loinc: '882-1' },
  { key: 'crossmatch', name: 'Crossmatch', specimen: 'Whole blood and serum', classification: 'Haematology', aliases: ['Compatibility test', 'Grouping and crossmatch'], loinc: '1250-0' },
  // Rapid tests
  { key: 'malaria-rdt', name: 'Malaria rapid diagnostic test', specimen: 'Capillary blood', classification: 'Rapid tests', aliases: ['mRDT', 'Malaria RDT'], loinc: '70569-9' },
  { key: 'hiv-rapid', name: 'HIV 1 and 2 rapid antibody test', specimen: 'Capillary blood or serum', classification: 'Rapid tests', aliases: ['RVS', 'HIV screening', 'HIV test'], loinc: '80387-4' },
  { key: 'hbsag', name: 'Hepatitis B surface antigen', specimen: 'Serum', classification: 'Rapid tests', aliases: ['HBsAg', 'Hepatitis B test'], loinc: '5196-1' },
  { key: 'hcv', name: 'Hepatitis C antibody', specimen: 'Serum or capillary blood', classification: 'Rapid tests', aliases: ['HCV', 'Anti-HCV', 'Hepatitis C test'], loinc: '72376-7' },
  { key: 'rpr', name: 'Syphilis screening (RPR)', specimen: 'Serum', classification: 'Rapid tests', aliases: ['RPR', 'VDRL', 'Syphilis test'], loinc: '20507-0' },
  { key: 'pregnancy', name: 'Urine pregnancy test', specimen: 'Urine', classification: 'Rapid tests', aliases: ['hCG', 'PT', 'Pregnancy test'], loinc: '2106-3' },
  { key: 'h-pylori', name: 'Helicobacter pylori stool antigen', specimen: 'Stool', classification: 'Rapid tests', aliases: ['H. pylori', 'H pylori'], loinc: '17780-8' },
  // Chemistry
  { key: 'rbs', name: 'Random blood glucose', specimen: 'Capillary blood', classification: 'Chemistry', aliases: ['RBS', 'Blood sugar'], loinc: '2339-0' },
  { key: 'fbs', name: 'Fasting blood glucose', specimen: 'Plasma (fluoride)', classification: 'Chemistry', aliases: ['FBS', 'Fasting blood sugar'], loinc: '1558-6' },
  { key: 'hba1c', name: 'HbA1c', specimen: 'Whole blood (EDTA)', classification: 'Chemistry', aliases: ['Glycated haemoglobin', 'A1c'], loinc: '4548-4' },
  { key: 'eucr', name: 'Electrolytes, urea and creatinine', specimen: 'Serum', classification: 'Chemistry', aliases: ['E/U/Cr', 'EUCr', 'U&E', 'Urea and electrolytes'] },
  { key: 'creatinine', name: 'Serum creatinine', specimen: 'Serum', classification: 'Chemistry', aliases: ['Creatinine', 'Cr'], loinc: '2160-0' },
  { key: 'lft', name: 'Liver function tests', specimen: 'Serum', classification: 'Chemistry', aliases: ['LFT', 'Liver panel'], loinc: '24325-3' },
  { key: 'lipids', name: 'Lipid profile', specimen: 'Serum', classification: 'Chemistry', aliases: ['Lipids', 'Cholesterol panel', 'Fasting lipid profile'], loinc: '24331-1' },
  { key: 'uric-acid', name: 'Serum uric acid', specimen: 'Serum', classification: 'Chemistry', aliases: ['Uric acid', 'Urate'], loinc: '3084-1' },
  { key: 'protein', name: 'Total protein and albumin', specimen: 'Serum', classification: 'Chemistry', aliases: ['TP and albumin', 'Serum proteins'] },
  // Urine and stool
  { key: 'urinalysis', name: 'Urinalysis (dipstick)', specimen: 'Urine', classification: 'Urine and stool', aliases: ['Urine test', 'Urine dipstick', 'U/A'], loinc: '24357-6' },
  { key: 'urine-microscopy', name: 'Urine microscopy', specimen: 'Urine', classification: 'Urine and stool', aliases: ['Urine sediment', 'Urine M/E'] },
  { key: 'stool-op', name: 'Stool microscopy (ova and parasites)', specimen: 'Stool', classification: 'Urine and stool', aliases: ['Stool O&P', 'Stool R/E', 'Stool microscopy'], loinc: '10704-5' },
  { key: 'fobt', name: 'Faecal occult blood', specimen: 'Stool', classification: 'Urine and stool', aliases: ['FOBT', 'Stool occult blood'], loinc: '2335-8' },
  // Microbiology
  { key: 'urine-mcs', name: 'Urine culture and sensitivity', specimen: 'Urine (midstream)', classification: 'Microbiology', aliases: ['Urine M/C/S', 'Urine MCS', 'Urine culture'], loinc: '630-4' },
  { key: 'blood-culture', name: 'Blood culture', specimen: 'Blood (culture bottle)', classification: 'Microbiology', aliases: ['Blood C/S', 'Blood MCS'], loinc: '600-7' },
  { key: 'wound-mcs', name: 'Wound swab culture and sensitivity', specimen: 'Wound swab', classification: 'Microbiology', aliases: ['Wound M/C/S', 'Wound swab MCS'], loinc: '6462-6' },
  { key: 'afb', name: 'Sputum AFB smear', specimen: 'Sputum', classification: 'Microbiology', aliases: ['AFB', 'ZN stain', 'Sputum for AFB'], loinc: '11545-1' },
  { key: 'genexpert', name: 'GeneXpert MTB/RIF', specimen: 'Sputum', classification: 'Microbiology', aliases: ['GeneXpert', 'Xpert', 'TB GeneXpert'], loinc: '89371-9' },
  { key: 'widal', name: 'Widal test', specimen: 'Serum', classification: 'Microbiology', aliases: ['Widal'] },
  // HIV care
  { key: 'cd4', name: 'CD4 count', specimen: 'Whole blood (EDTA)', classification: 'HIV care', aliases: ['CD4'], loinc: '24467-3' },
  { key: 'viral-load', name: 'HIV viral load', specimen: 'Plasma (EDTA)', classification: 'HIV care', aliases: ['VL', 'Viral load'], loinc: '20447-9' },
];

/** The coded concept a catalogue entry adopted from the standard list carries. */
export const standardConcept = (test: StandardTest) => test.loinc
  ? { system: LOINC_SYSTEM, code: test.loinc, label: test.name }
  : { system: STANDARD_TEST_SYSTEM, code: test.key, label: test.name };
