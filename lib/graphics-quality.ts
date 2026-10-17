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
    description: 'A cleaner, brighter night with a lightweight rendering budget.',
    features: ['Improved edge clarity', 'Matte asphalt', 'Light winter atmosphere'],
    pixelBudget: 600_000, maxPixelRatio: .85, renderScale: .72,
    shadowSize: 512, shadowInterval: 16,
    bloomResolution: .6, bloomStrength: .31, anisotropy: 4,
    streetLights: 2, snowDensity: .3, detailScale: .7,
  },
  medium: {
    label: 'Medium', computer: 'Modern PCs / capable integrated graphics',
    description: 'The previous High quality, with crisp city detail and rich neon.',
    features: ['Full-resolution clarity', 'Detailed shadows', 'Weathered road surfaces', 'Layered northern lights'],
    pixelBudget: 2_500_000, maxPixelRatio: 1.5, renderScale: 1,
    shadowSize: 1536, shadowInterval: 4,
    bloomResolution: 1, bloomStrength: .44, anisotropy: 8,
    streetLights: 6, snowDensity: .8, detailScale: 1,
  },
  high: {
    label: 'High', computer: 'Gaming laptops / dedicated graphics',
    description: 'Finer surfaces, deeper lighting and beautifully resolved city silhouettes.',
    features: ['Enhanced scene clarity', '2K soft shadows', 'Detailed asphalt', 'Cinematic neon color', 'Extended city detail'],
    pixelBudget: 3_300_000, maxPixelRatio: 1.65, renderScale: 1.08,
    shadowSize: 2048, shadowInterval: 4,
    bloomResolution: 1.25, bloomStrength: .45, anisotropy: 12,
    streetLights: 7, snowDensity: .9, detailScale: 1.15,
  },
  ultra: {
    label: 'Ultra', computer: 'High-end gaming PCs',
    description: 'A luminous winter city with textured streets, delicate glow and cinematic depth.',
    features: ['Supersampled clarity', 'Focused 2K soft shadows', 'Detailed asphalt aggregate', 'Precision HDR neon', 'Sculpted winter surfaces', 'Full city atmosphere'],
    pixelBudget: 4_800_000, maxPixelRatio: 1.85, renderScale: 1.35,
    shadowSize: 2048, shadowInterval: 3,
    bloomResolution: 1.6, bloomStrength: .47, anisotropy: 16,
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
  // Medium now carries the former High workload. Basic integrated GPUs should
  // start with the lighter tier instead of spending their first drive overloaded.
  if (mobile || /intel.*(?:\bhd\b|uhd)|vega [3-8]\b/i.test(rendererName) || cores <= 4 || (memory !== undefined && memory <= 4)) return 'low';
  if (!rendererName || /intel|integrated|iris|radeon\(tm\) graphics|radeon.*\b[6-9]\d{2}m\b/i.test(rendererName)) return 'medium';
  // Chromium intentionally caps reported memory at 8 GB; this remains a suggestion.
  const flagship = /rtx\s*[345]0[789]\d|rx\s*(?:[67][89]\d{2}|90[789]\d)/i.test(rendererName);
  if (cores >= 16 && memory !== undefined && memory >= 8 && flagship) return 'ultra';
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
