import { atom } from "jotai";
import type { Id } from "@/convex/_generated/dataModel";

// Chat input state
export const inputAtom = atom<string>("");
export const isLoadingAtom = atom<boolean>(false);

// UI settings
export const scanlinesEnabledAtom = atom<boolean>(true);

// Agent pane tabs
export type AgentTab = "tree" | "state" | "history" | "commands" | "dev";
export const activeAgentTabAtom = atom<AgentTab>("tree");

// Tree subtabs
export type TreeSubtab = "server" | "client";
export const activeTreeSubtabAtom = atom<TreeSubtab>("server");

// History subtabs
export type HistorySubtab = "steps" | "turns" | "messages" | "branches";
export const activeHistorySubtabAtom = atom<HistorySubtab>("steps");

// Step preview state
export const selectedStepIdAtom = atom<Id<"machineSteps"> | null>(null);
export const stepPreviewInstanceAtom = atom<unknown | null>(null);
export const isPreviewingAtom = atom<boolean>(false);

// Theme state (synced from session instance)
export const themeHueAtom = atom<number>(120);
export const themeSaturationAtom = atom<number>(100);
export const themeAnimatedAtom = atom<boolean>(false); // flux mode
export const themeGradientAtom = atom<boolean>(false); // gradient overlay

// Derived: current display hue (animated when flux mode is on)
export const displayHueAtom = atom<number>(120);
