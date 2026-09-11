import type { ReactNode } from "react";
import "./globals.css";
import { Providers } from "./providers";

export default function UiLayout({ children }: { children: ReactNode }) {
  return <Providers>{children}</Providers>;
}
