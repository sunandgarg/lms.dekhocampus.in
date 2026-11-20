import { memo } from 'react';
import { Archive, Download } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

function ArchiveRetentionView({ universities: _universities }: { universities: Array<{ id: string; name: string }> }) {
  return (
    <div className="container mx-auto px-4 py-6 max-w-3xl">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Archive className="h-5 w-5" /> Lead archive</CardTitle>
          <CardDescription>Batch history and lead transactions stay available for your ZIP reports.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 text-sm text-muted-foreground">
          <p>Every uploaded source CSV and each lead request and result is saved to private S3. Batch, lead, and API log records remain in MySQL so you can find the report later.</p>
          <Link to="/lead-push/history" className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-primary-foreground">
            <Download className="h-4 w-4" /> Open upload history
          </Link>
        </CardContent>
      </Card>
    </div>
  );
}

export default memo(ArchiveRetentionView);
