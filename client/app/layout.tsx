import type { Metadata } from 'next';
import { Mukta, Yatra_One } from 'next/font/google';
import './globals.css';

// Mukta reads well in both Latin and Devanagari; Yatra One gives headings a hand-painted, bazaar-signboard feel.
const body = Mukta({ subsets: ['latin', 'devanagari'], weight: ['400', '500', '600', '700'], variable: '--font-ui', display: 'swap' });
const display = Yatra_One({ subsets: ['latin', 'devanagari'], weight: '400', variable: '--font-display', display: 'swap' });

export const metadata: Metadata = {
  title: 'ProcureAI',
  description: 'An AI buyer finds the best price. You approve. PayPal pays.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${body.variable} ${display.variable}`}>
      <body>{children}</body>
    </html>
  );
}
