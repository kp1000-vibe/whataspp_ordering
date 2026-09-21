'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

/**
 * V1 navigation is deliberately short. Marketing, promotions and segments exist
 * in the backend but are NOT in the nav — this product is a takeaway counter
 * first, and a CRM only once the counter is earning its keep.
 */
const LINKS = [
  { href: '/dashboard', label: 'Orders' },
  { href: '/kitchen', label: 'Kitchen' },
  { href: '/menu', label: 'Menu' },
  { href: '/conversations', label: 'Chats' },
  { href: '/customers', label: 'Customers' },
  { href: '/analytics', label: 'Analytics' },
  { href: '/simulator', label: 'Test order' },
  { href: '/settings', label: 'Settings' },
];

export function ConsoleNav() {
  const pathname = usePathname();

  return (
    <nav className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
      {LINKS.map((link) => {
        const active = pathname === link.href || pathname.startsWith(`${link.href}/`);
        return (
          <Link
            key={link.href}
            href={link.href}
            className="whitespace-nowrap rounded-lg px-3 py-1.5 text-sm font-medium"
            style={
              active
                ? { background: 'color-mix(in srgb, var(--accent) 14%, transparent)', color: 'var(--accent)' }
                : { color: 'var(--muted)' }
            }
          >
            {link.label}
          </Link>
        );
      })}
    </nav>
  );
}
