"use client";

import {
  ArrowDownUp, ArrowRight, ArrowUp, Award, Bot, CalendarClock, Check, ChevronDown, CircleHelp, ClipboardList,
  Clock, Egg, FastForward, Fish, History, LayoutDashboard, Leaf, Maximize2, Milk, Minimize2, Moon, Nut, Pause, Play,
  Plus, RefreshCw, RotateCcw, Search, ShieldCheck, ShoppingBasket, Sparkles, SlidersHorizontal, Square, Sun,
  Tag, Trash2, Wheat,
} from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";
import Image from "next/image";
import OrderReview from "./components/order-review";
import RequestPlanner from "./components/request-planner";
import AgentManagement from "./components/agent-management";
import DecisionFlowDiagram from "./components/decision-flow-diagram";
import WebImageReferences, { ProductThumbnail } from "./components/web-image-references";
import { AgentIcon, CartIcon, ApprovalIcon, ApprovedIcon } from "./components/dashboard-icons";
import { createBrowserPreview, type ActivityEvent, type Agent } from "./lib/browser-preview";
import {
  api, errorMessage, formatOrderItemCapacity, money, orderRequester, sampleProducts, statusLabels,
  type AgentExecutionResult, type Allergen, type Availability, type BlockedAllergenMatches,
  type ClockAdvanceResponse, type Guardrails, type Order, type PriorityMode, type Product,
  type ScheduledOrderCadence, type ScheduledOrderRule, type ScheduleWorkspaceState,
} from "./lib/purchasing";

const allergens = [
  { name: "milk", label: "Milk", Icon: Milk },
  { name: "gluten", label: "Gluten", Icon: Wheat },
  { name: "soy", label: "Soy", Icon: Leaf },
  { name: "eggs", label: "Eggs", Icon: Egg },
  { name: "nuts", label: "Nuts", Icon: Nut },
  { name: "fish", label: "Fish", Icon: Fish },
] as const;

const priorityOptions: { id: PriorityMode; label: string; shortLabel: string; hint: string; Icon: typeof Award }[] = [
  { id: "authentic_finnish", label: "Authentic Finnish Origin", shortLabel: "Finnish", hint: "FI / Blue Swan / Key Flag", Icon: Award },
  { id: "highest_reliability", label: "Highest Reliability", shortLabel: "Reliability", hint: "100% on-time delivery", Icon: ShieldCheck },
  { id: "low_carbon", label: "Lowest Carbon Footprint", shortLabel: "Low CO₂", hint: "Lowest kg CO₂e/kg", Icon: Leaf },
  { id: "lowest_price", label: "Lowest Price / Budget", shortLabel: "Lowest Price", hint: "Cheapest €/L or €/kg", Icon: Tag },
  { id: "balanced", label: "Balanced Overall", shortLabel: "Balanced", hint: "Reliability + CO₂ + Price", Icon: Sparkles },
];

const PREFS_STORAGE_KEY = "keittio:preferences:v1";
const THEME_STORAGE_KEY = "keittio:theme:v1";
type StoredKitchenPrefs = { onboarded: boolean; priority_modes: PriorityMode[]; review_allergens: Allergen[] };

function computeSmoothFastForwardRate(
  simNowMs: number,
  rules: ScheduledOrderRule[],
): { rate: number; slowingForRule: ScheduledOrderRule | null } {
  const future = rules
    .filter((r) => r.enabled && new Date(r.next_run_at).getTime() > simNowMs)
    .sort((a, b) => new Date(a.next_run_at).getTime() - new Date(b.next_run_at).getTime());
  const nextRule = future[0];
  if (!nextRule) return { rate: 14400, slowingForRule: null };
  const secsUntil = (new Date(nextRule.next_run_at).getTime() - simNowMs) / 1000;
  if (secsUntil <= 60) return { rate: 30, slowingForRule: nextRule };
  if (secsUntil <= 300) return { rate: 360, slowingForRule: nextRule };
  if (secsUntil <= 3600) return { rate: 3600, slowingForRule: null };
  return { rate: 21600, slowingForRule: null };
}

function parseSetupPreferencesFromChat(text: string): { allergens?: Allergen[]; priorities?: PriorityMode[] } | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (/^(?:check|substitutes?|order|find|search)\b/i.test(trimmed)) return null;
  if (/\b\d+(?:[.,]\d+)?\s*(?:tons?|tonnes?|t|litres?|liters?|l|kilograms?|kilos?|kg|grams?|g|packs?|units?|boxes|cases|sacks?|rolls?)\b/i.test(trimmed)) {
    return null;
  }
  const hasSetupIntent = /\b(?:priorit(?:y|ize|ies)|allerg(?:y|ies|en)|exclud(?:e|ing)|avoid|dietar(?:y|ies)|no\s+allerg|none|no\s+restriction|balanced\s+priority|use\s+balanced|keep\s+defaults?)\b/i.test(trimmed)
    || /^(?:no\s+(?:milk|gluten|soy|eggs?|nuts?|fish)|(?:milk|gluten|soy|eggs?|nuts?|fish)(?:\s*[,&+]\s*(?:milk|gluten|soy|eggs?|nuts?|fish))*)$/i.test(trimmed);
  if (!hasSetupIntent) return null;

  const detectedAllergens: Allergen[] = [];
  if (/\b(?:milk|dairy|lactose)\b/i.test(trimmed) && !/\ballerg(?:y|ies)\s*:\s*none\b/i.test(trimmed)) detectedAllergens.push("milk");
  if (/\bgluten\b/i.test(trimmed)) detectedAllergens.push("gluten");
  if (/\bsoy\b/i.test(trimmed)) detectedAllergens.push("soy");
  if (/\beggs?\b/i.test(trimmed)) detectedAllergens.push("eggs");
  if (/\bnuts?\b/i.test(trimmed)) detectedAllergens.push("nuts");
  if (/\bfish\b/i.test(trimmed)) detectedAllergens.push("fish");

  const detectedPriorities: PriorityMode[] = [];
  if (/\b(?:finnish|kotimainen|key\s*flag|blue\s*swan)\b/i.test(trimmed)) detectedPriorities.push("authentic_finnish");
  if (/\b(?:carbon|co2|sustainable|green|eco)\b/i.test(trimmed)) detectedPriorities.push("low_carbon");
  if (/\b(?:cheap|cheapest|lowest\s+price|price|budget)\b/i.test(trimmed)) detectedPriorities.push("lowest_price");
  if (/\b(?:reliab(?:le|ility)|on[- ]time)\b/i.test(trimmed)) detectedPriorities.push("highest_reliability");
  if (/\bbalanced\b/i.test(trimmed) && detectedPriorities.length === 0) detectedPriorities.push("balanced");

  const result: { allergens?: Allergen[]; priorities?: PriorityMode[] } = {};
  if (/\bno\s+allerg|allerg(?:y|ies)\s*:\s*none|no\s+restriction|^none\b/i.test(trimmed)) {
    result.allergens = [];
  } else if (detectedAllergens.length > 0 || /\ballerg|exclud|avoid|dietar/i.test(trimmed)) {
    result.allergens = detectedAllergens;
  }
  if (detectedPriorities.length > 0) {
    result.priorities = detectedPriorities;
  }
  if (result.allergens === undefined && result.priorities === undefined) return null;
  return result;
}

function formatOffsetLabel(offsetSeconds: number): string {
  if (offsetSeconds <= 0) return "Live";
  const daysCount = Math.floor(offsetSeconds / 86400);
  const hoursCount = Math.floor((offsetSeconds % 86400) / 3600);
  const minsCount = Math.floor((offsetSeconds % 3600) / 60);
  const parts: string[] = [];
  if (daysCount) parts.push(`${daysCount}d`);
  if (hoursCount) parts.push(`${hoursCount}h`);
  if (minsCount && !daysCount) parts.push(`${minsCount}m`);
  return `+${parts.join(" ") || "1m"}`;
}

type Workspace = { guardrails: Guardrails; orders: Order[]; supplier_mode: "demo" | "junction" };
type Message = {
  role: "agent" | "user";
  text: string;
  headline?: string;
  bullets?: { label: string; value: string; code?: string }[];
  execution?: AgentExecutionResult;
  thinking?: string[];
  products?: Product[];
  sample?: boolean;
  substitutedFor?: string;
  requestedDate?: string;
  requestedQuantity?: number;
};

function imageReferenceQuery(message: Message) {
  // Use the actual selected item (including a substitute), not the private chef request.
  return (message.execution?.order?.items?.[0]?.name
    || message.execution?.plans?.[0]?.options?.[0]?.product.name
    || message.products?.[0]?.name || "").slice(0, 200);
}
const prompts = [
  { label: "Auto-approve (<= €250)", text: "Agent: 20 L of lactose-free milk for Monday", liveText: "Agent: 20 L of lactose-free milk for Monday", Icon: Check },
  { label: "Challenge brief (1,000 L milk)", text: "Agent: 1000 L of lactose-free milk for Monday", liveText: "Agent: 1000 L of lactose-free milk for Monday", Icon: Sparkles },
  { label: "Stock-out substitution", text: "Agent: stockout 30 L of lactose-free milk for Monday", liveText: "Agent: stockout 30 L of lactose-free milk for Monday", Icon: ArrowDownUp },
  { label: "Finnish priority (15 kg tomatoes)", text: "Agent: 15 kg authentic Finnish tomatoes", liveText: "Agent: 15 kg authentic Finnish tomatoes", Icon: Leaf },
];
const zone = "Europe/Helsinki";
const dates = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: zone });
const clockTimes = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: zone });
const days = new Intl.DateTimeFormat("en-CA", { dateStyle: "short", timeZone: zone });
const navigation = [
  { id: "overview", label: "Overview", Icon: LayoutDashboard },
  { id: "approvals", label: "Approvals", Icon: ClipboardList },
  { id: "agents", label: "Agents", Icon: Bot },
  { id: "policies", label: "Policies", Icon: ShieldCheck },
  { id: "activity", label: "Activity", Icon: History },
  { id: "demo", label: "Demo tools", Icon: ShoppingBasket },
] as const;
type View = (typeof navigation)[number]["id"];
const headings: Record<View, [string, string]> = {
  overview: ["Purchasing overview", "Monitor purchase orders and decisions across your workspace."],
  approvals: ["Approval Centre", "Review orders that need a human decision."],
  agents: ["Connected agents", "View external purchasing agent connections and permissions."],
  policies: ["Purchasing policies", "Manage the approval rules for this workspace."],
  activity: ["Order activity", "Inspect recorded orders, their latest status and approval reasons."],
  demo: ["Purchasing demo tools", "Try catalog lookup, quantity review and mock ordering."],
};

function describeOrder(order: Order) {
  return order.items.map((item) => `${item.quantity} × ${item.name}`).join(", ");
}

export default function Dashboard() {
  const [preview, setPreview] = useState(false);
  const [previewVersion, setPreviewVersion] = useState(0);
  const previewClient = useRef<ReturnType<typeof createBrowserPreview> | null>(null);
  if (!previewClient.current) previewClient.current = createBrowserPreview();
  const request = preview ? previewClient.current.request : api;
  const [serviceAgents, setServiceAgents] = useState<Agent[]>([]);
  const [serviceEvents, setServiceEvents] = useState<ActivityEvent[]>([]);
  const agents = preview ? previewClient.current.agents() : serviceAgents;
  const events = preview ? previewClient.current.events() : serviceEvents;
  const [view, setView] = useState<View>("overview");
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [draft, setDraft] = useState<Guardrails | null>(null);
  const [workspaceError, setWorkspaceError] = useState("");
  const [actionError, setActionError] = useState("");
  const [activeAction, setActiveAction] = useState("");
  const [decisionNotice, setDecisionNotice] = useState("");
  const [settingsSaved, setSettingsSaved] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [thinkingProgress, setThinkingProgress] = useState(0);
  const [showRecurringStrip, setShowRecurringStrip] = useState(true);
  const [selection, setSelection] = useState<{ product: Product; sample: boolean; quantity?: number; date?: string; substitutedFor?: string } | null>(null);
  const [showSamples, setShowSamples] = useState(false);
  const [scheduleState, setScheduleState] = useState<ScheduleWorkspaceState | null>(null);
  const [isFastForwarding, setIsFastForwarding] = useState(false);
  const [clockOpen, setClockOpen] = useState(false);
  const [visualSimNowMs, setVisualSimNowMs] = useState<number>(() => Date.now());
  const [showScheduleForm, setShowScheduleForm] = useState(false);
  const [schedPrompt, setSchedPrompt] = useState("20 L lactose-free milk");
  const [schedCadence, setSchedCadence] = useState<ScheduledOrderCadence>("daily");
  const [schedTime, setSchedTime] = useState("07:00");
  const [showSetupDialog, setShowSetupDialog] = useState(false);
  const [needsInitialSetup, setNeedsInitialSetup] = useState(false);
  const [isChatFullscreen, setIsChatFullscreen] = useState(false);
  const [darkMode, setDarkMode] = useState(false);
  const clockTickBusy = useRef(false);
  const clockSeqRef = useRef(0);
  const visualExtraMsRef = useRef(0);
  const scheduleStateRef = useRef<ScheduleWorkspaceState | null>(null);
  const prefsBootstrapped = useRef(false);
  const chatLogRef = useRef<HTMLDivElement>(null);
  const chatEnd = useRef<HTMLDivElement>(null);
  const chatInput = useRef<HTMLInputElement>(null);
  const reviewAnchor = useRef<HTMLDivElement>(null);

  function readStoredPrefs(): StoredKitchenPrefs | null {
    if (typeof window === "undefined") return null;
    try {
      const raw = window.localStorage.getItem(PREFS_STORAGE_KEY);
      if (!raw) return null;
      return JSON.parse(raw) as StoredKitchenPrefs;
    } catch {
      return null;
    }
  }

  function saveStoredPrefs(next: StoredKitchenPrefs) {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(PREFS_STORAGE_KEY, JSON.stringify(next));
    } catch {
      /* Ignore storage quota errors */
    }
  }

  function activePriorityList(g?: Guardrails | null): PriorityMode[] {
    if (g?.priority_modes?.length) return g.priority_modes;
    return [g?.priority_mode ?? "balanced"];
  }

  async function refreshSideData(signal?: AbortSignal) {
    try {
      const sched = await request<ScheduleWorkspaceState>("schedules", "GET", undefined, signal);
      if (!signal?.aborted) setScheduleState(sched);
    } catch {
      /* Schedules optional if older backend */
    }
    if (preview) return;
    try {
      const [nextAgents, nextEvents] = await Promise.all([
        request<Agent[]>("agents", "GET", undefined, signal),
        request<ActivityEvent[]>("events", "GET", undefined, signal),
      ]);
      if (signal?.aborted) return;
      setServiceAgents(nextAgents);
      setServiceEvents(nextEvents);
    } catch {
      /* Ignore side-data error if workspace handles primary error */
    }
  }

  async function loadWorkspace(signal?: AbortSignal, keepDraft = false) {
    setWorkspaceError("");
    try {
      let data = await request<Workspace>("workspace", "GET", undefined, signal);
      if (signal?.aborted) return;
      if (!prefsBootstrapped.current) {
        prefsBootstrapped.current = true;
        const savedPrefs = readStoredPrefs();
        if (!savedPrefs?.onboarded) {
          setNeedsInitialSetup(true);
        } else {
          setNeedsInitialSetup(false);
          const mergedModes = savedPrefs.priority_modes?.length ? savedPrefs.priority_modes : activePriorityList(data.guardrails);
          const nextGuardrails: Guardrails = {
            ...data.guardrails,
            priority_mode: mergedModes[0],
            priority_modes: mergedModes,
            review_allergens: savedPrefs.review_allergens ?? data.guardrails.review_allergens,
          };
          const differs = JSON.stringify(nextGuardrails.priority_modes) !== JSON.stringify(activePriorityList(data.guardrails))
            || JSON.stringify(nextGuardrails.review_allergens) !== JSON.stringify(data.guardrails.review_allergens);
          if (differs) {
            try {
              const saved = await request<Guardrails>("guardrails", "PUT", nextGuardrails, signal);
              data = { ...data, guardrails: saved };
            } catch {
              /* Use workspace defaults if save skipped */
            }
          }
        }
      }
      setWorkspace(data);
      if (!keepDraft) {
        const modes = activePriorityList(data.guardrails);
        setDraft({ ...data.guardrails, priority_mode: modes[0], priority_modes: modes });
      }
      await refreshSideData(signal);
    } catch (error) {
      if (!signal?.aborted) setWorkspaceError(errorMessage(error));
    }
  }

  async function syncWorkspaceQuietly(signal?: AbortSignal) {
    try {
      const fresh = await request<Workspace>("workspace", "GET", undefined, signal);
      if (signal?.aborted) return;
      setWorkspace(fresh);
      await refreshSideData(signal);
    } catch {
      /* Ignore background sync error */
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    void loadWorkspace(controller.signal);
    return () => controller.abort();
  }, [preview, previewVersion]);

  useEffect(() => {
    if (!messages.length && !sending) return;
    const el = chatLogRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, sending]);

  useEffect(() => {
    if (selection) reviewAnchor.current?.focus({ preventScroll: view === "overview" });
  }, [selection, view]);

  function updateOrder(order: Order) {
    setWorkspace((previous) => previous && {
      ...previous,
      orders: [order, ...previous.orders.filter((entry) => entry.id !== order.id)],
    });
    void refreshSideData();
  }

  async function persistGuardrails(nextGuardrails: Guardrails, markOnboarded = false) {
    const previous = workspace?.guardrails;
    const modes = activePriorityList(nextGuardrails);
    const normalized: Guardrails = { ...nextGuardrails, priority_mode: modes[0], priority_modes: modes };
    setWorkspace((prev) => prev && { ...prev, guardrails: normalized });
    setDraft((prev) => (prev ? { ...normalized } : normalized));
    setActionError("");
    if (markOnboarded) setNeedsInitialSetup(false);
    saveStoredPrefs({
      onboarded: markOnboarded || Boolean(readStoredPrefs()?.onboarded),
      priority_modes: modes,
      review_allergens: normalized.review_allergens,
    });
    try {
      const saved = await request<Guardrails>("guardrails", "PUT", normalized);
      setWorkspace((prev) => prev && { ...prev, guardrails: saved });
      setDraft({ ...saved, priority_modes: activePriorityList(saved) });
      return saved;
    } catch (error) {
      if (previous) {
        setWorkspace((prev) => prev && { ...prev, guardrails: previous });
        setDraft(previous);
      }
      setActionError(errorMessage(error));
      return null;
    }
  }

  async function toggleCompanyAllergen(name: Allergen) {
    if (!workspace || activeAction || sending) return;
    const current = workspace.guardrails.review_allergens;
    const nextAllergens = current.includes(name)
      ? current.filter((item) => item !== name)
      : [...current, name];
    await persistGuardrails({ ...workspace.guardrails, review_allergens: nextAllergens }, true);
  }

  async function toggleCompanyPriority(mode: PriorityMode) {
    if (!workspace || activeAction || sending) return;
    const current = activePriorityList(workspace.guardrails);
    let nextModes: PriorityMode[];
    if (mode === "balanced") {
      nextModes = ["balanced"];
    } else {
      const withoutBalanced = current.filter((m) => m !== "balanced");
      nextModes = withoutBalanced.includes(mode)
        ? withoutBalanced.filter((m) => m !== mode)
        : [...withoutBalanced, mode];
      if (!nextModes.length) nextModes = ["balanced"];
    }
    await persistGuardrails({ ...workspace.guardrails, priority_mode: nextModes[0], priority_modes: nextModes }, true);
  }

  async function advanceClock(options: { days?: number; hours?: number; minutes?: number; seconds?: number; jump_to_next_schedule?: boolean; reset?: boolean }) {
    if (activeAction || sending || (!options.reset && clockTickBusy.current)) return;
    const reqId = ++clockSeqRef.current;
    clockTickBusy.current = true;
    setActionError("");
    if (options.reset) {
      setIsFastForwarding(false);
      visualExtraMsRef.current = 0;
      setVisualSimNowMs(Date.now());
    }
    try {
      const res = await request<ClockAdvanceResponse>("clock/advance", "POST", options);
      if (reqId !== clockSeqRef.current) return;
      const nextState: ScheduleWorkspaceState = { simulated_now: res.simulated_now, real_now: res.real_now, offset_seconds: res.offset_seconds, rules: res.rules };
      scheduleStateRef.current = nextState;
      setScheduleState(nextState);
      visualExtraMsRef.current = 0;
      setVisualSimNowMs(Date.now() + res.offset_seconds * 1000);
      if (res.executed_runs.length > 0) {
        const createdOrders = res.executed_runs
          .map((run) => run.execution.order)
          .filter((order): order is Order => Boolean(order));
        if (createdOrders.length > 0) {
          setWorkspace((prev) => {
            if (!prev) return prev;
            const createdIds = new Set(createdOrders.map((o) => o.id));
            return {
              ...prev,
              orders: [...createdOrders, ...prev.orders.filter((o) => !createdIds.has(o.id))],
            };
          });
        }
        const newMessages: Message[] = res.executed_runs.flatMap((run) => [
          {
            role: "user" as const,
            text: `Scheduled (${run.rule.id} @ ${run.rule.run_time}): ${run.rule.prompt}`,
          },
          {
            role: "agent" as const,
            headline: `Scheduled Auto-Buy Executed · ${run.rule.id}`,
            text: `${dates.format(new Date(run.scheduled_for))} — ${run.execution.summary}`,
            execution: run.execution,
            thinking: run.execution.decision_trace,
          },
        ]);
        setMessages((prev) => [...prev, ...newMessages]);
        void syncWorkspaceQuietly();
      } else if (options.reset || (options.seconds ?? 0) >= 3600 || options.hours || options.days) {
        void refreshSideData();
      }
    } catch (error) {
      setIsFastForwarding(false);
      setActionError(errorMessage(error));
    } finally {
      clockTickBusy.current = false;
    }
  }

  async function createScheduleRule(promptText: string, cadence?: ScheduledOrderCadence, runTime?: string) {
    setActionError("");
    const nextState = await request<ScheduleWorkspaceState>("schedules", "POST", {
      prompt: promptText,
      cadence,
      run_time: runTime,
    });
    setScheduleState(nextState);
    return nextState;
  }

  async function toggleScheduleRule(ruleId: string, enabled: boolean) {
    if (activeAction) return;
    setActionError("");
    try {
      const next = await request<ScheduleWorkspaceState>(`schedules/${ruleId}`, "PATCH", { enabled });
      setScheduleState(next);
    } catch (error) {
      setActionError(errorMessage(error));
    }
  }

  async function deleteScheduleRule(ruleId: string) {
    if (activeAction) return;
    setActionError("");
    try {
      const next = await request<ScheduleWorkspaceState>(`schedules/${ruleId}`, "DELETE");
      setScheduleState(next);
    } catch (error) {
      setActionError(errorMessage(error));
    }
  }

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(THEME_STORAGE_KEY);
      if (saved === "dark") {
        setDarkMode(true);
        document.documentElement.dataset.theme = "dark";
      }
    } catch {
      /* Ignore storage access issues */
    }
  }, []);

  function toggleTheme() {
    setDarkMode((prev) => {
      const next = !prev;
      const mode = next ? "dark" : "light";
      document.documentElement.dataset.theme = mode;
      try {
        window.localStorage.setItem(THEME_STORAGE_KEY, mode);
      } catch {
        /* Ignore storage errors */
      }
      return next;
    });
  }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsChatFullscreen(false);
        setShowSetupDialog(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    if (!decisionNotice) return;
    const timer = window.setTimeout(() => setDecisionNotice(""), 3500);
    return () => window.clearTimeout(timer);
  }, [decisionNotice]);

  useEffect(() => {
    if (!sending) return;
    const timer = window.setInterval(() => {
      setThinkingProgress((prev) => (prev >= 94 ? prev : Math.min(94, prev + Math.max(0.45, (94 - prev) * 0.055))));
    }, 80);
    return () => window.clearInterval(timer);
  }, [sending]);

  useEffect(() => {
    scheduleStateRef.current = scheduleState;
    if (!isFastForwarding && scheduleState) {
      setVisualSimNowMs(Date.now() + scheduleState.offset_seconds * 1000);
    }
  }, [scheduleState, isFastForwarding]);

  useEffect(() => {
    if (isFastForwarding) {
      let rafId = 0;
      let lastFrame = performance.now();
      let lastPaint = lastFrame;
      let lastSync = lastFrame;

      const stepFrame = (now: number) => {
        const dtSec = Math.min(0.1, Math.max(0, (now - lastFrame) / 1000));
        lastFrame = now;
        const st = scheduleStateRef.current;
        const baseSimMs = Date.now() + (st?.offset_seconds ?? 0) * 1000;
        const currentSimMs = baseSimMs + visualExtraMsRef.current;
        const enabledRules = (st?.rules ?? []).filter((r) => r.enabled);
        const alreadyDue = enabledRules.some((r) => new Date(r.next_run_at).getTime() <= currentSimMs);
        const { rate } = computeSmoothFastForwardRate(currentSimMs, enabledRules);

        if (!clockTickBusy.current && !sending && !activeAction && !alreadyDue) {
          let stepMs = dtSec * rate * 1000;
          const nextFuture = enabledRules
            .filter((r) => new Date(r.next_run_at).getTime() > currentSimMs)
            .sort((a, b) => new Date(a.next_run_at).getTime() - new Date(b.next_run_at).getTime())[0];
          if (nextFuture) {
            const stopAtMs = new Date(nextFuture.next_run_at).getTime() + 1000;
            if (currentSimMs + stepMs > stopAtMs) {
              stepMs = Math.max(0, stopAtMs - currentSimMs);
            }
          }
          visualExtraMsRef.current += stepMs;
        }
        const nextVisualMs = baseSimMs + visualExtraMsRef.current;

        if (now - lastPaint >= 33) {
          lastPaint = now;
          setVisualSimNowMs(nextVisualMs);
        }

        const crossedRule = enabledRules.some((r) => new Date(r.next_run_at).getTime() <= nextVisualMs);
        const pendingSecs = Math.max(0, Math.ceil(visualExtraMsRef.current / 1000));
        if ((crossedRule || (pendingSecs >= 3 && now - lastSync >= 650)) && !clockTickBusy.current && !sending && !activeAction) {
          lastSync = now;
          const delta = Math.max(1, pendingSecs);
          visualExtraMsRef.current = 0;
          void advanceClock({ seconds: delta });
        }

        rafId = window.requestAnimationFrame(stepFrame);
      };

      rafId = window.requestAnimationFrame(stepFrame);
      return () => window.cancelAnimationFrame(rafId);
    }

    const timer = window.setInterval(() => {
      const st = scheduleStateRef.current;
      const simNowMs = Date.now() + (st?.offset_seconds ?? 0) * 1000;
      setVisualSimNowMs(simNowMs);
      if (st && !clockTickBusy.current && !sending && !activeAction) {
        const hasDue = st.rules.some((r) => r.enabled && new Date(r.next_run_at).getTime() <= simNowMs);
        if (hasDue) void advanceClock({ seconds: 1 });
      }
    }, 1000);
    return () => window.clearInterval(timer);
  }, [isFastForwarding, sending, activeAction]);

  async function saveSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft || activeAction) return;
    setActiveAction("settings");
    setActionError("");
    try {
      const modes = activePriorityList(draft);
      const guardrails = await persistGuardrails({ ...draft, priority_mode: modes[0], priority_modes: modes }, true);
      if (guardrails) {
        setSettingsSaved(true);
        void refreshSideData();
      }
    } finally {
      setActiveAction("");
    }
  }

  async function decideOrder(id: string, decision: "approved" | "rejected") {
    if (activeAction) return;
    setActiveAction(id);
    setActionError("");
    setDecisionNotice("");
    try {
      const order = await request<Order>(`orders/${id}`, "PATCH", { decision });
      updateOrder(order);
      setDecisionNotice(`Order ${order.id}: ${statusLabels[order.status]}.`);
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setActiveAction("");
    }
  }

  async function respond(text: string): Promise<Omit<Message, "role">> {
    const setupUpdate = parseSetupPreferencesFromChat(text);
    if (setupUpdate && workspace) {
      const nextAllergens = setupUpdate.allergens !== undefined ? setupUpdate.allergens : workspace.guardrails.review_allergens;
      const nextModes = setupUpdate.priorities !== undefined ? setupUpdate.priorities : activePriorityList(workspace.guardrails);
      await persistGuardrails(
        {
          ...workspace.guardrails,
          review_allergens: nextAllergens,
          priority_mode: nextModes[0],
          priority_modes: nextModes,
        },
        true,
      );
      const priorityText = nextModes.map((m) => priorityOptions.find((o) => o.id === m)?.label ?? m).join(" + ");
      return {
        headline: "Kitchen Preferences Saved",
        text: "Your dietary exclusions and purchasing priorities are now active and remembered for future orders. What would you like to buy?",
        bullets: [
          { label: "Excluded Allergens", value: nextAllergens.length ? nextAllergens.join(", ") : "None" },
          { label: "Purchasing Priority", value: priorityText },
        ],
      };
    }

    const isScheduleIntent = /\b(?:every\s+day|daily|every\s+weekday|weekdays|every\s+week|weekly|every\s+morning|each\s+day|schedule)\b/i.test(text)
      || /\b(?:at\s+\d{1,2}[:.]\d{2})\b/i.test(text);
    if (isScheduleIntent) {
      const stateAfter = await createScheduleRule(text);
      const created = stateAfter.rules[0];
      void refreshSideData();
      return {
        headline: `Scheduled Auto-Buy Active · ${created.id}`,
        text: `Scheduled '${created.prompt}' (${created.cadence} at ${created.run_time} Helsinki). Open the Simulation Clock below Recent orders to speed up time — it will automatically slow down as it approaches ${created.run_time} and execute live.`,
        bullets: [
          { label: "Schedule Rule", value: `${created.cadence} @ ${created.run_time}`, code: created.id },
          { label: "Order Item", value: created.prompt },
          { label: "Next Execution", value: dates.format(new Date(created.next_run_at)) },
        ],
      };
    }

    const check = text.match(/^check\s+(\S+)(?:\s+(\d+))?(?:\s+(\d{4}-\d{2}-\d{2}))?$/i);
    const substitutes = text.match(/^substitutes?\s+(?:for\s+)?(\S+)$/i);
    const purchase = text.match(/^order\s+(\d+)\s+(\S+)$/i);
    const autonomousPrefix = text.match(/^(?:agent|auto|buy|order\s+me)\s*:?\s+(.+)$/i);
    const naturalVolumeRequest = !check && !substitutes && !purchase && !/^(?:find|search)\b/i.test(text)
      && /\b\d+(?:[.,]\d+)?\s*(?:tons?|tonnes?|t|litres?|liters?|l|kilograms?|kilos?|kg|grams?|g|packs?|units?|boxes|cases|sacks?|rolls?)\b/i.test(text);

    if ((autonomousPrefix || naturalVolumeRequest) && !purchase) {
      const rawPrompt = autonomousPrefix ? autonomousPrefix[1].trim() : text.trim();
      const simulateShortage = /\b(?:stockout|stock-out|shortage|out of stock)\b/i.test(rawPrompt);
      const promptText = rawPrompt.replace(/\b(?:stockout|stock-out|shortage|out of stock)\s*:?\s*/gi, "").trim();
      const baseModes = activePriorityList(workspace?.guardrails);
      const inferredPriority: PriorityMode | null = /\b(?:finnish|kotimainen)\b/i.test(promptText)
        ? "authentic_finnish"
        : /\b(?:carbon|co2|sustainable)\b/i.test(promptText)
          ? "low_carbon"
          : null;
      const effectiveModes = inferredPriority
        ? [inferredPriority, ...baseModes.filter((m) => m !== inferredPriority)]
        : baseModes;
      const cleanPrompt = promptText.replace(/\bauthentic\s+finnish\s+/gi, "").trim();
      const result = await request<AgentExecutionResult>("agent_execute", "POST", {
        prompt: cleanPrompt || promptText,
        agent_id: "kitchen",
        priority_mode: effectiveModes[0],
        priority_modes: effectiveModes,
        exclude_allergens: workspace?.guardrails.review_allergens ?? [],
        auto_place_order: true,
        simulate_shortage_on_primary: simulateShortage,
      });
      if (result.order) updateOrder(result.order);
      else void refreshSideData();
      return {
        headline: result.rejected
          ? "Request Rejected — Excluded Allergen Match"
          : result.order
            ? `Order ${result.order.id} — ${statusLabels[result.order.status]}`
            : "Procurement Plan Prepared",
        text: result.summary,
        execution: result,
        thinking: result.decision_trace,
      };
    }

    if (check) {
      const params = new URLSearchParams({ product_id: check[1], quantity: check[2] ?? "1" });
      if (check[3]) params.set("requested_date", check[3]);
      const result = await request<Availability>(`check_availability?${params}`);
      void refreshSideData();
      const stock = result.available_quantity === null
        ? "Valio did not confirm a quantity."
        : `${result.available_quantity} ${result.sales_unit ?? "packs"} available${result.available_date ? ` from ${result.available_date}` : ""}.`;
      const delivery = result.sales_block ? "This product is blocked for ordering." :
        result.available === true ? "The requested quantity is available." :
        result.available === false ? "The requested quantity is unavailable for the selected date." :
        "Delivery quantity or date could not be confirmed.";
      const price = result.unit_price_cents !== null && result.currency
        ? ` Unit price including tax: ${new Intl.NumberFormat("en-IE", { style: "currency", currency: result.currency }).format(result.unit_price_cents / 100)}.`
        : " Unit price unavailable.";
      return {
        text: `${result.name} · ${stock} ${delivery}${price}`,
        thinking: [
          `1. Permission Check: Kitchen Assistant 'search' verified`,
          `2. Live Valio Aimo Lookup: SKU ${check[1]} (${check[2] ?? "1"} units) -> ${result.available ? "In stock" : "Unavailable"} @ ${result.unit_price_cents != null ? money(result.unit_price_cents) : "N/A"}`,
        ],
      };
    }
    if (substitutes) {
      const params = new URLSearchParams({ product_id: substitutes[1] });
      if (workspace?.guardrails.priority_mode) params.set("priority_mode", workspace.guardrails.priority_mode);
      for (const allergen of workspace?.guardrails.review_allergens ?? []) params.append("exclude_allergens", allergen);
      const products = await request<Product[]>(`suggest_substitutes?${params}`);
      void refreshSideData();
      return {
        text: products.length ? "Review these alternatives against your dietary and delivery requirements." : "No alternatives were returned for the saved allergen settings.",
        products,
        substitutedFor: substitutes[1],
        thinking: [
          `1. Category & Dietary Filter: Same GS1 category · Excluded allergens: ${(workspace?.guardrails.review_allergens ?? []).join(", ") || "none"}`,
          `2. Priority Ranking (${workspace?.guardrails.priority_mode ?? "balanced"}): Ranked ${products.length} Good-Better-Best substitutes`,
        ],
      };
    }
    if (purchase) {
      const order = await request<Order>("create_purchase_order", "POST", {
        items: [{ product_id: purchase[2], quantity: Number(purchase[1]) }],
      });
      updateOrder(order);
      return {
        text: `${order.id} · ${describeOrder(order)} · ${money(order.total_cents)}. ${statusLabels[order.status]}.${order.reasons.length ? ` ${order.reasons.join(" · ")}.` : ""}`,
        thinking: order.decision_trace?.length ? order.decision_trace : [
          `1. Pack Math & Live Stock: ${purchase[1]} × SKU ${purchase[2]} locked`,
          `2. Guardrail & Quote Lock: ${order.id} · ${money(order.total_cents)} · ${statusLabels[order.status]} · ${order.trust_verification?.quote_lock_id ?? "keittio-valio-trust-v1"}`,
        ],
      };
    }
    if (/^(check|substitutes?|order)\b/i.test(text)) {
      return { text: "Use “Check SKU 12 YYYY-MM-DD” for price and availability, “Substitutes for SKU” to find alternatives, or type “1000 L of lactose-free milk for Monday” for autonomous ordering." };
    }
    const query = text.replace(/^(?:find|search(?: for)?)\s+/i, "").trim();
    const searchParams = new URLSearchParams({ query });
    if (workspace?.guardrails.priority_mode) searchParams.set("priority_mode", workspace.guardrails.priority_mode);
    const products = await request<Product[]>(`search_products?${searchParams}`);
    void refreshSideData();
    if (products.length === 0 && (workspace?.guardrails.review_allergens.length ?? 0) > 0) {
      const blockedParams = new URLSearchParams({ query });
      for (const alg of workspace?.guardrails.review_allergens ?? []) blockedParams.append("exclude_allergens", alg);
      if (workspace?.guardrails.priority_mode) blockedParams.set("priority_mode", workspace.guardrails.priority_mode);
      try {
        const blocked = await request<BlockedAllergenMatches>(`blocked_allergen_matches?${blockedParams}`);
        if (blocked.products.length > 0 && blocked.blocking_allergens.length > 0) {
          const algList = blocked.blocking_allergens.join(", ");
          const reason = `Products matched '${query}', but all were excluded by your allergen rules (${algList}). No order was placed.`;
          const trace = [
            `1. Category & Dietary Filter: Searched '${query}' · All catalog matches contain excluded company allergen(s): ${algList}.`,
            `2. Priority Ranking: 0 allergen-safe products available without (${algList}).`,
            "3. Pack Math & Live Stock: Skipped — no compliant SKU available.",
            `4. Guardrail & Quote Lock: REJECTED — ${reason}`,
          ];
          return {
            headline: "Request Rejected — Excluded Allergen Match",
            text: reason,
            thinking: trace,
            execution: {
              prompt: text,
              requested_date: days.format(new Date()),
              priority_mode: workspace?.guardrails.priority_mode ?? "balanced",
              orchestrator_model: "strict-allergen-filter",
              parsed_lines: [{ query, target_volume_liters_or_kg: 1, unit_hint: "L/kg", exclude_allergens: workspace?.guardrails.review_allergens ?? [] }],
              plans: [],
              order: null,
              rejected: true,
              rejection_reason: reason,
              rejected_products: blocked.products,
              decision_trace: trace,
              summary: `Rejected: ${reason}`,
            },
          };
        }
      } catch {
        /* Fallback to standard empty search message */
      }
    }
    const topMatch = products[0];
    const nextStep = "Select a product to choose a quantity and review price and availability.";
    return {
      text: products.length ? `I found ${products.length} catalog ${products.length === 1 ? "match" : "matches"}. Top pick: SKU ${topMatch.product_id} — "${topMatch.name}" (${topMatch.delivery_reliability != null ? `${(topMatch.delivery_reliability * 100).toFixed(0)}% on-time` : "verified"}). ${nextStep}` : "I couldn’t find a match. Try a product name, category, or SKU.",
      products,
      thinking: [
        `1. Category & Dietary Filter: Routed '${query}' -> GS1 category · Excluded allergens: ${(workspace?.guardrails.review_allergens ?? []).join(", ") || "none"}`,
        `2. Priority Ranking (${workspace?.guardrails.priority_mode ?? "balanced"}): Ranked ${products.length} SKUs · #1 SKU ${topMatch?.product_id ?? "N/A"} — "${topMatch?.name ?? "None"}"`,
      ],
    };
  }

  async function send(text: string) {
    const message = text.trim();
    if (!message || sending || activeAction || !workspace) return;
    setInput("");
    setMessages((previous) => [...previous, { role: "user", text: message }]);
    setThinkingProgress(6);
    setSending(true);
    let reply: Omit<Message, "role">;
    try {
      reply = await respond(message);
    } catch (error) {
      reply = { text: errorMessage(error) };
      void refreshSideData();
    }
    setThinkingProgress(100);
    await new Promise((resolve) => window.setTimeout(resolve, 180));
    setMessages((previous) => [...previous, { role: "agent", ...reply }]);
    setSending(false);
    setThinkingProgress(0);
  }

  const pending = workspace?.orders.filter((order) => order.status === "pending") ?? [];
  const liveSupplier = workspace?.supplier_mode === "junction";
  const audit = [...(workspace?.orders ?? [])].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  const today = days.format(scheduleState?.simulated_now ? new Date(scheduleState.simulated_now) : new Date());
  const changedToday = audit.filter((order) => days.format(new Date(order.updated_at)) === today).length;
  const automatic = audit.filter((order) => order.status === "auto_approved").length;
  const settingsChanged = Boolean(draft && workspace && (
    draft.max_auto_approve_cents !== workspace.guardrails.max_auto_approve_cents ||
    draft.review_allergens.length !== workspace.guardrails.review_allergens.length ||
    draft.review_allergens.some((name) => !workspace.guardrails.review_allergens.includes(name))
    || draft.min_delivery_reliability !== workspace.guardrails.min_delivery_reliability
    || draft.require_approval_on_substitution !== workspace.guardrails.require_approval_on_substitution
    || JSON.stringify(activePriorityList(draft)) !== JSON.stringify(activePriorityList(workspace.guardrails))
  ));

  async function refreshWorkspace() {
    if (activeAction || sending) return;
    setActiveAction("refresh");
    try {
      await loadWorkspace(undefined, settingsChanged);
    } finally {
      setActiveAction("");
    }
  }

  function activity(orders: Order[]) {
    if (!orders.length) {
      return <p className="empty">{workspace ? "No recorded orders yet." : workspaceError ? "Connect the purchasing service to see order activity." : "Loading order activity…"}</p>;
    }

    return <div className="activity-list">
      {orders.map((order) => {
        const leadItem = order.items[0];
        return <details key={order.id} className="activity-entry">
          <summary className="activity-summary">
            {leadItem ? (
              <div className="activity-item-media" onClick={(e) => e.stopPropagation()}>
                <ProductThumbnail productId={leadItem.product_id} query={leadItem.name} alt={leadItem.name} />
                {order.items.length > 1 && (
                  <span className="activity-more-badge" title={`${order.items.length} products in order`}>
                    +{order.items.length - 1}
                  </span>
                )}
              </div>
            ) : null}
            <div className="activity-summary-body">
              <strong>{order.id}</strong>
              <span className="order-products">{describeOrder(order)}</span>
              <span className="order-requester">{orderRequester(order)}</span>
              <time dateTime={order.updated_at}>{dates.format(new Date(order.updated_at))}</time>
            </div>
            <span className={`status ${order.status}`}><span />{statusLabels[order.status]}</span>
            <strong className="activity-total">{money(order.total_cents)}</strong>
          </summary>
          <div className="activity-details">
            <ul className="approval-items activity-items">
              {order.items.map((item, idx) => {
                const cap = formatOrderItemCapacity(item.quantity, item.unit);
                const lineCents = item.unit_price_cents != null ? item.unit_price_cents * item.quantity : null;
                return (
                  <li key={`${item.product_id}:${idx}`} className="approval-item-row">
                    <div className="approval-item-media">
                      <ProductThumbnail productId={item.product_id} query={item.name} alt={item.name} />
                    </div>
                    <div className="approval-item-main">
                      <span className="approval-item-name">{item.name}</span>
                      <span className="approval-item-sub">
                        <code>SKU {item.product_id}</code>
                        {cap.perPackLabel ? ` · ${cap.perPackLabel}` : ""}
                        {item.unit_price_cents != null ? ` · ${money(item.unit_price_cents)}/unit` : ""}
                      </span>
                    </div>
                    <div className="approval-item-metrics">
                      <strong>
                        {item.quantity.toLocaleString("en-GB")}×{cap.totalLabel ? ` (${cap.totalLabel})` : ` · ${item.unit}`}
                      </strong>
                      {lineCents != null && <span className="approval-item-price">{money(lineCents)}</span>}
                    </div>
                  </li>
                );
              })}
            </ul>
            {order.reasons.length > 0 && <ul>{order.reasons.map((reason, index) => <li key={index}>{reason}</li>)}</ul>}
            {order.decision_trace && order.decision_trace.length > 0 && (
              <div className="order-timeline">
                <h3>Agent decision steps</h3>
                <ol>{order.decision_trace.map((step, sIdx) => <li key={sIdx}><span>{step}</span></li>)}</ol>
              </div>
            )}
            {(preview || Boolean(workspace)) && events.some((event) => event.order_id === order.id) && <div className="order-timeline">
              <h3>Order history</h3>
              <ol>{events.filter((event) => event.order_id === order.id).map((event) => <li key={event.id}>
                <strong>{event.action}</strong><p>{event.detail}</p><time dateTime={event.timestamp}>{dates.format(new Date(event.timestamp))}</time>
              </li>)}</ol>
            </div>}
            {order.trust_verification && <dl className="review-facts">
              <div><dt>Verification protocol</dt><dd>{order.trust_verification.protocol}</dd></div>
              <div><dt>Verified at</dt><dd>{order.trust_verification.verified_at}</dd></div>
              <div><dt>Supplier mode</dt><dd>{order.trust_verification.supplier_mode}</dd></div>
              <div><dt>Requested delivery</dt><dd>{order.trust_verification.requested_delivery_date ?? "Unconfirmed"}</dd></div>
              {order.trust_verification.earliest_closing_time && <div><dt>Order cutoff</dt><dd>{order.trust_verification.earliest_closing_time}</dd></div>}
              {order.trust_verification.quote_lock_id && <div><dt>Quote lock ID</dt><dd><code>{order.trust_verification.quote_lock_id}</code></dd></div>}
              {order.trust_verification.signature_hmac_sha256 && <div><dt>HMAC-SHA256 signature</dt><dd><code>{order.trust_verification.signature_hmac_sha256.slice(0, 18)}…</code></dd></div>}
              {order.trust_verification.privacy_audit_summary && <div><dt>Privacy & margin protection</dt><dd>{order.trust_verification.privacy_audit_summary}</dd></div>}
            </dl>}
          </div>
        </details>;
      })}
    </div>;
  }

  async function findAlternatives(date: string, quantity: number) {
    if (!selection || activeAction || sending) return;
    setActiveAction("alternatives");
    setActionError("");
    try {
      const params = new URLSearchParams({ product_id: selection.product.product_id });
      if (date) params.set("requested_date", date);
      for (const name of workspace?.guardrails.review_allergens ?? []) params.append("exclude_allergens", name);
      const products = await request<Product[]>(`suggest_substitutes?${params}`);
      setMessages((previous) => [...previous, { role: "agent", text: products.length ? "Review the proposed replacements and their trade-offs. Check pack sizes before confirming quantities." : "No alternatives were returned.", products, substitutedFor: selection.product.product_id, requestedDate: date, requestedQuantity: quantity }]);
      setView("overview");
    } catch (cause) {
      setActionError(errorMessage(cause));
    } finally {
      setActiveAction("");
    }
  }

  function productCards(products: Product[], sample = false, substitutedFor?: string, requestedDate?: string, requestedQuantity?: number) {
    return products.map((product) => (
      <article className="product-card" key={product.product_id}>
        <div className="product-card-heading">
          <div><h3>{product.name}</h3><p>{product.unit} · {product.product_id}</p></div>
          <span className="product-price">{product.unit_price_cents == null ? "Price unconfirmed" : money(product.unit_price_cents)}<small>per sales unit</small></span>
        </div>
        <div className="product-details">
          <span className={`stock-label ${product.stock === 0 ? "attention" : ""}`}>{product.stock == null ? "Stock not confirmed" : product.stock === 0 ? "Out of stock" : `${product.stock} sales units in catalog`}</span>
          <span>{product.allergens == null ? "Allergens unknown" : product.allergens.length ? `Contains: ${product.allergens.join(", ")}` : "No allergens listed"}</span>
        </div>
        <dl className="product-comparison">
          <div><dt>Delivery reliability</dt><dd>{product.delivery_reliability == null ? "Unconfirmed" : `${(product.delivery_reliability * 100).toFixed(1)}%`}</dd></div>
          <div><dt>Supplier sustainability labels</dt><dd>{product.sustainability_labels?.join(", ") || "No labels supplied"}</dd></div>
          <div><dt>Dietary claims</dt><dd>{product.dietary_claims?.join(", ") || "Unconfirmed"}</dd></div>
          {product.ingredients_text && <div><dt>Ingredients</dt><dd>{product.ingredients_text}</dd></div>}
          {product.comparison_price_cents != null && product.comparison_unit && <div><dt>Comparison price</dt><dd>{money(product.comparison_price_cents)} / {product.comparison_unit}</dd></div>}
        </dl>
        {product.substitute_reason && <p className="decision-note">{product.substitute_tier && <strong>{product.substitute_tier} · </strong>}{product.substitute_reason}</p>}
        <div className="product-card-footer">
          <small>{sample ? "Illustrative sample · not supplier data" : "Check availability before ordering"}</small>
          <button type="button" className="secondary-button" disabled={Boolean(activeAction) || sending} onClick={() => setSelection({ product, sample, substitutedFor, date: requestedDate, quantity: requestedQuantity })}>Review product <ArrowRight size={14} /></button>
        </div>
      </article>
    ));
  }

  function switchMode(nextPreview: boolean) {
    if (activeAction || sending) return;
    setWorkspace(null);
    setDraft(null);
    setWorkspaceError("");
    setActionError("");
    setDecisionNotice("");
    setSettingsSaved(false);
    setMessages([]);
    setSelection(null);
    setShowSamples(false);
    setInput("");
    setPreview(nextPreview);
  }

  return (
    <div className="min-h-screen">
      <header className="topbar">
        <div className="topbar-inner">
          <button className="brand-home" type="button" aria-label="KeittiöMCP overview" onClick={() => setView("overview")}>
            <Image src="/branding/keittio-wordmark.png" alt="Keittiö" width={1120} height={500} className="brand-logo" priority />
            <span className="brand-mcp">MCP</span>
          </button>
          <nav className="control-nav" aria-label="KeittiöMCP workspace">
            {navigation.map(({ id, label }) => <button type="button" key={id} aria-current={view === id ? "page" : undefined} onClick={() => setView(id)}>
              {label}{id === "approvals" && pending.length > 0 && <span className="count">{pending.length}</span>}
            </button>)}
          </nav>
          <div className="mode-controls">
            <span className={`demo-label ${!workspace || workspaceError ? "disconnected" : ""}`} role="status"><span /> {preview ? "Browser preview" : workspaceError ? workspace ? "Connection lost" : "Service disconnected" : workspace ? liveSupplier ? "Junction mock connection" : "Demo workspace" : "Connecting…"}</span>
            <div className="mode-controls-buttons">
              <button
                className="secondary-button theme-toggle-btn"
                type="button"
                aria-pressed={darkMode}
                title={darkMode ? "Switch to light theme" : "Switch to dark theme"}
                onClick={toggleTheme}
              >
                {darkMode ? <Sun size={13} /> : <Moon size={13} />}
                <span>{darkMode ? "Light" : "Dark"}</span>
              </button>
              {preview && <button className="secondary-button" type="button" disabled={Boolean(activeAction) || sending} onClick={() => switchMode(false)}>Use service connection</button>}
            </div>
          </div>
        </div>
        <svg className="header-wave" viewBox="0 0 1440 80" preserveAspectRatio="none" aria-hidden="true" focusable="false">
          <path d="M0 42 C180 -8 330 -8 570 24 S1260 110 1440 36 L1440 0 H0 Z" />
        </svg>
      </header>

      <main className="shell">
        <div className="overview">
          <div>
            <p className="page-eyebrow">Purchasing control centre</p>
            <h1>{headings[view][0]}</h1>
            <p>{headings[view][1]}</p>
          </div>
          <button className="secondary-button refresh-button" type="button" disabled={Boolean(activeAction) || sending || (!workspace && !workspaceError)} onClick={() => void refreshWorkspace()}>
            <RefreshCw size={15} aria-hidden="true" />{activeAction === "refresh" ? "Refreshing…" : "Refresh workspace"}
          </button>
        </div>

        {preview && <div className="preview-banner" role="status">
          <div><strong>Browser preview · simulated data</strong><p>Changes stay in this browser session and reset when you reload.</p></div>
          <button type="button" className="text-button" disabled={Boolean(activeAction) || sending} onClick={() => { previewClient.current = createBrowserPreview(); setMessages([]); setSelection(null); setDecisionNotice(""); setSettingsSaved(false); setPreviewVersion((value) => value + 1); }}>Reset preview</button>
        </div>}

        {workspaceError && <div className="connection-notice" role="status">
          <div><strong>{workspace ? "Showing the last loaded workspace" : "The purchasing service is disconnected"}</strong><p>Use Refresh workspace to retry the connection.</p></div>
          {!workspace && view !== "overview" && <button type="button" className="secondary-button" onClick={() => { setShowSamples(true); setView("overview"); }}>Explore sample products</button>}
        </div>}
        {actionError && <p className="error workspace-error" role="alert">{actionError}</p>}
        {decisionNotice && view !== "approvals" && <p className="decision-feedback" role="status">{decisionNotice}</p>}

        {view === "agents" && (preview || Boolean(workspace)) && <AgentManagement agents={agents} request={request} busy={Boolean(activeAction) || sending} onBusy={setActiveAction} onChanged={() => void loadWorkspace(undefined, true)} />}
        {view === "agents" && !preview && !workspace && <section className="panel control-empty">
          <Bot size={24} aria-hidden="true" />
          <h2>Agent data unavailable</h2>
          <p>The current workspace API provides orders and shared purchasing policies. Agent identities, permissions, per-agent limits and last activity require an agent management API.</p>
          <button type="button" className="secondary-button" onClick={() => switchMode(true)}>Try agent management in browser preview</button>
        </section>}

        {view === "demo" && <RequestPlanner key={`${preview}:${previewVersion}`} request={request} connected={Boolean(workspace) && !workspaceError} busy={Boolean(activeAction) || sending} onBusy={setActiveAction}
          onSelect={(product, quantity, date) => setSelection({ product, sample: false, quantity, date })} />}
        <div className={`dashboard-grid ${view === "overview" ? "home-purchasing" : "demo-review"}`} hidden={view !== "demo" && view !== "overview"}>
          {view === "overview" && <section className={`panel chat-panel ${isChatFullscreen ? "is-fullscreen" : ""}`} aria-labelledby="chat-title">
            <div className="chat-header">
              <div className="chat-icon"><Bot size={23} strokeWidth={1.75} /></div>
              <div>
                <h2 id="chat-title">Purchasing assistant</h2>
                <p><span className={workspace ? "online-dot" : "offline-dot"} /> {preview ? "Using the simulated catalog" : workspace ? "Connected to purchasing service" : workspaceError ? "Waiting for purchasing service" : "Connecting…"}</p>
              </div>
              <div className="chat-header-actions">
                <span className="supplier-label">{preview ? "Sample catalog" : "Valio Aimo catalog"}</span>
                <button
                  type="button"
                  className="chat-fullscreen-btn"
                  aria-pressed={isChatFullscreen}
                  title={isChatFullscreen ? "Exit fullscreen chat (Esc)" : "Expand chat fullscreen"}
                  onClick={() => setIsChatFullscreen((v) => !v)}
                >
                  {isChatFullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
                  <span>{isChatFullscreen ? "Exit fullscreen" : "Fullscreen"}</span>
                </button>
              </div>
            </div>

            {workspace && (
              <div className="kitchen-setup-wrap">
                <div className="kitchen-setup-bar">
                  <div className="kitchen-setup-summary">
                    <span className={`setup-summary-pill ${workspace.guardrails.review_allergens.length > 0 ? "is-warn" : ""}`}>
                      <ShieldCheck size={12} />
                      {workspace.guardrails.review_allergens.length > 0
                        ? `Excluded: ${workspace.guardrails.review_allergens.join(", ")}`
                        : "No allergens excluded"}
                    </span>
                    <span className="setup-summary-pill">
                      <Award size={12} />
                      Priority: {activePriorityList(workspace.guardrails).map((m) => priorityOptions.find((o) => o.id === m)?.shortLabel ?? m).join(" + ")}
                    </span>
                    {!showRecurringStrip && (
                      <button
                        type="button"
                        className="schedule-restore-btn"
                        onClick={() => setShowRecurringStrip(true)}
                      >
                        <CalendarClock size={12} /> Show auto-buys
                      </button>
                    )}
                  </div>
                  <button
                    type="button"
                    className={`kitchen-setup-toggle ${showSetupDialog ? "is-open" : ""}`}
                    aria-expanded={showSetupDialog}
                    onClick={() => setShowSetupDialog((v) => !v)}
                  >
                    <SlidersHorizontal size={13} />
                    <span>Keittiö Setup</span>
                    <ChevronDown size={14} className="setup-chevron" />
                  </button>
                </div>

                {showRecurringStrip && (
                  <div className="kitchen-schedule-strip" role="region" aria-label="Recurring and timed auto-buys">
                    <div className="kitchen-schedule-strip-head">
                      <span className="kitchen-schedule-title">
                        <CalendarClock size={13} /> Recurring &amp; timed auto-buys
                        {(scheduleState?.rules.filter((r) => r.enabled).length ?? 0) > 0 && (
                          <span className="setup-summary-pill is-accent">{scheduleState?.rules.filter((r) => r.enabled).length} active</span>
                        )}
                      </span>
                      <div className="kitchen-schedule-strip-actions">
                        <button type="button" className="text-button quick-setup-btn" onClick={() => setShowScheduleForm((v) => !v)}>
                          <Plus size={13} /> {showScheduleForm ? "Close form" : "Schedule auto-buy"}
                        </button>
                        <button type="button" className="text-button schedule-hide-btn" onClick={() => setShowRecurringStrip(false)}>
                          Hide
                        </button>
                      </div>
                    </div>
                  {showScheduleForm && (
                    <form className="schedule-inline-form" onSubmit={(e) => {
                      e.preventDefault();
                      if (!schedPrompt.trim()) return;
                      void createScheduleRule(schedPrompt.trim(), schedCadence, schedTime).then(() => {
                        setSchedPrompt("");
                      }).catch((err) => setActionError(errorMessage(err)));
                    }}>
                      <input
                        type="text"
                        value={schedPrompt}
                        maxLength={200}
                        placeholder="e.g. 20 L of banana yogurt"
                        onChange={(e) => setSchedPrompt(e.target.value)}
                      />
                      <select value={schedCadence} onChange={(e) => setSchedCadence(e.target.value as ScheduledOrderCadence)}>
                        <option value="daily">Every day</option>
                        <option value="weekdays">Weekdays</option>
                        <option value="weekly">Weekly</option>
                        <option value="once">Once (next)</option>
                      </select>
                      <input type="time" value={schedTime} onChange={(e) => setSchedTime(e.target.value)} />
                      <button type="submit" className="secondary-button">Add</button>
                      <button
                        type="button"
                        className="text-button"
                        onClick={() => {
                          void (async () => {
                            try {
                              await createScheduleRule("20 L of banana yogurt", "daily", "07:00");
                              await createScheduleRule("30 L lactose-free milk", "daily", "07:15");
                              await createScheduleRule("15 kg bell pepper", "daily", "07:30");
                            } catch (err) {
                              setActionError(errorMessage(err));
                            }
                          })();
                        }}
                      >
                        +3 shop orders
                      </button>
                    </form>
                  )}
                  {scheduleState && scheduleState.rules.length > 0 ? (
                    <div className="schedule-pills-list">
                      {scheduleState.rules.map((rule) => (
                        <div key={rule.id} className={`schedule-rule-pill ${rule.enabled ? "" : "is-paused"}`}>
                          <div>
                            <strong>{rule.prompt}</strong>
                            <small>
                              <code>{rule.id}</code> · {rule.cadence} @ {rule.run_time} · Next: {dates.format(new Date(rule.next_run_at))}
                              {rule.runs_completed > 0 ? ` · Ran ${rule.runs_completed}×` : ""}
                            </small>
                          </div>
                          <div className="schedule-rule-actions">
                            <button type="button" title={rule.enabled ? "Pause" : "Resume"} onClick={() => void toggleScheduleRule(rule.id, !rule.enabled)}>
                              {rule.enabled ? <Pause size={12} /> : <Play size={12} />}
                            </button>
                            <button type="button" title="Delete schedule" onClick={() => void deleteScheduleRule(rule.id)}>
                              <Trash2 size={12} />
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="allergen-quickbar-note">
                      Tip: Click <strong>Schedule auto-buy</strong> or type <code>Every day at 07:00 buy 20 L lactose-free milk</code>, then speed up the clock below Recent orders to watch it buy live.
                    </p>
                  )}
                  </div>
                )}
              </div>
            )}

            <div ref={chatLogRef} className="chat-content" role="log" aria-label="Conversation">
              <div className="message">
                <div className="message-icon"><Sparkles size={16} /></div>
                <div className="message-body">
                  <span className="message-author">Purchasing assistant</span>
                  <div className="bubble welcome">
                    {needsInitialSetup ? (
                      <>
                        <strong>First-time kitchen setup — what are your dietaries &amp; priorities?</strong>
                        <p>
                          Before we start ordering, let me know if your kitchen needs to <strong>exclude any allergens</strong>{" "}
                          (milk, gluten, soy, eggs, nuts, fish) and <strong>which purchasing priority</strong> to optimize for
                          (Authentic Finnish, Lowest CO₂, Lowest Price, Delivery Reliability, or Balanced).
                        </p>
                        <div className="welcome-setup-actions">
                          <button type="button" className="primary-button" onClick={() => setShowSetupDialog(true)}>
                            <SlidersHorizontal size={13} /> Open Keittiö Setup
                          </button>
                          <button
                            type="button"
                            className="secondary-button"
                            onClick={() => {
                              if (!workspace) return;
                              void persistGuardrails({ ...workspace.guardrails }, true);
                            }}
                          >
                            No allergies · Use Balanced
                          </button>
                        </div>
                      </>
                    ) : (
                      <>
                        <strong>What are you sourcing today?</strong>
                        <p>Click a quick request below or type what you need (for example: “20 L of lactose-free milk for Monday”) to run the 4-step selection, quote-lock, and guardrail engine.</p>
                      </>
                    )}
                  </div>
                </div>
              </div>
              {showSamples && <section className="sample-results" aria-label="Sample product results">
                <div className="sample-heading"><span className="eyebrow">Design preview · sample data</span><button type="button" className="text-button" disabled={Boolean(activeAction)} onClick={() => { setShowSamples(false); if (selection?.sample) setSelection(null); }}>Hide samples</button></div>
                <p>Try a quantity and see the estimated cost. These examples are not connected to the purchasing service.</p>
                {productCards(sampleProducts, true)}
              </section>}
              {messages.map((message, index) => (
                <div key={index} className={`message ${message.role === "user" ? "user-message" : ""}`}>
                  {message.role === "agent" ? <div className="message-icon"><Sparkles size={16} /></div> : null}
                  <div className="message-body">
                    <span className="message-author">{message.role === "user" ? "You" : "Purchasing assistant"}</span>
                    {message.execution ? (
                      <DecisionFlowDiagram
                        execution={message.execution}
                        order={message.execution.order}
                        guardrails={workspace?.guardrails ?? null}
                        thinkingFallback={message.thinking}
                        onOpenApprovals={() => setView("approvals")}
                      />
                    ) : (
                      <>
                        <div className="bubble markdown-bubble">
                          {message.headline && <strong style={{ display: "block", marginBottom: 4 }}>{message.headline}</strong>}
                          {message.bullets && message.bullets.length > 0 ? (
                            <ul>
                              {message.bullets.map((b, bIdx) => (
                                <li key={bIdx}>
                                  <strong>{b.label}:</strong> {b.code && <><code>{b.code}</code> </>}{b.value}
                                </li>
                              ))}
                            </ul>
                          ) : (
                            <p style={{ margin: 0, color: "var(--ink)" }}>{message.text}</p>
                          )}
                        </div>
                        {message.role === "agent" && message.thinking && message.thinking.length > 0 && (
                          <DecisionFlowDiagram
                            guardrails={workspace?.guardrails ?? null}
                            thinkingFallback={message.thinking}
                            onOpenApprovals={() => setView("approvals")}
                          />
                        )}
                      </>
                    )}
                    {message.role === "agent" && !message.execution && imageReferenceQuery(message) && (
                      <WebImageReferences
                        query={imageReferenceQuery(message)}
                        productId={message.products?.[0]?.product_id}
                      />
                    )}
                    {message.products && productCards(message.products, Boolean(message.sample), message.substitutedFor, message.requestedDate, message.requestedQuantity)}
                  </div>
                </div>
              ))}
              {sending ? (
                <div className="message" role="status" aria-live="polite" aria-label="Purchasing assistant is thinking">
                  <div className="message-icon is-thinking"><Sparkles size={16} /></div>
                  <div className="message-body">
                    <span className="message-author">Purchasing assistant</span>
                    <div className="thinking-bubble">
                      <div className="thinking-status-row">
                        <span className="thinking-shimmer-text">Thinking</span>
                        <span className="thinking-pct">{Math.round(thinkingProgress)}%</span>
                      </div>
                      <div className="thinking-progress-track" aria-hidden="true">
                        <div className="thinking-progress-fill" style={{ width: `${Math.round(thinkingProgress)}%` }} />
                      </div>
                    </div>
                  </div>
                </div>
              ) : null}
              <div ref={chatEnd} />
            </div>

            <div className="chat-footer">
              <div className="prompts">
                {!workspace && workspaceError && !showSamples && <button type="button" onClick={() => setShowSamples(true)}>Explore sample products</button>}
                {prompts.map(({ label, text, liveText, Icon }) => (
                  <button type="button" key={label} disabled={sending || Boolean(activeAction) || !workspace} onClick={() => {
                    if (liveSupplier && text.startsWith("Find")) {
                      setInput(liveText);
                      chatInput.current?.focus();
                    } else {
                      void send(text);
                    }
                  }}><Icon size={14} /> {label}</button>
                ))}
              </div>
              <form className="composer" onSubmit={(event) => { event.preventDefault(); void send(input); }}>
                <label className="sr-only" htmlFor="chat-input">Message the purchasing assistant</label>
                <input ref={chatInput} id="chat-input" value={input} maxLength={120} disabled={!workspace} onChange={(event) => setInput(event.target.value)} placeholder={workspace ? "Try: 20 L of lactose-free milk for Monday" : "Connect the purchasing service to search"} />
                <button type="submit" aria-label="Send message" disabled={sending || Boolean(activeAction) || !workspace || !input.trim()}><ArrowUp size={19} /></button>
              </form>
              <p className="chat-note"><CircleHelp size={13} /> {preview ? "Simulated actions are recorded in this browser session." : workspace ? liveSupplier ? "Connected to Junction’s mock catalog." : "Demo orders are recorded locally." : "Sample preview is available above. Orders require a connection."}</p>
            </div>
          </section>}

          <aside className="right-panel" aria-label="Purchasing controls">
            <div ref={reviewAnchor} tabIndex={-1} className="review-anchor" hidden={!selection && view === "overview"}>
              {selection ? <OrderReview key={`${selection.sample}:${selection.product.product_id}:${selection.quantity}:${selection.date}:${selection.substitutedFor}`} product={selection.product} sample={selection.sample}
                request={request} preview={preview}
                initialQuantity={selection.quantity} initialDate={selection.date} substitutedFor={selection.substitutedFor}
                mode={workspace?.supplier_mode} guardrails={workspace?.guardrails ?? null} orders={workspace?.orders ?? []}
                busy={Boolean(activeAction) || sending} onBusy={setActiveAction} onCreated={updateOrder}
                onClose={() => setSelection(null)} onAlternatives={(date, quantity) => void findAlternatives(date, quantity)} /> :
                <section className="panel review-placeholder"><ShoppingBasket size={25} /><h2>Your selection, explained</h2><p>Select a product to choose a quantity, check availability, and review purchasing rules before ordering.</p></section>}
            </div>
            {view === "overview" && <section className="panel side-panel recent-orders" aria-labelledby="recent-activity">
              <div className="control-heading"><h2 id="recent-activity">Recent orders</h2><button type="button" className="text-button" onClick={() => setView("activity")}>View all <ArrowRight size={16} /></button></div>
              {activity(audit.slice(0, 5))}
              {preview && <p className="panel-footnote">Sample orders · changes reset on reload</p>}
            </section>}

            {view === "overview" && scheduleState && (() => {
              const dueRule = scheduleState.rules
                .filter((r) => r.enabled && new Date(r.next_run_at).getTime() <= visualSimNowMs)
                .sort((a, b) => new Date(a.next_run_at).getTime() - new Date(b.next_run_at).getTime())[0] ?? null;
              const { slowingForRule } = isFastForwarding && !dueRule
                ? computeSmoothFastForwardRate(visualSimNowMs, scheduleState.rules)
                : { slowingForRule: null };
              const nextRule = scheduleState.rules
                .filter((r) => r.enabled && new Date(r.next_run_at).getTime() > visualSimNowMs)
                .sort((a, b) => new Date(a.next_run_at).getTime() - new Date(b.next_run_at).getTime())[0];
              return (
                <section
                  className={`panel side-clock-card ${scheduleState.offset_seconds > 0 ? "is-future" : ""} ${isFastForwarding ? "is-fast" : ""} ${slowingForRule || dueRule ? "is-slowing" : ""}`}
                  aria-label="Simulation clock controller"
                >
                  <div className="side-clock-row">
                    <button
                      type="button"
                      className="side-clock-trigger"
                      aria-expanded={clockOpen}
                      onClick={() => setClockOpen((v) => !v)}
                    >
                      <span className="side-clock-icon"><Clock size={16} /></span>
                      <div className="side-clock-meta">
                        <strong>
                          <time dateTime={new Date(visualSimNowMs).toISOString()}>{clockTimes.format(new Date(visualSimNowMs))}</time>
                        </strong>
                        <small>
                          {dueRule
                            ? `Running ${dueRule.run_time} auto-buy (“${dueRule.prompt}”)`
                            : slowingForRule
                              ? `Slowing near ${slowingForRule.run_time} auto-buy`
                              : nextRule
                                ? `Next auto-buy: ${nextRule.run_time} (${dates.format(new Date(nextRule.next_run_at))})`
                                : "Helsinki · Click to control clock"}
                        </small>
                      </div>
                      <span className={`side-clock-badge ${isFastForwarding ? "active" : ""}`}>
                        {dueRule ? "Running" : isFastForwarding ? (slowingForRule ? "Slowing" : "Fast") : scheduleState.offset_seconds > 0 ? formatOffsetLabel(scheduleState.offset_seconds) : "Live"}
                      </span>
                      <ChevronDown size={15} className={`side-clock-chevron ${clockOpen ? "is-open" : ""}`} />
                    </button>
                    <button
                      type="button"
                      className={`side-clock-reset-btn ${scheduleState.offset_seconds > 0 || isFastForwarding ? "is-active" : ""}`}
                      aria-label="Reset time to right now"
                      title="Reset time to right now"
                      disabled={Boolean(activeAction || sending || (scheduleState.offset_seconds <= 0 && !isFastForwarding && visualSimNowMs - Date.now() < 1500))}
                      onClick={() => { void advanceClock({ reset: true }); }}
                    >
                      <RotateCcw size={14} />
                    </button>
                  </div>

                  {clockOpen && (
                    <div className="side-clock-drawer">
                      <div className="side-clock-two-actions">
                        <button
                          type="button"
                          className={`clock-main-btn fast ${isFastForwarding ? "is-active" : ""}`}
                          disabled={isFastForwarding}
                          onClick={() => setIsFastForwarding(true)}
                        >
                          <FastForward size={14} />
                          <span>Fast Forward</span>
                        </button>
                        <button
                          type="button"
                          className={`clock-main-btn stop ${!isFastForwarding ? "is-idle" : ""}`}
                          disabled={!isFastForwarding}
                          onClick={() => {
                            setIsFastForwarding(false);
                            const pending = Math.floor(visualExtraMsRef.current / 1000);
                            if (pending > 0) {
                              visualExtraMsRef.current = 0;
                              void advanceClock({ seconds: pending });
                            }
                          }}
                        >
                          <Square size={12} fill="currentColor" />
                          <span>Stop</span>
                        </button>
                      </div>
                      <p className="side-clock-note">
                        {slowingForRule
                          ? `Slowing smoothly as time approaches ${slowingForRule.run_time} (“${slowingForRule.prompt}”).`
                          : isFastForwarding
                            ? "Advancing quickly — slows down automatically when approaching scheduled buys."
                            : "Press Fast Forward to smoothly advance simulated time."}
                      </p>
                    </div>
                  )}
                </section>
              );
            })()}
          </aside>
        </div>

        {view === "overview" && <div className="control-content overview-content overview-metrics-below">
          <dl className="metric-grid">
            <div className="panel metric-card"><div className="metric-icon sky"><AgentIcon /></div><dt>Connected agents</dt><dd>{preview || workspace ? agents.filter((agent) => agent.status === "connected").length : "—"}</dd><small>{preview ? "Simulated agent connections" : workspace ? "Verified external trade agents" : "Agent data unavailable"}</small><button type="button" className="text-button" onClick={() => setView("agents")}>View agents <ArrowRight size={16} /></button></div>
            <div className="panel metric-card"><div className="metric-icon blue"><CartIcon /></div><dt>Orders updated today</dt><dd>{workspace ? changedToday : "—"}</dd><small>Helsinki time</small><button type="button" className="text-button" onClick={() => setView("activity")}>View activity <ArrowRight size={16} /></button></div>
            <div className="panel metric-card"><div className="metric-icon turquoise"><ApprovalIcon /></div><dt>Awaiting approval</dt><dd>{workspace ? pending.length : "—"}</dd><small>{pending.length ? "A decision needs your attention" : "No pending decisions"}</small><button type="button" className="primary-button" onClick={() => setView("approvals")}>Open Approval Centre <ArrowRight size={16} /></button></div>
            <div className="panel metric-card"><div className="metric-icon orange"><ApprovedIcon /></div><dt>Automatically approved</dt><dd>{workspace ? automatic : "—"}</dd><small>Across recorded orders</small><button type="button" className="text-button" onClick={() => setView("policies")}>View policies <ArrowRight size={16} /></button></div>
          </dl>
        </div>}

            {view === "policies" && <section className="panel side-panel policy-panel" aria-labelledby="guardrails-title">
              <div className="section-heading">
                <div className="section-icon"><ShieldCheck size={20} /></div>
                <div><h2 id="guardrails-title">Workspace approval rules</h2><p>Set a spend limit and choose which allergens trigger review.</p></div>
              </div>
              {draft ? (
                <form className="settings" onSubmit={saveSettings}>
                  <div className="slider-label">
                    <label htmlFor="spend">Max auto-approve spend</label>
                    <output htmlFor="spend">{money(draft.max_auto_approve_cents)}</output>
                  </div>
                  <input id="spend" type="range" min="0" max="500000" step="500" value={draft.max_auto_approve_cents}
                    aria-valuetext={money(draft.max_auto_approve_cents)}
                    disabled={Boolean(activeAction)}
                    style={{ background: `linear-gradient(to right, var(--accent) ${draft.max_auto_approve_cents / 5000}%, var(--line) 0)` }}
                    onChange={(event) => {
                      setSettingsSaved(false);
                      setDraft({ ...draft, max_auto_approve_cents: Number(event.target.value) });
                    }} />
                  <div className="slider-range"><span>€0</span><span>€5,000</span></div>
                  {draft.min_delivery_reliability != null && <div className="quantity-row">
                    <label htmlFor="reliability">Minimum delivery reliability (%)</label>
                    <input id="reliability" type="number" min="0" max="100" step="0.1" required disabled={Boolean(activeAction)} value={Number((draft.min_delivery_reliability * 100).toFixed(2))}
                      onChange={(event) => { if (event.target.value === "") return; setSettingsSaved(false); setDraft({ ...draft, min_delivery_reliability: Number(event.target.value) / 100 }); }} />
                  </div>}
                  <fieldset className="allergens" disabled={Boolean(activeAction)}>
                    <legend>Kitchen purchasing priorities (combine one or more — remembered automatically)</legend>
                    <div className="allergen-options">
                      {priorityOptions.map(({ id, label, Icon }) => {
                        const activeModes = activePriorityList(draft);
                        const checked = activeModes.includes(id);
                        return (
                          <label key={id}>
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={(event) => {
                                setSettingsSaved(false);
                                const prevModes = activePriorityList(draft);
                                let nextModes: PriorityMode[];
                                if (id === "balanced") {
                                  nextModes = event.target.checked ? ["balanced"] : prevModes.filter((m) => m !== "balanced");
                                } else {
                                  const withoutBalanced = prevModes.filter((m) => m !== "balanced");
                                  nextModes = event.target.checked
                                    ? [...withoutBalanced, id]
                                    : withoutBalanced.filter((m) => m !== id);
                                }
                                if (!nextModes.length) nextModes = ["balanced"];
                                setDraft({ ...draft, priority_mode: nextModes[0], priority_modes: nextModes });
                              }}
                            />
                            <Icon size={14} /> {label}
                          </label>
                        );
                      })}
                    </div>
                  </fieldset>
                  {draft.require_approval_on_substitution != null && <label className="substitution-policy">
                    <input type="checkbox" disabled={Boolean(activeAction)} checked={draft.require_approval_on_substitution} onChange={(event) => { setSettingsSaved(false); setDraft({ ...draft, require_approval_on_substitution: event.target.checked }); }} />
                    Require human approval for substitutions
                  </label>}
                  <fieldset className="allergens" disabled={Boolean(activeAction)}>
                    <legend>Excluded company allergens (strict ignore)</legend>
                    <div className="allergen-options">
                      {allergens.map(({ name, label, Icon }) => (
                        <label key={name}>
                          <input type="checkbox" checked={draft.review_allergens.includes(name)} onChange={(event) => {
                            setSettingsSaved(false);
                            setDraft({
                              ...draft, review_allergens: event.target.checked
                                ? [...draft.review_allergens, name]
                                : draft.review_allergens.filter((item) => item !== name),
                            });
                          }} />
                          <Icon size={14} /> {label}
                        </label>
                      ))}
                    </div>
                  </fieldset>
                  <div className="settings-actions">
                    <span role="status">{settingsSaved ? <><Check size={13} /> {preview ? "Saved in browser preview" : "Settings saved"}</> : null}</span>
                    <button type="submit" className="secondary-button" disabled={!settingsChanged || Boolean(activeAction)}>Save settings</button>
                  </div>
                </form>
              ) : <p className="empty">{workspaceError ? "Guardrails unavailable." : "Loading guardrails…"}</p>}
            </section>}

            {view === "approvals" && <section className="control-content" aria-label="Pending orders">
              <p className="decision-feedback" role="status">{decisionNotice}</p>
              {pending.length ? <div className="approval-grid">
                {pending.map((order) => (
                  <article className="panel approval-card" key={order.id}>
                    <div className="control-heading"><h2>Order {order.id}</h2><span className="status pending"><span />Pending approval</span></div>
                    <p className="approval-timestamp">{orderRequester(order)} · Updated <time dateTime={order.updated_at}>{dates.format(new Date(order.updated_at))}</time></p>
                    <ul className="approval-items">
                      {order.items.map((item, index) => {
                        const cap = formatOrderItemCapacity(item.quantity, item.unit);
                        const lineCents = item.unit_price_cents != null ? item.unit_price_cents * item.quantity : null;
                        return (
                          <li key={`${item.product_id}:${index}`} className="approval-item-row">
                            <div className="approval-item-media">
                              <ProductThumbnail productId={item.product_id} query={item.name} alt={item.name} />
                            </div>
                            <div className="approval-item-main">
                              <span className="approval-item-name">{item.name}</span>
                              <span className="approval-item-sub">
                                <code>SKU {item.product_id}</code>
                                {cap.perPackLabel ? ` · ${cap.perPackLabel}` : ""}
                                {item.unit_price_cents != null ? ` · ${money(item.unit_price_cents)}/unit` : ""}
                              </span>
                            </div>
                            <div className="approval-item-metrics">
                              <strong>
                                {item.quantity.toLocaleString("en-GB")}×{cap.totalLabel ? ` (${cap.totalLabel})` : ` · ${item.unit}`}
                              </strong>
                              {lineCents != null && <span className="approval-item-price">{money(lineCents)}</span>}
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                    <div className="approval-total"><span>Order total</span><strong>{money(order.total_cents)}</strong></div>
                    <div className="decision-note attention"><strong>Why this needs approval</strong>
                      {order.reasons.length ? <ul>{order.reasons.map((reason, index) => <li key={index}>{reason}</li>)}</ul> : <p>No reason was provided with this order.</p>}
                    </div>
                    <div className="queue-actions">
                      <button type="button" disabled={Boolean(activeAction) || Boolean(workspaceError)} onClick={() => void decideOrder(order.id, "rejected")}>Reject</button>
                      <button type="button" disabled={Boolean(activeAction) || Boolean(workspaceError)} onClick={() => void decideOrder(order.id, "approved")}>Approve <ArrowRight size={13} /></button>
                    </div>
                  </article>
                ))}
              </div> : <div className="panel control-empty"><ClipboardList size={24} aria-hidden="true" /><h2>{workspace ? "No orders awaiting approval" : workspaceError ? "Approval queue unavailable" : "Loading approvals…"}</h2><p>Orders that require human review appear here after the purchasing service records them.</p></div>}
              {!workspace && workspaceError && <details className="panel approval-card sample-approval">
                <summary>Preview an example approval</summary>
                <div className="control-heading"><h2>Example order #1042</h2><span className="status pending"><span />Illustrative example</span></div>
                <p className="approval-timestamp">Kitchen Assistant · Sample request</p>
                <ul className="approval-items"><li><span>Lactose-free milk</span><strong>1,000 L</strong></li><li><span>Mozzarella</span><strong>50 kg</strong></li></ul>
                <div className="approval-total"><span>Order total</span><strong>€1,450.00</strong></div>
                <div className="decision-note attention"><strong>Why this needs approval</strong><p>The example order exceeds the €500 automatic approval limit by €950.</p></div>
                <p className="review-caption">Connect the purchasing service to act on recorded orders.</p>
              </details>}
            </section>}

        {view === "activity" && <div className="control-content">
          <section className="panel side-panel" aria-label="Recorded order activity"><h2>Order history</h2>{activity(audit)}</section>
        </div>}
      </main>

      {showSetupDialog && workspace && (
        <div className="onboarding-backdrop" role="dialog" aria-modal="true" aria-labelledby="setup-dialog-title" onClick={(e) => {
          if (e.target === e.currentTarget) setShowSetupDialog(false);
        }}>
          <div className="onboarding-modal">
            <div className="onboarding-head">
              <span className="section-icon"><SlidersHorizontal size={20} /></span>
              <div>
                <h2 id="setup-dialog-title">Keittiö Setup — Allergens &amp; Priorities</h2>
                <p>Remembered automatically across your workspace. Category lock + excluded allergens always run first.</p>
              </div>
            </div>

            <div className="onboarding-block">
              <strong>1. Company excluded allergens (high priority)</strong>
              <div className="allergen-quick-chips">
                {allergens.map(({ name, label, Icon }) => {
                  const selected = workspace.guardrails.review_allergens.includes(name);
                  return (
                    <button
                      key={name}
                      type="button"
                      aria-pressed={selected}
                      disabled={Boolean(activeAction) || sending}
                      className={`allergen-chip ${selected ? "is-excluded" : ""}`}
                      onClick={() => void toggleCompanyAllergen(name)}
                    >
                      <Icon size={13} /> <span>{label}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="onboarding-block">
              <strong>2. Kitchen purchasing priorities (combine one or more)</strong>
              <div className="allergen-quick-chips">
                {priorityOptions.map(({ id, label, hint, Icon }) => {
                  const selected = activePriorityList(workspace.guardrails).includes(id);
                  return (
                    <button
                      key={id}
                      type="button"
                      title={hint}
                      aria-pressed={selected}
                      disabled={Boolean(activeAction) || sending}
                      className={`priority-chip ${selected ? "is-selected" : ""}`}
                      onClick={() => void toggleCompanyPriority(id)}
                    >
                      <Icon size={13} /> <span>{label}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="onboarding-actions">
              <button type="button" className="primary-button" onClick={() => {
                saveStoredPrefs({
                  onboarded: true,
                  priority_modes: activePriorityList(workspace.guardrails),
                  review_allergens: workspace.guardrails.review_allergens,
                });
                setNeedsInitialSetup(false);
                setShowSetupDialog(false);
              }}>Done</button>
            </div>
          </div>
        </div>
      )}

      <footer className="site-footer"><span>KeittiöMCP</span><span>Independent Junction prototype</span></footer>
    </div>
  );
}
