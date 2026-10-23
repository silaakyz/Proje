import type { ReactNode } from "react";
import { AppShell } from "@/components/eip/shell";

export default function ShellLayout({ children }: { children: ReactNode }) {
  return <AppShell>{children}</AppShell>;
}
