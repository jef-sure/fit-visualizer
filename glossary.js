const GLOSSARY = {
  normalizedPower: 'Normalized Power (NP): a weighted power estimate that reflects the physiological cost of variable efforts.',
  intensityFactor: 'Intensity Factor (IF): normalized power divided by FTP; it expresses ride intensity relative to threshold.',
  trainingStressScore: 'Training Stress Score (TSS): a power-based estimate of training load that combines duration and intensity.',
  xpower: 'xPower: GoldenCheetah\'s exponentially weighted estimate of the physiological cost of variable power.',
  relativeIntensity: 'Relative Intensity (RI): xPower divided by FTP.',
  bikeStress: 'BikeStress: GoldenCheetah\'s power-based training-load score using xPower and Relative Intensity.',
  decoupling: 'Decoupling: the change in the relationship between power and heart rate from the first half of a ride to the second.',
  trimp: 'TRIMP: a heart-rate-based training impulse score that combines duration and heart-rate intensity.',
  hrTss: 'hrTSS: a heart-rate-based estimate of training stress when power-based TSS is unavailable.',
  vpower: 'Virtual power: a power estimate calculated from speed, grade, mass, and resistance assumptions; it is most reliable on climbs.',
  climb: 'Climb: a segment whose average grade exceeds the configured uphill threshold.',
  descent: 'Descent: a segment whose average grade exceeds the configured downhill threshold in the negative direction.',
  flat: 'Flat: a segment between the configured uphill and downhill grade thresholds.',
  stopped: 'Stopped: an interval detected from near-zero speed or a recording gap.',
  technical: 'Technical: a steep descent with highly variable speed, where an effort estimate is intentionally withheld.',
};

function localizeGlossary(localize) {
  const translate = typeof localize === 'function' ? localize : (text) => text;
  return Object.fromEntries(Object.entries(GLOSSARY).map(([term, description]) => [term, translate(description)]));
}

module.exports = { GLOSSARY, localizeGlossary };