import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ReelHouse",
  description: "Private household media streaming for your home network"
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
