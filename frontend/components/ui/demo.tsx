import { ThinkingOrb, type OrbState } from "@/components/ui/thinking-orbs";

type Props = {
  state?: OrbState;
  label?: string;
  sublabel?: string;
};

// KeittiöMCP status pill using ThinkingOrb, styled for the navy/teal/coral brand palette.
export default function ThinkingOrbWorkingDemo({
  state = "working",
  label = "Working…",
  sublabel,
}: Props) {
  return (
    <div
      className="inline-flex min-h-[62px] items-center gap-3 rounded-full pl-[10px] pr-6"
      style={{
        background: "#002f6d",
        boxShadow:
          "inset 0 0 0 1px rgba(142,208,210,0.35), 0 4px 14px rgba(0,47,109,0.12)",
      }}
    >
      <span className="[&_canvas]:!size-12 flex items-center justify-center">
        <ThinkingOrb state={state} size={64} theme="dark" />
      </span>
      <span className="flex flex-col py-1.5">
        <span
          className="whitespace-nowrap text-sm font-bold leading-5"
          style={{ color: "#ffffff" }}
        >
          {label}
        </span>
        {sublabel && (
          <span
            className="text-xs leading-4"
            style={{ color: "rgba(227,240,239,0.82)" }}
          >
            {sublabel}
          </span>
        )}
      </span>
    </div>
  );
}
