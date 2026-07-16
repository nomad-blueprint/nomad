import { create } from 'zustand';

export type ViewMode = 'solid' | 'wireframe' | 'xray';

interface UIStore {
  viewMode: ViewMode;
  setViewMode: (mode: ViewMode) => void;
  resetCameraKey: number;
  resetCamera: () => void;
}

export const useUIStore = create<UIStore>((set) => ({
  viewMode: 'solid',
  setViewMode: (viewMode) => set({ viewMode }),
  resetCameraKey: 0,
  resetCamera: () => set((s) => ({ resetCameraKey: s.resetCameraKey + 1 })),
}));
