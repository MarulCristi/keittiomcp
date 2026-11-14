import type { SVGProps } from "react";

// User-supplied Tabler paths, with a slightly heavier stroke for the dashboard tiles.
type IconProps = SVGProps<SVGSVGElement> & { size?: number };
function Icon({ size = 36, children, ...props }: IconProps) {
  return <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.25} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>{children}</svg>;
}

export function AgentIcon(props: IconProps) {
  return <Icon {...props}>
    <path d="M7 10.5c0 -.828 .746 -1.5 1.667 -1.5h6.666c.92 0 1.667 .672 1.667 1.5v3c0 .828 -.746 1.5 -1.667 1.5h-6.666c-.92 0 -1.667 -.672 -1.667 -1.5v-3" />
    <path d="M12 7v2M10 12v.01M14 12v.01M4 8v-2a2 2 0 0 1 2 -2h2M4 16v2a2 2 0 0 0 2 2h2M16 4h2a2 2 0 0 1 2 2v2M16 20h2a2 2 0 0 0 2 -2v-2" />
  </Icon>;
}
export function CartIcon(props: IconProps) {
  return <Icon {...props}>
    <path d="M4 19a2 2 0 1 0 4 0a2 2 0 1 0 -4 0M15 19a2 2 0 1 0 4 0a2 2 0 1 0 -4 0M17 17h-11v-14h-2M6 5l14 1l-1 7h-13" />
  </Icon>;
}
export function ApprovalIcon(props: IconProps) {
  return <Icon {...props}>
    <path d="M9 5h-2a2 2 0 0 0 -2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2 -2v-12a2 2 0 0 0 -2 -2h-2M9 5a2 2 0 0 1 2 -2h2a2 2 0 0 1 2 2a2 2 0 0 1 -2 2h-2a2 2 0 0 1 -2 -2M9 12l.01 0M13 12l2 0M9 16l.01 0M13 16l2 0" />
  </Icon>;
}
export function ApprovedIcon(props: IconProps) {
  return <Icon {...props}>
    <path d="M9 11l3 3l8 -8M20 12v6a2 2 0 0 1 -2 2h-12a2 2 0 0 1 -2 -2v-12a2 2 0 0 1 2 -2h9" />
  </Icon>;
}
