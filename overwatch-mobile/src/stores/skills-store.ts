import { create } from "zustand";
import type { ActiveSkill } from "../types";

type SkillsStore = {
  skills: ActiveSkill[];
  replaceSkills: (skills: ActiveSkill[]) => void;
};

export const useSkillsStore = create<SkillsStore>((set) => ({
  skills: [],
  replaceSkills: (skills) => set({ skills }),
}));
