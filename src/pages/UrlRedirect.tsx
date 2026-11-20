import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { AlertCircle } from 'lucide-react';

const KNOWN_ROUTES = new Set([
  'auth', 'dashboard', 'lead-push', 'crm', 'settings', 'url-shortener',
  'telecaller', 'universities', 'upload', 'history', 'logs', 'marketing',
]);

export default function UrlRedirect() {
  const params = useParams<{ code?: string; header?: string; codeOrHeader?: string }>();
  const navigate = useNavigate();
  const processed = useRef(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (processed.current) return;
    processed.current = true;
    const code = params.code || params.codeOrHeader;
    const header = params.header || null;
    if (!code || !/^[a-zA-Z0-9]+$/.test(code) || header && !/^[a-zA-Z0-9]+$/.test(header)) {
      setError('Invalid short URL');
      return;
    }
    if (KNOWN_ROUTES.has(code.toLowerCase())) {
      navigate('/not-found', { replace: true });
      return;
    }

    const url = new URL('/api/redirect/resolve', window.location.origin);
    url.searchParams.set('code', code);
    if (header) url.searchParams.set('header', header);
    fetch(url, { credentials: 'same-origin' })
      .then(async (response) => {
        if (!response.ok) throw new Error(response.status === 404 ? 'URL not found' : 'Could not load short URL');
        return response.json();
      })
      .then(({ original_url }) => window.location.replace(original_url))
      .catch((reason) => setError(reason.message));
  }, [params.code, params.header, params.codeOrHeader, navigate]);

  if (!error) return null;
  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <div className="text-center max-w-md">
        <AlertCircle className="h-16 w-16 text-destructive mx-auto mb-6" />
        <h1 className="text-2xl font-bold mb-2">Link unavailable</h1>
        <p className="text-muted-foreground mb-6">{error}</p>
        <a href="/" className="inline-flex items-center px-6 py-3 rounded-lg bg-primary text-primary-foreground">Go to LMS</a>
      </div>
    </div>
  );
}
