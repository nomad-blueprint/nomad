import type { InstalledPart } from '@/types';

export function encodeShareLink(parts: InstalledPart[]): string {
  try {
    const json = JSON.stringify(parts);
    const b64 = btoa(encodeURIComponent(json));
    const url = new URL(window.location.href);
    url.search = `?b=${encodeURIComponent(b64)}`;
    return url.toString();
  } catch {
    return window.location.href;
  }
}

export function decodeShareParam(b64: string): InstalledPart[] | null {
  try {
    const json = decodeURIComponent(atob(b64));
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return null;
    return parsed as InstalledPart[];
  } catch {
    return null;
  }
}
