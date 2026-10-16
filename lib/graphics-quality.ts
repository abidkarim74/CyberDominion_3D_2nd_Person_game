export const GRAPHICS_QUALITY_LEVELS = ['low', 'medium', 'high', 'ultra'] as const;
export type GraphicsQuality = typeof GRAPHICS_QUALITY_LEVELS[number];

export type GraphicsPreset = {
  label: string;
  computer: string;
  description: string;
  features: readonly string[];
  pixelBudget: number;
  maxPixelRatio: number;
  renderScale: number;
  shadowSize: number;
  shadowInterval: number;
  reflectionSize: number;
  reflectionCadence: number;
  bloomResolution: number;
  bloomStrength: number;
  anisotropy: number;
  streetLights: number;
  snowDensity: number;
  detailScale: number;
};

/** Budgets describe rendering work, never vehicle physics or collision detail. */
export const GRAPHICS_PRESETS: Record<GraphicsQuality, GraphicsPreset> = {
  low: {
    label: 'Low', computer: 'Older PCs / basic laptops',
    description: 'Lightweight rendering for smooth city cruising.',
    features: ['Reduced resolution', 'Simple shadows', 'Light snowfall'],
    pixelBudget: 600_000, maxPixelRatio: .85, renderScale: .72,
    shadowSize: 512, shadowInterval: 16, reflectionSize: 128, reflectionCadence: 18,
    bloomResolution: .5, bloomStrength: .28, anisotropy: 2,
    streetLights: 2, snowDensity: .25, detailScale: .65,
  },
  medium: {
    label: 'Medium', computer: 'Everyday PCs / integrated graphics',
    description: 'Balanced clarity, neon atmosphere and performance.',
    features: ['Balanced resolution', 'Neon glow', 'Soft street reflections'],
    pixelBudget: 1_100_000, maxPixelRatio: 1.25, renderScale: .9,
    shadowSize: 768, shadowInterval: 9, reflectionSize: 256, reflectionCadence: 9,
    bloomResolution: .75, bloomStrength: .38, anisotropy: 4,
    streetLights: 4, snowDensity: .5, detailScale: .8,
  },
  high: {
    label: 'High', computer: 'Gaming laptops / dedicated graphics',
    description: 'Rich lighting and crisp detail throughout the city.',
    features: ['Crisp resolution', 'Detailed shadows', 'Rich reflections'],
    pixelBudget: 2_500_000, maxPixelRatio: 1.5, renderScale: 1,
    shadowSize: 1536, shadowInterval: 4, reflectionSize: 512, reflectionCadence: 4,
    bloomResolution: 1, bloomStrength: .44, anisotropy: 8,
    streetLights: 6, snowDensity: .8, detailScale: 1,
  },
  ultra: {
    label: 'Ultra', computer: 'High-end gaming PCs',
    description: 'The city at its finest. Cinematic clarity and luminous detail.',
    features: ['Supersampled clarity', '2K soft shadows', 'Live 1K reflections', 'Refined HDR neon', 'Full winter atmosphere'],
    pixelBudget: 5_500_000, maxPixelRatio: 2, renderScale: 1.35,
    shadowSize: 2048, shadowInterval: 1, reflectionSize: 1024, reflectionCadence: 1,
    bloomResolution: 2, bloomStrength: .46, anisotropy: 16,
    streetLights: 8, snowDensity: 1, detailScale: 1.3,
  },
};

export type GraphicsStatus = {
  preset: GraphicsQuality;
  recommended: GraphicsQuality;
  automatic: boolean;
  fps: number;
  resolutionScale: number;
};

const STORAGE_KEY = 'neon-nocturne.graphics.v1';
export const isGraphicsQuality = (value: unknown): value is GraphicsQuality =>
  typeof value === 'string' && GRAPHICS_QUALITY_LEVELS.includes(value as GraphicsQuality);

/** Browser signals only suggest a starting point; the player always has final control. */
export function recommendGraphicsQuality(rendererName: string, cores: number, memory?: number, mobile = false): GraphicsQuality {
  if (/swiftshader|llvmpipe|software|microsoft basic/i.test(rendererName) || cores <= 2 || (memory !== undefined && memory <= 2)) return 'low';
  if (mobile || /intel|integrated|iris|uhd|vega [3-8]\b/i.test(rendererName) || cores <= 4 || (memory !== undefined && memory <= 4)) return 'medium';
  // Chromium intentionally caps reported memory at 8 GB; this remains a suggestion.
  if (cores >= 16 && memory !== undefined && memory >= 8 && /nvidia|radeon|geforce/i.test(rendererName)) return 'ultra';
  return 'high';
}

export function loadGraphicsPreference(recommended: GraphicsQuality): Pick<GraphicsStatus, 'preset' | 'automatic'> {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (saved && isGraphicsQuality(saved.preset) && typeof saved.automatic === 'boolean') {
      return { preset: saved.preset, automatic: saved.automatic };
    }
  } catch { /* Private browsing or malformed storage: use the safe recommendation. */ }
  return { preset: recommended, automatic: true };
}

export function saveGraphicsPreference(preset: GraphicsQuality, automatic: boolean) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ preset, automatic })); }
  catch { /* Graphics controls still work when browser storage is unavailable. */ }
}
