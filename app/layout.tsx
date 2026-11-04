import "./globals.css";
import type { ReactNode } from "react";

export const metadata = { title: "Performance Management", description: "Goals, work and scores calculated from locked rules" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return <html lang="en"><body>{children}</body></html>;
}
