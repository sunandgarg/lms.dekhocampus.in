import { Archive } from 'lucide-react';
import { cn } from '@/lib/utils';

interface DataRetentionNoticeProps {
  className?: string;
  variant?: 'inline' | 'banner';
}

export function DataRetentionNotice({ className, variant = 'inline' }: DataRetentionNoticeProps) {
  if (variant === 'banner') {
    return (
      <div className={cn(
        "flex items-center gap-2 px-4 py-2.5 rounded-lg bg-amber-500/10 border border-amber-500/20 text-amber-700 dark:text-amber-400 text-sm",
        className
      )}>
        <Archive className="h-4 w-4 shrink-0" />
        <span>
          <strong>Private archive:</strong> Uploads and incoming API leads save their original data in S3. Partner delivery records are included in batch ZIPs.
        </span>
      </div>
    );
  }

  return (
    <p className={cn("flex items-center gap-1.5 text-xs text-muted-foreground", className)}>
      <Archive className="h-3 w-3" />
      New lead transactions are archived in private S3
    </p>
  );
}
