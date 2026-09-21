import type { ReactNode } from 'react';
import './globals.css';

export const metadata = {
  title: 'AI Takeaway Counter',
  description: 'Turn a restaurant WhatsApp number into an AI takeaway counter.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
