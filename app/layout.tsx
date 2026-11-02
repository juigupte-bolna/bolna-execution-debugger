import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Bolna Execution Debugger",
  description: "Paste a Bolna execution ID, get a root-cause diagnosis.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
