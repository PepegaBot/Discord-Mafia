import type { Metadata } from 'next';
import { Amiri, Cairo } from 'next/font/google';
import './globals.css';

const cairo = Cairo({
  subsets: ['arabic', 'latin'],
  variable: '--font-cairo',
  weight: ['400', '600', '700'],
});

const amiri = Amiri({
  subsets: ['arabic'],
  variable: '--font-amiri',
  weight: ['400', '700'],
});

export const metadata: Metadata = {
  title: 'Mafia Discord Activity',
  description: 'لعبة مافيا عربية مباشرة داخل Discord Voice Channel',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ar" dir="rtl" className={`${cairo.variable} ${amiri.variable}`}>
      <body className="font-body bg-gotham-black text-gotham-bone antialiased">{children}</body>
    </html>
  );
}
