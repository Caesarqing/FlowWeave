import { create } from "zustand";
import type { ActivePage } from "../types";

type NavigationState = {
  activePage: ActivePage;
  setActivePage: (activePage: ActivePage) => void;
};

export const useNavigationStore = create<NavigationState>((set) => ({
  activePage: "canvas",
  setActivePage: (activePage) => set({ activePage })
}));
