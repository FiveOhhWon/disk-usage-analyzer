import type { AppSettings } from "./types";

export const defaultSettings: AppSettings = {
  recentRoots: [],
  favoriteRoots: [],
};

export function normalizeRoots(roots: string[], limit = 12): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const root of roots.slice().reverse()) {
    const trimmed = root.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    normalized.push(trimmed);
    if (normalized.length >= limit) {
      break;
    }
  }

  return normalized;
}

export function addRecentRoot(roots: string[], root: string, limit = 12): string[] {
  const trimmed = root.trim();
  if (!trimmed) {
    return normalizeRoots(roots, limit);
  }
  return [trimmed, ...roots.filter((candidate) => candidate !== trimmed)].slice(0, limit);
}

export function toggleFavorite(roots: string[], root: string): string[] {
  const trimmed = root.trim();
  if (!trimmed) {
    return roots;
  }
  if (roots.includes(trimmed)) {
    return roots.filter((candidate) => candidate !== trimmed);
  }
  return [...roots, trimmed];
}

export function sanitizeSettings(settings: Partial<AppSettings> | null | undefined): AppSettings {
  return {
    recentRoots: normalizeRoots(settings?.recentRoots ?? []),
    favoriteRoots: normalizeRoots(settings?.favoriteRoots ?? [], 24).reverse(),
  };
}
