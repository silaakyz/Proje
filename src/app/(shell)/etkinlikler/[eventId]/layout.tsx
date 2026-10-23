import type { ReactNode } from "react";
import { EventWorkspace } from "@/components/eip/workspace";

export default function EventLayout({ children }: { children: ReactNode }) {
  return <EventWorkspace>{children}</EventWorkspace>;
}
