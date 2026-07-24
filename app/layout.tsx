import type { Metadata } from 'next';
import { Manrope, Inter, IBM_Plex_Mono } from 'next/font/google';
import './globals.css';

const display = Manrope({ subsets: ['latin'], variable: '--font-display', weight: ['500', '700', '800'] });
const body = Inter({ subsets: ['latin'], variable: '--font-body', weight: ['400', '500', '600'] });
const mono = IBM_Plex_Mono({ subsets: ['latin'], variable: '--font-mono', weight: ['500', '600', '700'] });

export const metadata: Metadata = {
  title: 'Fuel Trader — Cheapest fuel near you',
  description: 'Ask a question, find the cheapest fuel nearby, right now.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className={`${display.variable} ${body.variable} ${mono.variable}`}>{children}</body>
    </html>
  );
}
