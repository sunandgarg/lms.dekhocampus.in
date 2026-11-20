import { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { ArrowLeft, Eye, EyeOff } from 'lucide-react';
import { api } from '@/integrations/api/client';
import { useToast } from '@/hooks/use-toast';

const WEBHOOK_EVENTS = [
  { key: 'delivered', label: 'Delivered' },
  { key: 'open', label: 'Open' },
  { key: 'click', label: 'Click' },
  { key: 'bounce', label: 'Bounce' },
  { key: 'spam_report', label: 'Spam Report' },
  { key: 'unsubscribe', label: 'Unsubscribe' },
  { key: 'deferred', label: 'Deferred' },
  { key: 'block', label: 'Blocked' },
  { key: 'invalid', label: 'Invalid Email' },
];

interface EmailSettingsProps {
  onBack: () => void;
}

export function EmailSettings({ onBack }: EmailSettingsProps) {
  const [settings, setSettings] = useState({
    id: '',
    api_key: '',
    sender_domain: '',
    default_from_email: '',
    default_from_name: '',
    webhook_events: {} as Record<string, boolean>,
    webhook_key: '',
  });
  const [showKey, setShowKey] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const { toast } = useToast();

  const webhookUrl = settings.webhook_key
    ? `${window.location.origin}/api/webhooks/netcore-email-webhook?key=${settings.webhook_key}`
    : 'Save settings to generate a webhook URL';

  useEffect(() => {
    fetchSettings();
  }, []);

  const fetchSettings = async () => {
    setLoading(true);
    const { data, error } = await api.from('email_api_settings').select('*').limit(1).single();
    if (data) {
      setSettings({
        id: data.id,
        api_key: (data as any).api_key || '',
        sender_domain: (data as any).sender_domain || '',
        default_from_email: (data as any).default_from_email || '',
        default_from_name: (data as any).default_from_name || '',
        webhook_events: (data as any).webhook_events || {},
        webhook_key: (data as any).webhook_key || '',
      });
    }
    setLoading(false);
  };

  const handleSave = async () => {
    setSaving(true);
    const payload = {
      api_key: settings.api_key,
      sender_domain: settings.sender_domain,
      default_from_email: settings.default_from_email,
      default_from_name: settings.default_from_name,
      webhook_events: settings.webhook_events,
      webhook_key: settings.webhook_key || Array.from(crypto.getRandomValues(new Uint8Array(24)))
        .map((byte) => byte.toString(16).padStart(2, '0')).join(''),
      updated_at: new Date().toISOString(),
    };

    if (settings.id) {
      const { error } = await api.from('email_api_settings').update(payload).eq('id', settings.id);
      if (error) { toast({ title: 'Error', description: error.message, variant: 'destructive' }); setSaving(false); return; }
    } else {
      const { data, error } = await api.from('email_api_settings').insert(payload).select().single();
      if (error) { toast({ title: 'Error', description: error.message, variant: 'destructive' }); setSaving(false); return; }
      if (data) setSettings(prev => ({ ...prev, id: data.id }));
    }
    toast({ title: 'Saved', description: 'Email settings saved successfully' });
    setSettings(prev => ({ ...prev, webhook_key: payload.webhook_key }));
    setSaving(false);
  };

  const toggleEvent = (key: string) => {
    setSettings(prev => ({
      ...prev,
      webhook_events: { ...prev.webhook_events, [key]: !prev.webhook_events[key] },
    }));
  };

  if (loading) return <div className="flex items-center justify-center py-12 text-muted-foreground">Loading settings...</div>;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" onClick={onBack}><ArrowLeft className="h-4 w-4 mr-1" /> Back</Button>
        <div>
          <h2 className="text-2xl font-bold text-foreground">Email Service Settings</h2>
          <p className="text-sm text-muted-foreground">Configure your Netcore API for email delivery</p>
        </div>
      </div>

      {/* API Configuration */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Netcore API Configuration</CardTitle>
          <CardDescription>Enter your Netcore credentials to enable email sending</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Label>API Key *</Label>
            <div className="relative">
              <Input
                type={showKey ? 'text' : 'password'}
                value={settings.api_key}
                onChange={e => setSettings(p => ({ ...p, api_key: e.target.value }))}
                placeholder="Enter Netcore API key"
                className="pr-10"
              />
              <button onClick={() => setShowKey(!showKey)} className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </div>
          <div>
            <Label>Sender Domain *</Label>
            <Input value={settings.sender_domain} onChange={e => setSettings(p => ({ ...p, sender_domain: e.target.value }))} placeholder="mail.yourcompany.com" />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <Label>Default From Email *</Label>
              <Input value={settings.default_from_email} onChange={e => setSettings(p => ({ ...p, default_from_email: e.target.value }))} placeholder="noreply@yourcompany.com" />
            </div>
            <div>
              <Label>Default From Name *</Label>
              <Input value={settings.default_from_name} onChange={e => setSettings(p => ({ ...p, default_from_name: e.target.value }))} placeholder="Your Company" />
            </div>
          </div>
          <div>
            <Label>Webhook URL</Label>
            <Input value={webhookUrl} readOnly className="bg-muted text-muted-foreground font-mono text-xs" />
            <p className="text-xs text-muted-foreground mt-1">Set this URL in your Netcore dashboard to receive delivery events.</p>
          </div>
          <div className="flex gap-3">
            <Button onClick={handleSave} disabled={saving}>{saving ? 'Saving...' : 'Save Settings'}</Button>
          </div>
        </CardContent>
      </Card>

      {/* Webhook Events */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Webhook Events - Receive & Display</CardTitle>
          <CardDescription>Netcore will POST delivery events to your webhook URL. Toggle which events to track.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
            {WEBHOOK_EVENTS.map(evt => (
              <div key={evt.key} className="flex items-center justify-between p-3 border rounded-md">
                <span className="text-sm font-medium">{evt.label}</span>
                <Switch checked={!!settings.webhook_events[evt.key]} onCheckedChange={() => toggleEvent(evt.key)} />
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

    </div>
  );
}
