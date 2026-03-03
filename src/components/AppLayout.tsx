import { ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { MessageSquare, Settings2 } from 'lucide-react';
import { cn } from '@/lib/utils';

export function AppLayout({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();

  const nav = [
    { to: '/', label: 'Ask Codes', icon: MessageSquare },
    { to: '/admin', label: 'Manage Sources', icon: Settings2 },
  ];

  return (
    <div className="flex h-screen bg-background">
      {/* Sidebar */}
      <aside className="w-56 shrink-0 border-r border-border flex flex-col">
        <div className="p-4 border-b border-border">
          <h1 className="text-sm font-bold text-foreground leading-tight">Hampton Building Codes</h1>
          <p className="text-[11px] text-muted-foreground mt-0.5">AI-powered code search</p>
        </div>
        <nav className="flex-1 p-3 space-y-1">
          {nav.map(({ to, label, icon: Icon }) => (
            <Link
              key={to}
              to={to}
              className={cn(
                'flex items-center gap-2.5 px-3 py-2 rounded-md text-sm transition-colors',
                pathname === to
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground'
              )}
            >
              <Icon className="h-4 w-4 shrink-0" />
              {label}
            </Link>
          ))}
        </nav>
      </aside>

      {/* Main */}
      <main className="flex-1 min-w-0 overflow-hidden">
        {children}
      </main>
    </div>
  );
}
